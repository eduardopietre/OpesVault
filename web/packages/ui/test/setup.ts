import { cleanup } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach } from "vitest";
import { cancelAllDecisions } from "../src/components/Dialog.tsx";
import { clearToasts } from "../src/components/Toast.tsx";

// happy-dom has no real animation timeline: animations end at once in tests.
MotionGlobalConfig.skipAnimations = true;

// happy-dom does no layout: give elements a size so virtualized lists render rows.
HTMLElement.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600, toJSON: () => ({}) };
};

Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1000 });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });

afterEach(() => {
  cleanup();
  cancelAllDecisions();
  clearToasts();
});
