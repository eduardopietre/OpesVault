import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MotionConfig } from "motion/react";
import { describe, expect, it, vi } from "vitest";
import {
  Collapsible,
  confirm,
  DataTable,
  decide,
  DecisionHost,
  Dialog,
  MenuButton,
  MoneyField,
  notify,
  NumberTicker,
  PreferencesProvider,
  presetFor,
  memoryPreferences,
  Select,
  StatusPill,
  Tabs,
  Toaster,
  TOAST_HISTORY_SIZE,
  clearToasts,
  toastHistory,
  type DataColumn,
} from "../src/index.ts";

describe("decide and confirm", () => {
  it("resolves with the chosen action and null for Cancel", async () => {
    const user = userEvent.setup();
    render(<DecisionHost />);
    let answer: Promise<boolean> = Promise.resolve(false);
    act(() => {
      answer = confirm({
        title: "Excluir o lançamento?",
        text: "Ele vai para o histórico.",
        confirmLabel: "Excluir",
        danger: true,
      });
    });
    const dialog = await screen.findByRole("alertdialog", { name: "Excluir o lançamento?" });
    // A destructive decision starts on Cancel.
    expect(document.activeElement?.textContent).toBe("Cancelar");
    await user.click(within(dialog).getByRole("button", { name: "Excluir" }));
    await expect(answer).resolves.toBe(true);

    let second: Promise<string | null> = Promise.resolve("x");
    act(() => {
      second = decide({
        title: "Salvar alterações antes de sair?",
        choices: [
          { id: "discard", label: "Descartar alterações", variant: "danger" },
          { id: "save", label: "Salvar", variant: "primary" },
        ],
      });
    });
    await screen.findByRole("alertdialog", { name: "Salvar alterações antes de sair?" });
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    await expect(second).resolves.toBeNull();
  });

  it("Escape cancels a decision", async () => {
    render(<DecisionHost />);
    let answer: Promise<string | null> = Promise.resolve("x");
    act(() => {
      answer = decide({ title: "Continuar?", choices: [{ id: "go", label: "Continuar" }] });
    });
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await expect(answer).resolves.toBeNull();
  });
});

describe("Dialog", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Abrir</button>
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title="Nova conta"
          footer={<button onClick={() => setOpen(false)}>Salvar</button>}
        >
          <input aria-label="Nome" />
        </Dialog>
      </>
    );
  }

  it("opens with focus inside, closes on Escape and gives focus back", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Abrir" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Nova conta" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
});

describe("notify", () => {
  it("announces in a polite live region and disappears by itself", async () => {
    vi.useFakeTimers();
    try {
      render(<Toaster />);
      act(() => {
        notify("Lançamento corrigido.");
      });
      const region = screen.getByRole("status");
      expect(region.getAttribute("aria-live")).toBe("polite");
      expect(region.textContent).toContain("Lançamento corrigido.");
      await act(async () => {
        vi.advanceTimersByTime(6000);
      });
      await act(async () => {
        vi.runAllTimers();
      });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(screen.getByRole("status").textContent).not.toContain("Lançamento corrigido."));
  });

  it("runs its action once", async () => {
    const user = userEvent.setup();
    const undo = vi.fn();
    render(<Toaster />);
    act(() => {
      notify("Lançamento excluído.", { action: { label: "Desfazer", run: undo } });
    });
    await user.click(screen.getByRole("button", { name: "Desfazer" }));
    expect(undo).toHaveBeenCalledTimes(1);
  });
});

describe("toast history", () => {
  it("keeps the latest toasts of the tab, newest first, without their action, and forgets them on clear", () => {
    act(() => {
      notify("Primeiro.");
      notify("Segundo.", { tone: "positive", action: { label: "Desfazer", run: () => undefined } });
    });
    expect(toastHistory().map((item) => [item.message, item.tone])).toEqual([
      ["Segundo.", "positive"],
      ["Primeiro.", "info"],
    ]);
    expect(toastHistory()[0]).not.toHaveProperty("action");
    act(() => {
      for (let i = 0; i < TOAST_HISTORY_SIZE + 5; i++) notify(`Aviso ${i}`);
    });
    expect(toastHistory()).toHaveLength(TOAST_HISTORY_SIZE);
    expect(toastHistory()[0]?.message).toBe(`Aviso ${TOAST_HISTORY_SIZE + 4}`);
    act(() => clearToasts());
    expect(toastHistory()).toEqual([]);
  });
});

describe("Tabs", () => {
  const TABS = ["Contas bancárias", "Todas as contas", "Cartões", "Faturas"].map((label) => ({
    id: label,
    label,
    content: <p>{`Conteúdo de ${label}`}</p>,
  }));

  function Harness() {
    const [value, setValue] = useState("Contas bancárias");
    return <Tabs tabs={TABS} value={value} onValueChange={setValue} label="Cadastros" />;
  }

  it("shows an arrow on each side with more tabs, out of the Tab order, that scrolls the row", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const list = screen.getByRole("tablist", { name: "Cadastros" });
    // all tabs fit: no arrows
    expect(screen.queryByRole("button", { name: "Mais abas" })).toBeNull();
    // a narrow row: 300 px showing of 900
    let left = 0;
    Object.defineProperty(list, "clientWidth", { configurable: true, get: () => 300 });
    Object.defineProperty(list, "scrollWidth", { configurable: true, get: () => 900 });
    Object.defineProperty(list, "scrollLeft", {
      configurable: true,
      get: () => left,
      set: (value: number) => (left = value),
    });
    const scrollBy = vi.fn((options: ScrollToOptions) => {
      left += options.left ?? 0;
      fireEvent.scroll(list);
    });
    list.scrollBy = scrollBy as unknown as typeof list.scrollBy;
    fireEvent.scroll(list);
    const more = await screen.findByRole("button", { name: "Mais abas" });
    expect(more.tabIndex).toBe(-1);
    expect(screen.queryByRole("button", { name: "Abas anteriores" })).toBeNull();
    await user.click(more);
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: 210 }));
    expect(await screen.findByRole("button", { name: "Abas anteriores" })).toBeTruthy();
    // the keyboard still goes from tab to tab
    act(() => screen.getByRole("tab", { name: "Contas bancárias" }).focus());
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement?.textContent).toBe("Todas as contas");
  });
});

describe("MenuButton", () => {
  it("keeps a disabled item with a reason reachable: dimmed, described, and choosing it does nothing", async () => {
    const user = userEvent.setup();
    const edit = vi.fn();
    const add = vi.fn();
    render(
      <MenuButton
        label="Mais"
        items={[
          { id: "add", label: "Nova meta…", onSelect: add },
          { id: "edit", label: "Editar meta…", onSelect: edit, disabled: true, reason: "Selecione uma meta na lista." },
          { id: "off", label: "Arquivar…", onSelect: edit, disabled: true },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Mais" }));
    const item = await screen.findByRole("menuitem", { name: "Editar meta…" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("aria-description")).toBe("Selecione uma meta na lista.");
    expect(item.getAttribute("title")).toBe("Selecione uma meta na lista.");
    expect(item.hasAttribute("data-disabled")).toBe(false);
    // the arrow keys reach it (a plain disabled item is skipped)
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(item);
    expect(screen.getByRole("menuitem", { name: "Arquivar…" }).hasAttribute("data-disabled")).toBe(true);
    // choosing it (a tap on a phone, with no tooltip) tells why, and runs nothing
    await user.keyboard("{Enter}");
    expect(edit).not.toHaveBeenCalled();
    expect(toastHistory()[0]?.message).toBe("Selecione uma meta na lista.");
  });
});

describe("MoneyField", () => {
  function Harness({ onValue }: { onValue: (value: string | null) => void }) {
    const [text, setText] = useState("");
    return <MoneyField label="Valor" value={text} onChange={setText} onValueChange={onValue} />;
  }

  it("keeps the text as typed and gives the canonical decimal", async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    const input = screen.getByRole("textbox", { name: "Valor" });
    await user.type(input, "1.234,56");
    expect((input as HTMLInputElement).value).toBe("1.234,56");
    expect(onValue).toHaveBeenLastCalledWith("1234.56");
    expect(input.getAttribute("inputmode")).toBe("decimal");
  });

  it("explains a format error after leaving the field, in text", async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    const input = screen.getByRole("textbox", { name: "Valor" });
    await user.type(input, "12,345");
    expect(screen.queryByRole("alert")).toBeNull();
    await user.tab();
    expect(screen.getByRole("alert").textContent).toContain("Valor inválido");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(onValue).toHaveBeenLastCalledWith(null);
  });
});

interface Entry {
  id: string;
  description: string;
  amount: string;
}

const columns: DataColumn<Entry>[] = [
  {
    id: "description",
    header: "Descrição",
    cell: (row) => row.description,
    sortValue: (row) => row.description,
    grow: 2,
  },
  {
    id: "amount",
    header: "Valor",
    cell: (row) => row.amount,
    align: "end",
    sortValue: (row) => BigInt(row.amount.replace(".", "")),
  },
];

const make = () => [
  { id: "a1", description: "Mercado", amount: "120.00" },
  { id: "b2", description: "Aluguel", amount: "2500.00" },
  { id: "c3", description: "Farmácia", amount: "35.90" },
];

describe("DataTable", () => {
  function Harness({ onActivate }: { onActivate?: (id: string) => void }) {
    const [rows, setRows] = useState(make);
    const [selected, setSelected] = useState<string | null>(null);
    return (
      <>
        <button onClick={() => setRows(make())}>Recarregar</button>
        <span data-testid="selected">{selected ?? ""}</span>
        <DataTable
          label="Lançamentos"
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          selectedId={selected}
          onSelect={setSelected}
          {...(onActivate ? { onActivate } : {})}
          layout="table"
        />
      </>
    );
  }

  it("selects by id, keeps the selection when rows are read again, and moves with the keyboard", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(<Harness onActivate={onActivate} />);
    const grid = screen.getByRole("grid", { name: "Lançamentos" });
    await user.click(screen.getByText("Aluguel"));
    expect(screen.getByTestId("selected").textContent).toBe("b2");
    // New objects with the same ids (a project read back): still selected.
    await user.click(screen.getByRole("button", { name: "Recarregar" }));
    const selectedRow = grid.querySelector('[aria-selected="true"]');
    expect(selectedRow?.getAttribute("data-row-id")).toBe("b2");
    expect(grid.getAttribute("aria-activedescendant")).toBe(selectedRow?.id);

    grid.focus();
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(screen.getByTestId("selected").textContent).toBe("c3");
    fireEvent.keyDown(grid, { key: "Home" });
    expect(screen.getByTestId("selected").textContent).toBe("a1");
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledWith("a1");
  });

  it("sorts by the exact value and announces the order", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const header = screen.getAllByRole("columnheader")[1]!;
    expect(header.getAttribute("aria-sort")).toBeNull();
    await user.click(within(header).getByRole("button"));
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    const order = [...screen.getByRole("grid").querySelectorAll("[data-row-id]")]
      .sort((a, b) => Number(a.getAttribute("data-index")) - Number(b.getAttribute("data-index")))
      .map((row) => row.getAttribute("data-row-id"));
    expect(order).toEqual(["c3", "a1", "b2"]);
  });

  it("becomes a card list", () => {
    render(<DataTable label="Lançamentos" rows={make()} columns={columns} getRowId={(row) => row.id} layout="cards" />);
    expect(screen.getByRole("listbox", { name: "Lançamentos" })).toBeTruthy();
    expect(screen.getAllByRole("option").length).toBe(3);
  });
});

describe("DataTable row context menu", () => {
  type Row = ReturnType<typeof make>[number];
  function Harness({
    onEdit,
    onRemove,
    onMove,
  }: {
    onEdit: (id: string) => void;
    onRemove: (id: string) => void;
    onMove: (id: string, to: string) => void;
  }) {
    const [selected, setSelected] = useState<string | null>(null);
    const menu = (row: Row) => [
      { id: "edit", label: "Editar…", onSelect: () => onEdit(row.id) },
      {
        kind: "submenu" as const,
        id: "move",
        label: "Mover para",
        items: [
          { id: "a", label: "Conta A", onSelect: () => onMove(row.id, "A") },
          { id: "b", label: "Conta B", onSelect: () => onMove(row.id, "B") },
        ],
      },
      { kind: "separator" as const, id: "s" },
      { id: "remove", label: "Excluir…", danger: true, onSelect: () => onRemove(row.id) },
    ];
    return (
      <>
        <span data-testid="selected">{selected ?? ""}</span>
        <DataTable
          label="Lançamentos"
          rows={make()}
          columns={columns}
          getRowId={(row) => row.id}
          selectedId={selected}
          onSelect={setSelected}
          rowMenu={menu}
          layout="table"
        />
      </>
    );
  }

  it("opens on a right click, selects the row, runs a command and gives the focus back to the table", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<Harness onEdit={onEdit} onRemove={vi.fn()} onMove={vi.fn()} />);
    const grid = screen.getByRole("grid", { name: "Lançamentos" });
    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("Aluguel") });
    const menu = await screen.findByRole("menu", { name: "Ações de Aluguel" });
    expect(screen.getByTestId("selected").textContent).toBe("b2");
    // the destructive command is there, apart, in red
    const remove = within(menu).getByRole("menuitem", { name: "Excluir…" });
    expect(remove.className).toContain("text-negative");
    // never the normal text color as well, which would win in the generated CSS
    expect(remove.className.split(" ")).not.toContain("text-text");
    await user.click(within(menu).getByRole("menuitem", { name: "Editar…" }));
    expect(onEdit).toHaveBeenCalledWith("b2");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(grid);
  });

  it("opens a cascade of options and runs the one chosen inside it", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    render(<Harness onEdit={vi.fn()} onRemove={vi.fn()} onMove={onMove} />);
    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("Farmácia") });
    const menu = await screen.findByRole("menu", { name: "Ações de Farmácia" });
    expect(within(menu).getByRole("menuitem", { name: "Mover para" }).getAttribute("aria-haspopup")).toBe("menu");
    // by the keyboard: down to the cascade, right into it, down to the second option
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowRight}");
    expect(await screen.findByRole("menuitem", { name: "Conta A" })).toBeTruthy();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onMove).toHaveBeenCalledWith("c3", "B");
  });

  it("opens from the keyboard on the selected row (Shift+F10) and closes with Escape", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<Harness onEdit={vi.fn()} onRemove={onRemove} onMove={vi.fn()} />);
    const grid = screen.getByRole("grid", { name: "Lançamentos" });
    grid.focus();
    await user.keyboard("{ArrowDown}{Shift>}{F10}{/Shift}");
    expect(await screen.findByRole("menu", { name: "Ações de Mercado" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("opens on a long press with a finger, and the click of lifting it is not a tap", async () => {
    const selections: [string, string | undefined][] = [];
    render(
      <DataTable
        label="Lançamentos"
        rows={make()}
        columns={columns}
        getRowId={(row) => row.id}
        onSelect={(id, via) => selections.push([id, via])}
        rowMenu={() => [{ id: "edit", label: "Editar…", onSelect: () => undefined }]}
        layout="cards"
      />,
    );
    const card = screen.getByText("Aluguel");
    fireEvent.pointerDown(card, { pointerType: "touch", clientX: 10, clientY: 10 });
    expect(await screen.findByRole("menu", {}, { timeout: 2000 })).toBeTruthy();
    fireEvent.pointerUp(card, { pointerType: "touch" });
    fireEvent.click(card);
    // selected once, to open the menu, and told so (a page may skip opening a sheet then)
    expect(selections).toEqual([["b2", "menu"]]);
  });

  it("does not open when the finger moves (a scroll)", async () => {
    render(
      <DataTable
        label="Lançamentos"
        rows={make()}
        columns={columns}
        getRowId={(row) => row.id}
        rowMenu={() => [{ id: "edit", label: "Editar…", onSelect: () => undefined }]}
        layout="cards"
      />,
    );
    const card = screen.getByText("Aluguel");
    fireEvent.pointerDown(card, { pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.pointerMove(card, { pointerType: "touch", clientX: 10, clientY: 60 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("leaves the browser's own menu outside the rows", () => {
    render(<Harness onEdit={vi.fn()} onRemove={vi.fn()} onMove={vi.fn()} />);
    const header = screen.getByRole("columnheader", { name: /Descrição/ });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    header.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("Select", () => {
  it("chooses by id, and finds the option for an id read back as a new string", async () => {
    const user = userEvent.setup();
    const options = [
      { id: "acc-1", label: "Conta corrente" },
      { id: "acc-2", label: "Poupança" },
    ];
    function Harness() {
      const [value, setValue] = useState<string | null>(["acc", "2"].join("-"));
      return <Select label="Conta" options={options} value={value} onChange={setValue} />;
    }
    render(<Harness />);
    const trigger = screen.getByRole("combobox", { name: "Conta" });
    expect(trigger.textContent).toContain("Poupança");
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "Conta corrente" }));
    expect(trigger.textContent).toContain("Conta corrente");
  });
});

describe("motion", () => {
  it("reduced motion keeps only fades", () => {
    const preset = presetFor(true);
    for (const key of ["initial", "animate", "exit"] as const) {
      expect(Object.keys(preset.enter[key])).toEqual(["opacity"]);
    }
    expect(Object.keys(presetFor(false).enter.initial)).toContain("y");
    expect(presetFor(true).spring("dialog")).not.toHaveProperty("type", "spring");
  });

  it("NumberTicker shows the exact value at once when motion is reduced", () => {
    render(
      <MotionConfig reducedMotion="always">
        <NumberTicker value="12345.67" />
      </MotionConfig>,
    );
    const visible = document.querySelector('[aria-hidden="true"]');
    expect(visible?.textContent).toBe("12.345,67");
  });
});

describe("state is never color alone", () => {
  it("StatusPill writes the state", () => {
    render(<StatusPill state="offline" />);
    expect(screen.getByRole("status").textContent).toContain("Sem conexão");
  });

  it("Collapsible remembers only the user's click", async () => {
    const user = userEvent.setup();
    const store = memoryPreferences();
    render(
      <PreferencesProvider store={store}>
        <Collapsible title="Mês a mês" prefKey="visao-geral/mes">
          <p>conteúdo</p>
        </Collapsible>
      </PreferencesProvider>,
    );
    const toggle = screen.getByRole("button", { name: "Mês a mês" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(store.get("secoes/visao-geral/mes")).toBe("0");
  });
});
