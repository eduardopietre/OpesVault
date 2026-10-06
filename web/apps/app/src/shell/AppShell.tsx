/**
 * The window of an open project (docs/16 §1, docs/18 §5.1) in four bands:
 *   wide ≥ 1440: fixed sidebar (Ctrl+Shift+B turns it into an icon rail);
 *   medium 1024–1439: sidebar that collapses into an icon rail;
 *   tablet 640–1023: the sidebar becomes a drawer;
 *   phone < 640: bottom bar with four destinations and "Mais" in a sheet.
 * Page changes slide and fade in briefly. Files dropped anywhere go to Importar e revisar.
 */
import { useAttention } from "../data/attention.ts";
import {
  BottomNav,
  CommandPalette,
  LockScreen,
  Sheet,
  Sidebar,
  cn,
  notify,
  useBand,
  useMotionPreset,
  useStoredFlag,
  type Command,
  type NavGroup,
  type NavItem,
} from "@opesvault/ui";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { motion } from "motion/react";
import { CircleHelp, FileUp, Lock, LogOut, Monitor, Moon, PanelLeft, Redo2, Repeat2, Sun, Undo2 } from "lucide-react";
import { useEffect, useState, type DragEvent } from "react";
import { BOTTOM_NAV, PAGES, SECTIONS, pageById, pageByPath, shortcutOf, type PageDef } from "../pages.tsx";
import { SIDEBAR_KEY } from "../preferences.ts";
import { syncStateOf, useSession, useSessionActions } from "../session.tsx";
import { useTheme } from "../theme.tsx";
import { HelpDialog } from "./HelpDialog.tsx";
import { addDroppedFiles } from "../data/dropped_files.ts";
import { useShortcuts } from "./shortcuts.ts";
import { TopBar } from "./TopBar.tsx";
import { useUndo } from "./undo.tsx";
import { Wordmark } from "./Logo.tsx";
import { SHOW_CATALOG } from "../flags.ts";

const EMPTY_ATTENTION: Readonly<Record<string, number>> = {};

function navItem(page: PageDef, attention: Readonly<Record<string, number>>): NavItem {
  const shortcut = shortcutOf(page);
  const count = page.counted ? attention[page.id] : undefined;
  return {
    id: page.id,
    label: page.title,
    href: page.path,
    icon: page.icon,
    ...(count ? { count } : {}),
    ...(shortcut ? { shortcut } : {}),
  };
}

export function AppShell() {
  const session = useSession();
  const actions = useSessionActions();
  const band = useBand();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = pageByPath(pathname);
  const undo = useUndo();
  const { theme, setTheme } = useTheme();
  const preset = useMotionPreset();
  const [collapsed, setCollapsed] = useStoredFlag(SIDEBAR_KEY, false);
  const [drawer, setDrawer] = useState(false);
  const [more, setMore] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Opening the project and unlocking it replace what had focus (a dialog, the lock screen): without this,
  // keyboard and screen reader users would start again from the top of the document.
  const locked = session.locked;
  useEffect(() => {
    if (locked) return;
    const main = document.getElementById("conteudo");
    if (main && (document.activeElement === document.body || document.activeElement === null)) {
      main.focus({ preventScroll: true });
    }
  }, [locked]);

  const attention = useAttention(session.open?.attention ?? EMPTY_ATTENTION);
  const groups: NavGroup[] = SECTIONS.map((section) => ({
    label: section,
    items: PAGES.filter((page) => page.section === section).map((page) => navItem(page, attention)),
  }));
  const footer = PAGES.filter((page) => page.section === null).map((page) => navItem(page, attention));

  const go = (id: string) => {
    const page = pageById(id);
    if (!page) return;
    setDrawer(false);
    setMore(false);
    void navigate({ to: page.path }).then(() => {
      // Keyboard users continue in the new page's content (not at the top of the document).
      const main = document.getElementById("conteudo");
      if (main && (document.activeElement === document.body || document.activeElement === null)) {
        main.focus({ preventScroll: true });
      }
    });
  };
  const lock = () => void actions.lock();
  const switchProject = () => void actions.closeProject().then(() => navigate({ to: "/projetos" }));
  const signOut = () => void actions.signOut().then(() => navigate({ to: "/boas-vindas" }));
  const toggleSidebar = () => {
    if (band === "tablet") setDrawer((value) => !value);
    else if (band !== "phone") setCollapsed(!collapsed);
  };

  useShortcuts(
    {
      palette: () => setPalette(true),
      help: () => setHelp(true),
      goIndex: (index) => {
        const page = PAGES[index];
        if (page) go(page.id);
      },
      goLetter: (letter) => {
        const page = PAGES.find((item) => item.letter === letter);
        if (!page) return false;
        go(page.id);
        return true;
      },
      undo: undo.undo,
      redo: undo.redo,
      toggleSidebar,
      lock,
    },
    !session.locked,
  );

  const commands: Command[] = [
    ...PAGES.map((page) => ({
      id: `go-${page.id}`,
      label: page.title,
      group: "Ir para",
      icon: page.icon,
      keywords: `${page.section ?? ""} g ${page.letter}`,
      shortcut: shortcutOf(page) ?? `g ${page.letter}`,
      run: () => go(page.id),
    })),
    { id: "undo", label: undo.undoLabel, group: "Editar", icon: <Undo2 />, shortcut: "Ctrl+Z", run: undo.undo },
    { id: "redo", label: undo.redoLabel, group: "Editar", icon: <Redo2 />, shortcut: "Ctrl+Shift+Z", run: undo.redo },
    {
      id: "sidebar",
      label: collapsed ? "Expandir a barra lateral" : "Recolher a barra lateral",
      group: "Exibir",
      icon: <PanelLeft />,
      shortcut: "Ctrl+Shift+B",
      run: toggleSidebar,
    },
    {
      id: "theme-system",
      label: "Aparência como o sistema",
      group: "Exibir",
      icon: <Monitor />,
      run: () => setTheme("system"),
    },
    {
      id: "theme-light",
      label: "Aparência clara",
      group: "Exibir",
      icon: <Sun />,
      keywords: "tema claro",
      run: () => setTheme("light"),
    },
    {
      id: "theme-dark",
      label: "Aparência escura",
      group: "Exibir",
      icon: <Moon />,
      keywords: "tema escuro",
      run: () => setTheme("dark"),
    },
    {
      id: "lock",
      label: "Bloquear o projeto",
      group: "Projeto",
      icon: <Lock />,
      shortcut: "Ctrl+Shift+L",
      run: lock,
    },
    { id: "switch", label: "Trocar de projeto", group: "Projeto", icon: <Repeat2 />, run: switchProject },
    { id: "signout", label: "Sair da conta", group: "Projeto", icon: <LogOut />, run: signOut },
    {
      id: "help",
      label: "Ajuda desta tela",
      group: "Ajuda",
      icon: <CircleHelp />,
      shortcut: "F1",
      run: () => setHelp(true),
    },
    ...(SHOW_CATALOG
      ? [
          {
            id: "catalog",
            label: "Catálogo de componentes",
            group: "Ajuda",
            icon: <FileUp />,
            run: () => void navigate({ to: "/catalogo" }),
          },
        ]
      : []),
  ];

  if (session.locked) {
    return (
      <LockScreen
        projectName={session.lockedName}
        onUnlock={(password) => actions.unlock(password)}
        onSignOut={signOut}
      />
    );
  }

  const onDragOver = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDragging(true);
  };
  const onDrop = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDragging(false);
    // The files wait in a shared store: Importar e revisar takes them once, whether it was already open or not.
    const count = addDroppedFiles(Array.from(event.dataTransfer.files));
    go("importar");
    notify(
      count === 1 ? "1 arquivo recebido em Importar e revisar." : `${count} arquivos recebidos em Importar e revisar.`,
    );
  };

  const rail = band === "wide" || band === "medium";
  const bottomItems = BOTTOM_NAV.map((id) => pageById(id))
    .filter((page): page is PageDef => Boolean(page))
    .map((page) => ({ ...navItem(page, attention), label: page.short ?? page.title }));
  const moreCount = PAGES.filter((page) => !BOTTOM_NAV.includes(page.id) && page.counted).reduce(
    (total, page) => total + (attention[page.id] ?? 0),
    0,
  );

  return (
    <div
      className="flex h-dvh flex-col bg-window"
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <a
        href="#conteudo"
        className="sr-only z-50 rounded-md bg-raised px-3 py-2 text-body font-semibold shadow-md focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Pular para o conteúdo
      </a>
      <TopBar
        band={band}
        account={session.account}
        open={session.open}
        sync={syncStateOf(session)}
        operatorId={session.operatorId}
        sidebarCollapsed={collapsed}
        theme={theme}
        undo={undo}
        onToggleSidebar={toggleSidebar}
        onOpenDrawer={() => setDrawer(true)}
        onPalette={() => setPalette(true)}
        onHelp={() => setHelp(true)}
        onLock={lock}
        onSwitchProject={switchProject}
        onSignOut={signOut}
        onOperator={actions.setOperator}
        onTheme={setTheme}
      />
      <div className="flex min-h-0 flex-1">
        {rail ? (
          <div
            className={cn(
              "shrink-0 transition-[width] duration-[var(--ov-duration-base)] ease-standard",
              collapsed ? "w-16" : "w-60",
            )}
          >
            <Sidebar
              groups={groups}
              footer={footer}
              selectedId={current?.id ?? null}
              onNavigate={go}
              collapsed={collapsed}
            />
          </div>
        ) : null}
        <main
          id="conteudo"
          tabIndex={-1}
          className={cn(
            "min-w-0 flex-1 overflow-y-auto bg-content outline-none",
            rail && "rounded-tl-xl border-t border-l border-separator",
            band === "tablet" && "border-t border-separator",
          )}
        >
          <motion.div
            key={pathname}
            initial={preset.enter.initial}
            animate={preset.enter.animate}
            transition={preset.enter.transition}
            className="mx-auto w-full max-w-[1680px] px-4 pt-5 pb-10 tablet:px-6 tablet:pt-6 wide:px-8"
          >
            {/* Closing the project or signing out: the page goes before the route guard redirects, and no
                screen may render without its project. */}
            {session.open ? <Outlet /> : null}
          </motion.div>
        </main>
      </div>
      {band === "phone" ? (
        <BottomNav
          items={bottomItems}
          selectedId={current?.id ?? null}
          onNavigate={go}
          onMore={() => setMore(true)}
          moreSelected={Boolean(current && !BOTTOM_NAV.includes(current.id))}
          moreCount={moreCount}
        />
      ) : null}

      <Sheet open={drawer && band === "tablet"} onOpenChange={setDrawer} title="Seções" side="left" hideTitle>
        <Sidebar
          groups={groups}
          footer={footer}
          selectedId={current?.id ?? null}
          onNavigate={go}
          header={<Wordmark className="px-5 pt-1 pb-2" />}
        />
      </Sheet>
      <Sheet open={more && band === "phone"} onOpenChange={setMore} title="Todas as seções" side="bottom">
        <Sidebar
          groups={groups}
          footer={footer}
          selectedId={current?.id ?? null}
          onNavigate={go}
          label="Todas as seções"
        />
      </Sheet>
      <CommandPalette open={palette} onOpenChange={setPalette} commands={commands} />
      <HelpDialog open={help} onOpenChange={setHelp} page={current} />
      {dragging ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-3 z-40 grid place-items-center rounded-xl border-2 border-dashed border-accent bg-accent-soft/80"
        >
          <span className="text-headline font-semibold text-accent">Solte para importar</span>
        </div>
      ) : null}
    </div>
  );
}
