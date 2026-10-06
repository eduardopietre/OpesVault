/**
 * The solver of the internal rate of return, off the main thread. It receives the dated flows as text
 * ("2026-01-02", "-1000.00") and answers with the rate as text, or null with the reason: no ledger, no
 * secret, only numbers cross. Exact decimals are rebuilt from the text here and never pass through a float.
 */
import { Dec, investments } from "@opesvault/domain";

interface Request {
  id: number;
  dated: [string, string][];
}

type Reply = { id: number; rate: string | null; reason: string } | { id: number; error: true };

const scope = self as unknown as {
  onmessage: ((event: { data: Request }) => void) | null;
  postMessage(message: Reply): void;
};

scope.onmessage = (event) => {
  const { id, dated } = event.data;
  try {
    const flows = dated.map(([on, amount]) => [on, Dec.parse(amount)] as const);
    const [rate, reason] = investments.returns.xirrFromFlows(flows as never);
    scope.postMessage({ id, rate: rate === null ? null : rate.toFixed(), reason });
  } catch {
    scope.postMessage({ id, error: true });
  }
};
