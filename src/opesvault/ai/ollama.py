"""Optional local AI suggestions through Ollama (docs/05 §5, docs/02 §7).

- Only the loopback interface is ever contacted (the port may change, the host never);
  remote hosts and cloud models are refused.
- Only descriptions and category names are sent: no amounts, people, accounts or passwords.
- Text from documents is data, never instructions; every answer is validated against what was
  asked (known indexes, allowed categories, names made of the description's own words) and is a
  suggestion the user must approve.
- No tools, no streaming, no prompt logging.
- Thinking is turned off: classifying a short description gains little from it and costs
  many seconds per batch on reasoning models (Gemma 4, Qwen 3.5).
- A bad answer costs one batch, not the whole run: it is asked once more, then skipped,
  and what the other batches suggested is kept.
- Ollama keeps the last prompt cached while a model is loaded, so the app unloads the
  models it used when the vault is closed (`unload`).

Two tasks: a category per description (`suggest_categories`) and a readable merchant name
per description (`suggest_names`). Their instructions live in `ai/prompts.py`.
"""

import contextlib
import json
import re
import time
import unicodedata
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, ValidationError

from opesvault.ai import prompts

DEFAULT_PORT = 11434
DEFAULT_URL = f"http://127.0.0.1:{DEFAULT_PORT}"
PROMPT_VERSION = prompts.CATEGORY_VERSION
TIMEOUT_S = 180  # the first call also loads the model into memory
INFO_TIMEOUT_S = 5
UNLOAD_TIMEOUT_S = 2
BATCH_SIZE = 40  # descriptions per request: keeps the prompt small and the answer short
MAX_EXAMPLES = 24  # past classifications sent with each batch
MAX_NAME = 60  # the longest merchant name the ledger keeps
CONTEXT_TOKENS = 8192
KEEP_ALIVE = "10m"  # unloaded from RAM/VRAM after a while; nothing is promised about clearing it
_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
_NONE = {"NENHUMA", "NENHUM"}

# Measured with scripts/avaliar_modelos.py on 02/10/2026 (RTX 4070 Ti 12 GB): gemma4:12b got 97%
# right with 1 wrong suggestion; qwen3.5:9b 77% (13 wrong) and granite4.2:8b 56% (27 wrong). docs/09 §4.
RECOMMENDED_MODELS = ("gemma4:12b",)


class AiUnavailable(Exception):
    """The model could not help. `fatal`: the server is off or the model missing, so retrying is pointless."""

    def __init__(self, message: str, *, fatal: bool = False) -> None:
        super().__init__(message)
        self.fatal = fatal


def local_url(port: int = DEFAULT_PORT) -> str:
    """The Ollama address on this computer; only the port can change (OLLAMA_HOST=127.0.0.1:<port>)."""
    if not 1 <= port <= 65535:
        raise AiUnavailable("Porta do Ollama inválida.", fatal=True)
    return f"http://127.0.0.1:{port}"


class _Choice(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: int
    category: str


class _Answer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    suggestions: list[_Choice]


class _Name(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: int
    name: str


class _Names(BaseModel):
    model_config = ConfigDict(extra="forbid")

    names: list[_Name]


@dataclass(frozen=True)
class Suggestion:
    index: int
    category: str
    source: str  # "ollama:<model>:<prompt version>[@<digest>]"


@dataclass(frozen=True)
class NameSuggestion:
    index: int
    name: str
    source: str


@dataclass(frozen=True)
class ServerInfo:
    version: str
    models: tuple[str, ...]  # installed local models (cloud ones are left out)
    seconds: float
    digests: dict[str, str] = field(default_factory=dict)  # model -> content digest (its exact version)

    def installed(self, model: str) -> str | None:
        """The installed name for `model` ("gemma4" is "gemma4:latest"), or None."""
        for name in (model, f"{model}:latest"):
            if name in self.models:
                return name
        return None


@dataclass(frozen=True)
class Placement:
    """Where a loaded model sits: all in the GPU is fast; any part in the CPU is many times slower."""

    size: int  # bytes in memory
    vram: int  # of those, bytes in the GPU

    @property
    def gpu_percent(self) -> int:
        return round(100 * self.vram / self.size) if self.size else 0


@dataclass
class Run[T]:
    """What one batched call got back, and how much it could not get."""

    suggestions: list[T]
    failed: list[int] = field(default_factory=list)  # indexes left unanswered (bad answer, interruption)
    cancelled: bool = False


CategoryRun = Run[Suggestion]
NameRun = Run[NameSuggestion]


def _schema(key: str, field_name: str) -> dict[str, object]:
    return {
        "type": "object",
        "properties": {
            key: {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"index": {"type": "integer"}, field_name: {"type": "string"}},
                    "required": ["index", field_name],
                },
            }
        },
        "required": [key],
    }


def _is_cloud(name: str) -> bool:
    return name.endswith("-cloud") or ":cloud" in name


def _clean(description: str, limit: int) -> str:
    """One line per description, so a document's text cannot fake another line of the listing."""
    return " ".join(description.split())[:limit]


def _letters(text: str) -> str:
    plain = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^A-Z0-9]", "", plain.upper())


def plausible_name(description: str, name: str) -> str | None:
    """The name tidied, when it is made of the description's own words; otherwise None.

    A model may "recognize" a brand that is not there: at least one word of three or more
    letters of the name must appear in the description (ignoring case, accents and spaces,
    so "PAG*JOSEDASILVA" → "José da Silva" passes and "PADARIA" → "Carrefour" does not).
    """
    tidy = " ".join(name.split())
    if not tidy or tidy.upper() in _NONE or len(tidy) > MAX_NAME:
        return None
    source = _letters(description)
    words = [_letters(w) for w in tidy.split()]
    if not any(len(w) >= 3 and w in source for w in words):
        return None
    return tidy


class OllamaClient:
    def __init__(self, model: str, base_url: str = DEFAULT_URL) -> None:
        host = urlparse(base_url).hostname
        if host not in _LOCAL_HOSTS or urlparse(base_url).scheme != "http":
            raise AiUnavailable("Somente o Ollama local (127.0.0.1) é permitido.", fatal=True)
        if _is_cloud(model):
            raise AiUnavailable("Modelos em nuvem do Ollama não são permitidos.", fatal=True)
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.digest: str | None = None  # known after `check_model`; recorded with each suggestion
        self._think_supported = True  # turned off for servers or models that reject the option

    def _request(
        self, path: str, payload: dict[str, object] | None = None, timeout: float = TIMEOUT_S
    ) -> dict[str, object]:
        request = urllib.request.Request(  # noqa: S310 - the constructor only accepts loopback http
            self.base_url + path,
            data=json.dumps(payload).encode("utf-8") if payload is not None else None,
            headers={"Content-Type": "application/json"},
            method="POST" if payload is not None else "GET",
        )
        # The process-wide proxy settings must never route this call elsewhere.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            if exc.code == 404 and "not found" in detail:
                raise self._missing() from exc
            raise _HttpError(exc.code, detail) from exc
        except json.JSONDecodeError as exc:
            raise AiUnavailable("Resposta do Ollama ilegível.") from exc
        except TimeoutError as exc:
            raise AiUnavailable("O Ollama demorou demais para responder.", fatal=True) from exc
        except (urllib.error.URLError, OSError) as exc:
            raise AiUnavailable("Ollama indisponível.", fatal=True) from exc

    def _missing(self) -> AiUnavailable:
        return AiUnavailable(
            f"O modelo {self.model} não está instalado no Ollama. Instale com “ollama pull {self.model}”.", fatal=True
        )

    def server_info(self) -> ServerInfo:
        """Version and installed local models; also proves the server answers."""
        started = time.perf_counter()
        # Quick calls: a server that does not answer fast is "off".
        version = self._request("/api/version", timeout=INFO_TIMEOUT_S).get("version")
        tags = self._request("/api/tags", timeout=INFO_TIMEOUT_S).get("models")
        names: list[str] = []
        digests: dict[str, str] = {}
        for entry in tags if isinstance(tags, list) else []:
            name = entry.get("name") if isinstance(entry, dict) else None
            if isinstance(name, str) and not _is_cloud(name) and not entry.get("remote_host"):
                names.append(name)
                digest = entry.get("digest")
                if isinstance(digest, str):
                    digests[name] = digest
        return ServerInfo(str(version or "?"), tuple(sorted(names)), time.perf_counter() - started, digests)

    def check_model(self) -> ServerInfo:
        """Fails early, saying what to do, when the server is off or the model is not installed."""
        info = self.server_info()
        name = info.installed(self.model)
        if name is None:
            raise self._missing()
        self.digest = info.digests.get(name)
        return info

    def warm_up(self) -> None:
        """Loads the model into memory ahead of the first batch. Best effort."""
        with contextlib.suppress(AiUnavailable, _HttpError):
            self._request("/api/generate", {"model": self.model, "keep_alive": KEEP_ALIVE})

    def unload(self) -> None:
        """Asks Ollama to drop the model, and the prompts it still caches, from memory. Best effort."""
        with contextlib.suppress(AiUnavailable, _HttpError):
            self._request("/api/generate", {"model": self.model, "keep_alive": 0}, timeout=UNLOAD_TIMEOUT_S)

    def placement(self) -> Placement | None:
        """How much of this model, if loaded, is in the GPU (Ollama /api/ps). None when unknown."""
        try:
            loaded = self._request("/api/ps", timeout=INFO_TIMEOUT_S).get("models")
        except (AiUnavailable, _HttpError):
            return None
        for entry in loaded if isinstance(loaded, list) else []:
            if isinstance(entry, dict) and entry.get("name") in (self.model, f"{self.model}:latest"):
                size, vram = entry.get("size"), entry.get("size_vram")
                if isinstance(size, int) and isinstance(vram, int) and size > 0:
                    return Placement(size, min(vram, size))
        return None

    def source_for(self, version: str) -> str:
        """What a suggestion records about its origin: model, prompt version and model digest."""
        tag = f"ollama:{self.model}:{version}"
        return f"{tag}@{self.digest.removeprefix('sha256:')[:12]}" if self.digest else tag

    @property
    def source(self) -> str:
        return self.source_for(prompts.CATEGORY_VERSION)

    def _chat(self, system: str, user: str, schema: dict[str, object]) -> str:
        payload: dict[str, object] = {
            "model": self.model,
            "stream": False,
            "format": schema,
            "keep_alive": KEEP_ALIVE,
            "options": {"temperature": 0, "num_ctx": CONTEXT_TOKENS},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        if self._think_supported:
            payload["think"] = False
        try:
            body = self._request("/api/chat", payload)
        except _HttpError as exc:
            if self._think_supported and "think" in exc.detail.lower():
                self._think_supported = False  # older server or a model without the option
                return self._chat(system, user, schema)
            raise AiUnavailable(f"Ollama recusou o pedido ({exc.code}).") from exc
        message = body.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str):
            raise AiUnavailable("Resposta do Ollama sem conteúdo.")
        return content

    def _ask[M: BaseModel](self, system: str, user: str, answer: type[M], schema: dict[str, object]) -> M:
        """One batch; a malformed answer is asked once more before giving up on it."""
        try:
            return answer.model_validate_json(self._chat(system, user, schema))
        except ValidationError:
            pass
        except AiUnavailable as exc:
            if exc.fatal:
                raise
        try:
            return answer.model_validate_json(self._chat(system, user, schema))
        except ValidationError as exc:
            raise AiUnavailable("Resposta do Ollama fora do formato esperado.") from exc

    def _batched[T](
        self,
        count: int,
        ask_batch: Callable[[int, int], dict[int, T]],
        on_progress: Callable[[int], None] | None,
        cancelled: Callable[[], bool] | None,
    ) -> Run[T]:
        """Runs `ask_batch(offset, size)` over `count` entries; it returns what it found by global index.

        Raises AiUnavailable only when no batch worked.
        """
        run: Run[T] = Run([])
        out: dict[int, T] = {}
        answered = 0
        error: AiUnavailable | None = None
        for offset in range(0, count, BATCH_SIZE):
            size = min(BATCH_SIZE, count - offset)
            if cancelled is not None and cancelled():
                run.cancelled = True
                run.failed.extend(range(offset, count))
                break
            try:
                found = ask_batch(offset, size)
            except AiUnavailable as exc:
                error = exc
                if exc.fatal:  # the next batches would fail the same way
                    run.failed.extend(range(offset, count))
                    break
                run.failed.extend(range(offset, offset + size))
            else:
                answered += 1
                for index, value in found.items():
                    out.setdefault(index, value)
            if on_progress is not None:
                on_progress(offset + size)
        if not answered and error is not None:
            raise error
        run.suggestions = [out[i] for i in sorted(out)]
        return run

    def suggest_categories(
        self,
        descriptions: Sequence[str],
        categories: Sequence[str],
        examples: Sequence[tuple[str, str]] = (),
        on_progress: Callable[[int], None] | None = None,
        cancelled: Callable[[], bool] | None = None,
    ) -> CategoryRun:
        """Suggests a category per description, in batches.

        `examples` are (description, category) pairs the family already chose: they show how
        this family classifies. `on_progress` receives how many descriptions were handled so far;
        `cancelled` is checked between batches. Raises AiUnavailable only when no batch worked.
        """
        if not descriptions or not categories:
            return Run([])
        allowed = set(categories)
        source = self.source_for(prompts.CATEGORY_VERSION)
        guide = [f"- {_clean(d, 120)} → {c}" for d, c in examples if c in allowed][:MAX_EXAMPLES]
        schema = _schema("suggestions", "category")

        def ask_batch(offset: int, size: int) -> dict[int, Suggestion]:
            chunk = descriptions[offset : offset + size]
            listing = "\n".join(f"{i}: {_clean(d, 200)}" for i, d in enumerate(chunk))
            user = prompts.category_request(list(categories), guide, listing)
            answer = self._ask(prompts.CATEGORY_SYSTEM, user, _Answer, schema)
            # Valid JSON proves nothing: unknown indexes or categories are dropped.
            return {
                offset + c.index: Suggestion(offset + c.index, c.category, source)
                for c in reversed(answer.suggestions)  # the first answer for an index wins
                if 0 <= c.index < size and c.category in allowed
            }

        return self._batched(len(descriptions), ask_batch, on_progress, cancelled)

    def suggest_names(
        self,
        descriptions: Sequence[str],
        on_progress: Callable[[int], None] | None = None,
        cancelled: Callable[[], bool] | None = None,
    ) -> NameRun:
        """Suggests a readable merchant name per description ("IFD*IFOOD.COM AGENCIA" → "iFood").

        Names not made of the description's own words are dropped (`plausible_name`).
        """
        if not descriptions:
            return Run([])
        source = self.source_for(prompts.MERCHANT_VERSION)
        schema = _schema("names", "name")

        def ask_batch(offset: int, size: int) -> dict[int, NameSuggestion]:
            chunk = descriptions[offset : offset + size]
            listing = "\n".join(f"{i}: {_clean(d, 200)}" for i, d in enumerate(chunk))
            answer = self._ask(prompts.MERCHANT_SYSTEM, prompts.merchant_request(listing), _Names, schema)
            found: dict[int, NameSuggestion] = {}
            for entry in reversed(answer.names):
                if not 0 <= entry.index < size:
                    continue
                name = plausible_name(chunk[entry.index], entry.name)
                if name is not None:
                    found[offset + entry.index] = NameSuggestion(offset + entry.index, name, source)
            return found

        return self._batched(len(descriptions), ask_batch, on_progress, cancelled)


class _HttpError(Exception):
    def __init__(self, code: int, detail: str) -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail
