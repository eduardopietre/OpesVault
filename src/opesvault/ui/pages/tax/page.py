"""Imposto de renda: the year in the shape of the return's sheets, what is missing and the
monthly DARFs (docs/09 §1.3 F). Support material: rates and tables are the user's.

The page builds the sheets and fills them from the domain (`opesvault.tax`) through the plain
row builders in `rows`; the commands live in `commands` and the informes in `informes`.
"""

from datetime import date
from typing import Any
from uuid import UUID

from PySide6.QtGui import QColor
from PySide6.QtWidgets import QComboBox, QStackedWidget, QTableWidget

from opesvault.domain.alerts import Severity
from opesvault.domain.money import ZERO
from opesvault.tax import checklist, declaration, issues, records, simulation, statements, variable_income
from opesvault.ui.common import (
    combo_value,
    fill_combo,
    fit_to_rows,
    fmt,
    select_combo,
    selected_id,
    set_rows,
    stretch_column,
    summary_table,
)
from opesvault.ui.components import Collapsible, EmptyState, Figures, adaptive, button, menu_button, scroll_body, text
from opesvault.ui.pages.base import Page
from opesvault.ui.pages.tax import rows
from opesvault.ui.pages.tax.commands import TaxCommands
from opesvault.ui.pages.tax.informes import ReportCommands
from opesvault.ui.theme import SPACE_L, tokens

PROJECT = "Projeto inteiro"
YEARS_SHOWN = 8
SIDE_BY_SIDE = 1300  # width from which related sheets sit side by side


class TaxPage(TaxCommands, ReportCommands, Page):
    title = "Imposto de renda"
    section = "Acompanhamento"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.year = QComboBox()
        self.year.setAccessibleName("Ano-calendário")
        this_year = date.today().year
        for year in range(this_year, this_year - YEARS_SHOWN, -1):
            self.year.addItem(f"Ano-calendário {year}", year)
        self.year.setCurrentIndex(1)  # the return filed this year is about the year before
        self.declarant = QComboBox()
        self.declarant.setAccessibleName("Declarante")
        self.declarant.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToContents)
        self.year.currentIndexChanged.connect(self.refresh)
        self.declarant.currentIndexChanged.connect(self.refresh)
        setup = menu_button(
            "Cadastros",
            [
                ("Declarantes e dependentes…", self.edit_people),
                ("Natureza dos rendimentos…", lambda: self.edit_natures(None)),
                ("Novo bem (imóvel, veículo)…", self.new_asset),
                None,
                ("Tabela e limites do ano…", self.edit_parameters),
                ("Regras de renda variável…", self.edit_rules),
            ],
            tip="CPF, natureza das receitas, bens e os valores do ano",
        )
        more = menu_button(
            "Mais",
            [
                ("Novo informe sem arquivo…", self.new_report),
                ("Relatório para a declaração (PDF)…", self.export_pdf),
            ],
        )
        self.import_button = button(
            "Importar informe…", self.import_report, role="primary", tip="PDF do banco, da corretora ou do empregador"
        )
        self.header.add(self.year, self.declarant, setup, more, self.import_button)

        self.figures = Figures(["Rendimentos tributáveis", "Imposto retido", "Deduções registradas", "Pendências"])
        self.notice = text(declaration.NOTICE, "caption", wrap=True)
        self.notice.setMinimumWidth(160)

        # pendências and the year's documents
        self.issue_table = summary_table(["", "Pendência", "Detalhe"], max_rows=12)
        self.issue_table.setAccessibleName("Pendências da declaração")
        stretch_column(self.issue_table, 2)
        self.issue_table.doubleClicked.connect(lambda _: self.resolve())
        self.issues_section = Collapsible("Pendências", "ir/pendencias")
        self.issues_section.add_actions(button("Resolver…", self.resolve))
        self.issues_section.add(self.issue_table)
        self.docs_table = summary_table(["Documento", "Situação"], max_rows=12)
        self.docs_table.setAccessibleName("Documentos do ano")
        stretch_column(self.docs_table, 0)
        self.docs_table.doubleClicked.connect(lambda _: self.open_document_item())
        self.docs_section = Collapsible(
            "Documentos do ano", "ir/documentos", caption="Informes e comprovantes que a declaração pede."
        )
        self.docs_section.add_actions(
            button("Abrir…", self.open_document_item),
            button("Recebido / não recebido", self.toggle_received, role="plain"),
        )
        self.docs_section.add(self.docs_table)

        # income
        self.taxable = summary_table(
            ["Fonte pagadora", "CNPJ", "Integrante", "Rendimentos", "INSS", "IR retido", "13º salário", "IR 13º"],
            max_rows=10,
        )
        self.taxable.setAccessibleName("Rendimentos tributáveis de pessoa jurídica")
        stretch_column(self.taxable, 0)
        self.taxable.doubleClicked.connect(lambda _: self.detail_payslips())
        self.other = summary_table(["Natureza", "Fonte", "CNPJ", "Integrante", "Valor", "IR retido"], max_rows=12)
        self.other.setAccessibleName("Rendimentos isentos, exclusivos e do Carnê-Leão")
        stretch_column(self.other, 1)
        self.other.doubleClicked.connect(lambda _: self.edit_selected_nature())
        self.carne = summary_table(["Mês", "Integrante", "Recebido", "DARF pago", "Vence"], max_rows=12)
        self.carne.setAccessibleName("Carnê-Leão mês a mês")
        stretch_column(self.carne, 1)
        self.income_section = Collapsible(
            "Rendimentos",
            "ir/rendimentos",
            caption="Pelo regime de caixa (data do dinheiro). Sem o contracheque, o depósito conta pelo líquido.",
        )
        self.income_section.add_actions(
            button("CNPJ da fonte…", self.edit_payer),
            button("Contracheques…", self.detail_payslips),
            button("Natureza…", self.edit_selected_nature, role="plain"),
        )
        self.income_empty = text(
            "Nenhuma receita no ano. Salários, aluguéis e rendimentos aparecem aqui conforme a natureza de cada "
            "categoria (Cadastros › Natureza dos rendimentos).",
            "secondary",
            wrap=True,
        )
        self.taxable_title = text("Tributáveis recebidos de pessoa jurídica", "strong")
        self.other_title = text("Isentos, exclusivos, Carnê-Leão e a classificar", "strong")
        self.income_section.add(self.income_empty)
        self.income_section.add(self.taxable_title)
        self.income_section.add(self.taxable)
        self.income_section.add(self.other_title)
        self.income_section.add(self.other)
        self.carne_title = text("Carnê-Leão mês a mês (o imposto é calculado no Carnê-Leão Web)", "strong")
        self.income_section.add(self.carne_title)
        self.income_section.add(self.carne)
        self.carne_actions = button("Registrar DARF do Carnê-Leão…", self.pay_carne_leao, role="plain")
        self.income_section.add(self.carne_actions)

        # payments
        self.payments = summary_table(
            ["Tipo", "Quem recebeu", "CPF/CNPJ", "Beneficiário", "Pago", "Não dedutível", "Dedutível", "Comprovantes"],
            max_rows=14,
        )
        self.payments.setAccessibleName("Pagamentos efetuados")
        stretch_column(self.payments, 1)
        self.payments.doubleClicked.connect(lambda _: self.payment_receipts())
        self.payments_section = Collapsible(
            "Pagamentos efetuados",
            "ir/pagamentos",
            caption="Despesas das categorias marcadas como dedutíveis. A parte reembolsada (plano de saúde, "
            "empresa) é a parcela não dedutível.",
        )
        self.payments_section.add_actions(
            button("CPF/CNPJ…", self.edit_payee), button("Comprovantes…", self.payment_receipts, role="plain")
        )
        self.payments_empty = text(
            "Nenhum pagamento dedutível no ano. Marque as categorias em Contas e cartões › Categorias › "
            "Dedutível no IR (saúde, educação, previdência privada, pensão).",
            "secondary",
            wrap=True,
        )
        self.payments_section.add(self.payments_empty)
        self.payments_section.add(self.payments)

        # assets and debts
        self.assets = summary_table(
            ["Grupo", "Código", "Bem", "Discriminação", "CNPJ", "31/12 anterior", "31/12"], max_rows=16
        )
        self.assets.setAccessibleName("Bens e direitos")
        stretch_column(self.assets, 3)
        self.assets.doubleClicked.connect(lambda _: self.edit_filing())
        self.assets_section = Collapsible(
            "Bens e direitos",
            "ir/bens",
            caption="Pelo custo de aquisição do que ainda é seu, nunca pelo valor de mercado.",
        )
        self.assets_section.add_actions(
            button("Classificar…", self.edit_filing),
            button("CNPJ…", self.edit_institution, role="plain"),
            button("Novo bem…", self.new_asset, role="plain"),
        )
        self.assets_empty = text("Nenhum bem com saldo ou custo no fim do ano.", "secondary", wrap=True)
        self.assets_section.add(self.assets_empty)
        self.assets_section.add(self.assets)
        self.debts = summary_table(["Dívida", "CNPJ", "31/12 anterior", "31/12"], max_rows=8)
        self.debts.setAccessibleName("Dívidas e ônus reais")
        stretch_column(self.debts, 0)
        self.debts_section = Collapsible(
            "Dívidas e ônus", "ir/dividas", caption="Financiamentos e empréstimos. Faturas de cartão ficam de fora."
        )
        self.debts_section.add_actions(button("CNPJ…", self.edit_lender, role="plain"))
        self.debts_section.add(self.debts)

        # variable income
        self.variable = summary_table(
            [
                "Mês",
                "Tipo",
                "Vendas",
                "Resultado",
                "Isento",
                "Compensado",
                "Base",
                "Imposto",
                "IR fonte",
                "DARF",
                "Vence",
                "Pago",
            ],
            max_rows=14,
        )
        self.variable.setAccessibleName("Renda variável mês a mês")
        stretch_column(self.variable, 1)
        self.variable_note = text("", "caption", wrap=True)
        self.variable_note.setMinimumWidth(160)
        self.variable_section = Collapsible(
            "Renda variável",
            "ir/renda_variavel",
            caption="Vendas de ações, ETF e fundos imobiliários, mês a mês, com as alíquotas que você informou.",
        )
        self.variable_section.add_actions(
            button("Registrar DARF…", self.pay_variable), button("Regras…", self.edit_rules, role="plain")
        )
        self.variable_section.add(self.variable)
        self.variable_section.add(self.variable_note)

        # simulation
        self.simulation = summary_table(["", "Simplificada", "Completa"], max_rows=8)
        self.simulation.setAccessibleName("Simplificada ou completa")
        stretch_column(self.simulation, 0)
        self.simulation_note = text("", "caption", wrap=True)
        self.simulation_note.setMinimumWidth(160)
        self.simulation_section = Collapsible("Simplificada ou completa", "ir/simulacao", caption=simulation.NOTICE)
        self.simulation_section.add_actions(button("Tabela do ano…", self.edit_parameters, role="plain"))
        self.simulation_section.add(self.simulation)
        self.simulation_section.add(self.simulation_note)

        # informes
        self.reports = summary_table(["Fonte", "CNPJ", "Linhas", "Conferência"], max_rows=8)
        self.reports.setAccessibleName("Informes de rendimentos")
        stretch_column(self.reports, 0)
        self.reports.itemSelectionChanged.connect(self._show_checks)
        self.reports.doubleClicked.connect(lambda _: self.open_report())
        self.checks = summary_table(["Campo", "Informe", "Registrado", "Diferença"], max_rows=8)
        self.checks.setAccessibleName("Informe comparado com o registrado")
        stretch_column(self.checks, 0)
        self.reports_section = Collapsible(
            "Informes",
            "ir/informes",
            caption="Cada informe comparado com o que foi registrado; uma diferença aponta lançamento faltando "
            "ou errado.",
        )
        self.reports_section.add_actions(
            button("Abrir…", self.open_report), button("Remover", self.remove_report, role="plain")
        )
        self.reports_empty = text(
            "Nenhum informe deste ano. Importe o PDF do banco, da corretora ou do empregador para comparar "
            "com o que foi registrado.",
            "secondary",
            wrap=True,
        )
        self.reports_section.add(self.reports_empty)
        self.reports_section.add(self.reports)
        self.reports_section.add(self.checks)

        self.empty = EmptyState(
            "Nada registrado neste ano",
            "A página organiza o ano nas fichas da declaração assim que houver lançamentos.",
        )
        self.body_scroll, content = scroll_body()
        content.setSpacing(SPACE_L)
        content.addWidget(self.figures)
        content.addWidget(self.notice)
        content.addWidget(adaptive(SIDE_BY_SIDE, (self.issues_section, 3), (self.docs_section, 2)))
        content.addWidget(self.income_section)
        content.addWidget(self.payments_section)
        content.addWidget(adaptive(SIDE_BY_SIDE, (self.assets_section, 3), (self.debts_section, 2)))
        content.addWidget(self.variable_section)
        content.addWidget(adaptive(SIDE_BY_SIDE, (self.simulation_section, 2), (self.reports_section, 3)))
        content.addStretch(1)
        self.views = QStackedWidget()
        self.views.addWidget(self.body_scroll)
        self.views.addWidget(self.empty)
        layout = self.page_layout()
        layout.addWidget(self.views, 1)
        self._issues: list[issues.Issue] = []
        self._docs: list[checklist.Expected] = []
        self._income: declaration.Income | None = None
        self._payments: list[declaration.PaymentRow] = []
        self._assets: list[declaration.AssetRow] = []
        self._months: list[variable_income.MonthResult] = []
        self._job: Any = None

    # ── state ──────────

    def _year(self) -> int:
        return int(combo_value(self.year) or date.today().year - 1)

    def _declarant(self) -> UUID | None:
        return combo_value(self.declarant)

    def _people(self) -> set[UUID] | None:
        assert self.session is not None
        return records.people_of(self.session.ledger, self._declarant())

    def _name(self, member_id: UUID | None) -> str:
        assert self.session is not None
        member = self.session.ledger.members.get(member_id) if member_id else None
        return member.name if member else "—"

    def _fill_declarants(self) -> None:
        assert self.session is not None
        ledger = self.session.ledger
        current = self._declarant()
        self.declarant.blockSignals(True)
        fill_combo(self.declarant, [(ledger.members[m].name, m) for m in records.declarants(ledger)], empty=PROJECT)
        select_combo(self.declarant, current)
        self.declarant.blockSignals(False)

    def reveal(self, ref: object, *, act: bool = False) -> None:
        """("year", year) from the season alert; a DARF reminder opens its payment."""
        if isinstance(ref, tuple) and ref and ref[0] == "year":
            select_combo(self.year, ref[1])
            return
        if isinstance(ref, tuple) and ref and ref[0] in ("variable_income", "carne_leao"):
            month = ref[1]
            select_combo(self.year, month.year)
            if act:
                self._pay(ref)

    def set_session(self, session) -> None:  # type: ignore[no-untyped-def]
        """Opens on last year (the return filed now); on this year when last year has nothing."""
        if session is not None:
            years = {d.year for op in session.ledger.active_operations() if (d := op.cash_date)}
            last = date.today().year - 1
            self.year.blockSignals(True)
            select_combo(self.year, last if last in years or not years else max(y for y in years if y <= last + 1))
            self.year.blockSignals(False)
        super().set_session(session)

    # ── refresh ──────────

    def _tables(self) -> list[QTableWidget]:
        return [
            self.issue_table,
            self.docs_table,
            self.taxable,
            self.other,
            self.carne,
            self.payments,
            self.assets,
            self.debts,
            self.variable,
            self.simulation,
            self.reports,
            self.checks,
        ]

    def refresh(self) -> None:
        if self.session is None:
            for table in self._tables():
                table.setRowCount(0)
            self.declarant.clear()
            self._issues, self._docs, self._income = [], [], None
            self._payments, self._assets, self._months = [], [], []
            return
        self._fill_declarants()
        ledger = self.session.ledger
        year, declarant, people = self._year(), self._declarant(), self._people()
        self._issues = issues.issues(ledger, year, declarant)
        self._docs = checklist.expected(ledger, year, people)
        self._income = found = declaration.income(ledger, year, people)
        self._payments = declaration.payments(ledger, year, people)
        self._assets = declaration.assets(ledger, year, people)
        self._months = variable_income.months(ledger, year, people)
        comparison = simulation.compare(ledger, year, declarant)
        self._fill_issues()
        self._fill_docs()
        self._fill_income(found)
        self._fill_payments()
        self._fill_assets(declaration.debts(ledger, year, people))
        self._fill_variable(variable_income.carried_loss(ledger, year, people))
        self._show(self.simulation, rows.simulation_rows(comparison))
        self.simulation_note.setText(rows.simulation_notes(comparison))
        self._fill_reports(year)
        withheld = sum((r.withheld + r.thirteenth_withheld for r in found.taxable), ZERO)
        self.figures.set("Rendimentos tributáveis", fmt(comparison.taxable))
        self.figures.set("Imposto retido", fmt(withheld))
        self.figures.set("Deduções registradas", fmt(sum(comparison.deductions.values(), ZERO)))
        urgent = sum(1 for i in self._issues if i.severity is Severity.URGENT)
        self.figures.set("Pendências", str(len(self._issues)), "negative" if urgent else None)
        who = self.declarant.currentText() if declarant else "todo o projeto"
        self.header.set_subtitle(f"Declaração de {year + 1} (ano-calendário {year}) · {who}")
        has_any = bool(found.taxable or found.other or self._payments or self._assets or self._months or self._issues)
        self.views.setCurrentIndex(0 if has_any else 1)

    @staticmethod
    def _show(table: QTableWidget, found: list[rows.Row]) -> bool:
        """Fills a sheet's table to its rows; returns whether it has any."""
        set_rows(table, found)
        fit_to_rows(table)
        return bool(found)

    def _fill_issues(self) -> None:
        self._show(self.issue_table, rows.issue_rows(self._issues))
        for row, issue in enumerate(self._issues):
            item = self.issue_table.item(row, 0)
            tone = rows.SEVERITY_TONES[issue.severity]
            if item is not None and tone:
                item.setForeground(QColor(getattr(tokens(), tone)))
        self.issues_section.set_title(f"Pendências · {len(self._issues)}" if self._issues else "Pendências")

    def _fill_docs(self) -> None:
        self._show(self.docs_table, rows.document_rows(self._docs))
        for row, item in enumerate(self._docs):
            cell = self.docs_table.item(row, 0)
            if cell is not None:
                cell.setToolTip(item.detail)
        missing = len(checklist.missing(self._docs))
        self.docs_section.set_title(f"Documentos do ano · faltam {missing}" if missing else "Documentos do ano")

    def _fill_income(self, found: declaration.Income) -> None:
        taxable = self._show(self.taxable, rows.taxable_rows(found, self._name))
        other = self._show(self.other, rows.other_income_rows(found, self._name))
        carne = self._show(self.carne, rows.carne_leao_rows(found, self._name))
        for widget, visible in (
            (self.taxable_title, taxable),
            (self.taxable, taxable),
            (self.other_title, other),
            (self.other, other),
            (self.income_empty, not (taxable or other)),
            (self.carne_title, carne),
            (self.carne, carne),
            (self.carne_actions, carne),
        ):
            widget.setVisible(visible)

    def _fill_payments(self) -> None:
        shown = self._show(self.payments, rows.payment_rows(self._payments, self._name))
        self.payments.setVisible(shown)
        self.payments_empty.setVisible(not shown)

    def _fill_assets(self, debts: list[declaration.DebtRow]) -> None:
        shown = self._show(self.assets, rows.asset_rows(self._assets))
        for row, asset in enumerate(self._assets):
            cell = self.assets.item(row, 0)
            if cell is not None:
                cell.setToolTip(asset.group_label)
        self.assets.setVisible(shown)
        self.assets_empty.setVisible(not shown)
        self.debts_section.setVisible(self._show(self.debts, rows.debt_rows(debts)))

    def _fill_variable(self, carried: Any) -> None:
        shown = self._show(self.variable, rows.variable_rows(self._months))
        self.variable_note.setText(rows.variable_notes(self._months, carried))
        self.variable_section.setVisible(shown)

    def _fill_reports(self, year: int) -> None:
        assert self.session is not None
        shown = self._show(
            self.reports, rows.report_rows(self.session.ledger, records.reports_of(self.session.ledger, year))
        )
        for widget in (self.reports, self.checks):
            widget.setVisible(shown)
        self.reports_empty.setVisible(not shown)
        self._show_checks()

    def _show_checks(self) -> None:
        if self.session is None:
            self.checks.setRowCount(0)
            return
        report = records.reports(self.session.ledger).get(selected_id(self.reports))
        self._show(self.checks, rows.check_rows(statements.check(self.session.ledger, report) if report else []))
