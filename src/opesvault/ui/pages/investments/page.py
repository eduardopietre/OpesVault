"""Investimentos: positions, valuations, flows, redemptions and the simulator (docs/07 §2-3, §6).

One scrolling page: the portfolio table, then the selected investment (`InvestmentDetail`).
Commands on the selected investment live in `events` and `trades`.
"""

from datetime import date
from typing import Any
from uuid import UUID

from PySide6.QtWidgets import QLineEdit, QStackedWidget, QVBoxLayout

from opesvault.domain.ledger import DomainError
from opesvault.investments import service as inv
from opesvault.investments.model import ASSET_CLASS_LABELS, NATURE_LABELS, TrackingMode
from opesvault.investments.performance import realized, unrealized, value_at
from opesvault.ui.common import (
    date_edit,
    fit_to_rows,
    fmt,
    fmt_date,
    money_edit,
    run_guarded,
    select_id,
    selected_id,
    set_rows,
    stretch_column,
    summary_table,
)
from opesvault.ui.components import EmptyState, button, menu_button, scroll_body, separator, text
from opesvault.ui.pages.base import Page
from opesvault.ui.pages.investments.detail import InvestmentDetail
from opesvault.ui.pages.investments.events import EventCommands
from opesvault.ui.pages.investments.forms import Field, Form, cash_accounts, combo
from opesvault.ui.pages.investments.trades import TradeCommands
from opesvault.ui.theme import SPACE_S, SPACE_XL

COLUMNS = (
    "Investimento",
    "Classe",
    "Modo",
    "Custo remanescente",
    "Último valor",
    "Data-base",
    "Não realizado",
    "Realizado",
)


class InvestmentsPage(EventCommands, TradeCommands, Page):
    title = "Investimentos"
    section = "Acompanhamento"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.positions = summary_table(list(COLUMNS), max_rows=6)
        stretch_column(self.positions)
        self.positions.itemSelectionChanged.connect(self._show_detail)
        self.positions.setAccessibleName("Investimentos")
        new = button("Novo investimento…", self.new_position, role="primary")
        record = menu_button(
            "Registrar",
            [
                ("Avaliação…", self.new_valuation),
                None,
                ("Aporte…", self.contribution),
                ("Provento…", self.distribution),
                ("Resgate…", self.redemption),
                ("Simular resgate (não grava)…", self.simulate),
                ("Resgate só com o líquido…", self.net_only),
                ("Completar resgate…", self.complete),
                None,
                ("Pagamento de imposto…", self.pay_tax),
            ],
            tip="Eventos do investimento selecionado",
        )
        trade = menu_button(
            "Negociação",
            [
                ("Compra…", self.buy),
                ("Venda…", self.sell),
                ("Posição inicial…", self.opening),
                None,
                ("Desdobramento ou grupamento…", self.split),
                ("Bonificação…", self.bonus),
            ],
            tip="Ativos acompanhados por quantidade",
        )
        more = menu_button(
            "Mais",
            [
                ("Características (tipo, emissor, taxa, vencimento, tributação)…", self.edit_profile),
                None,
                ("Composição da carteira (Relatórios)", lambda: self.navigate("reports", "composition")),
                None,
                ("Regra de imposto…", self.new_rule),
                None,
                ("Importar índice de referência…", self.import_benchmark),
            ],
        )
        self.header.add(record, trade, more, SPACE_S, new)
        self.position_actions = (record, trade)
        self.detail = InvestmentDetail(self.use_valuation, self.fix_valuation)
        self.empty = EmptyState(
            "Nenhum investimento",
            "Cadastre um investimento para acompanhar avaliações, aportes, resgates e rentabilidade.",
            [button("Novo investimento…", self.new_position)],
        )
        # One scrolling page: the portfolio, then the selected investment's sections.
        scroll, content = scroll_body()
        content.setSpacing(SPACE_XL)
        holdings = QVBoxLayout()
        holdings.setSpacing(SPACE_S)
        holdings.addWidget(self.positions)
        # The table speaks the language of the calculation; one line says what each figure means.
        holdings.addWidget(
            text(
                "Custo remanescente: o que você aplicou e ainda não resgatou. Não realizado: último valor menos esse "
                "custo, ganho ou perda que ainda não saiu do investimento. Realizado: o resultado do que já foi "
                "resgatado ou vendido. “Indisponível” e “sem avaliação” indicam falta de dado, nunca zero.",
                "caption",
                wrap=True,
            )
        )
        content.addLayout(holdings)
        content.addWidget(separator())
        content.addWidget(self.detail)
        content.addStretch(1)
        self.views = QStackedWidget()
        self.views.addWidget(scroll)
        self.views.addWidget(self.empty)
        layout = self.page_layout()
        layout.addWidget(self.views, 1)

    # ── data ────────────────────────────────────────

    def refresh(self) -> None:
        if self.session is None:
            self.positions.setRowCount(0)
            self._show_detail()
            return
        ledger = self.session.ledger
        today = date.today()
        rows: list[tuple[list[Any], Any]] = []
        for pos in inv.positions(ledger).values():
            asset = inv.assets(ledger)[pos.asset_id]
            observed = value_at(ledger, pos.id, today)
            gain = unrealized(ledger, pos.id, today)
            done = realized(ledger, pos.id)
            rows.append(
                (
                    [
                        asset.name + (" (encerrado)" if pos.closed else ""),
                        ASSET_CLASS_LABELS[asset.asset_class],
                        "Quantidade" if pos.mode is TrackingMode.QUANTITY else "Valor",
                        fmt(inv.remaining_cost(ledger, pos.id)) if pos.cost_known else "desconhecido",
                        fmt(observed.valuation.value) if observed else "sem avaliação",
                        f"{fmt_date(observed.valuation.on)} ({NATURE_LABELS[observed.valuation.nature]})"
                        if observed
                        else "—",
                        fmt(gain.value) if gain.available else "indisponível",
                        fmt(done.value) + (" (incompleto)" if done.quality.value == "incomplete" else ""),
                    ],
                    pos.id,
                )
            )
        set_rows(self.positions, rows)
        fit_to_rows(self.positions)
        self.views.setCurrentIndex(0 if rows else 1)
        open_count = sum(1 for p in inv.positions(ledger).values() if not p.closed)
        total = f" · {len(rows)} no total" if len(rows) != open_count else ""
        self.header.set_subtitle(f"{open_count} em carteira{total}")
        if rows and selected_id(self.positions) is None:
            self.positions.selectRow(0)  # the detail area is never blank when there is something to show
        self._show_detail()

    def _position_id(self) -> UUID | None:
        return selected_id(self.positions)

    def _show_detail(self) -> None:
        pos_id = self._position_id()
        for action in self.position_actions:
            action.setEnabled(pos_id is not None)
        ledger = self.session.ledger if self.session is not None else None
        self.detail.setVisible(ledger is not None and pos_id is not None)
        self.detail.show_position(ledger, pos_id)

    def reveal(self, ref: object, *, act: bool = False) -> None:
        """A maturity alert or calendar event: select the position; ``act`` opens its characteristics."""
        select_id(self.positions, ref)
        self._show_detail()
        if act and self._position_id() == ref:
            self.edit_profile()

    # ── the portfolio ───────────────────────────────

    def new_position(self) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        fields: list[Field] = [
            ("name", "Nome:", QLineEdit()),
            ("class", "Classe:", combo([(label, c) for c, label in ASSET_CLASS_LABELS.items()])),
            (
                "mode",
                "Acompanhamento:",
                combo([("Por valor observado", TrackingMode.VALUE), ("Por quantidade e preço", TrackingMode.QUANTITY)]),
            ),
            ("ticker", "Código (opcional):", QLineEdit()),
            ("holder", "Titular:", combo([(m.name, m.id) for m in ledger.members.values()], empty="(projeto)")),
            ("on", "Data inicial:", date_edit()),
            ("cost", "Capital/custo inicial:", money_edit("vazio se desconhecido")),
            ("from", "Dinheiro saiu de:", combo(cash_accounts(ledger), empty="(investimento já existente)")),
            ("reference", "Valor de referência:", money_edit("se o custo é desconhecido")),
        ]

        def check(form: Form) -> None:
            if not form.value("name"):
                raise DomainError("Informe o nome.")
            if form.money("cost", optional=True) is None and form.money("reference", optional=True) is None:
                raise DomainError("Informe o custo inicial ou um valor de referência.")

        created: list[UUID] = []

        def apply(form: Form) -> None:
            position = inv.create_position(
                ledger,
                form.value("name"),
                form.value("class"),
                form.date("on"),
                holder_id=form.value("holder"),
                mode=form.value("mode"),
                ticker=form.value("ticker") or None,
                initial_cost=form.money("cost", optional=True),
                from_account=form.value("from"),
                reference_value=form.money("reference", optional=True),
            )
            created.append(position.id)

        if self._run_form(Form(self, "Novo investimento", fields, check), apply) and created:
            select_id(self.positions, created[0])
            self.notify("Investimento criado. Descreva tipo, taxa e vencimento em Mais › Características.")

    def edit_profile(self) -> None:
        from opesvault.ui.bank_dialogs import InvestmentDialog

        pos_id = self._position_id()
        if self.session is None or pos_id is None:
            self.notify("Escolha um investimento.")
            return
        dialog = InvestmentDialog(self, self.session.ledger, position_id=pos_id)
        if dialog.exec() and run_guarded(self, lambda: dialog.apply() or True):
            self.notify("Características salvas.")
            self.changed()

    def import_benchmark(self) -> None:
        if self.session is None:
            return
        from pathlib import Path

        from PySide6.QtWidgets import QFileDialog, QInputDialog

        from opesvault.investments.benchmarks import import_benchmark_csv

        path, _ = QFileDialog.getOpenFileName(self, "Série do índice (data;valor)", "", "CSV (*.csv *.txt)")
        if not path:
            return
        name, ok = QInputDialog.getText(self, "Índice", "Nome do índice:")
        if not ok or not name.strip():
            return
        ledger = self.session.ledger
        try:
            data = Path(path).read_bytes()
        except OSError:
            self.notify("Não foi possível ler o arquivo do índice.")
            return
        if run_guarded(self, lambda: import_benchmark_csv(ledger, name.strip(), data, f"arquivo {Path(path).name}")):
            self.changed()
