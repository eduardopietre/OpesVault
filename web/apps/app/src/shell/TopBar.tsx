/**
 * The top bar (docs/16 §1, docs/18 §6 Shell): which project is open, the sync state (dot and text), undo,
 * help, lock and the account menu with the operator and the theme. On phones only the essentials stay.
 */
import {
  ElidedText,
  IconButton,
  MenuButton,
  StatusPill,
  type Band,
  type MenuEntry,
  type SyncState,
  type ThemeChoice,
} from "@opesvault/ui";
import { CircleHelp, Lock, PanelLeft, PanelLeftClose, Redo2, Search, Undo2 } from "lucide-react";
import type { Account, OpenProject } from "../services/types.ts";
import { THEME_LABELS } from "../theme.tsx";
import { LogoMark } from "./Logo.tsx";
import type { UndoApi } from "./undo.tsx";

export interface TopBarProps {
  band: Band;
  account: Account | null;
  open: OpenProject | null;
  sync: SyncState;
  operatorId: string | null;
  sidebarCollapsed: boolean;
  theme: ThemeChoice;
  undo: UndoApi;
  onToggleSidebar(): void;
  onOpenDrawer(): void;
  onPalette(): void;
  onHelp(): void;
  onLock(): void;
  onSwitchProject(): void;
  onSignOut(): void;
  onOperator(id: string): void;
  onTheme(choice: ThemeChoice): void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase() || "?";
}

export function TopBar(props: TopBarProps) {
  const { band, account, open, sync, operatorId, sidebarCollapsed, theme, undo } = props;
  const phone = band === "phone";
  const tablet = band === "tablet";
  const members = open?.members ?? [];
  const items: MenuEntry[] = [
    { kind: "label", id: "who", label: account ? `${account.name} · ${account.email}` : "Conta" },
    ...(members.length > 1
      ? [
          {
            kind: "radio" as const,
            id: "operator",
            label: "Quem está operando",
            value: operatorId ?? "",
            options: members.map((member) => ({ value: member.id, label: member.name })),
            onChange: props.onOperator,
          },
        ]
      : []),
    {
      kind: "radio",
      id: "theme",
      label: "Aparência",
      value: theme,
      options: (Object.keys(THEME_LABELS) as ThemeChoice[]).map((value) => ({ value, label: THEME_LABELS[value] })),
      onChange: (value) => props.onTheme(value as ThemeChoice),
    },
    { kind: "separator", id: "s1" },
    { id: "help", label: "Atalhos e ajuda", shortcut: "F1", onSelect: props.onHelp },
    { id: "switch", label: "Trocar de projeto", onSelect: props.onSwitchProject },
    { id: "signout", label: "Sair da conta", onSelect: props.onSignOut },
  ];
  const operator = members.find((member) => member.id === operatorId);

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 bg-window px-2 tablet:px-3">
      {phone ? null : tablet ? (
        <IconButton label="Abrir menu de seções" icon={<PanelLeft />} onClick={props.onOpenDrawer} />
      ) : (
        <IconButton
          label={sidebarCollapsed ? "Expandir barra lateral" : "Recolher barra lateral"}
          shortcut="Ctrl+Shift+B"
          icon={sidebarCollapsed ? <PanelLeft /> : <PanelLeftClose />}
          aria-expanded={!sidebarCollapsed}
          onClick={props.onToggleSidebar}
        />
      )}
      <div className="flex min-w-0 items-center gap-2.5 pl-1">
        <LogoMark className={phone ? "size-6" : undefined} />
        <div className="min-w-0">
          <ElidedText className="text-body font-semibold text-text">{open?.project.name ?? "OpesVault"}</ElidedText>
          {!phone && operator && members.length > 1 ? (
            <ElidedText className="text-caption text-secondary">{`Operando como ${operator.name}`}</ElidedText>
          ) : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 justify-center px-2">
        {band === "wide" || band === "medium" ? (
          <button
            type="button"
            onClick={props.onPalette}
            aria-keyshortcuts="Control+K Meta+K"
            className="flex h-8 w-full max-w-[420px] items-center gap-2 rounded-md border border-separator bg-raised px-3 text-body text-secondary shadow-sm transition-colors hover:border-separator-strong hover:text-text"
          >
            <Search aria-hidden="true" className="size-4" />
            <span className="flex-1 truncate text-left">Buscar seção ou comando…</span>
            <kbd className="rounded border border-separator px-1.5 font-sans text-caption">Ctrl K</kbd>
          </button>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <StatusPill state={sync} compact={phone} className={phone ? "max-w-[124px]" : undefined} />
        {phone ? (
          <IconButton label="Buscar seção ou comando" shortcut="Ctrl+K" icon={<Search />} onClick={props.onPalette} />
        ) : (
          <>
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-separator" />
            {band === "tablet" ? (
              <IconButton
                label="Buscar seção ou comando"
                shortcut="Ctrl+K"
                icon={<Search />}
                onClick={props.onPalette}
              />
            ) : null}
            <IconButton label={undo.undoLabel} shortcut="Ctrl+Z" icon={<Undo2 />} onClick={undo.undo} />
            <IconButton label={undo.redoLabel} shortcut="Ctrl+Shift+Z" icon={<Redo2 />} onClick={undo.redo} />
            <IconButton label="Ajuda desta tela" shortcut="F1" icon={<CircleHelp />} onClick={props.onHelp} />
          </>
        )}
        <IconButton label="Bloquear o projeto" shortcut="Ctrl+Shift+L" icon={<Lock />} onClick={props.onLock} />
        <MenuButton
          label="Conta"
          items={items}
          trigger={
            <button
              type="button"
              aria-label={account ? `Conta de ${account.name}` : "Conta"}
              title={account?.name ?? "Conta"}
              className="ml-1 grid size-8 place-items-center rounded-full bg-accent-soft text-caption font-semibold text-accent transition-shadow hover:ring-2 hover:ring-separator-strong"
            >
              {initials(account?.name ?? "")}
            </button>
          }
        />
      </div>
    </header>
  );
}
