/**
 * Performance of a big project in the real browser (docs/18 W12), on the production build of perf.html:
 *   pnpm --filter @opesvault/app perf          (PERF_OPS=50000 by default; E2E_PORT picks the port)
 * Writes build/perf/results.json; `node tools/perf_report.ts` prints it as a table.
 *
 * Targets: open under 3 s, tab memory under 500 MiB, scrolling at 60 fps and filtering under 100 ms in
 * the Livro. Headless Chromium paints with software rendering, so the fps is a lower bound.
 */
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const OPS = Number(process.env["PERF_OPS"] ?? 50_000);
const OUT = resolve(process.cwd(), "build/perf/results.json");

type Results = Record<string, Record<string, number | string>>;

function save(section: string, values: Record<string, number | string>): void {
  mkdirSync(dirname(OUT), { recursive: true });
  const all: Results = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as Results) : {};
  all[section] = { ...all[section], ...values };
  writeFileSync(OUT, JSON.stringify(all, null, 2));
}

async function boot(page: Page, mode: "fake" | "real"): Promise<void> {
  await page.goto(`/perf.html?mode=${mode}&ops=${OPS}`);
  await page.waitForFunction(() => document.documentElement.dataset["perfReady"] === "1", null, { timeout: 280_000 });
}

async function call<T>(page: Page, fn: string): Promise<T> {
  return (await page.evaluate(`(async () => (${fn})(window.__perf))()`)) as T;
}

/** JS heap and renderer RSS after a forced collection (MiB). */
async function memory(page: Page, cdp: CDPSession): Promise<{ heapMiB: number; heapTotalMiB: number; rssMiB: number }> {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const get = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
  let rss = 0;
  try {
    const info = (await cdp.send("SystemInfo.getProcessInfo" as never)) as {
      processInfo: { type: string; id: number }[];
    };
    for (const p of info.processInfo.filter((x) => x.type === "renderer")) {
      const status = readFileSync(`/proc/${p.id}/status`, "utf8");
      const kb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
      rss = Math.max(rss, kb / 1024);
    }
  } catch {
    // not on Linux, or the browser-level call is not available to a page session
  }
  void page;
  return {
    heapMiB: +(get("JSHeapUsedSize") / 2 ** 20).toFixed(0),
    heapTotalMiB: +(get("JSHeapTotalSize") / 2 ** 20).toFixed(0),
    rssMiB: +rss.toFixed(0),
  };
}

/** Browser-level CDP for the process list (SystemInfo lives there). */
async function processRss(page: Page): Promise<number> {
  const browser = page.context().browser();
  if (!browser) return 0;
  const session = await browser.newBrowserCDPSession();
  try {
    const info = (await session.send("SystemInfo.getProcessInfo")) as { processInfo: { type: string; id: number }[] };
    let rss = 0;
    for (const p of info.processInfo.filter((x) => x.type === "renderer")) {
      const kb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${p.id}/status`, "utf8"))?.[1] ?? 0);
      rss = Math.max(rss, kb / 1024);
    }
    return +rss.toFixed(0);
  } catch {
    return 0;
  } finally {
    await session.detach();
  }
}

/**
 * Opens the project through the page and adds the main thread's own CPU time (ms) for it, which is less
 * sensitive to a loaded machine than the clock.
 */
async function openProject(page: Page, cdp: CDPSession): Promise<Record<string, number>> {
  const cpu = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    return (metrics.find((m) => m.name === "TaskDuration")?.value ?? 0) * 1000;
  };
  const before = await cpu();
  const times = await call<Record<string, number>>(page, "(p) => p.open()");
  return { ...times, mainThreadCpu: Math.round((await cpu()) - before) };
}

test.describe.configure({ mode: "serial" });
test.setTimeout(600_000);

test.describe("real vault path", () => {
  test("open from the server (cold) and from the device (warm)", async ({ page }) => {
    await boot(page, "real");
    const info = await call<{ operations: number; records: number; phases: Record<string, number> }>(
      page,
      "(p) => ({ operations: p.operations, records: p.records, phases: p.phases })",
    );
    save("project", { operations: info.operations, records: info.records, ...info.phases });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");

    // Cold: this device never saw the project; every record comes from the server.
    await call(page, "(p) => p.useColdCache()");
    const cold = await openProject(page, cdp);
    const coldMarks = await call<Record<string, number>>(page, "(p) => p.marks()");
    save("open cold (server)", { ...cold, ...coldMarks });
    const coldMemory = await memory(page, cdp);
    coldMemory.rssMiB = (await processRss(page)) || coldMemory.rssMiB;
    save("memory after cold open", coldMemory);

    // The vault writes this device's snapshot a moment after opening a big project (docs/19 §8).
    const waited = await call<number>(page, "(p) => p.waitForDeviceSnapshot()");
    const bytes = await call<number>(page, "(p) => p.deviceSnapshotBytes()");
    save("device snapshot", {
      "written after opening (ms, includes the 5 s delay)": waited,
      "size (MiB)": +(bytes / 2 ** 20).toFixed(1),
    });

    // Warm: the records are in IndexedDB, with the device snapshot.
    await call(page, "(p) => p.close()");
    await page.evaluate(() => performance.clearMeasures());
    const warm = await openProject(page, cdp);
    const warmMarks = await call<Record<string, number>>(page, "(p) => p.marks()");
    save("open warm (device)", { ...warm, ...warmMarks });
    const warmMemory = await memory(page, cdp);
    warmMemory.rssMiB = (await processRss(page)) || warmMemory.rssMiB;
    save("memory after warm open", warmMemory);
    expect(warm["total"]).toBeGreaterThan(0);

    // The same without the snapshot: every record decrypted one by one, as before the snapshot was written.
    await call(page, "(p) => p.close()");
    await call(page, "(p) => p.dropDeviceSnapshot()");
    await page.evaluate(() => performance.clearMeasures());
    const noSnapshot = await openProject(page, cdp);
    const noSnapshotMarks = await call<Record<string, number>>(page, "(p) => p.marks()");
    save("open warm without the snapshot", { ...noSnapshot, ...noSnapshotMarks });
    const noSnapshotMemory = await memory(page, cdp);
    noSnapshotMemory.rssMiB = (await processRss(page)) || noSnapshotMemory.rssMiB;
    save("memory after warm open without the snapshot", noSnapshotMemory);
  });
});

test.describe("screens (project in memory, no cryptography)", () => {
  test("every page: time to the heading", async ({ page }) => {
    await boot(page, "fake");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const opened = await openProject(page, cdp);
    save("open (UI only)", opened);
    const paths = [
      ["livro", "/livro"],
      ["orcamento", "/orcamento"],
      ["contas", "/contas"],
      ["investimentos", "/investimentos"],
      ["recorrencias", "/recorrencias"],
      ["relatorios", "/relatorios"],
      ["metas", "/metas"],
      ["calendario", "/calendario"],
      ["reembolsos", "/reembolsos"],
      ["imposto", "/imposto"],
      ["importar", "/importar"],
      ["documentos", "/documentos"],
      ["configuracoes", "/configuracoes"],
      ["visao-geral", "/visao-geral"],
    ] as const;
    const times: Record<string, number> = {};
    for (const [name, path] of paths) {
      const ms = await page.evaluate(async (to) => {
        const api = (window as unknown as { __perf: { go(to: string): Promise<void> } }).__perf;
        const t0 = performance.now();
        await api.go(to);
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        return performance.now() - t0;
      }, path);
      times[name] = Math.round(ms);
    }
    save("page navigation (ms)", times);
  });

  test("Livro: first paint, scroll, filters, memory", async ({ page }) => {
    await boot(page, "fake");
    await call(page, "(p) => p.open()");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await page.setViewportSize({ width: 1920, height: 1080 });

    const first = await page.evaluate(async () => {
      const api = (window as unknown as { __perf: { go(to: string): Promise<void> } }).__perf;
      const t0 = performance.now();
      await api.go("/livro");
      while (!document.querySelector("[data-row-id]")) await new Promise((r) => setTimeout(r, 5));
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      return {
        ms: performance.now() - t0,
        rows: Number(document.querySelector('[role="grid"]')?.getAttribute("aria-rowcount") ?? 0) - 1,
      };
    });
    save("livro", { firstPaintMs: Math.round(first.ms), rowsShown: first.rows });

    // Everything on screen, so the filters below start from the whole book.
    const grid = page.locator('[role="grid"][aria-label="Lançamentos"]');
    await expect(grid).toBeVisible();

    // Scrolling: one scroll step per animation frame over 240 frames. 120 px per frame (7 200 px/s) is a
    // fast flick of a wheel or touch; 900 px per frame is a stress test no hand reaches.
    const scrollRun = (step: number) =>
      page.evaluate(async (stepPx) => {
        const el = document.querySelector<HTMLElement>('[role="grid"][aria-label="Lançamentos"]')!;
        el.scrollTop = 0;
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        const deltas: number[] = [];
        let last = performance.now();
        const longTasks: number[] = [];
        const observer = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) longTasks.push(e.duration);
        });
        try {
          observer.observe({ entryTypes: ["longtask"] });
        } catch {
          // not supported
        }
        await new Promise<void>((resolve) => {
          let n = 0;
          const tick = () => {
            const now = performance.now();
            deltas.push(now - last);
            last = now;
            el.scrollTop += stepPx;
            if (++n >= 240) return resolve();
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        observer.disconnect();
        deltas.shift();
        const sorted = [...deltas].sort((a, b) => a - b);
        const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
        return {
          fps: 1000 / avg,
          p95: sorted[Math.floor(sorted.length * 0.95)]!,
          worst: sorted[sorted.length - 1]!,
          over20: deltas.filter((d) => d > 20).length,
          frames: deltas.length,
          longTasks: longTasks.length,
        };
      }, step);
    for (const [name, step] of [
      ["livro scroll 120px/frame", 120],
      ["livro scroll 900px/frame (stress)", 900],
    ] as const) {
      const read = async () => {
        const { metrics } = await cdp.send("Performance.getMetrics");
        const get = (n: string) => metrics.find((m) => m.name === n)?.value ?? 0;
        return {
          task: get("TaskDuration"),
          script: get("ScriptDuration"),
          layout: get("LayoutDuration"),
          style: get("RecalcStyleDuration"),
        };
      };
      const before = await read();
      const r = await scrollRun(step);
      const after = await read();
      // Main-thread CPU per frame, from the browser's own counters: what stays when raster is on the GPU.
      const per = (k: keyof typeof before) => +(((after[k] - before[k]) * 1000) / (r.frames + 1)).toFixed(2);
      save(name, {
        mainThreadMsPerFrame: per("task"),
        scriptMsPerFrame: per("script"),
        layoutMsPerFrame: per("layout"),
        styleMsPerFrame: per("style"),
        fps: +r.fps.toFixed(1),
        p95FrameMs: +r.p95.toFixed(1),
        worstFrameMs: +r.worst.toFixed(1),
        framesOver20ms: r.over20,
        frames: r.frames,
        longTasks: r.longTasks,
      });
    }

    // Filter latency: from the input event to the frame that shows the new table.
    async function timed(action: () => Promise<void>, label: string, settleExtraMs = 0): Promise<number> {
      await page.evaluate(() => {
        const w = window as unknown as { __t0: number; __last: number; __obs?: MutationObserver };
        w.__obs?.disconnect();
        w.__t0 = 0;
        w.__last = 0;
        const grid = document.querySelector('[role="grid"][aria-label="Lançamentos"]')?.parentElement ?? document.body;
        w.__obs = new MutationObserver(() => {
          w.__last = performance.now();
        });
        w.__obs.observe(grid, { childList: true, subtree: true, attributes: true });
        // The last user event starts the clock (a select takes two clicks; the second one filters).
        const mark = () => {
          w.__t0 = performance.now();
          w.__last = 0;
        };
        document.addEventListener("input", mark, { capture: true });
        document.addEventListener("click", mark, { capture: true });
      });
      await action();
      // Wait until the table stops changing.
      await page.waitForFunction(
        (extra) => {
          const w = window as unknown as { __t0: number; __last: number };
          return w.__t0 > 0 && w.__last > w.__t0 && performance.now() - w.__last > 150 + extra;
        },
        settleExtraMs,
        { timeout: 20_000, polling: 20 },
      );
      const ms = await page.evaluate(() => {
        const w = window as unknown as { __t0: number; __last: number };
        return w.__last - w.__t0;
      });
      void label;
      return Math.round(ms);
    }

    const rowCount = () =>
      page.evaluate(() => Number(document.querySelector('[role="grid"]')?.getAttribute("aria-rowcount") ?? 0) - 1);
    const pick = async (name: string, option: string | RegExp) => {
      await page.getByRole("combobox", { name, exact: true }).click();
      await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
    };

    // Saved as it goes, so a stuck step does not lose the earlier numbers.
    const filters: Record<string, number | string> = new Proxy(
      {},
      {
        set(target: Record<string, number | string>, key: string, value: number | string) {
          target[key] = value;
          save("livro filters", { [key]: value });
          return true;
        },
      },
    );
    page.setDefaultTimeout(20_000);
    const search = page.getByRole("searchbox", { name: "Buscar lançamentos" });
    // The search waits 250 ms after the last key by design; the number below is what comes after it.
    const searchTotal = await timed(() => search.fill("Mercado"), "search");
    filters["search 'Mercado' total (ms, includes 250 debounce)"] = searchTotal;
    filters["search 'Mercado' after debounce (ms)"] = Math.max(0, searchTotal - 250);
    filters["rows after search"] = await rowCount();
    filters["search narrower 'Mercado 12' total (ms)"] = await timed(() => search.fill("Mercado 12"), "search2");
    await page.getByRole("button", { name: "Limpar filtros" }).first().click();
    await expect.poll(rowCount).toBeGreaterThan(40_000);
    filters["account (ms)"] = await timed(() => pick("Conta ou categoria", "Banco A"), "account");
    filters["rows after account"] = await rowCount();
    filters["category (ms)"] = await timed(() => pick("Conta ou categoria", "Categoria: Lazer"), "category");
    await page.getByRole("button", { name: "Limpar filtros" }).first().click();
    filters["period 'Mês selecionado' (ms)"] = await timed(() => pick("Período", /20\d\d/), "month");
    filters["rows in month"] = await rowCount();
    await page.getByRole("button", { name: "Limpar filtros" }).first().click();
    filters["origin 'Importado' (ms)"] = await timed(() => pick("Origem", /Import/), "origin");

    const mem = await memory(page, cdp);
    mem.rssMiB = (await processRss(page)) || mem.rssMiB;
    save("memory in the Livro (UI only)", mem);
  });
});
