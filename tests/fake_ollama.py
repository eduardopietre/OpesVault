"""A local stand-in for the Ollama HTTP API (the `ollama` fixture in conftest.py serves it)."""

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer


class FakeOllama(BaseHTTPRequestHandler):
    answer: str = ""
    answers: list[str] = []  # noqa: RUF012 - test double: consumed in order before `answer`
    received: list[dict] = []  # noqa: RUF012 - test double
    reject_think = False
    missing_model = False

    def _send(self, code: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/api/version":
            self._send(200, {"version": "0.35.1"})
        else:
            models = [{"name": "gemma4:12b", "digest": "sha256:0123456789abcdef"}, {"name": "gpt-oss:120b-cloud"}]
            self._send(200, {"models": [*models, {"name": "qwen3.5:9b"}]})

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeOllama.received.append(body)
        if FakeOllama.missing_model:
            self._send(404, {"error": f"model '{body['model']}' not found"})
        elif self.path == "/api/generate":  # load or unload a model: no answer is consumed
            self._send(200, {"model": body["model"], "done": True})
        elif FakeOllama.reject_think and "think" in body:
            self._send(400, {"error": f"{body['model']} does not support thinking"})
        else:
            content = FakeOllama.answers.pop(0) if FakeOllama.answers else FakeOllama.answer
            self._send(200, {"message": {"role": "assistant", "content": content}})

    def log_message(self, format: str, *args: object) -> None:
        pass


@contextmanager
def serve() -> Iterator[str]:
    server = HTTPServer(("127.0.0.1", 0), FakeOllama)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    FakeOllama.answer = ""
    FakeOllama.received = []
    FakeOllama.answers = []
    FakeOllama.reject_think = False
    FakeOllama.missing_model = False
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
