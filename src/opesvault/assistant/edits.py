"""Edit tools: changes the assistant may propose. None of them changes anything by itself.

`prepare` resolves names and ids, runs every check it can and describes the change in words
(`PreparedEdit`); a wrong argument is a ToolError the model can fix. The ledger only changes
in `PreparedEdit.apply`, which the page calls after the user approves, as one undo step.
Changes that keep history carry the origin ("assistente, ollama:<modelo>:a1@…") in the reason.
"""

from datetime import date
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, WithJsonSchema

from opesvault.assistant.reads import amount_of
from opesvault.assistant.tools import (
    PreparedEdit,
    Registry,
    Tool,
    ToolError,
    ToolKind,
    account_label,
    day,
    find_account,
    find_category,
    find_operation,
    guarded,
    money,
    month,
)
from opesvault.domain import budget, merchants, tags
from opesvault.domain.edits import reclassify
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountType, Operation
from opesvault.domain.money import format_brl

MAX_DETAILS = 20  # lines listed in the approval; the rest are counted
MAX_IDS = 200


# Kept as the model sent it (text, or a JSON number already read as Decimal): `money` converts it
# and refuses a float, so pydantic's float-to-Decimal coercion never runs on money.
AmountText = Annotated[Any, WithJsonSchema({"type": "string"})]


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _when(op: Operation) -> str:
    found = op.occurred_on or op.cash_date
    return f"{found:%d/%m/%Y}" if found else "sem data"


def _listing(lines: list[str]) -> tuple[str, ...]:
    if len(lines) <= MAX_DETAILS:
        return tuple(lines)
    return (*lines[:MAX_DETAILS], f"… e mais {len(lines) - MAX_DETAILS}")


def _operations(ledger: Ledger, ids: list[str]) -> list[Operation]:
    found: dict[Any, Operation] = {}
    for ref in ids:
        op = find_operation(ledger, ref)
        if not op.active:
            raise ToolError(f"O lançamento {ref} está cancelado e não pode ser alterado.")
        found[op.id] = op
    return list(found.values())


def _reason(origin: str, text: str) -> str:
    return f"{' '.join(text.split())} (assistente, {origin})"


# ── reclassify ──────────────────────────────────────


class ReclassifyArgs(_Args):
    ids: list[str] = Field(min_length=1, max_length=MAX_IDS, description="'id' dos lançamentos")
    category: str = Field(description="Nome da nova categoria")
    reason: str = Field(min_length=3, max_length=200, description="Motivo, que fica no histórico")


def prepare_reclassify(ledger: Ledger, args: ReclassifyArgs, origin: str) -> PreparedEdit:
    from opesvault.importing import learning

    target = find_category(ledger, args.category)
    lines: list[str] = []
    moving: list[Operation] = []
    for op in _operations(ledger, args.ids):
        current = learning.category_of(ledger, op)
        if current is None:
            raise ToolError(
                f"O lançamento {op.id.hex[:8]} não tem uma única categoria (é transferência ou rateio); "
                "reclassifique pela tela do Livro."
            )
        if current[1] is not target.type:
            raise ToolError(f"O lançamento {op.id.hex[:8]} é de outro tipo que a categoria '{args.category}'.")
        if current[0] == target.id:
            continue
        moving.append(op)
        old = account_label(ledger, ledger.account(current[0]))
        lines.append(f"{_when(op)} · {op.description} · {format_brl(amount_of(ledger, op))}: {old} → ")
    if not moving:
        raise ToolError(f"Os lançamentos já estão na categoria '{args.category}'.")
    label = account_label(ledger, target)
    reason = _reason(origin, args.reason)

    def apply() -> dict[str, Any]:
        result = guarded(lambda: reclassify(ledger, [op.id for op in moving], target.id, reason))
        if not result.changed:  # the operations changed between the proposal and the approval
            raise ToolError("Nada foi reclassificado: " + ("; ".join(result.errors) or "os lançamentos mudaram."))
        return {"resultado": "aplicado", "reclassificados": result.changed, "mantidos": result.skipped}

    return PreparedEdit(
        "reclassify_operations",
        f"Reclassificar {len(moving)} lançamento(s) para {label}",
        (*_listing([line + label for line in lines]), f"Motivo no histórico: {args.reason.strip()}"),
        apply,
    )


# ── tags ────────────────────────────────────────────


class TagArgs(_Args):
    ids: list[str] = Field(min_length=1, max_length=MAX_IDS, description="'id' dos lançamentos")
    tag: str = Field(min_length=1, max_length=40, description="Marcador, ex.: Viagem 2026")
    remove: bool = Field(default=False, description="true para tirar o marcador em vez de pôr")


def prepare_tag(ledger: Ledger, args: TagArgs, _origin: str) -> PreparedEdit:
    tag = tags.normalize(args.tag)
    if not tag:
        raise ToolError("Informe o marcador.")
    ops = _operations(ledger, args.ids)
    has = [op for op in ops if tag.casefold() in (t.casefold() for t in tags.tags_of(ledger, op.id))]
    affected = has if args.remove else [op for op in ops if op not in has]
    if not affected:
        raise ToolError("Nada a mudar: " + ("nenhum tem esse marcador." if args.remove else "todos já o têm."))
    lines = [f"{_when(op)} · {op.description} · {format_brl(amount_of(ledger, op))}" for op in affected]
    ids = [op.id for op in affected]

    def apply() -> dict[str, Any]:
        count = guarded(lambda: tags.remove_tag(ledger, ids, tag) if args.remove else tags.add_tag(ledger, ids, tag))
        if not count:
            raise ToolError("Nada mudou: os lançamentos mudaram depois da proposta.")
        return {"resultado": "aplicado", "lancamentos": count}

    verb = "Tirar o marcador" if args.remove else "Marcar com"
    return PreparedEdit("tag_operations", f"{verb} “{tag}” {len(affected)} lançamento(s)", _listing(lines), apply)


# ── merchant name ───────────────────────────────────


class MerchantArgs(_Args):
    description: str = Field(min_length=1, max_length=200, description="Descrição do banco, como no lançamento")
    name: str = Field(min_length=1, max_length=60, description="Nome legível, ex.: iFood")


def prepare_merchant(ledger: Ledger, args: MerchantArgs, origin: str) -> PreparedEdit:
    name = " ".join(args.name.split())
    key = merchants.key_of(args.description)
    alike = [op for op in ledger.active_operations() if merchants.key_of(op.description) == key]
    if not alike:
        raise ToolError("Nenhum lançamento tem essa descrição; copie-a de search_operations.")
    current = merchants.merchant_of(ledger, args.description)
    if current == name:
        raise ToolError(f"O estabelecimento já se chama '{name}'.")

    def apply() -> dict[str, Any]:
        guarded(lambda: merchants.name_merchant(ledger, args.description, name, origin=f"assistente, {origin}"))
        return {"resultado": "aplicado", "lancamentos": len(alike)}

    return PreparedEdit(
        "name_merchant",
        f"Chamar “{current}” de “{name}”",
        (
            f"Vale para {len(alike)} lançamento(s) com descrições como “{alike[0].description}”.",
            "As descrições do banco não mudam; busca, relatórios e regras passam a mostrar o nome.",
        ),
        apply,
    )


# ── category rule ───────────────────────────────────


class RuleArgs(_Args):
    pattern: str = Field(min_length=3, max_length=80, description="Trecho que a descrição contém")
    category: str = Field(description="Categoria que a regra sugere")


def prepare_rule(ledger: Ledger, args: RuleArgs, _origin: str) -> PreparedEdit:
    from opesvault.importing import rules

    target = find_category(ledger, args.category)
    pattern = rules.normalize(args.pattern)
    if len(pattern) < rules.MIN_PATTERN:
        raise ToolError(f"O trecho precisa ter ao menos {rules.MIN_PATTERN} letras.")
    if any(r.pattern == pattern and r.active for r in rules.rules(ledger).values()):
        raise ToolError(f"Já existe uma regra para '{pattern}'.")
    matched = sum(1 for op in ledger.active_operations() if pattern in rules.normalize(op.description))
    label = account_label(ledger, target)

    def apply() -> dict[str, Any]:
        guarded(lambda: rules.add_rule(ledger, pattern, target.id))
        return {"resultado": "aplicado"}

    return PreparedEdit(
        "create_category_rule",
        f"Criar a regra “contém {pattern}” → {label}",
        (
            f"Hoje {matched} lançamento(s) contêm esse trecho; a regra vale para as próximas importações.",
            "Regras só sugerem: a escolha feita à mão na revisão continua valendo.",
        ),
        apply,
    )


# ── budget ──────────────────────────────────────────


class BudgetArgs(_Args):
    month: str = Field(description="Mês AAAA-MM")
    category: str = Field(description="Categoria de despesa")
    amount: AmountText = Field(description="Valor planejado, ex.: 800.00")


def prepare_budget(ledger: Ledger, args: BudgetArgs, _origin: str) -> PreparedEdit:
    when = month(args.month)
    if when is None:
        raise ToolError("Informe o mês, AAAA-MM.")
    target = find_category(ledger, args.category, AccountType.EXPENSE)
    value = money(args.amount)
    current = budget.line_for(ledger, target.id, when)
    if current is not None and current.amount == value:
        raise ToolError("O orçamento já tem esse valor.")
    label = account_label(ledger, target)
    before = format_brl(current.amount) if current is not None else "sem plano"

    def apply() -> dict[str, Any]:
        guarded(lambda: budget.set_budget(ledger, target.id, when, value))
        return {"resultado": "aplicado"}

    return PreparedEdit(
        "set_budget",
        f"Orçamento de {label} em {when.month:02d}/{when.year}: {format_brl(value)}",
        (f"Antes: {before}.",),
        apply,
    )


# ── new operations ──────────────────────────────────


class EntryArgs(_Args):
    account: str = Field(description="Conta de onde sai (despesa) ou para onde vai (receita) o dinheiro")
    category: str = Field(description="Categoria")
    amount: AmountText = Field(description="Valor, ex.: 87.40")
    date: str = Field(description="Data AAAA-MM-DD")
    description: str = Field(min_length=1, max_length=200)


def _prepare_entry(ledger: Ledger, args: EntryArgs, kind: AccountType) -> PreparedEdit:
    account = find_account(ledger, args.account, categories=False)
    if account.type is not AccountType.ASSET:
        raise ToolError(f"'{args.account}' não é conta corrente, poupança ou carteira; compras no cartão: pela tela.")
    category = find_category(ledger, args.category, kind)
    value = money(args.amount)
    when = day(args.date)
    if when is None:
        raise ToolError("Informe a data, AAAA-MM-DD.")
    if when > date.today():
        raise ToolError("A data está no futuro; para algo previsto, use Recorrências.")
    text = " ".join(args.description.split())
    expense = kind is AccountType.EXPENSE

    def apply() -> dict[str, Any]:
        if expense:
            op = guarded(lambda: ledger.record_expense(account.id, category.id, value, when, text))
        else:
            op = guarded(lambda: ledger.record_income(account.id, category.id, value, when, text))
        return {"resultado": "aplicado", "id": op.id.hex[:8]}

    label = "Despesa" if expense else "Receita"
    flow = (
        f"{account.name} → {account_label(ledger, category)}"
        if expense
        else f"{account_label(ledger, category)} → {account.name}"
    )
    return PreparedEdit(
        "record_expense" if expense else "record_income",
        f"{label}: {text}, {format_brl(value)} em {when:%d/%m/%Y}",
        (flow,),
        apply,
    )


def prepare_expense(ledger: Ledger, args: EntryArgs, _origin: str) -> PreparedEdit:
    return _prepare_entry(ledger, args, AccountType.EXPENSE)


def prepare_income(ledger: Ledger, args: EntryArgs, _origin: str) -> PreparedEdit:
    return _prepare_entry(ledger, args, AccountType.INCOME)


# ── import review ───────────────────────────────────


class ItemArgs(_Args):
    item: str = Field(description="'id' do item, devolvido por list_pending_import_items")
    category: str = Field(description="Categoria escolhida")


def prepare_item(ledger: Ledger, args: ItemArgs, origin: str) -> PreparedEdit:
    from opesvault.importing import pipeline
    from opesvault.importing.model import ItemStatus

    ref = args.item.strip().lower().replace("-", "")
    found = [i for i in pipeline.items(ledger).values() if len(ref) >= 8 and i.id.hex.startswith(ref)]
    if len(found) != 1:
        raise ToolError(f"Não existe item com id '{args.item}'. Use list_pending_import_items.")
    item = found[0]
    if item.status not in (ItemStatus.READY, ItemStatus.NEEDS_REVIEW):
        raise ToolError("Esse item já foi revisado.")
    category = find_category(ledger, args.category)
    label = account_label(ledger, category)

    def apply() -> dict[str, Any]:
        guarded(
            lambda: pipeline.correct_item(
                ledger, item.id, "target_account_id", category.id, reason=f"assistente, {origin}"
            )
        )
        return {"resultado": "aplicado", "observacao": "o item continua aguardando aprovação na revisão"}

    amount = format_brl(item.amount) if item.amount is not None else "sem valor"
    return PreparedEdit(
        "set_import_item_category",
        f"Categoria do item importado: {label}",
        (f"{item.description} · {amount}", "O item continua na revisão; aprovar continua sendo com você."),
        apply,
    )


EDITS: tuple[tuple[str, str, type[_Args], Any], ...] = (
    (
        "reclassify_operations",
        "Propõe mudar a categoria de lançamentos (precisa da aprovação do usuário).",
        ReclassifyArgs,
        prepare_reclassify,
    ),
    ("tag_operations", "Propõe pôr ou tirar um marcador de lançamentos (precisa de aprovação).", TagArgs, prepare_tag),
    (
        "name_merchant",
        "Propõe um nome legível para um estabelecimento, a partir da descrição do banco (precisa de aprovação).",
        MerchantArgs,
        prepare_merchant,
    ),
    (
        "create_category_rule",
        "Propõe uma regra: descrições com um trecho recebem uma categoria (precisa de aprovação).",
        RuleArgs,
        prepare_rule,
    ),
    (
        "set_budget",
        "Propõe o valor do orçamento de uma categoria num mês (precisa de aprovação).",
        BudgetArgs,
        prepare_budget,
    ),
    (
        "record_expense",
        "Propõe registrar uma despesa paga por uma conta (precisa de aprovação).",
        EntryArgs,
        prepare_expense,
    ),
    ("record_income", "Propõe registrar uma receita numa conta (precisa de aprovação).", EntryArgs, prepare_income),
    (
        "set_import_item_category",
        "Propõe a categoria de um item importado que aguarda revisão (precisa de aprovação).",
        ItemArgs,
        prepare_item,
    ),
)


def register(registry: Registry) -> None:
    for name, description, args, prepare in EDITS:
        registry.add(Tool(name, description, args, ToolKind.EDIT, prepare=prepare))
