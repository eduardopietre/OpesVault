import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button, DataTable, matchesSearch, searchWords, type DataColumn } from "../src/index.ts";

interface Row {
  id: string;
  description: string;
  archived: boolean;
}

const rows: Row[] = [
  { id: "a1", description: "Mercado Pão de Açúcar", archived: false },
  { id: "b2", description: "Aluguel", archived: true },
  { id: "c3", description: "Farmácia", archived: false },
  { id: "d4", description: "Padaria", archived: false },
];

const columns: DataColumn<Row>[] = [
  { id: "description", header: "Descrição", cell: (row) => row.description, sortValue: (row) => row.description },
];

const bodyRows = (grid: HTMLElement) => within(grid).getAllByRole("row").slice(1);

describe("searchWords and matchesSearch", () => {
  it("ignore accents and case, and need every word", () => {
    expect(searchWords("  FARMÁCIA  centro ")).toEqual(["farmacia", "centro"]);
    expect(matchesSearch("farmacia do centro", searchWords("Centro farmácia"))).toBe(true);
    expect(matchesSearch("farmacia", searchWords("farmácia centro"))).toBe(false);
  });
});

describe("DataTable search and filters", () => {
  function Searchable() {
    return (
      <DataTable
        label="Despesas"
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        layout="table"
        search={{ text: (row) => row.description }}
        filters={[{ id: "active", label: "Ocultar arquivadas", keep: (row) => !row.archived }]}
      />
    );
  }

  it("finds rows without accents or case, counts them and says when nothing matches", async () => {
    const user = userEvent.setup();
    render(<Searchable />);
    const box = screen.getByRole("searchbox", { name: "Buscar em Despesas" });
    await user.type(box, "acucar");
    expect(bodyRows(screen.getByRole("grid")).map((r) => r.textContent)).toEqual(["Mercado Pão de Açúcar"]);
    expect(screen.getByText("1 de 4")).toBeTruthy();

    await user.clear(box);
    await user.type(box, "nenhuma coisa");
    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.getByText("Nada encontrado")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Limpar busca e filtros" }));
    expect(bodyRows(screen.getByRole("grid")).length).toBe(4);
    expect(screen.queryByText(/de 4/)).toBeNull();
  });

  it("Escape clears the search", async () => {
    const user = userEvent.setup();
    render(<Searchable />);
    const box = screen.getByRole("searchbox", { name: "Buscar em Despesas" });
    await user.type(box, "pad");
    expect(bodyRows(screen.getByRole("grid")).length).toBe(1);
    await user.keyboard("{Escape}");
    expect((box as HTMLInputElement).value).toBe("");
    expect(bodyRows(screen.getByRole("grid")).length).toBe(4);
  });

  it("a toggle filter narrows the rows", async () => {
    const user = userEvent.setup();
    render(<Searchable />);
    await user.click(screen.getByRole("checkbox", { name: "Ocultar arquivadas" }));
    expect(bodyRows(screen.getByRole("grid")).map((r) => r.textContent)).not.toContain("Aluguel");
    expect(screen.getByText("3 de 4")).toBeTruthy();
  });

  it("starts with a filter on when asked", () => {
    render(
      <DataTable
        label="Metas"
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        layout="table"
        filters={[{ id: "active", label: "Ocultar arquivadas", keep: (row) => !row.archived, initial: true }]}
      />,
    );
    expect(bodyRows(screen.getByRole("grid")).length).toBe(3);
  });
});

describe("DataTable selection", () => {
  function Selectable({
    onBatch,
    canSelect,
  }: {
    onBatch: (ids: readonly string[]) => void;
    canSelect?: (row: Row) => boolean;
  }) {
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const [current, setCurrent] = useState<string | null>(null);
    return (
      <DataTable
        label="Despesas"
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        layout="table"
        selectedId={current}
        onSelect={setCurrent}
        search={{ text: (row) => row.description }}
        selection={{
          selected,
          onChange: setSelected,
          ...(canSelect ? { canSelect } : {}),
          actions: (ids) => <Button onClick={() => onBatch(ids)}>Arquivar</Button>,
        }}
      />
    );
  }

  it("ticks rows, a range with Shift and all shown, and hands the batch command the ids", async () => {
    const user = userEvent.setup();
    const onBatch = vi.fn();
    render(<Selectable onBatch={onBatch} />);
    await user.click(screen.getByRole("checkbox", { name: "Selecionar Mercado Pão de Açúcar" }));
    expect(screen.getByText("1 selecionado")).toBeTruthy();
    // a click on the checkbox does not move the current row
    expect(screen.getByRole("grid").querySelector('[aria-selected="true"]')).toBeNull();
    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("checkbox", { name: "Selecionar Farmácia" }));
    await user.keyboard("{/Shift}");
    expect(screen.getByText("3 selecionados")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Arquivar" }));
    expect(onBatch).toHaveBeenLastCalledWith(["a1", "b2", "c3"]);

    const all = screen.getByRole("checkbox", { name: "Selecionar todos os exibidos" });
    expect(all.getAttribute("aria-checked")).toBe("mixed");
    await user.click(all);
    expect(screen.getByText("4 selecionados")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Limpar seleção" }));
    expect(screen.queryByText(/selecionados?$/)).toBeNull();
  });

  it("Space ticks the current row", async () => {
    const user = userEvent.setup();
    render(<Selectable onBatch={vi.fn()} />);
    await user.click(screen.getByText("Aluguel"));
    const grid = screen.getByRole("grid");
    grid.focus();
    fireEvent.keyDown(grid, { key: " " });
    expect(screen.getByText("1 selecionado")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Selecionar Aluguel" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(grid, { key: " " });
    expect(screen.queryByText("1 selecionado")).toBeNull();
  });

  it("acts only on the ticked rows the search still shows, and skips rows that cannot be ticked", async () => {
    const user = userEvent.setup();
    const onBatch = vi.fn();
    render(<Selectable onBatch={onBatch} canSelect={(row) => !row.archived} />);
    expect((screen.getByRole("checkbox", { name: "Selecionar Aluguel" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "Selecionar todos os exibidos" }));
    expect(screen.getByText("3 selecionados")).toBeTruthy();
    await user.type(screen.getByRole("searchbox"), "far");
    expect(screen.getByText("1 selecionado")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Arquivar" }));
    expect(onBatch).toHaveBeenLastCalledWith(["c3"]);
  });

  it("puts a checkbox in each card and a select-all above the cards", async () => {
    const user = userEvent.setup();
    function Cards() {
      const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
      return (
        <DataTable
          label="Despesas"
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          layout="cards"
          selection={{ selected, onChange: setSelected }}
        />
      );
    }
    render(<Cards />);
    await user.click(screen.getByRole("checkbox", { name: "Selecionar Padaria" }));
    expect(screen.getByText("1 selecionado")).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "Selecionar todos os exibidos" }));
    expect(screen.getByText("4 selecionados")).toBeTruthy();
  });
});
