"""Dialogs for tags, reimbursements, settling up, loans, balance checks and deductible categories."""

from decimal import Decimal
from typing import Any
from uuid import UUID

from PySide6.QtWidgets import QComboBox, QCompleter, QLineEdit, QSpinBox, QWidget

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount, Operation
from opesvault.domain.money import ZERO, format_brl, format_decimal_br
from opesvault.ui.common import (
    combo_value,
    date_edit,
    fill_combo,
    fmt,
    fmt_date,
    from_qdate,
    money_edit,
    read_money,
    select_combo,
)
from opesvault.ui.components import text
from opesvault.ui.dialogs import FormDialog, asset_accounts, category_items, liquid_accounts


def _editable(value: Decimal) -> str:
    """A value as typed in a money field: '1.234,56' (no currency symbol)."""
    return format_brl(value).replace("R$", "").strip()


# ── tags ─────────────────────────────────────────────────


class TagDialog(FormDialog):
    """Adds or removes one tag on the selected operations (an installment plan is tagged as a whole)."""

    def __init__(self, parent: QWidget | None, ledger: Ledger, operation_ids: list[UUID]) -> None:
        from opesvault.domain.tags import all_tags, tags_of

        super().__init__(parent, "Marcadores", "Aplicar")
        self.ledger = ledger
        self.ids = operation_ids
        self.tag = QLineEdit()
        self.tag.setPlaceholderText("ex.: Viagem 2026, Reforma da cozinha")
        self.tag.setAccessibleName("Marcador")
        self.tag.setCompleter(QCompleter(all_tags(ledger), self.tag))
        self.action = QComboBox()
        self.action.setAccessibleName("O que fazer")
        fill_combo(self.action, [("Adicionar aos selecionados", "add"), ("Remover dos selecionados", "remove")])
        current = sorted({t for op_id in operation_ids for t in tags_of(ledger, op_id)}, key=str.casefold)
        self.form.addRow(
            "",
            text(
                f"{len(operation_ids)} lançamento(s). Marcadores atuais: {', '.join(current) or 'nenhum'}. "
                "Marcadores agrupam lançamentos de várias categorias (uma viagem, uma reforma) e não mudam valores.",
                "caption",
                wrap=True,
            ),
        )
        self.form.addRow("Marcador:", self.tag)
        self.form.addRow("Ação:", self.action)

    def validate(self) -> None:
        from opesvault.domain.tags import normalize

        normalize(self.tag.text())

    def apply(self) -> int:
        from opesvault.domain.tags import add_tag, remove_tag

        if combo_value(self.action) == "remove":
            return remove_tag(self.ledger, self.ids, self.tag.text().strip())
        return add_tag(self.ledger, self.ids, self.tag.text())


class RenameTagDialog(FormDialog):
    def __init__(self, parent: QWidget | None, ledger: Ledger, tag: str) -> None:
        super().__init__(parent, "Renomear marcador", "Renomear")
        self.ledger = ledger
        self.old = tag
        self.name = QLineEdit(tag)
        self.name.setAccessibleName("Novo nome")
        self.form.addRow("Novo nome:", self.name)

    def validate(self) -> None:
        from opesvault.domain.tags import normalize

        normalize(self.name.text())

    def apply(self) -> int:
        from opesvault.domain.tags import rename_tag

        return rename_tag(self.ledger, self.old, self.name.text())


# ── reimbursements and settling up ───────────────────────


class ReimbursementDialog(FormDialog):
    """Marks an expense as something a health plan, an employer or someone else will pay back."""

    def __init__(self, parent: QWidget | None, ledger: Ledger, op: Operation) -> None:
        super().__init__(parent, "Reembolso a receber", "Registrar")
        self.ledger = ledger
        self.op = op
        total = sum(
            (
                p.amount
                for p in op.postings
                if ledger.account(p.account_id).type is AccountType.EXPENSE and p.amount > 0
            ),
            ZERO,
        )
        self.payer = QLineEdit()
        self.payer.setPlaceholderText("ex.: Plano de saúde, Empresa")
        self.payer.setAccessibleName("Quem reembolsa")
        self.expected = money_edit()
        self.expected.setAccessibleName("Valor esperado")
        if total > 0:
            self.expected.setText(_editable(total))
        self.requested = date_edit()
        self.requested.setAccessibleName("Pedido em")
        self.form.addRow(
            "", text(f"{op.description} · {fmt_date(op.occurred_on)} · {fmt(total)}", "caption", wrap=True)
        )
        self.form.addRow("Quem reembolsa:", self.payer)
        self.form.addRow("Valor esperado:", self.expected)
        self.form.addRow("Pedido em:", self.requested)

    def validate(self) -> None:
        if not self.payer.text().strip():
            raise DomainError("Informe quem reembolsa.")
        value = read_money(self.expected)
        if value is None or value <= 0:
            raise DomainError("Informe um valor positivo.")

    def apply(self) -> object:
        from opesvault.domain.sharing import request

        return request(
            self.ledger,
            self.op.id,
            self.payer.text(),
            read_money(self.expected),
            from_qdate(self.requested.date()),
        )


class ReceiveDialog(FormDialog):
    """The money of a reimbursement arrived: it becomes a refund of the original categories."""

    def __init__(self, parent: QWidget | None, ledger: Ledger, reimbursement: Any) -> None:
        from opesvault.domain.sharing import received

        super().__init__(parent, "Reembolso recebido", "Registrar recebimento")
        self.ledger = ledger
        self.item = reimbursement
        missing = reimbursement.expected - received(ledger, reimbursement)
        self.account = QComboBox()
        self.account.setAccessibleName("Recebido na conta")
        fill_combo(self.account, asset_accounts(ledger))
        self.amount = money_edit()
        self.amount.setAccessibleName("Valor recebido")
        if missing > 0:
            self.amount.setText(_editable(missing))
        self.when = date_edit()
        self.when.setAccessibleName("Data do recebimento")
        self.form.addRow(
            "",
            text(
                "O valor entra como estorno das categorias da despesa original, no mês em que foi recebido.",
                "caption",
                wrap=True,
            ),
        )
        self.form.addRow("Recebido na conta:", self.account)
        self.form.addRow("Valor:", self.amount)
        self.form.addRow("Data:", self.when)

    def validate(self) -> None:
        if combo_value(self.account) is None:
            raise DomainError("Cadastre a conta que recebeu.")
        value = read_money(self.amount)
        if value is None or value <= 0:
            raise DomainError("Informe um valor positivo.")

    def apply(self) -> object:
        from opesvault.domain.sharing import receive

        return receive(
            self.ledger, self.item.id, combo_value(self.account), read_money(self.amount), from_qdate(self.when.date())
        )


class SettlementDialog(FormDialog):
    """Records that one member paid another back (the transfer itself, if any, is a normal operation)."""

    def __init__(
        self,
        parent: QWidget | None,
        ledger: Ledger,
        debtor: UUID | None = None,
        creditor: UUID | None = None,
        amount: Decimal | None = None,
    ) -> None:
        super().__init__(parent, "Registrar acerto", "Registrar")
        self.ledger = ledger
        members = [(m.name, m.id) for m in ledger.members.values() if m.active]
        self.debtor = QComboBox()
        self.debtor.setAccessibleName("Quem pagou")
        fill_combo(self.debtor, members)
        self.creditor = QComboBox()
        self.creditor.setAccessibleName("Para quem")
        fill_combo(self.creditor, members)
        select_combo(self.debtor, debtor)
        select_combo(self.creditor, creditor)
        self.amount = money_edit()
        self.amount.setAccessibleName("Valor")
        if amount is not None:
            self.amount.setText(_editable(amount))
        self.when = date_edit()
        self.when.setAccessibleName("Data do acerto")
        self.note = QLineEdit()
        self.note.setAccessibleName("Observação")
        self.form.addRow("Quem pagou:", self.debtor)
        self.form.addRow("Para quem:", self.creditor)
        self.form.addRow("Valor:", self.amount)
        self.form.addRow("Data:", self.when)
        self.form.addRow("Observação:", self.note)

    def validate(self) -> None:
        if combo_value(self.debtor) is None or combo_value(self.debtor) == combo_value(self.creditor):
            raise DomainError("Escolha dois integrantes diferentes.")
        value = read_money(self.amount)
        if value is None or value <= 0:
            raise DomainError("Informe um valor positivo.")

    def apply(self) -> object:
        from opesvault.domain.sharing import settle

        return settle(
            self.ledger,
            combo_value(self.debtor),
            combo_value(self.creditor),
            read_money(self.amount),
            from_qdate(self.when.date()),
            self.note.text().strip() or None,
        )


# ── loans ────────────────────────────────────────────────


class LoanDialog(FormDialog):
    """A loan or financing as the contract says: balance, rate, term, system and first due date."""

    def __init__(self, parent: QWidget | None, ledger: Ledger) -> None:
        from opesvault.domain.loans import SYSTEM_LABELS, Opening

        super().__init__(parent, "Novo financiamento", "Criar financiamento")
        self.ledger = ledger
        self.name = QLineEdit()
        self.name.setPlaceholderText("ex.: Financiamento do apartamento")
        self.name.setAccessibleName("Nome")
        self.principal = money_edit()
        self.principal.setAccessibleName("Saldo devedor")
        self.rate = QLineEdit()
        self.rate.setPlaceholderText("ex.: 0,99")
        self.rate.setAccessibleName("Taxa de juros (%)")
        self.rate_basis = QComboBox()
        self.rate_basis.setAccessibleName("Período da taxa")
        fill_combo(self.rate_basis, [("% ao mês", "month"), ("% ao ano (efetiva)", "year")])
        self.term = QSpinBox()
        self.term.setRange(1, 600)
        self.term.setValue(60)
        self.term.setAccessibleName("Parcelas restantes")
        self.system = QComboBox()
        self.system.setAccessibleName("Sistema de amortização")
        fill_combo(self.system, [(label, value) for value, label in SYSTEM_LABELS.items()])
        self.first_due = date_edit()
        self.first_due.setAccessibleName("Vencimento da próxima parcela")
        self.payment = QComboBox()
        self.payment.setAccessibleName("Parcelas pagas pela conta")
        fill_combo(self.payment, asset_accounts(ledger))
        self.interest = QComboBox()
        self.interest.setAccessibleName("Categoria dos juros")
        fill_combo(self.interest, category_items(ledger, AccountType.EXPENSE))
        juros = next((a.id for a in ledger.categories(AccountType.EXPENSE) if a.name == "Juros e encargos"), None)
        select_combo(self.interest, juros)
        self.fees = money_edit("0,00")
        self.fees.setAccessibleName("Seguros e tarifas por parcela")
        self.fees_category = QComboBox()
        self.fees_category.setAccessibleName("Categoria dos seguros e tarifas")
        fill_combo(self.fees_category, category_items(ledger, AccountType.EXPENSE))
        select_combo(self.fees_category, juros)
        self.opening = QComboBox()
        self.opening.setAccessibleName("Como a dívida entra no livro")
        fill_combo(
            self.opening,
            [
                ("Dívida existente: registrar o saldo devedor como saldo de abertura", Opening.OPENING_BALANCE),
                ("Dinheiro recebido agora numa conta", Opening.DEPOSIT),
                ("A dívida já está registrada no livro", Opening.NONE),
            ],
        )
        self.deposit = QComboBox()
        self.deposit.setAccessibleName("Conta que recebeu o dinheiro")
        fill_combo(self.deposit, asset_accounts(ledger))
        self.opened_on = date_edit()
        self.opened_on.setAccessibleName("Data do saldo")
        self.opening.currentIndexChanged.connect(lambda _: self._opening_changed())
        for label, widget in (
            ("Nome:", self.name),
            ("Saldo devedor:", self.principal),
            ("Taxa de juros:", self.rate),
            ("Período da taxa:", self.rate_basis),
            ("Parcelas restantes:", self.term),
            ("Sistema:", self.system),
            ("Próxima parcela vence em:", self.first_due),
            ("Pagas pela conta:", self.payment),
            ("Categoria dos juros:", self.interest),
            ("Seguros e tarifas por parcela:", self.fees),
            ("Categoria dos seguros:", self.fees_category),
            ("No livro:", self.opening),
            ("Conta que recebeu:", self.deposit),
            ("Data do saldo:", self.opened_on),
        ):
            self.form.addRow(label, widget)
        self.form.addRow(
            "",
            text(
                "Informe o saldo devedor e as parcelas que ainda faltam, como no extrato do contrato. "
                "O cronograma é calculado; diferenças de centavos com o banco são normais.",
                "caption",
                wrap=True,
            ),
        )
        self._opening_changed()

    def _opening_changed(self) -> None:
        from opesvault.domain.loans import Opening

        choice = combo_value(self.opening)
        self.deposit.setEnabled(choice == Opening.DEPOSIT)
        self.opened_on.setEnabled(choice != Opening.NONE)

    def monthly_rate(self) -> Decimal:
        from opesvault.domain.loans import annual_to_monthly
        from opesvault.domain.money import MoneyError, parse_brl

        try:
            percent = parse_brl(self.rate.text() or "0")
        except MoneyError:
            raise DomainError("Taxa inválida. Use o formato 0,99.") from None
        if percent < 0 or percent >= 100:
            raise DomainError("Informe a taxa em %, entre 0 e 100.")
        fraction = percent / 100
        return annual_to_monthly(fraction) if combo_value(self.rate_basis) == "year" else fraction

    def build(self) -> Any:
        from opesvault.domain.loans import AmortizationSystem, LoanPlan

        name = self.name.text().strip()
        if not name:
            raise DomainError("Informe o nome do financiamento.")
        principal = read_money(self.principal)
        if principal is None or principal <= 0:
            raise DomainError("Informe o saldo devedor.")
        if combo_value(self.payment) is None or combo_value(self.interest) is None:
            raise DomainError("Cadastre a conta de pagamento e a categoria de juros.")
        fees = read_money(self.fees, allow_empty=True) or ZERO
        return LoanPlan(
            name=name,
            liability_account_id=UUID(int=0),  # replaced by the account created in apply()
            payment_account_id=combo_value(self.payment),
            interest_category_id=combo_value(self.interest),
            fees_category_id=combo_value(self.fees_category) if fees > 0 else None,
            principal=principal,
            monthly_rate=self.monthly_rate(),
            term=self.term.value(),
            system=AmortizationSystem(combo_value(self.system)),
            first_due=from_qdate(self.first_due.date()),
            fees_per_installment=fees,
        )

    def validate(self) -> None:
        from opesvault.domain.loans import schedule

        plan = self.build()
        schedule(plan)

    def apply(self) -> object:
        from opesvault.domain.loans import Opening, create_loan

        plan = self.build()
        account = self.ledger.add_account(
            LedgerAccount(name=plan.name, type=AccountType.LIABILITY, subtype=AccountSubtype.LOAN)
        )
        return create_loan(
            self.ledger,
            plan.model_copy(update={"liability_account_id": account.id}),
            Opening(combo_value(self.opening)),
            on=from_qdate(self.opened_on.date()),
            deposit_account_id=combo_value(self.deposit),
        )


class PayInstallmentDialog(FormDialog):
    def __init__(self, parent: QWidget | None, ledger: Ledger, plan: Any, item: Any) -> None:
        super().__init__(parent, f"Pagar parcela {item.number} — {plan.name}", "Registrar pagamento")
        self.ledger = ledger
        self.plan = plan
        self.item = item
        self.account = QComboBox()
        self.account.setAccessibleName("Pago pela conta")
        fill_combo(self.account, liquid_accounts(ledger))
        select_combo(self.account, plan.payment_account_id)
        self.amount = money_edit()
        self.amount.setAccessibleName("Valor pago")
        self.amount.setText(_editable(item.payment))
        self.when = date_edit()
        self.when.setAccessibleName("Data do pagamento")
        detail = (
            f"Vencimento {fmt_date(item.due)} · amortização {fmt(item.amortization)} · juros {fmt(item.interest)}"
            + (f" · seguros e tarifas {fmt(item.fees)}" if item.fees else "")
        )
        self.form.addRow("", text(detail, "caption", wrap=True))
        self.form.addRow("Pago pela conta:", self.account)
        self.form.addRow("Valor:", self.amount)
        self.form.addRow("Data:", self.when)
        self.form.addRow(
            "", text("Valor acima da parcela (multa, juros de atraso) entra como juros.", "caption", wrap=True)
        )

    def validate(self) -> None:
        value = read_money(self.amount)
        if value is None or value < self.item.payment:
            raise DomainError("O valor não pode ser menor que a parcela.")

    def apply(self) -> object:
        from opesvault.domain.loans import pay_installment

        return pay_installment(
            self.ledger,
            self.plan.id,
            self.item.number,
            from_qdate(self.when.date()),
            read_money(self.amount),
            combo_value(self.account),
        )


class PrepaymentDialog(FormDialog):
    """Simulates an early repayment as the user types; registering it is a separate, explicit choice."""

    def __init__(self, parent: QWidget | None, ledger: Ledger, plan: Any) -> None:
        from opesvault.domain.loans import MODE_LABELS

        super().__init__(parent, f"Amortização antecipada — {plan.name}", "Registrar amortização")
        self.ledger = ledger
        self.plan = plan
        self.amount = money_edit()
        self.amount.setAccessibleName("Valor da amortização")
        self.mode = QComboBox()
        self.mode.setAccessibleName("Efeito")
        fill_combo(self.mode, [(label, mode) for mode, label in MODE_LABELS.items()])
        self.account = QComboBox()
        self.account.setAccessibleName("Pago pela conta")
        fill_combo(self.account, liquid_accounts(ledger))
        select_combo(self.account, plan.payment_account_id)
        self.when = date_edit()
        self.when.setAccessibleName("Data da amortização")
        self.simulation = text("Informe um valor para ver a economia.", "caption", wrap=True)
        self.simulation.setAccessibleName("Resultado da simulação")
        self.amount.textChanged.connect(lambda _: self._simulate())
        self.mode.currentIndexChanged.connect(lambda _: self._simulate())
        self.form.addRow("Valor:", self.amount)
        self.form.addRow("Efeito:", self.mode)
        self.form.addRow("Pago pela conta:", self.account)
        self.form.addRow("Data:", self.when)
        self.form.addRow("Simulação:", self.simulation)

    def _simulate(self) -> None:
        from opesvault.domain.loans import PrepaymentMode, simulate_prepayment

        try:
            value = read_money(self.amount)
            if value is None or value <= 0:
                raise DomainError("")
            sim = simulate_prepayment(self.ledger, self.plan.id, value, PrepaymentMode(combo_value(self.mode)))
        except (DomainError, ValueError):
            self.simulation.setText("Informe um valor para ver a economia.")
            return
        saved = f"economia {fmt(sim.interest_saved)}"
        lines = [f"Juros a pagar: {fmt(sim.interest_before)} → {fmt(sim.interest_after)} ({saved})"]
        lines.append(f"Parcelas restantes: {sim.installments_before} → {sim.installments_after}")
        if sim.next_payment_before is not None and sim.next_payment_after is not None:
            lines.append(f"Próxima parcela: {fmt(sim.next_payment_before)} → {fmt(sim.next_payment_after)}")
        lines.append("Simulação: nada é registrado até você confirmar.")
        self.simulation.setText("\n".join(lines))

    def validate(self) -> None:
        value = read_money(self.amount)
        if value is None or value <= 0:
            raise DomainError("Informe um valor positivo.")

    def apply(self) -> object:
        from opesvault.domain.loans import PrepaymentMode, prepay

        return prepay(
            self.ledger,
            self.plan.id,
            read_money(self.amount),
            from_qdate(self.when.date()),
            PrepaymentMode(combo_value(self.mode)),
            combo_value(self.account),
        )


# ── balance check and deductible categories ──────────────


class BalanceCheckDialog(FormDialog):
    def __init__(self, parent: QWidget | None, ledger: Ledger, account_id: UUID) -> None:
        super().__init__(parent, f"Conferir saldo — {ledger.account(account_id).name}", "Conferir")
        self.ledger = ledger
        self.account_id = account_id
        self.when = date_edit()
        self.when.setAccessibleName("Data do saldo no banco")
        self.informed = money_edit()
        self.informed.setAccessibleName("Saldo no banco")
        self.note = QLineEdit()
        self.note.setAccessibleName("Observação")
        self.note.setPlaceholderText("ex.: extrato do aplicativo do banco")
        account = ledger.account(account_id)
        hint = (
            "Saldo devedor, como o banco mostra (valor positivo)."
            if account.type is AccountType.LIABILITY
            else "Saldo da conta no fim do dia, como o banco mostra (negativo se estiver no cheque especial)."
        )
        self.form.addRow("", text(hint, "caption", wrap=True))
        self.form.addRow("Data:", self.when)
        self.form.addRow("Saldo no banco:", self.informed)
        self.form.addRow("Observação:", self.note)

    def validate(self) -> None:
        read_money(self.informed)

    def apply(self) -> object:
        from opesvault.domain.balance_checks import record

        return record(
            self.ledger,
            self.account_id,
            from_qdate(self.when.date()),
            read_money(self.informed),
            self.note.text(),
        )


class DeductibleDialog(FormDialog):
    def __init__(self, parent: QWidget | None, ledger: Ledger, category_id: UUID) -> None:
        from opesvault.domain.deductibles import KIND_LABELS, kind_of, marks

        super().__init__(parent, f"Despesa dedutível — {ledger.account(category_id).name}", "Salvar")
        self.ledger = ledger
        self.category_id = category_id
        self.kind = QComboBox()
        self.kind.setAccessibleName("Tipo de dedução")
        fill_combo(self.kind, [(label, kind) for kind, label in KIND_LABELS.items()], empty="Não é dedutível")
        own = next((m.kind for m in marks(ledger).values() if m.category_id == category_id), None)
        select_combo(self.kind, own)
        inherited = kind_of(ledger, category_id) if own is None else None
        self.form.addRow("Tipo:", self.kind)
        if inherited is not None:
            self.form.addRow("", text(f"Já dedutível pela categoria-mãe ({KIND_LABELS[inherited]}).", "caption"))
        self.form.addRow(
            "",
            text(
                "Despesas destas categorias aparecem em Relatórios › Despesas dedutíveis, por pessoa, "
                "como apoio à declaração anual. Limites legais não são aplicados.",
                "caption",
                wrap=True,
            ),
        )

    def apply(self) -> object:
        from opesvault.domain.deductibles import DeductibleKind, mark

        value = combo_value(self.kind)
        mark(self.ledger, self.category_id, DeductibleKind(value) if value else None)
        return True


def rate_label(monthly: Decimal) -> str:
    return f"{format_decimal_br(monthly * 100, 4)}% ao mês"
