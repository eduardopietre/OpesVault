/** The parts of Configurações that need no React: words, the Ollama guide, the backup status and the refs. */
import { ai, makeDate, dom } from "@opesvault/domain";
import { describe, expect, it } from "vitest";
import { backupFileName, documentBlobRefs, lastBackupKey } from "../../src/data/backup.ts";
import { backupNotices, readLastBackup, writeLastBackup } from "../../src/pages/configuracoes/backup_state.ts";
import {
  backupStatus,
  bytesText,
  checkedText,
  originGuide,
  parsePort,
  parseTab,
  persistWords,
  placementText,
} from "../../src/pages/configuracoes/rows.ts";
import { memoryPreferences } from "@opesvault/ui";

const GB = 1_000_000_000;

describe("sections and links", () => {
  it("reads the sections a link may point to and nothing else", () => {
    for (const ref of ["projeto", "ia", "seguranca", "backup", "privacidade"]) expect(parseTab(ref)).toBe(ref);
    for (const ref of [undefined, "", "IA", "nada", "backup:x"]) expect(parseTab(ref)).toBeNull();
  });
});

describe("where the model runs", () => {
  it("says it in words (desktop placement_text)", () => {
    expect(placementText(null)).toBe("");
    expect(placementText(new ai.ollama.Placement(8 * GB, 8 * GB))).toContain("inteiro na GPU");
    expect(placementText(new ai.ollama.Placement(8 * GB, 0))).toContain("só na CPU");
    expect(placementText(new ai.ollama.Placement(8 * GB, 2 * GB))).toContain("Só 25% do modelo coube na GPU");
  });

  it("says what the check found for each situation", () => {
    const models = new ai.ollama.ServerInfo("0.35.1", ["gemma4:12b", "llama3.2:3b"], 0.1);
    expect(checkedText("gemma4:12b", models, null)).toBe("Ollama 0.35.1 respondeu: 2 modelo(s) instalado(s).");
    expect(checkedText("outro", models, null)).toContain(
      "o modelo outro não está instalado. Instale com “ollama pull outro”.",
    );
    expect(checkedText("", new ai.ollama.ServerInfo("1", [], 0), null)).toContain("nenhum modelo instalado ainda");
    expect(checkedText("x", new ai.ollama.ServerInfo("1", ["x"], 0), null)).toContain(
      "o indicado (gemma4:12b) não está entre eles",
    );
  });
});

describe("the port", () => {
  it("accepts 1024 to 65535 only", () => {
    expect(parsePort("11434")).toBe(11434);
    expect(parsePort(" 1024 ")).toBe(1024);
    expect(parsePort("65535")).toBe(65535);
    for (const bad of ["", "1023", "65536", "abc", "11.5", "-1", "0x10", "123456"]) expect(parsePort(bad)).toBeNull();
  });
});

describe("OLLAMA_ORIGINS guide", () => {
  it("carries this app's exact origin in every command", () => {
    const guide = originGuide("https://app.exemplo.com.br:8443");
    expect(guide.origin).toBe("https://app.exemplo.com.br:8443");
    expect(guide.windows).toBe('setx OLLAMA_ORIGINS "https://app.exemplo.com.br:8443"');
    expect(guide.mac).toBe('launchctl setenv OLLAMA_ORIGINS "https://app.exemplo.com.br:8443"');
    expect(guide.linux).toContain('Environment="OLLAMA_ORIGINS=https://app.exemplo.com.br:8443"');
    expect(guide.linux).toContain("sudo systemctl edit ollama.service");
  });
});

describe("backup status and reminder", () => {
  const today = makeDate(2026, 10, 6);

  it("says how the last backup made here stands", () => {
    expect(backupStatus(null, today)).toMatchObject({ tone: "warning", title: "Nenhum backup feito neste aparelho" });
    expect(backupStatus(today, today)).toMatchObject({ tone: "positive" });
    expect(backupStatus(today, today).title).toBe("Último backup feito neste aparelho: 06/10/2026 (hoje)");
    expect(backupStatus(makeDate(2026, 10, 5), today).title).toContain("(ontem)");
    expect(backupStatus(makeDate(2026, 10, 1), today).title).toContain("(há 5 dias)");
    expect(backupStatus(makeDate(2026, 9, 6), today)).toMatchObject({ tone: "warning" }); // 30 days
    expect(backupStatus(makeDate(2026, 9, 7), today)).toMatchObject({ tone: "positive" }); // 29 days
  });

  it("reminds after the domain's 30 days, or when there is data and never a backup, in the web's words", () => {
    expect(backupNotices(null, today, false)).toEqual([]);
    expect(backupNotices(makeDate(2026, 9, 20), today, true)).toEqual([]);
    const never = backupNotices(null, today, true);
    expect(never).toHaveLength(1);
    expect(never[0]).toMatchObject({
      severity: dom.alerts.Severity.INFO,
      title: "Faça um backup do cofre",
      ref: "backup",
    });
    expect(never[0]!.detail).toContain("Configurações");
    expect(never[0]!.detail).not.toContain("pasta");
    const old = backupNotices(makeDate(2026, 8, 1), today, true);
    expect(old[0]!.title).toBe("Último backup há 66 dias");
    expect(old[0]!.detail).toContain("de 01/08/2026");
    expect(old[0]!.detail).toContain("Verificar arquivo…");
    expect(old[0]!.ref).toBe("backup");
  });

  it("keeps the day per project on this device", () => {
    const store = memoryPreferences();
    expect(readLastBackup(store, "p1")).toBeNull();
    writeLastBackup(store, "p1", today);
    expect(readLastBackup(store, "p1")).toBe(today);
    expect(readLastBackup(store, "p2")).toBeNull();
    store.set(lastBackupKey("p1"), "not a date");
    expect(readLastBackup(store, "p1")).toBeNull();
  });
});

describe("what the backup tells the vault", () => {
  it("only document records point to attachments", () => {
    expect(documentBlobRefs({ kind: "operation", payload: { blob_id: "a".repeat(32) } })).toEqual([]);
    expect(documentBlobRefs({ kind: "document", payload: { blob_id: "a".repeat(32), sha256: "ab" } })).toEqual([
      { id: "a".repeat(32), sha256: "ab" },
    ]);
    expect(documentBlobRefs({ kind: "document", payload: { sha256: "ab" } })).toEqual([]);
    expect(documentBlobRefs({ kind: "document", payload: null })).toEqual([]);
    expect(documentBlobRefs({ kind: "document", payload: { blob_id: "a".repeat(32) } })).toEqual([
      { id: "a".repeat(32), sha256: undefined },
    ]);
  });

  it("names the file without the project's name", () => {
    expect(backupFileName(new Date(2026, 9, 6, 12))).toBe("opesvault-backup-2026-10-06.ovbackup");
    expect(backupFileName(new Date(2026, 0, 5, 12))).toBe("opesvault-backup-2026-01-05.ovbackup");
  });
});

describe("sizes and storage words", () => {
  it("writes sizes in Portuguese", () => {
    expect(bytesText(512)).toBe("512 B");
    expect(bytesText(1536)).toBe("1,5 KiB");
    expect(bytesText(5 * 1024 * 1024)).toBe("5 MiB");
    expect(bytesText(10 * 1024 ** 3)).toBe("10 GiB");
  });

  it("says what each state of the storage means", () => {
    expect(persistWords("yes")).toContain("não apaga");
    expect(persistWords("no")).toContain("pode apagar");
    expect(persistWords("unavailable")).toContain("não informa");
  });
});
