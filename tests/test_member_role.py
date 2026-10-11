"""Members have a role (schema 2); vaults written before it are migrated on open."""

from opesvault.domain.ledger import SCHEMA_VERSION, Ledger
from opesvault.domain.model import MemberRole

from .domain_fixtures import family


def test_new_members_are_holders_unless_said_otherwise() -> None:
    ledger = Ledger.new("Projeto")
    assert ledger.add_member("Ana").role is MemberRole.HOLDER
    assert ledger.add_member("Lia", MemberRole.DEPENDENT).role is MemberRole.DEPENDENT


def test_schema_1_vault_is_migrated_with_every_member_a_holder() -> None:
    f = family()
    rows = f.ledger.to_records()
    old = []
    for rid, kind, payload in rows:
        if kind == "ledger.meta":
            payload = {**payload, "schema_version": 1}
        elif kind == "member":
            payload = {k: v for k, v in payload.items() if k != "role"}  # as version 1 wrote it
        old.append((rid, kind, payload))
    restored = Ledger.from_records(old)
    assert restored.migrated_from == 1 and restored.meta.schema_version == SCHEMA_VERSION == 2
    assert {m.name: m.role for m in restored.members.values()} == {
        "Ana": MemberRole.HOLDER,
        "Bruno": MemberRole.HOLDER,
    }
