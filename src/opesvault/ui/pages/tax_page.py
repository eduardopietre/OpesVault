"""Imposto de renda: the year in the shape of the return's sheets, what is missing and the
monthly DARFs (docs/09 §1.3 F). Support material: rates and tables are the user's."""

from datetime import date
from typing import Any
from uuid import UUID

from PySide6.QtWidgets import QComboBox, QFileDialog, QInputDialog, QLineEdit, QStackedWidget, QTableWidget

from opesvault.domain.alerts import Severity
from opesvault.domain.deductibles import KIND_LABELS
from opesvault.domain.model import YearMonth
from opesvault.domain.money import ZERO
from opesvault.tax import checklist, declaration, ids, issues, records, simulation, statements, variable_income
from opesvault.tax.model import (
    BUCKET_LABELS,
    FIELD_LABELS,
    NATURE_SHORT,
    FilingSubject,
    NatureSubject,
    PaymentPurpose,
    ReportSource,
    TaxSubject,
)
from opesvault.ui.common import (
    combo_value,
    fill_combo,
    fit_to_rows,
    fmt,
    fmt_date,
    run_guarded,
    select_combo,
    selected_id,
    set_rows,
    stretch_column,
    summary_table,
)
from opesvault.ui.components import (
    Collapsible,
    EmptyState,
    Figures,
    adaptive,
    button,
    confirm,
    menu_button,
    scroll_body,
    text,
)
from opesvault.ui.pages.base import Page
from opesvault.ui.theme import SPACE_L

SEVERITY_WORDS = {Severity.URGENT: "Corrigir", Severity.SOON: "Em breve", Severity.INFO: "Conferir"}
SEVERITY_TONES = {Severity.URGENT: "negative", Severity.SOON: "warning", Severity.INFO: None}
PROJECT = "Projeto inteiro"


def _tid(value: str | None) -> str:
    return ids.display(value) if value else "falta"


class TaxPage(Page):
    title = "Imposto de renda"
    section = "Acompanhamento"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.year = QComboBox()
        self.year.setAccessibleName("Ano-calendário")
        this_year = date.today().year
        for year in range(this_year, this_year - 8, -1):
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
        content.addWidget(adaptive(1300, (self.issues_section, 3), (self.docs_section, 2)))
        content.addWidget(self.income_section)
        content.addWidget(self.payments_section)
        content.addWidget(adaptive(1300, (self.assets_section, 3), (self.debts_section, 2)))
        content.addWidget(self.variable_section)
        content.addWidget(adaptive(1300, (self.simulation_section, 2), (self.reports_section, 3)))
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

    def refresh(self) -> None:
        tables: list[QTableWidget] = [
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
        if self.session is None:
            for table in tables:
                table.setRowCount(0)
            self.declarant.clear()
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
        self._fill_issues()
        self._fill_docs()
        self._fill_income(found)
        self._fill_payments()
        self._fill_assets(year, people)
        self._fill_variable(year, people)
        comparison = simulation.compare(ledger, year, declarant)
        self._fill_simulation(comparison)
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

    def _fill_issues(self) -> None:
        rows = [([SEVERITY_WORDS[i.severity], i.title, i.detail], index) for index, i in enumerate(self._issues)]
        set_rows(self.issue_table, rows)
        for row, issue in enumerate(self._issues):
            item = self.issue_table.item(row, 0)
            tone = SEVERITY_TONES[issue.severity]
            if item is not None and tone:
                from PySide6.QtGui import QColor

                from opesvault.ui.theme import tokens

                item.setForeground(QColor(getattr(tokens(), tone)))
        fit_to_rows(self.issue_table)
        self.issues_section.set_title(f"Pendências · {len(self._issues)}" if self._issues else "Pendências")

    def _fill_docs(self) -> None:
        rows = []
        for index, item in enumerate(self._docs):
            state = "Recebido" if item.received else "Falta"
            if item.by_hand:
                state += " (marcado)"
            rows.append(([item.title, state], index))
        set_rows(self.docs_table, rows)
        for row, item in enumerate(self._docs):
            cell = self.docs_table.item(row, 0)
            if cell is not None:
                cell.setToolTip(item.detail)
        fit_to_rows(self.docs_table)
        missing = len(checklist.missing(self._docs))
        self.docs_section.set_title(f"Documentos do ano · faltam {missing}" if missing else "Documentos do ano")

    def _fill_income(self, found: declaration.Income) -> None:
        set_rows(
            self.taxable,
            [
                (
                    [
                        r.payer,
                        _tid(r.tax_id),
                        self._name(r.member_id),
                        fmt(r.taxable) + (" *" if r.net_only else ""),
                        fmt(r.social_security),
                        fmt(r.withheld),
                        fmt(r.thirteenth),
                        fmt(r.thirteenth_withheld),
                    ],
                    index,
                )
                for index, r in enumerate(found.taxable)
            ],
        )
        fit_to_rows(self.taxable)
        self.taxable_title.setVisible(bool(found.taxable))
        self.taxable.setVisible(bool(found.taxable))
        set_rows(
            self.other,
            [
                (
                    [
                        (NATURE_SHORT[r.nature] + (f" ({r.code})" if r.code else "")) if r.nature else "A definir",
                        r.source,
                        _tid(r.tax_id) if r.subject is NatureSubject.CATEGORY or r.tax_id else "—",
                        self._name(r.member_id),
                        fmt(r.amount),
                        fmt(r.withheld) if r.withheld else "—",
                    ],
                    index,
                )
                for index, r in enumerate(found.other)
            ],
        )
        fit_to_rows(self.other)
        self.other_title.setVisible(bool(found.other))
        self.other.setVisible(bool(found.other))
        self.income_empty.setVisible(not (found.taxable or found.other))
        set_rows(
            self.carne,
            [
                (
                    [
                        f"{m.month.month:02d}/{m.month.year}",
                        self._name(m.member_id),
                        fmt(m.amount),
                        fmt(m.paid) if m.paid else "não registrado",
                        fmt_date(variable_income.due_date(m.month)),
                    ],
                    index,
                )
                for index, m in enumerate(found.carne_leao)
            ],
        )
        fit_to_rows(self.carne)
        for widget in (self.carne_title, self.carne, self.carne_actions):
            widget.setVisible(bool(found.carne_leao))

    def _fill_payments(self) -> None:
        rows = []
        for index, r in enumerate(self._payments):
            count = len(r.operations)
            receipts = f"{count - r.without_receipt} de {count}"
            rows.append(
                (
                    [
                        KIND_LABELS[r.kind],
                        r.payee,
                        _tid(r.tax_id),
                        self._name(r.beneficiary_id),
                        fmt(r.paid),
                        fmt(r.not_deductible) if r.not_deductible else "—",
                        fmt(r.net),
                        receipts,
                    ],
                    index,
                )
            )
        set_rows(self.payments, rows)
        fit_to_rows(self.payments)
        self.payments.setVisible(bool(self._payments))
        self.payments_empty.setVisible(not self._payments)

    def _fill_assets(self, year: int, people: set[UUID] | None) -> None:
        assert self.session is not None
        rows = []
        for index, r in enumerate(self._assets):
            group = r.group or "a definir"
            if r.suggested and r.group:
                group += " (sugerido)"
            rows.append(
                (
                    [
                        group,
                        r.code or "—",
                        r.name,
                        r.description,
                        _tid(r.tax_id) if r.subject != "declared" else "—",
                        fmt(r.previous),
                        fmt(r.current),
                    ],
                    index,
                )
            )
        set_rows(self.assets, rows)
        for row, asset in enumerate(self._assets):
            cell = self.assets.item(row, 0)
            if cell is not None:
                cell.setToolTip(asset.group_label)
        fit_to_rows(self.assets)
        self.assets.setVisible(bool(self._assets))
        self.assets_empty.setVisible(not self._assets)
        debts = declaration.debts(self.session.ledger, year, people)
        set_rows(
            self.debts,
            [([d.name, _tid(d.tax_id), fmt(abs(d.previous)), fmt(abs(d.current))], d.account_id) for d in debts],
        )
        fit_to_rows(self.debts)
        self.debts_section.setVisible(bool(debts))

    def _fill_variable(self, year: int, people: set[UUID] | None) -> None:
        assert self.session is not None
        rows = []
        for index, r in enumerate(self._months):
            rows.append(
                (
                    [
                        f"{r.month.month:02d}/{r.month.year}",
                        BUCKET_LABELS[r.bucket] + (" *" if r.approximate else ""),
                        fmt(r.sales),
                        fmt(r.result),
                        fmt(r.exempt_gain) if r.exempt_gain else "—",
                        fmt(r.compensated) if r.compensated else "—",
                        fmt(r.base),
                        fmt(r.tax),
                        fmt(r.withheld) if r.withheld else "—",
                        fmt(r.due),
                        fmt_date(r.due_date),
                        fmt(r.paid) if r.paid else "—",
                    ],
                    index,
                )
            )
        set_rows(self.variable, rows)
        fit_to_rows(self.variable)
        notes = []
        carried = variable_income.carried_loss(self.session.ledger, year, people)
        losses = [f"{BUCKET_LABELS[b]}: {fmt(v)}" for b, v in carried.items() if v]
        if losses:
            notes.append("Prejuízo a compensar no fim do ano — " + "; ".join(losses) + ".")
        if any(r.approximate for r in self._months):
            notes.append("* Day trade separado pelo preço médio das compras do mesmo dia; confira com a nota.")
        if any(r.missing_rate for r in self._months):
            notes.append("Há base tributável sem alíquota: informe em Regras… (o imposto fica desconhecido).")
        notes.append("O vencimento é o último dia útil do mês seguinte sem contar feriados; confira a data.")
        self.variable_note.setText(" ".join(notes))
        self.variable_section.setVisible(bool(self._months))

    def _fill_simulation(self, comparison: simulation.Comparison) -> None:
        simple, full = comparison.simplified, comparison.itemized

        def cell(model: simulation.Model | None, attr: str) -> str:
            value = getattr(model, attr) if model is not None else None
            return fmt(value)

        rows: list[tuple[list[Any], Any]] = [
            (["Rendimentos tributáveis", fmt(comparison.taxable), fmt(comparison.taxable)], "taxable"),
            (["Desconto ou deduções", cell(simple, "deductions"), cell(full, "deductions")], "deductions"),
            (["Base de cálculo", cell(simple, "base"), cell(full, "base")], "base"),
            (["Imposto devido", cell(simple, "tax"), cell(full, "tax")], "tax"),
            (["Imposto já pago ou retido", fmt(comparison.withheld), fmt(comparison.withheld)], "paid"),
        ]
        balances = [comparison.balance(simple), comparison.balance(full)]
        rows.append(
            (
                ["A pagar (+) ou a restituir (−)", *(fmt(b) for b in balances)],
                "balance",
            )
        )
        set_rows(self.simulation, rows)
        fit_to_rows(self.simulation)
        notes = []
        if comparison.missing:
            notes.append("Falta informar " + ", ".join(comparison.missing) + " (Tabela do ano…).")
        best = comparison.best
        if best is not None:
            notes.append(f"Com estes números, a {best.name.lower()} resulta em menos imposto.")
        if comparison.deductions:
            notes.append(
                "Deduções: "
                + "; ".join(f"{label} {fmt(value)}" for label, value in comparison.deductions.items())
                + "."
            )
        if comparison.left_out:
            notes.append(
                "Fora da base: "
                + "; ".join(f"{label} {fmt(value)}" for label, value in comparison.left_out.items())
                + "."
            )
        self.simulation_note.setText(" ".join(notes))

    def _fill_reports(self, year: int) -> None:
        assert self.session is not None
        ledger = self.session.ledger
        rows = []
        for report in records.reports_of(ledger, year):
            source = ledger.accounts.get(report.source_id)
            diffs = statements.differences(ledger, report)
            state = f"{len(diffs)} diferença(s)" if diffs else "confere"
            rows.append(
                ([source.name if source else "?", _tid(report.payer_tax_id), str(len(report.lines)), state], report.id)
            )
        set_rows(self.reports, rows)
        fit_to_rows(self.reports)
        for widget in (self.reports, self.checks):
            widget.setVisible(bool(rows))
        self.reports_empty.setVisible(not rows)
        self._show_checks()

    def _show_checks(self) -> None:
        if self.session is None:
            self.checks.setRowCount(0)
            return
        report = records.reports(self.session.ledger).get(selected_id(self.reports))
        found = statements.check(self.session.ledger, report) if report else []
        set_rows(
            self.checks,
            [
                (
                    [
                        FIELD_LABELS[c.field],
                        fmt(c.informed),
                        fmt(c.recorded) if c.recorded is not None else "sem registro",
                        "—" if c.matches or c.difference is None else fmt(c.difference),
                    ],
                    c.field,
                )
                for c in found
            ],
        )
        fit_to_rows(self.checks)

    # ── actions ──────────

    def _run(self, dialog: Any, message: str) -> bool:
        if dialog.exec() and run_guarded(self, lambda: dialog.apply() or True):
            self.notify(message)
            self.changed()
            return True
        return False

    def resolve(self) -> None:
        index = selected_id(self.issue_table)
        if self.session is None or not isinstance(index, int) or not 0 <= index < len(self._issues):
            return
        issue = self._issues[index]
        action, ref = issue.action, issue.ref
        if action == "identity" and isinstance(ref, tuple):
            subject, key = ref
            self._identity(subject, key, issue.title.split(": ", 1)[-1])
        elif action == "member" and isinstance(ref, UUID):
            from opesvault.ui.tax_dialogs import MemberTaxDialog

            self._run(MemberTaxDialog(self, self.session.ledger, ref), "Dados fiscais salvos.")
        elif action == "nature":
            self.edit_natures(ref)
        elif action == "filing":
            row = next((r for r in self._assets if (r.subject, r.ref) == ref), None)
            if row is not None:
                self._filing(row)
        elif action in ("detail", "receipts"):
            self._operations(ref, action)
        elif action == "report":
            self._open_report_id(ref)
        elif action == "checklist":
            self.docs_section.set_expanded(True)
            self.body_scroll.ensureWidgetVisible(self.docs_section)
        elif action == "rules":
            self.edit_rules()
        elif action == "params":
            self.edit_parameters()
        elif action == "payment":
            self._pay(ref)
        elif action == "investments":
            self.navigate("investments")
        elif action == "ledger":
            self.navigate("ledger")

    def _identity(self, subject: TaxSubject, ref: object, label: str) -> None:
        from opesvault.ui.tax_dialogs import TaxIdDialog

        assert self.session is not None
        self._run(TaxIdDialog(self, self.session.ledger, subject, ref, label), "CPF/CNPJ salvo.")

    def edit_people(self) -> None:
        from opesvault.ui.tax_dialogs import PeopleDialog

        if self.session is None:
            return
        if not self.session.ledger.members:
            self.notify("Cadastre os integrantes em Contas e cartões › Integrantes.")
            return
        dialog = PeopleDialog(self, self.session.ledger)
        dialog.exec()
        if dialog.edited:
            self.changed()

    def edit_natures(self, focus: object) -> None:
        from opesvault.ui.tax_dialogs import NatureDialog

        if self.session is not None:
            self._run(NatureDialog(self, self.session.ledger, focus), "Natureza dos rendimentos salva.")  # type: ignore[arg-type]

    def edit_selected_nature(self) -> None:
        index = selected_id(self.other)
        row = self._income.other[index] if self._income and isinstance(index, int) else None
        self.edit_natures((row.subject, row.ref) if row else None)

    def edit_payer(self) -> None:
        index = selected_id(self.taxable)
        if self._income is None or not isinstance(index, int):
            index = selected_id(self.other)
            row = self._income.other[index] if self._income and isinstance(index, int) else None
            if row is not None and row.subject is NatureSubject.CATEGORY:
                self._identity(TaxSubject.CATEGORY, row.ref, row.source)
            return
        taxable = self._income.taxable[index]
        self._identity(TaxSubject.CATEGORY, taxable.source_id, taxable.payer)

    def detail_payslips(self) -> None:
        index = selected_id(self.taxable)
        if self._income is None or not isinstance(index, int):
            self.notify("Escolha uma fonte pagadora.")
            return
        self._operations(tuple(self._income.taxable[index].operations), "detail")

    def _operations(self, operation_ids: object, mode: str) -> None:
        from opesvault.ui.tax_dialogs import OperationsDialog

        if self.session is None or not isinstance(operation_ids, tuple):
            return
        dialog = OperationsDialog(self, self.session, operation_ids, mode)
        dialog.exec()
        if dialog.edited:
            self.changed()

    def _selected_payment(self) -> declaration.PaymentRow | None:
        index = selected_id(self.payments)
        return self._payments[index] if isinstance(index, int) and 0 <= index < len(self._payments) else None

    def edit_payee(self) -> None:
        row = self._selected_payment()
        if row is not None:
            self._identity(TaxSubject.MERCHANT, row.payee_key, row.payee)

    def payment_receipts(self) -> None:
        row = self._selected_payment()
        if row is not None:
            self._operations(tuple(row.operations), "receipts")

    def _selected_asset(self) -> declaration.AssetRow | None:
        index = selected_id(self.assets)
        return self._assets[index] if isinstance(index, int) and 0 <= index < len(self._assets) else None

    def edit_filing(self) -> None:
        row = self._selected_asset()
        if row is not None:
            self._filing(row)

    def _filing(self, row: declaration.AssetRow) -> None:
        from opesvault.ui.tax_dialogs import DeclaredAssetDialog, FilingDialog

        assert self.session is not None
        ledger = self.session.ledger
        if row.subject == "declared":
            self._run(DeclaredAssetDialog(self, ledger, records.declared_assets(ledger)[row.ref]), "Bem salvo.")
            return
        subject = FilingSubject.ACCOUNT if row.subject == "account" else FilingSubject.POSITION
        self._run(FilingDialog(self, ledger, subject, row.ref, row.name, row.group), "Bem classificado.")

    def edit_institution(self) -> None:
        row = self._selected_asset()
        if row is None or row.subject == "declared" or self.session is None:
            return
        ref = row.ref
        if row.subject == "position":
            from opesvault.investments.service import positions

            ref = positions(self.session.ledger)[row.ref].account_id
        self._identity(TaxSubject.ACCOUNT, ref, row.name)

    def edit_lender(self) -> None:
        account_id = selected_id(self.debts)
        if account_id is not None and self.session is not None:
            self._identity(TaxSubject.ACCOUNT, account_id, self.session.ledger.account(account_id).name)

    def new_asset(self) -> None:
        from opesvault.ui.tax_dialogs import DeclaredAssetDialog

        if self.session is not None:
            self._run(DeclaredAssetDialog(self, self.session.ledger), "Bem incluído.")

    def edit_parameters(self) -> None:
        from opesvault.ui.tax_dialogs import ParametersDialog

        if self.session is not None:
            self._run(ParametersDialog(self, self.session.ledger, self._year()), "Tabela do ano salva.")

    def edit_rules(self) -> None:
        from opesvault.ui.tax_dialogs import VariableRulesDialog

        if self.session is not None:
            self._run(VariableRulesDialog(self, self.session.ledger), "Regras de renda variável salvas.")

    def pay_variable(self) -> None:
        index = selected_id(self.variable)
        month = self._months[index].month if isinstance(index, int) and 0 <= index < len(self._months) else None
        if month is None:
            due = variable_income.due_by_month(self._months)
            month = next((m for m, (value, paid, _) in due.items() if paid < value), None)
        if month is None:
            self.notify("Escolha o mês na tabela de renda variável.")
            return
        self._pay(("variable_income", month))

    def pay_carne_leao(self) -> None:
        index = selected_id(self.carne)
        if self._income is None or not isinstance(index, int):
            self.notify("Escolha o mês do Carnê-Leão.")
            return
        item = self._income.carne_leao[index]
        self._pay(("carne_leao", item.month, item.member_id))

    def _pay(self, ref: object) -> None:
        from opesvault.ui.tax_dialogs import PaymentDialog

        if self.session is None or not isinstance(ref, tuple):
            return
        ledger = self.session.ledger
        month: YearMonth = ref[1]
        if ref[0] == "variable_income":
            rows = variable_income.months(ledger, month.year)
            due = variable_income.due_by_month(rows).get(month)
            suggested = (due[0] - due[1]) if due else None
            dialog = PaymentDialog(self, ledger, PaymentPurpose.VARIABLE_INCOME, month, None, suggested)
        else:
            dialog = PaymentDialog(
                self, ledger, PaymentPurpose.CARNE_LEAO, month, ref[2] if len(ref) > 2 else None, None
            )
        self._run(dialog, "Pagamento do DARF registrado.")

    # ── documents checklist ──────────

    def _selected_doc(self) -> checklist.Expected | None:
        index = selected_id(self.docs_table)
        return self._docs[index] if isinstance(index, int) and 0 <= index < len(self._docs) else None

    def open_document_item(self) -> None:
        item = self._selected_doc()
        if item is None or self.session is None:
            return
        if item.action == "receipts":
            self._operations(item.ref, "receipts")
        elif item.action == "report" and isinstance(item.ref, tuple):
            existing = next(
                (
                    r
                    for r in records.reports_of(self.session.ledger, self._year())
                    if (r.source, r.source_id) == item.ref
                ),
                None,
            )
            if existing is not None:
                self._open_report_id(existing.id)
            else:
                self.import_report(item.ref)
        else:
            self.toggle_received()

    def toggle_received(self) -> None:
        item = self._selected_doc()
        if item is None or self.session is None:
            return
        ledger, year = self.session.ledger, self._year()
        records.set_mark(ledger, year, item.key, None if item.by_hand else not item.received)
        self.changed()

    # ── informes ──────────

    def import_report(self, source: object = None) -> None:
        if self.session is None or self._job is not None:
            return
        name, _ = QFileDialog.getOpenFileName(self, "Importar informe", "", "Informes (*.pdf *.csv *.txt)")
        if not name:
            return
        from pathlib import Path

        try:
            data = Path(name).read_bytes()
        except OSError:
            self.notify("Não foi possível ler o arquivo.")
            return
        self._read_report(Path(name).name, data, source if isinstance(source, tuple) else None, None)

    def _read_report(
        self, name: str, data: bytes, source: tuple[ReportSource, UUID] | None, password: str | None
    ) -> None:
        from opesvault.ui.background import BackgroundJob

        self.import_button.setEnabled(False)
        job = BackgroundJob(lambda _report: statements.read(data, password))  # PDF text off the UI thread
        job.signals.done.connect(lambda result: self._report_read(name, data, source, result))
        self._job = job
        job.start()

    def _report_read(self, name: str, data: bytes, source: tuple[ReportSource, UUID] | None, result: object) -> None:
        from opesvault.importing.source import SourceError, SourceProblem
        from opesvault.ui.tax_dialogs import ReportDialog

        self._job = None
        self.import_button.setEnabled(True)
        if self.session is None:
            return
        if isinstance(result, SourceError) and result.problem in (
            SourceProblem.PASSWORD_REQUIRED,
            SourceProblem.WRONG_PASSWORD,
        ):
            password, ok = QInputDialog.getText(
                self, "Informe protegido", "Senha do PDF (não será guardada):", QLineEdit.EchoMode.Password
            )
            if ok and password:
                self._read_report(name, data, source, password)
            return
        if not isinstance(result, statements.ParsedReport):
            self.notify("Não foi possível ler este arquivo. Use Mais › Novo informe sem arquivo.")
            return
        dialog = ReportDialog(
            self,
            self.session.ledger,
            year=result.year or self._year(),
            lines=result.lines,
            payer_tax_id=result.payer_tax_id,
            payer_name=result.payer_name,
            source=source,
            skipped=result.skipped,
        )
        if not dialog.exec():
            return
        session = self.session

        def save() -> object:
            document = session.find_document_by_hash(_sha256(data)) or session.add_document(name, data)
            dialog.document_id = document.meta.id
            return dialog.apply()

        if run_guarded(self, save):
            self.notify("Informe salvo e comparado com o registrado.")
            self.changed()

    def new_report(self) -> None:
        from opesvault.ui.tax_dialogs import ReportDialog

        if self.session is not None:
            self._run(ReportDialog(self, self.session.ledger, year=self._year(), lines=[]), "Informe salvo.")

    def open_report(self) -> None:
        report_id = selected_id(self.reports)
        if report_id is not None:
            self._open_report_id(report_id)

    def _open_report_id(self, report_id: object) -> None:
        from opesvault.ui.tax_dialogs import ReportDialog

        if self.session is None:
            return
        report = records.reports(self.session.ledger).get(report_id)  # type: ignore[arg-type]
        if report is None:
            return
        dialog = ReportDialog(
            self,
            self.session.ledger,
            year=report.year,
            lines=list(report.lines),
            payer_tax_id=report.payer_tax_id,
            payer_name=report.payer_name,
            source=(report.source, report.source_id),
            report_id=report.id,
        )
        dialog.document_id = report.document_id
        self._run(dialog, "Informe corrigido.")

    def remove_report(self) -> None:
        report_id = selected_id(self.reports)
        if report_id is None or self.session is None:
            return
        if confirm(self, "Remover este informe?", "O arquivo original continua em Documentos.", "Remover"):
            records.remove_report(self.session.ledger, report_id)
            self.changed()

    def export_pdf(self) -> None:
        from opesvault.exports import tax_report_html
        from opesvault.ui.pdf_export import save_pdf

        if self.session is None:
            return
        ledger, year, declarant = self.session.ledger, self._year(), self._declarant()
        if save_pdf(self, f"declaracao-{year}.pdf", lambda: tax_report_html(ledger, year, declarant)):
            self.notify(f"Relatório de {year} gerado.")


def _sha256(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()
