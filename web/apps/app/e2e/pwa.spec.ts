/** PWA: installable manifest, service worker registered through the Trusted Types policy, shell offline. */
import { expect, test } from "@playwright/test";
import { watchErrors } from "./helpers.ts";

test.use({ serviceWorkers: "allow" });

test("manifest, worker and an app shell that opens offline", async ({ page, context }) => {
  const errors = watchErrors(page);
  await page.goto("/boas-vindas");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBeTruthy();
  const manifest = await (await page.request.get(href!)).json();
  expect(manifest.name).toBe("OpesVault");
  expect(manifest.lang).toBe("pt-BR");
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(
    expect.arrayContaining(["192x192", "512x512"]),
  );

  await expect(page.getByRole("status").filter({ hasText: "Pronto para abrir sem conexão" })).toBeVisible({
    timeout: 15_000,
  });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Boas-vindas ao OpesVault" })).toBeVisible();
  await context.setOffline(false);
  expect(errors.filter((error) => !/net::ERR_INTERNET_DISCONNECTED/.test(error))).toEqual([]);
});
