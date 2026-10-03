"""Matplotlib rendering of chart datasets, with tooltips and point inspection (docs/07 §5).

No CDN, fonts or network: Matplotlib draws locally. Exporting an image is an
explicit user action elsewhere.
"""

import warnings
from collections.abc import Callable
from datetime import date
from decimal import Decimal
from typing import Any

import matplotlib

matplotlib.use("QtAgg")

from matplotlib.backends.backend_qt import NavigationToolbar2QT
from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg
from matplotlib.figure import Figure
from matplotlib.ticker import FuncFormatter
from PySide6.QtCore import QSize, Qt
from PySide6.QtWidgets import QVBoxLayout, QWidget

from opesvault.charts.data import Chart, Point
from opesvault.domain.money import format_brl

# Muted, distinguishable hues: charts inform, they do not compete with the figures around them.
TIGHT_RECT = (0, 0.04, 1, 1)  # room for the footer notes
PALETTE = ["#3b6ea8", "#c0605a", "#4f8a5b", "#c49a3e", "#7d6b9e", "#3f8f99"]


def _label(value: Decimal | None, unit: str) -> str:
    if value is None:
        return "sem informação"
    if unit == "%":
        return f"{value * 100:.2f}%".replace(".", ",")
    return format_brl(value)


MONTH_ABBREVIATIONS = ("jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez")


def _month_tick(label: str) -> str:
    """'2026-03' -> 'mar/26' (how months are written in Brazil); other labels unchanged."""
    year, dash, month = label.partition("-")
    if dash and len(year) == 4 and year.isdigit() and month.isdigit() and 1 <= int(month) <= 12:
        return f"{MONTH_ABBREVIATIONS[int(month) - 1]}/{year[2:]}"
    return label


def _use_ui_font() -> None:
    """Charts use the interface font (Segoe UI on Windows), falling back to Matplotlib's own."""
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance()
    family = app.font().family() if isinstance(app, QApplication) else ""
    families = [family, "DejaVu Sans"] if family else ["DejaVu Sans"]
    if matplotlib.rcParams["font.sans-serif"][: len(families)] != families:
        matplotlib.rcParams["font.family"] = "sans-serif"
        matplotlib.rcParams["font.sans-serif"] = families + list(matplotlib.rcParams["font.sans-serif"])


def draw(figure: Figure, chart: Chart) -> list[tuple[Any, list[Point], str]]:
    """Draws `chart` on `figure`; returns (artist, points, series name) for hover lookups."""
    from opesvault.ui.theme import tokens

    t = tokens()
    _use_ui_font()
    figure.clear()
    figure.set_facecolor(t.content)
    ax = figure.add_subplot(111)
    ax.set_facecolor(t.content)
    ax.set_title(chart.title, loc="left", fontsize=11, fontweight="semibold", color=t.text, pad=12)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(t.separator)
    ax.tick_params(colors=t.secondary, labelsize=9, length=0)
    hover: list[tuple[Any, list[Point], str]] = []
    drawn = [s for s in chart.series if not s.hidden]  # hidden series live only in the table of values
    categorical = any(isinstance(p.x, str) for s in drawn for p in s.points)
    bar_series = [s for s in drawn if s.style in ("bar", "forecast")]
    width = 0.8 / max(len(bar_series), 1)
    labels: list[str] = []
    if categorical:
        for s in drawn:
            for p in s.points:
                if str(p.x) not in labels:
                    labels.append(str(p.x))
    for index, s in enumerate(drawn):
        color = PALETTE[index % len(PALETTE)]
        known = [p for p in s.points if p.y is not None]  # missing data is a gap, never zero
        if not known:
            continue
        ys = [float(p.y) for p in known if p.y is not None]  # presentation only; never fed back
        xs_all: list[Any] = [labels.index(str(p.x)) for p in known] if categorical else [p.x for p in known]
        if s.style in ("bar", "forecast"):
            offset = bar_series.index(s) * width - 0.4 + width / 2
            xs = [x + offset for x in xs_all] if categorical else xs_all
            artist = ax.bar(
                xs,
                ys,
                width=width if categorical else 5,
                label=s.name,
                color=color,
                alpha=0.45 if s.style == "forecast" else 0.9,
                hatch="//" if s.style == "forecast" else None,
            )
        elif s.style == "scatter":
            artist = ax.scatter(xs_all, ys, label=s.name, color=color, marker="v", zorder=3)
        elif s.style == "step":  # a balance holds until the next movement
            (artist,) = ax.step(xs_all, ys, where="post", label=s.name, color=color)
            ax.plot(xs_all, ys, linestyle="none", marker="o", markersize=3, color=color)
        else:
            (artist,) = ax.plot(xs_all, ys, label=s.name, color=color, marker="o" if s.marker_points else None)
        hover.append((artist, known, s.name))
    if categorical:
        ax.set_xticks(range(len(labels)))
        ax.set_xticklabels([_month_tick(label) for label in labels], rotation=45, ha="right")
    else:
        from matplotlib.dates import DateFormatter

        ax.xaxis.set_major_formatter(DateFormatter("%d/%m/%y"))
        figure.autofmt_xdate()
    unit = chart.unit
    ax.yaxis.set_major_formatter(
        FuncFormatter(lambda v, _pos: f"{v * 100:.0f}%" if unit == "%" else format_brl(Decimal(str(round(v, 2)))))
    )
    ax.grid(axis="y", color=t.separator, linewidth=0.8)
    ax.set_axisbelow(True)
    if len(hover) > 1:
        legend = ax.legend(loc="best", fontsize=9, frameon=False)
        for item in legend.get_texts():
            item.set_color(t.text)
    footer = " · ".join(chart.notes)
    if footer:
        figure.text(0.01, 0.01, footer, fontsize=8, color=t.secondary)
    figure.tight_layout(rect=TIGHT_RECT)
    return hover


class ChartWidget(QWidget):
    """Interactive chart: zoom/reset via toolbar, hover tooltip, click to inspect the underlying point."""

    def __init__(self, on_inspect: Callable[[str, Point], None] | None = None) -> None:
        super().__init__()
        self.figure = Figure(figsize=(8, 4.5))
        self.canvas = FigureCanvasQTAgg(self.figure)
        self.toolbar = NavigationToolbar2QT(self.canvas, self)
        # Keep navigation (reset, pan, zoom); configuration dialogs are noise here and
        # saving goes through the page's own export command.
        for action in self.toolbar.actions():
            if action.text() in ("Subplots", "Customize", "Save", "Back", "Forward"):
                self.toolbar.removeAction(action)
        self.toolbar.setIconSize(QSize(16, 16))
        self.toolbar.setToolTip("Início: desfaz o zoom · Mover · Zoom por retângulo")
        self.chart: Chart | None = None
        self._hover: list[tuple[Any, list[Point], str]] = []
        self._annotation = None
        self._on_inspect = on_inspect
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addWidget(self.toolbar, alignment=Qt.AlignmentFlag.AlignRight)
        layout.addWidget(self.canvas)
        self.canvas.mpl_connect("motion_notify_event", self._on_move)
        self.canvas.mpl_connect("button_press_event", self._on_click)
        self.canvas.mpl_connect("resize_event", self._on_resize)

    def _on_resize(self, _event) -> None:  # type: ignore[no-untyped-def]
        """Margins follow the new size: axis labels drawn for another size would be cut off."""
        if self.chart is None:
            return
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")  # a size too small for the labels: keep the last layout
            self.figure.tight_layout(rect=TIGHT_RECT)

    def show_chart(self, chart: Chart) -> None:
        self.chart = chart
        self._hover = draw(self.figure, chart)
        ax = self.figure.axes[0]
        self._annotation = ax.annotate(
            "",
            xy=(0, 0),
            xytext=(12, 12),
            textcoords="offset points",
            bbox={"boxstyle": "round", "fc": _tokens().raised, "ec": _tokens().separator, "alpha": 0.97},
            color=_tokens().text,
            fontsize=8,
        )
        self._annotation.set_visible(False)
        self.canvas.draw_idle()

    def _find(self, event) -> tuple[str, Point, tuple[float, float]] | None:  # type: ignore[no-untyped-def]
        for artist, points, name in self._hover:
            if hasattr(artist, "patches"):  # bar container
                for patch, point in zip(artist.patches, points, strict=False):
                    if patch.contains(event)[0]:
                        return name, point, (patch.get_x() + patch.get_width() / 2, patch.get_height())
            else:
                hit, details = artist.contains(event)
                if hit and details.get("ind") is not None and len(details["ind"]):
                    index = int(details["ind"][0])
                    point = points[index]
                    if hasattr(artist, "get_xydata"):
                        x, y = artist.get_xydata()[index]
                    else:
                        x, y = artist.get_offsets()[index]
                    return name, point, (x, y)
        return None

    def tooltip_text(self, name: str, point: Point) -> str:
        assert self.chart is not None
        when = point.x.strftime("%d/%m/%Y") if isinstance(point.x, date) else _month_tick(str(point.x))
        lines = [name, when, _label(point.y, self.chart.unit) + (" (BRL)" if self.chart.unit == "BRL" else "")]
        if self.chart.regime:
            lines.append(f"regime: {self.chart.regime}")
        lines += [f"{k}: {v}" for k, v in point.info.items() if not k.startswith("_")]  # "_": internal keys
        return "\n".join(lines)

    def _on_move(self, event) -> None:  # type: ignore[no-untyped-def]
        if self._annotation is None or event.inaxes is None:
            return
        found = self._find(event)
        if found is None:
            if self._annotation.get_visible():
                self._annotation.set_visible(False)
                self.canvas.draw_idle()
            return
        name, point, xy = found
        self._annotation.xy = xy
        self._annotation.set_text(self.tooltip_text(name, point))
        self._annotation.set_visible(True)
        self.canvas.draw_idle()

    def _on_click(self, event) -> None:  # type: ignore[no-untyped-def]
        if event.inaxes is None or self._on_inspect is None:
            return
        found = self._find(event)
        if found is not None:
            self._on_inspect(found[0], found[1])

    def clear(self) -> None:
        self.chart = None
        self._hover = []
        self._annotation = None
        self.figure.clear()
        self.canvas.draw_idle()

    def highlight(self, x: object) -> Point | None:
        """Points at `x` on the first drawn series that has it (a row chosen in the table)."""
        if self._annotation is None or self.chart is None:
            return None
        for artist, points, name in self._hover:
            for index, point in enumerate(points):
                if point.x != x:
                    continue
                if hasattr(artist, "patches"):
                    patch = artist.patches[index]
                    xy = (patch.get_x() + patch.get_width() / 2, patch.get_height())
                elif hasattr(artist, "get_xydata"):
                    xy = tuple(artist.get_xydata()[index])
                else:
                    xy = tuple(artist.get_offsets()[index])
                self._annotation.xy = xy
                self._annotation.set_text(self.tooltip_text(name, point))
                self._annotation.set_visible(True)
                self.canvas.draw_idle()
                return point
        return None

    def export_png(self, path: str) -> None:
        self.figure.savefig(path, dpi=150)


def _tokens():  # type: ignore[no-untyped-def]
    from opesvault.ui.theme import tokens

    return tokens()
