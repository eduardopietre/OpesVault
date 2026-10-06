/**
 * Layouts suportados (desktop `CoverageDialog`): the support is declared per layout, never per bank name. A layout
 * without validation against real documents shows a warning at each import, so the items are checked against the
 * original. A document with no layout can be recorded by hand in the Livro.
 */
import { importing } from "@opesvault/domain";
import { Badge } from "@opesvault/ui";
import { Caption, FormDialog } from "./livro_form.tsx";

export function ImportCoverageDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <FormDialog open={open} onClose={onClose} title="Layouts suportados" closeOnly size="lg">
      <Caption>
        Layouts sem validação com documentos reais mostram um aviso a cada importação; confira os itens. Um documento
        sem layout pode ser registrado manualmente no Livro financeiro.
      </Caption>
      <div
        role="region"
        aria-label="Layouts suportados"
        tabIndex={0}
        className="max-h-[55dvh] overflow-auto rounded-lg border border-separator"
      >
        <table className="w-full min-w-[44rem] border-collapse text-body">
          <thead className="sticky top-0 bg-raised">
            <tr className="border-b border-separator text-left text-caption font-semibold text-secondary">
              {["Instituição", "Produto", "Formato", "Layout", "Versão", "Validado", "Limitações"].map((header) => (
                <th key={header} scope="col" className="px-3 py-2">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {importing.parsers.PARSERS.map((p) => (
              <tr key={p.id} className="border-b border-separator/60 align-top last:border-b-0">
                <td className="px-3 py-2 font-medium">{p.institution}</td>
                <td className="px-3 py-2">{p.product}</td>
                <td className="px-3 py-2">{p.doc_format.toUpperCase()}</td>
                <td className="px-3 py-2 font-mono text-caption">{p.id}</td>
                <td className="px-3 py-2">{p.version}</td>
                <td className="px-3 py-2">
                  {p.validated_with_real_documents ? (
                    <Badge tone="positive">sim</Badge>
                  ) : (
                    <Badge tone="warning">não (sintético)</Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-secondary">{p.limitations}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </FormDialog>
  );
}
