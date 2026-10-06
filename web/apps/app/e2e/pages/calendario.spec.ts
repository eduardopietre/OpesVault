/**
 * Calendário end to end: the month by day, the list of due dates, every button and link, the phone's list of
 * days, no console errors, no sideways scrolling at the five sizes and axe clean, in light and dark.
 */
import AxeBuilder from "@axe-core/playwright";
import { animationsDone } from "../helpers.ts";
import { expect, test, type Page } from "@playwright/test";
import { SCHEMES, SIZES, expectNoHorizontalOverflow, openDemo, settle, watchErrors } from "../helpers.ts";

async function audit(page: Page, label: string) {
  await settle(page, 300);
  await animationsDone(page);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    result.violations.map(
      (v) =>
        `${label}: ${v.id} (${v.impact}) ${v.nodes
          .map((n) => n.target.join(" "))
          .slice(0, 3)
          .join(", ")}`,
    ),
  ).toEqual([]);
}

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    test.describe(`calendário ${size.width}x${size.height} ${scheme}`, () => {
      test.use({ viewport: size, colorScheme: scheme });

      test("renders cleanly, never scrolls sideways and passes axe", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/calendario");
        await expect(page.getByRole("heading", { level: 1, name: "Calendário" })).toBeVisible();
        await expect(page.getByText(/vencimento\(s\) em/)).toBeVisible();
        if (size.width >= 640) {
          await expect(page.getByRole("table", { name: "Dias do mês" })).toBeVisible();
          await expect(page.getByRole("grid", { name: "Vencimentos" })).toBeVisible();
        } else {
          await expect(page.getByRole("list", { name: "Dias com vencimentos" })).toBeVisible();
        }
        await settle(page, 600);
        await expectNoHorizontalOverflow(page);
        await audit(page, "calendário");
        await page.evaluate(() => document.getElementById("conteudo")?.scrollTo(0, 1e6));
        await expectNoHorizontalOverflow(page);
        expect(errors).toEqual([]);
      });
    });
  }
}

test.describe("calendário: every action", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("chooses days, opens entries from the table and the Abrir… button, changes month", async ({ page }) => {
    const errors = watchErrors(page);
    await openDemo(page, "/calendario");
    const grid = page.getByRole("table", { name: "Dias do mês" });
    const days = grid.getByRole("button");
    const withEntries = await days.count();
    expect(withEntries).toBeGreaterThan(0);
    // A day shows only its entries; the same day again, or "Mês inteiro", shows the month.
    await days.first().click();
    await expect(days.first()).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: /Vencimentos de \d\d\/\d\d\/\d{4}/ })).toBeVisible();
    await page.getByRole("button", { name: "Mês inteiro" }).click();
    await expect(page.getByRole("heading", { name: "Vencimentos do mês" })).toBeVisible();
    await days.first().click();
    await days.first().click();
    await expect(page.getByRole("heading", { name: "Vencimentos do mês" })).toBeVisible();
    // "Abrir…" asks for a selection first.
    await page.getByRole("button", { name: "Abrir…" }).click();
    await expect(page.getByText("Selecione um vencimento.")).toBeVisible();
    // Select a row and open it.
    const table = page.getByRole("grid", { name: "Vencimentos" });
    await table.getByRole("row").nth(1).click();
    await page.getByRole("button", { name: "Abrir…" }).click();
    await expect(page).not.toHaveURL(/\/calendario/);
    // The row's own button: a bill or installment opens ready to pay.
    await openDemo(page, "/calendario");
    await page
      .getByRole("button", { name: /^Pagar…: / })
      .first()
      .click();
    await expect(page).toHaveURL(/\/contas/);
    // "ready to pay": Contas consumes the link's act=pagar at once and opens the payment form.
    await expect(page.getByRole("dialog", { name: /^Pagar (fatura|parcela)/ })).toBeVisible();
    // Double click opens too.
    await openDemo(page, "/calendario");
    await page.getByRole("grid", { name: "Vencimentos" }).getByRole("row").nth(1).dblclick();
    await expect(page).not.toHaveURL(/\/calendario/);
    // The month picker, shared with the other screens.
    await openDemo(page, "/calendario");
    const picker = page.getByRole("group", { name: "Mês" });
    await picker.getByRole("button", { name: "Próximo mês" }).click();
    await expect(page.getByText(/vencimento\(s\) em novembro de 2026/)).toBeVisible();
    await picker.getByRole("button", { name: "Mês anterior" }).click();
    await picker.getByRole("button", { name: "Mês anterior" }).click();
    await expect(page.getByText(/vencimento\(s\) em setembro de 2026/)).toBeVisible();
    // Sorting the list by a column.
    await table.getByRole("button", { name: "Valor", exact: true }).click();
    await page.getByRole("button", { name: "Vencimentos do mês" }).click(); // folds the list
    await expect(page.getByRole("button", { name: "Vencimentos do mês" })).toHaveAttribute("aria-expanded", "false");
    expect(errors).toEqual([]);
  });

  test("on a phone, every entry of the list of days has its action", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = watchErrors(page);
    await openDemo(page, "/calendario");
    const list = page.getByRole("list", { name: "Dias com vencimentos" });
    await expect(list.getByRole("heading", { level: 3 }).first()).toBeVisible();
    await list.getByRole("button").first().click();
    await expect(page).not.toHaveURL(/\/calendario/);
    // Next month's entries, from the picker.
    await openDemo(page, "/calendario");
    await page.getByRole("button", { name: "Próximo mês" }).click();
    await expect(page.getByText(/vencimento\(s\) em novembro de 2026/)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
