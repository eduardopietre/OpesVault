/** Mounting Configurações on the demonstration project (fake services with light key derivation) for its tests. */
import { within } from "@testing-library/react";
import { vi } from "vitest";
import type { User } from "../dom.ts";
import { mountApp, type MountOptions } from "../mount.tsx";
import { TEST_KDF } from "@opesvault/vault/testing";

/** Configurações (or another page, by `heading`) on the demonstration project, with light key derivation. */
export async function openSettings(path = "/configuracoes", options: MountOptions = {}) {
  return mountApp(path, { width: 1600, heading: "Configurações", services: { kdf: TEST_KDF }, ...options });
}

/** Types into a field by its label. */
export async function type(user: User, scope: HTMLElement, label: string | RegExp, text: string) {
  const field = within(scope).getByLabelText(label) as HTMLInputElement;
  await user.clear(field);
  if (text) await user.type(field, text);
}

/** Lets the page download files without a browser: remembers what was offered. */
export function captureDownloads(): { files: { name: string; blob: Blob }[]; restore: () => void } {
  const files: { name: string; blob: Blob }[] = [];
  const blobs = new Map<string, Blob>();
  let counter = 0;
  const create = vi.spyOn(URL, "createObjectURL").mockImplementation((object) => {
    const url = `blob:test/${++counter}`;
    blobs.set(url, object as Blob);
    return url;
  });
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    const blob = blobs.get(this.href);
    if (blob && this.download) files.push({ name: this.download, blob });
  });
  return {
    files,
    restore: () => {
      create.mockRestore();
      revoke.mockRestore();
      click.mockRestore();
    },
  };
}

/** A File the person would pick, from a downloaded Blob. */
export async function fileOf(download: { name: string; blob: Blob }): Promise<File> {
  return new File([await download.blob.arrayBuffer()], download.name, { type: "application/octet-stream" });
}

/** The projects screen of a signed-in account with no project open. */
export async function openProjects(options: { width?: number } = {}) {
  return mountApp("/projetos", {
    width: options.width ?? 1600,
    heading: "Projetos",
    project: "none",
    services: { kdf: TEST_KDF },
  });
}
