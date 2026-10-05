/** A destination whose screen arrives in a later phase: its header and an empty state that says what it is for. */
import { Button, EmptyState, PageHeader } from "@opesvault/ui";
import { useNavigate } from "@tanstack/react-router";
import type { PageDef } from "../pages.tsx";

export function PlaceholderPage({ page }: { page: PageDef }) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={page.title} context="Ainda não disponível na versão web" />
      <div className="rounded-xl border border-dashed border-separator-strong bg-window/40">
        <EmptyState
          icon={page.icon}
          title={`${page.title} chega numa próxima etapa`}
          description={
            <>
              <p>{page.about}</p>
              <p className="mt-2">
                Enquanto isso, a tela ocupa o seu lugar na navegação, com atalho e ajuda (F1). Etapa prevista:{" "}
                {page.phase}.
              </p>
            </>
          }
          actions={
            page.id === "visao-geral" ? null : (
              <Button onClick={() => void navigate({ to: "/visao-geral" })}>Voltar à Visão geral</Button>
            )
          }
        />
      </div>
    </div>
  );
}
