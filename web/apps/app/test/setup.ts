import { cancelAllDecisions, clearToasts } from "@opesvault/ui";
import { cleanup } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeAll } from "vitest";
import { preloadProjectScreens } from "../src/router.tsx";

// happy-dom has no animation timeline or layout.
MotionGlobalConfig.skipAnimations = true;
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1280 });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 800 });

// The shell and the screens load on demand in the app: have them ready, so the tests wait for a page and not for code.
beforeAll(async () => {
  await preloadProjectScreens();
}, 120_000);

afterEach(() => {
  cleanup();
  cancelAllDecisions();
  clearToasts();
  document.documentElement.removeAttribute("data-theme");
});
