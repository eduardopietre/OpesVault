import { cancelAllDecisions, clearToasts } from "@opesvault/ui";
import { cleanup } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach } from "vitest";

// happy-dom has no animation timeline or layout.
MotionGlobalConfig.skipAnimations = true;
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1280 });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 800 });

afterEach(() => {
  cleanup();
  cancelAllDecisions();
  clearToasts();
  document.documentElement.removeAttribute("data-theme");
});
