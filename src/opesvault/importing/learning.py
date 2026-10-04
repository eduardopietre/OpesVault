"""Categories learned from use: what the family chose for alike descriptions (docs/05 §6).

Nothing new is stored. What the app "learned" is read from the active operations, so it
always reflects the category an operation has now, after any correction or reclassification,
whether it came from a document, a manual entry or a recurrence. Descriptions are compared by
their merchant key: uppercase, no accents, no numbers, installments or card ids
("UBER *TRIP 8812 PARCELA 2/3" → "UBER *TRIP").

Learning sits between the user's explicit rules and the built-in keyword rules, and, like
every suggestion, it never approves anything. It also feeds back into the rules:

- `proposals`: descriptions categorized the same way several times, offered as a rule;
- `contradictions`: user rules the family keeps overriding, so they can be revised.

The result is cached until an operation or an account changes (`Ledger.changes_of`).
"""

from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date
from uuid import UUID

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountSubtype, AccountType, Operation
from opesvault.importing import rules

# A description seen this many times with one category is offered as a rule.
PROPOSAL_MIN_COUNT = 3
# Below this, a key is too generic to learn from ("PIX", "TED", "COMPRA").
MIN_KEY_LENGTH = 4
# Only the most recent choices decide: a family that changed its mind is followed.
RECENT_CHOICES = 5
# A rule is reported as contradicted when the family chose another category this often…
CONTRADICTION_MIN_COUNT = 2
# …and in at least this share (out of 100) of the operations the rule matches.
CONTRADICTION_MIN_SHARE = 50
KINDS = (AccountType.EXPENSE, AccountType.INCOME)


def merchant_key(description: str) -> str:
    return rules.suggest_pattern(description)


@dataclass(frozen=True)
class Choice:
    """One categorized operation: when, where (the money account), which category and its text."""

    on: date
    category_id: UUID
    account_id: UUID | None
    text: str  # the whole normalized description, for rules that keep numbers


@dataclass
class Learned:
    """The choices for one merchant key, newest last."""

    key: str
    kind: AccountType
    choices: list[Choice] = field(default_factory=list)

    def decide(self, account_id: UUID | None = None) -> "Suggestion | None":
        """The most frequent category among the recent choices; a tie goes to the newest.

        Choices made on `account_id` win when there are any, like a rule limited to an account.
        """
        own = [c for c in self.choices if account_id is not None and c.account_id == account_id]
        pool = (own or self.choices)[-RECENT_CHOICES:]
        if not pool:
            return None
        counts = Counter(c.category_id for c in pool)
        newest = {c.category_id: i for i, c in enumerate(pool)}
        best = max(counts, key=lambda category: (counts[category], newest[category]))
        return Suggestion(self.key, best, counts[best], len(pool))


@dataclass(frozen=True)
class Suggestion:
    key: str
    category_id: UUID
    agreeing: int  # recent choices for this category
    considered: int  # recent choices looked at

    @property
    def source(self) -> str:
        """Stored in `ExtractedItem.suggestion_source`; read back by `describe_source`."""
        return f"learned:{self.agreeing}/{self.considered}"


@dataclass(frozen=True)
class Proposal:
    """A rule the family's own choices suggest; creating it is the user's decision."""

    pattern: str
    category_id: UUID
    count: int


@dataclass(frozen=True)
class Contradiction:
    rule_id: UUID
    matched: int  # operations whose description the rule matches
    contrary: int  # of those, categorized differently by the family
    usual_category_id: UUID  # what the family chose instead, most often


def category_of(ledger: Ledger, op: Operation) -> tuple[UUID, AccountType, UUID | None] | None:
    """The single income or expense category of an operation and the account the money moved in."""
    categories = []
    others = []
    for posting in op.postings:
        account = ledger.accounts.get(posting.account_id)
        if account is None:
            return None
        if account.subtype is AccountSubtype.CATEGORY and account.type in KINDS:
            categories.append(account)
        else:
            others.append(account.id)
    if len({c.id for c in categories}) != 1:
        return None  # a split or a transfer teaches nothing about one description
    category = categories[0]
    if category.archived:
        return None
    return category.id, category.type, others[0] if others else None


def knowledge(ledger: Ledger) -> dict[tuple[str, AccountType], Learned]:
    """Every merchant key with the categories the family chose for it."""
    # Only operations and accounts teach anything: review items changing during an import keep it.
    stamp = ledger.changes_of("operation", "account")
    cached = getattr(ledger, "_learned_categories", None)
    if cached is not None and cached[0] == stamp:
        return cached[1]
    found: dict[tuple[str, AccountType], Learned] = {}
    seen_plans: set[UUID] = set()
    for op in sorted(ledger.active_operations(), key=lambda o: o.cash_date or o.occurred_on or date.min):
        if op.installment is not None:
            if op.installment.plan_id in seen_plans:
                continue  # one purchase in installments is one choice, not one per installment
            seen_plans.add(op.installment.plan_id)
        key = merchant_key(op.description)
        if len(key) < MIN_KEY_LENGTH:
            continue
        category = category_of(ledger, op)
        if category is None:
            continue
        category_id, kind, account_id = category
        learned = found.setdefault((key, kind), Learned(key, kind))
        when = op.cash_date or op.occurred_on or date.min
        learned.choices.append(Choice(when, category_id, account_id, rules.normalize(op.description)))
    ledger._learned_categories = (stamp, found)  # type: ignore[attr-defined]
    return found


def suggest(
    ledger: Ledger, description: str, wanted: AccountType | Iterable[AccountType], account_id: UUID | None = None
) -> Suggestion | None:
    """What the family usually chose for this description: the same merchant key first, then the
    longest learned key that starts it on a word boundary ("NETFLIX" for "NETFLIX.COM SP")."""
    kinds = (wanted,) if isinstance(wanted, AccountType) else tuple(wanted)
    key = merchant_key(description)
    if len(key) < MIN_KEY_LENGTH:
        return None
    learned = knowledge(ledger)
    for kind in kinds:
        exact = learned.get((key, kind))
        if exact is not None:
            return exact.decide(account_id)
    prefixes = [
        entry
        for (learned_key, kind), entry in learned.items()
        if kind in kinds and key.startswith(learned_key) and key[len(learned_key) : len(learned_key) + 1] in (" ", ".")
    ]
    if not prefixes:
        return None
    return max(prefixes, key=lambda entry: len(entry.key)).decide(account_id)


def describe_source(source: str) -> str | None:
    """'learned:3/4' → 'aprendida: 3 de 4 escolhas recentes'; None for other sources."""
    if not source.startswith("learned:"):
        return None
    agreeing, _, considered = source.removeprefix("learned:").partition("/")
    if agreeing == considered:
        return f"aprendida: {agreeing} escolha(s) iguais"
    return f"aprendida: {agreeing} de {considered} escolhas recentes"


def proposals(ledger: Ledger, minimum: int = PROPOSAL_MIN_COUNT) -> list[Proposal]:
    """Keys always categorized the same way at least `minimum` times, not yet covered by a rule.

    Most repeated first. A key whose recent choices disagree is left out: a rule would be wrong
    part of the time.
    """
    found = []
    for (key, kind), learned in knowledge(ledger).items():
        recent = learned.choices[-RECENT_CHOICES:]
        categories = {c.category_id for c in recent}
        if len(learned.choices) < minimum or len(categories) != 1:
            continue
        category_id = next(iter(categories))
        existing = rules.match(ledger, key, None, kind)
        if existing is not None and existing.target_account_id == category_id:
            continue  # a rule already says so
        found.append(Proposal(key, category_id, len(learned.choices)))
    return sorted(found, key=lambda p: (-p.count, p.pattern))


def contradictions(ledger: Ledger) -> dict[UUID, Contradiction]:
    """Active user rules the family keeps overriding: operations the rule matches, categorized
    differently after the fact (a correction in review or a reclassification in the ledger)."""
    found: dict[UUID, Contradiction] = {}
    learned = knowledge(ledger)
    for rule in rules.rules(ledger).values():
        if not rule.active:
            continue
        target = ledger.accounts.get(rule.target_account_id)
        if target is None:
            continue
        matched = 0
        contrary: Counter[UUID] = Counter()
        for (_key, kind), entry in learned.items():
            if kind is not target.type:
                continue
            for choice in entry.choices:
                if rule.pattern not in choice.text:
                    continue
                if rule.account_id is not None and choice.account_id != rule.account_id:
                    continue
                matched += 1
                if choice.category_id != rule.target_account_id:
                    contrary[choice.category_id] += 1
        total_contrary = sum(contrary.values())
        if total_contrary >= CONTRADICTION_MIN_COUNT and total_contrary * 100 >= matched * CONTRADICTION_MIN_SHARE:
            usual = contrary.most_common(1)[0][0]
            found[rule.id] = Contradiction(rule.id, matched, total_contrary, usual)
    return found
