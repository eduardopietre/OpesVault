/**
 * Where focus goes when a dialog opens and closes (WCAG 2.4.3). Found by the keyboard-only e2e: a form opened on its
 * close button instead of its first field, and a dialog opened from a menu entry lost focus when it closed (the
 * entry it remembered no longer exists).
 */
import { Button, Dialog, MenuButton, TextField } from "@opesvault/ui";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

function FromButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Novo</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Despesa"
        onSubmit={() => setOpen(false)}
        footer={<Button type="submit">Registrar</Button>}
      >
        <TextField label="Descrição" value="" onChange={() => undefined} />
        <TextField label="Valor" value="" onChange={() => undefined} />
      </Dialog>
    </>
  );
}

function FromMenu() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MenuButton
        label="Novo lançamento"
        items={[{ id: "despesa", label: "Despesa", onSelect: () => setOpen(true) }]}
      />
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Despesa"
        onSubmit={() => setOpen(false)}
        footer={<Button type="submit">Registrar</Button>}
      >
        <TextField label="Descrição" value="" onChange={() => undefined} />
      </Dialog>
    </>
  );
}

describe("focus in dialogs", () => {
  it("a form opens on its first field, not on the close button, and closes back to its button", async () => {
    const user = userEvent.setup();
    render(<FromButton />);
    const trigger = screen.getByRole("button", { name: "Novo" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const field = await screen.findByLabelText("Descrição");
    expect(document.activeElement).toBe(field);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("a dialog opened from a menu entry gives focus back to the menu's button", async () => {
    const user = userEvent.setup();
    render(<FromMenu />);
    const trigger = screen.getByRole("button", { name: "Novo lançamento", exact: true });
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "Despesa" }));
    expect(document.activeElement).toBe(await screen.findByLabelText("Descrição"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});
