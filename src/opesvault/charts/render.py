"""Matplotlib rendering of chart datasets, with tooltips and point inspection (docs/07 §5).

No CDN, fonts or network: Matplotlib draws locally. Exporting an image is an
explicit user action elsewhere.
"""

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
from PySide6.QtWidgets import QVBoxLayout, QWidget

from opesvault.charts.data import Chart, Point
from opesvault.domain.money import format_brl

PALETTE = ["#2f6db3", "#d1495b", "#2e933c", "#edae49", "#7b4b94", "#00798c"]


def _label(value: Decimal | None, unit: str) -> str:
    if value is None:
        return "sem informação"
    if unit == "%":
        return f"{value * 100:.2f}%".replace(".", ",")
    return format_brl(value)


def draw(figure: Figure, chart: Chart) -> list[tuple[Any, list[Point], str]]:
    """Draws `chart` on `figure`; returns (artist, points, series name) for hover lookups."""
    figure.clear()
    ax = figure.add_subplot(111)
    ax.set_title(chart.title)
    hover: list[tuple[Any, list[Point], str]] = []
    categorical = any(isinstance(p.x, str) for s in chart.series for p in s.points)
    bar_series = [s for s in chart.series if s.style in ("bar", "forecast")]
    width = 0.8 / max(len(bar_series), 1)
    labels: list[str] = []
    if categorical:
        for s in chart.series:
            for p in s.points:
                if str(p.x) not in labels:
                    labels.append(str(p.x))
    for index, s in enumerate(chart.series):
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
        else:
            (artist,) = ax.plot(xs_all, ys, label=s.name, color=color, marker="o" if s.marker_points else None)
        hover.append((artist, known, s.name))
    if categorical:
        ax.set_xticks(range(len(labels)))
        ax.set_xticklabels(labels, rotation=45, ha="right")
    else:
        figure.autofmt_xdate()
    unit = chart.unit
    ax.yaxis.set_major_formatter(
        FuncFormatter(lambda v, _pos: f"{v * 100:.0f}%" if unit == "%" else format_brl(Decimal(str(round(v, 2)))))
    )
    ax.grid(axis="y", alpha=0.3)
    if len(chart.series) > 1:
        ax.legend(loc="best", fontsize="small")
    footer = " · ".join(chart.notes)
    if footer:
        figure.text(0.01, 0.01, footer, fontsize=7, alpha=0.8)
    figure.tight_layout(rect=(0, 0.04, 1, 1))
    return hover


class ChartWidget(QWidget):
    """Interactive chart: zoom/reset via toolbar, hover tooltip, click to inspect the underlying point."""

    def __init__(self, on_inspect: Callable[[str, Point], None] | None = None) -> None:
        super().__init__()
        self.figure = Figure(figsize=(8, 4.5))
        self.canvas = FigureCanvasQTAgg(self.figure)
        self.toolbar = NavigationToolbar2QT(self.canvas, self)
        self.chart: Chart | None = None
        self._hover: list[tuple[Any, list[Point], str]] = []
        self._annotation = None
        self._on_inspect = on_inspect
        layout = QVBoxLayout(self)
        layout.addWidget(self.toolbar)
        layout.addWidget(self.canvas)
        self.canvas.mpl_connect("motion_notify_event", self._on_move)
        self.canvas.mpl_connect("button_press_event", self._on_click)

    def show_chart(self, chart: Chart) -> None:
        self.chart = chart
        self._hover = draw(self.figure, chart)
        ax = self.figure.axes[0]
        self._annotation = ax.annotate(
            "",
            xy=(0, 0),
            xytext=(12, 12),
            textcoords="offset points",
            bbox={"boxstyle": "round", "fc": "white", "alpha": 0.95},
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
        when = point.x.strftime("%d/%m/%Y") if isinstance(point.x, date) else str(point.x)
        lines = [name, when, _label(point.y, self.chart.unit) + (" (BRL)" if self.chart.unit == "BRL" else "")]
        if self.chart.regime:
            lines.append(f"regime: {self.chart.regime}")
        lines += [f"{k}: {v}" for k, v in point.info.items()]
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

    def export_png(self, path: str) -> None:
        self.figure.savefig(path, dpi=150)
