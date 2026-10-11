"""The year's values the user informs (table and limits, variable income rules) and DARF payments."""

from datetime import date
from decimal import Decimal
from uuid import UUID

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox,
    QLineEdit,
    QTableWidget,
    QTableWidgetItem,
    QWidget,
)

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import YearMonth
from opesvault.domain.money import MoneyError, parse_brl
from opesvault.tax import records
from opesvault.tax.model import (
    BUCKET_LABELS,
    Bracket,
    Bucket,
    BucketRule,
    PaymentPurpose,
    TaxParameters,
)
from opesvault.ui.common import (
    combo_value,
    date_edit,
    fill_combo,
    from_qdate,
    money_edit,
    read_money,
)
from opesvault.ui.components import button
from opesvault.ui.dialogs import FormDialog, liquid_accounts
from opesvault.ui.tax_dialogs.fields import caption, cell_text, editable, percent_text, read_percent


class ParametersDialog(FormDialog):
    """The year's progressive table and limits, copied from the official source."""

    def __init__(self, parent: QWidget | None, ledger: Ledger, year: int) -> None:
        super().__init__(parent, f"Tabela e limites de {year}", "Salvar")
        self.ledger, self.year = ledger, year
        current = records.parameters(ledger, year) or TaxParameters(year=year)
        self.table = QTableWidget(0, 3)
        self.table.setHorizontalHeaderLabels(["Base anual até (vazio: acima)", "Alíquota (%)", "Parcela a deduzir"])
        self.table.verticalHeader().setVisible(False)
        self.table.setAccessibleName("Faixas da tabela anual")
        self.table.setMinimumHeight(200)
        from PySide6.QtWidgets import QHeaderView

        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)  # three equal columns
        for bracket in current.brackets or (None,) * 5:
            self._add(bracket)
        from opesvault.ui.components import hbox_widget

        tools = hbox_widget(
            button("Adicionar faixa", lambda: self._add(None), role="plain"),
            button("Remover faixa", self._remove, role="plain"),
            None,
        )
        self.simple_rate = QLineEdit(percent_text(current.simplified_rate))
        self.simple_cap = money_edit()
        self.simple_cap.setText(editable(current.simplified_cap))
        self.dependent = money_edit()
        self.dependent.setText(editable(current.dependent_deduction))
        self.education = money_edit()
        self.education.setText(editable(current.education_cap))
        self.pension = QLineEdit(percent_text(current.pension_cap_rate))
        self.source = QLineEdit(current.source)
        self.source.setMaxLength(300)
        for edit, name in (
            (self.simple_rate, "Desconto simplificado (%)"),
            (self.simple_cap, "Teto do desconto simplificado"),
            (self.dependent, "Dedução por dependente"),
            (self.education, "Limite de instrução por pessoa"),
            (self.pension, "Limite da previdência privada (%)"),
            (self.source, "Fonte dos valores"),
        ):
            edit.setAccessibleName(name)
        caption(
            self,
            "Nada vem preenchido: copie os valores do ano da fonte oficial (Receita Federal). "
            "Eles valem só para a simulação deste cofre.",
        )
        self.form.addRow(self.table)
        self.form.addRow("", tools)
        self.form.addRow("Desconto simplificado (%):", self.simple_rate)
        self.form.addRow("Teto do desconto:", self.simple_cap)
        self.form.addRow("Por dependente:", self.dependent)
        self.form.addRow("Instrução por pessoa:", self.education)
        self.form.addRow("Previdência privada (%):", self.pension)
        self.form.addRow("Fonte:", self.source)
        self.setMinimumWidth(640)

    def _add(self, bracket: Bracket | None) -> None:
        row = self.table.rowCount()
        self.table.insertRow(row)
        values = (
            (
                editable(bracket.up_to) if bracket.up_to is not None else "",
                percent_text(bracket.rate),
                editable(bracket.deduction),
            )
            if bracket
            else ("", "", "")
        )
        for column, value in enumerate(values):
            item = QTableWidgetItem(value)
            item.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            self.table.setItem(row, column, item)

    def _remove(self) -> None:
        row = self.table.currentRow()
        if row >= 0:
            self.table.removeRow(row)

    def build(self) -> TaxParameters:
        brackets = []
        for row in range(self.table.rowCount()):
            cells = [cell_text(self.table, row, c) for c in range(3)]
            if not any(cells):
                continue
            try:
                up_to = parse_brl(cells[0]) if cells[0] else None
                rate = parse_brl(cells[1].replace("%", "")) / 100 if cells[1] else Decimal(0)
                deduction = parse_brl(cells[2]) if cells[2] else Decimal(0)
            except MoneyError:
                raise DomainError(f"Faixa {row + 1}: use valores como 2.259,20 e 7,5.") from None
            brackets.append(Bracket(up_to=up_to, rate=rate, deduction=deduction))
        return TaxParameters(
            year=self.year,
            brackets=tuple(brackets),
            simplified_rate=read_percent(self.simple_rate, "Desconto simplificado"),
            simplified_cap=read_money(self.simple_cap, allow_empty=True),
            dependent_deduction=read_money(self.dependent, allow_empty=True),
            education_cap=read_money(self.education, allow_empty=True),
            pension_cap_rate=read_percent(self.pension, "Previdência privada"),
            source=self.source.text().strip() or "informado pelo usuário",
        )

    def validate(self) -> None:
        self.build()

    def apply(self) -> None:
        records.set_parameters(self.ledger, self.build())


class VariableRulesDialog(FormDialog):
    """Rates of stock, ETF and real estate fund gains and the monthly exemption limit."""

    def __init__(self, parent: QWidget | None, ledger: Ledger) -> None:
        super().__init__(parent, "Regras de renda variável", "Salvar")
        self.ledger = ledger
        self.setMinimumWidth(600)
        current = records.variable_rules(ledger)
        self.valid_from = date_edit(current.valid_from if current else date(date.today().year, 1, 1))
        self.valid_from.setAccessibleName("Vale a partir de")
        self.rates: dict[Bucket, QLineEdit] = {}
        self.form.addRow("Vale a partir de:", self.valid_from)
        for bucket, label in BUCKET_LABELS.items():
            rule = current.rule(bucket) if current else None
            edit = QLineEdit(percent_text(rule.rate if rule else None))
            edit.setPlaceholderText("alíquota em %")
            edit.setAccessibleName(f"Alíquota: {label}")
            self.rates[bucket] = edit
            self.form.addRow(f"{label} (%):", edit)
        common = current.rule(Bucket.COMMON) if current else None
        self.limit = money_edit("sem isenção")
        self.limit.setText(editable(common.exempt_sales_limit if common else None))
        self.limit.setAccessibleName("Limite mensal de vendas isentas de ações")
        self.form.addRow("Vendas de ações isentas até:", self.limit)
        self.source = QLineEdit(current.source if current else "")
        self.source.setPlaceholderText("de onde vieram os valores")
        self.source.setAccessibleName("Fonte")
        self.form.addRow("Fonte:", self.source)
        caption(
            self,
            "Nada vem preenchido: informe as alíquotas e o limite vigentes. Prejuízos são compensados nos meses "
            "seguintes dentro do mesmo tipo (comuns, day trade, fundos imobiliários). Sem alíquota, o imposto "
            "fica desconhecido.",
        )

    def build(self) -> list[BucketRule]:
        limit = read_money(self.limit, allow_empty=True)
        return [
            BucketRule(
                bucket=bucket,
                rate=read_percent(edit, BUCKET_LABELS[bucket]),
                exempt_sales_limit=limit if bucket is Bucket.COMMON else None,
            )
            for bucket, edit in self.rates.items()
        ]

    def validate(self) -> None:
        self.build()

    def apply(self) -> None:
        records.set_variable_rules(self.ledger, from_qdate(self.valid_from.date()), self.build(), self.source.text())


class PaymentDialog(FormDialog):
    """A DARF paid: money leaves the account as a tax expense and the month counts as paid."""

    def __init__(
        self,
        parent: QWidget | None,
        ledger: Ledger,
        purpose: PaymentPurpose,
        month: YearMonth,
        member_id: UUID | None,
        suggested: Decimal | None,
    ) -> None:
        from opesvault.tax.model import PURPOSE_LABELS

        super().__init__(parent, PURPOSE_LABELS[purpose], "Registrar pagamento")
        self.ledger, self.purpose, self.month, self.member_id = ledger, purpose, month, member_id
        self.amount = money_edit()
        self.amount.setText(editable(suggested))
        self.amount.setAccessibleName("Valor pago")
        self.on = date_edit()
        self.on.setAccessibleName("Data do pagamento")
        self.account = QComboBox()
        self.account.setAccessibleName("Conta")
        fill_combo(self.account, liquid_accounts(ledger))
        member = ledger.members.get(member_id) if member_id else None
        who = member.name if member else None
        caption(
            self,
            f"Apuração de {month.month:02d}/{month.year}"
            + (f" · {who}" if who else "")
            + ". Valor com multa e juros, se pago em atraso.",
        )
        self.form.addRow("Valor:", self.amount)
        self.form.addRow("Pago em:", self.on)
        self.form.addRow("Conta:", self.account)

    def validate(self) -> None:
        read_money(self.amount)
        if combo_value(self.account) is None:
            raise DomainError("Escolha a conta.")

    def apply(self) -> None:
        records.record_payment(
            self.ledger,
            self.purpose,
            self.month,
            read_money(self.amount),
            from_qdate(self.on.date()),
            combo_value(self.account),
            self.member_id,
        )
