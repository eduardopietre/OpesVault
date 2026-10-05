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
  MoneyField,
  notify,
  NumberTicker,
  PreferencesProvider,
  presetFor,
  memoryPreferences,
  Select,
  StatusPill,
  Toaster,
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
