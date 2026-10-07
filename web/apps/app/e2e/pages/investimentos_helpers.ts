/** Pieces the Investimentos end-to-end specs share. */
import { type Locator, type Page } from "@playwright/test";
import { audited, labelled } from "../ui.ts";

export const { audit, openDialog } = audited({ skipNotices: false });

/** Types into a field by its label (a required field's label ends with "*"). */
export const field = (scope: Locator | Page, label: string) => scope.getByLabel(labelled(label));

/** The notice (toast) with this text. */
export const notice = (page: Page, text: string | RegExp) => page.getByText(text).first();
