"""Refinements from the screen review: elided names, wrapping headers, column widths, charts."""

from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from PySide6.QtWidgets import QApplication, QPushButton

from opesvault.charts.data import Chart, Point, Series, loan_chart
from opesvault.charts.render import ChartWidget, layout
from opesvault.domain import loans
from opesvault.session import Session
from opesvault.ui import theme
from opesvault.ui.common import make_table, select_id, selected_id, set_rows
from opesvault.ui.components import ElidedLabel, PageHeader
from opesvault.ui.main_window import MainWindow

from .domain_fixtures import family


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    app = instance if isinstance(instance, QApplication) else QApplication([])
    theme.apply_theme(app, dark=False)
    return app


def test_elided_label_keeps_the_whole_text(app: QApplication) -> None:
    name = "fatura-do-cartao-de-credito-com-um-nome-de-arquivo-muito-longo.pdf"
    label = ElidedLabel(name, "headline")
    label.resize(120, 30)
    label.show()
    QApplication.processEvents()
    assert label.text() == name  # callers read the whole text
    assert label.toolTip() == name  # the cut text shows whole on hover
    assert label.accessibleDescription() == name
    assert label.minimumSizeHint().width() < 120  # a long name never widens the window
    label.resize(2000, 30)
    QApplication.processEvents()
    assert label.toolTip() == ""  # nothing cut, nothing to explain
    label.setToolTip("C:/cofres/projeto.opesvault")
    label.resize(60, 30)
    QApplication.processEvents()
    assert label.toolTip() == "C:/cofres/projeto.opesvault"  # the caller's tooltip wins
    label.clear()
    assert label.text() == ""


def test_page_header_actions_wrap_instead_of_widening(app: QApplication) -> None:
    header = PageHeader("Imposto de renda", "Declaração de 2027")
    buttons = [QPushButton(f"Ação número {n}") for n in range(6)]
    header.add(*buttons[:3], 24, *buttons[3:])
    widest = max(b.sizeHint().width() for b in buttons)
    assert header.minimumSizeHint().width() <= max(widest, header.title.sizeHint().width()) + 4
    header.resize(1800, 200)
    header.show()
    QApplication.processEvents()
    assert len({b.y() for b in buttons}) == 1  # wide: one line beside the title
    assert buttons[0].mapTo(header, buttons[0].rect().topLeft()).x() >= header.title.width()
    header.resize(300, 400)
    QApplication.processEvents()
    assert len({b.y() for b in buttons}) > 1  # narrow: below the title, wrapping
    assert all(b.mapTo(header, b.rect().topLeft()).y() >= header.title.height() for b in buttons)
    buttons[5].hide()  # a hidden action leaves no room behind on the single line
    header.resize(1800, 200)
    QApplication.processEvents()
    assert header._line_width() < sum(b.sizeHint().width() for b in buttons)


def test_sortable_columns_do_not_reserve_the_arrow_everywhere(app: QApplication) -> None:
    headers = ["Vencimento", "Fechamento", "Lançamentos", "Parcelas", "Créditos", "Total", "Pago", "Saldo"]
    table = make_table(headers)
    set_rows(table, [(["10/04/2026", "03/04/2026", *(["R$ 0,00"] * 6)], 1)])
    header = table.horizontalHeader()
    with_arrow = [header.sectionSizeHint(c) for c in range(len(headers))]
    widths = [table.columnWidth(c) for c in range(len(headers) - 1)]  # the last one stretches
    assert all(w < hint for w, hint in zip(widths, with_arrow, strict=False))
    assert all(w >= table.sizeHintForColumn(c) for c, w in enumerate(widths))
    table.sortByColumn(2, header.sortIndicatorOrder())  # the sorted column gets the arrow's room
    assert table.columnWidth(2) >= header.sectionSizeHint(2)


def test_window_fits_900_with_whole_sidebar_names(app: QApplication, tmp_path: Path) -> None:
    window = MainWindow()
    session = Session.new(tmp_path / "x.opesvault", "Um projeto com um nome realmente bem comprido para a barra")
    session.ledger = family().ledger
    window.session = session
    window._refresh()
    window.resize(900, 640)
    window.show()
    QApplication.processEvents()
    assert window.minimumSizeHint().width() <= 900  # the long project name gives way
    metrics = window.nav.fontMetrics()
    longest = max(metrics.horizontalAdvance(page.title) for page in window.pages)
    assert window.sidebar.minimumWidth() > longest


def _plain(points: list[tuple[date, str]]) -> list[Point]:
    return [Point(on, Decimal(value)) for on, value in points]


def test_second_scale_keeps_a_small_series_readable(app: QApplication) -> None:
    days = [date(2026, m, 1) for m in range(1, 7)]
    chart = Chart(
        "Teste",
        "BRL",
        [
            Series("Grande", _plain([(d, str(40000 - 5000 * i)) for i, d in enumerate(days)]), style="line"),
            Series("Pequena", _plain([(d, str(500 + 10 * i)) for i, d in enumerate(days)]), style="line", axis="right"),
        ],
    )
    widget = ChartWidget()
    widget.resize(800, 320)
    widget.show_chart(chart)
    assert len(widget.figure.axes) == 2
    left, right = widget.figure.axes
    assert left.get_ylim()[1] > 30000 and right.get_ylim()[1] < 1000
    # the tooltip lands on the point drawn against the right scale
    artist, points, _name = widget._hover[1]
    x, y = artist.get_xydata()[0]
    top = widget.figure.axes[-1]
    display = right.transData.transform((x, y))
    assert top.transData.transform(widget._to_top(artist, (x, y))) == pytest.approx(display)
    assert widget.highlight(points[0].x) is not None


def test_one_sided_axis_does_not_add_a_second_scale(app: QApplication) -> None:
    chart = Chart("Só direita", "BRL", [Series("A", _plain([(date(2026, 1, 1), "1")]), style="line", axis="right")])
    widget = ChartWidget()
    widget.show_chart(chart)
    assert len(widget.figure.axes) == 1


def test_legend_moves_below_a_title_it_would_cover(app: QApplication) -> None:
    days = [date(2026, m, 1) for m in range(1, 4)]
    series = [
        Series(name, _plain([(d, "1") for d in days]), style="line") for name in ("Primeira", "Segunda", "Terceira")
    ]
    chart = Chart("Um título comprido o bastante para disputar a linha", "BRL", series, ["Uma nota " * 12])
    widget = ChartWidget()
    widget.figure.set_size_inches(14, 3.2)
    widget.show_chart(chart)
    ax = widget.figure.axes[0]
    renderer = widget.figure.canvas.get_renderer()  # type: ignore[attr-defined]
    title = ax._left_title  # type: ignore[attr-defined]
    legend = ax.get_legend()
    assert legend is not None
    assert legend.get_window_extent(renderer).x0 > title.get_window_extent(renderer).x1  # same line
    one_line_note = widget.figure.texts[0].get_text()
    widget.figure.set_size_inches(4.5, 3.2)
    layout(widget.figure)
    legend_box = legend.get_window_extent(renderer)
    title_box = title.get_window_extent(renderer)
    assert legend_box.y1 <= title_box.y0 + 1  # its own line, under the title
    assert "\n" in widget.figure.texts[0].get_text() and "\n" not in one_line_note  # the note wraps
    assert title.get_fontweight() in ("semibold", 600) and title.get_fontsize() == 11  # style kept


def test_loan_installment_parts_use_the_second_scale() -> None:
    from .test_planning import _loan

    f = family()
    plan = loans.create_loan(f.ledger, _loan(f))
    chart = loan_chart(f.ledger, plan.id)
    axes = {s.name: s.axis for s in chart.series}
    assert axes["Saldo devedor"] == "left" and axes["Juros"] == axes["Amortização"] == "right"
    assert any("direita" in note for note in chart.notes)


def test_select_id_finds_the_row_by_its_id(app: QApplication) -> None:
    table = make_table(["Nome", "Valor"])
    set_rows(table, [(["A", "1"], "a"), (["B", "2"], "b"), (["C", "3"], "c")])
    assert select_id(table, "b") and selected_id(table) == "b"
    assert not select_id(table, "z") and selected_id(table) == "b"  # absent: selection untouched
    assert not select_id(table, None)


def test_missing_selection_is_a_notice_not_a_dialog(
    app: QApplication, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from PySide6.QtWidgets import QMessageBox

    from opesvault.ui.pages.investments import InvestmentsPage

    def no_dialog(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("a dialog is only for decisions")

    monkeypatch.setattr(QMessageBox, "information", no_dialog)
    window = MainWindow()
    session = Session.new(tmp_path / "x.opesvault", "Teste")
    session.ledger = family().ledger
    window.session = session
    window._refresh()
    page = next(p for p in window.pages if isinstance(p, InvestmentsPage))
    messages: list[str] = []
    monkeypatch.setattr(page, "notify", messages.append)
    page.new_valuation()  # nothing selected
    assert messages == ["Selecione um investimento."]
