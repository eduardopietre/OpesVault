/**
 * Reading documents off the main thread (docs/18 §3.5, desktop `pipeline.run_parser`): pdf.js, layout detection
 * and the parsers run here, as untrusted code over untrusted input. The domain's `serveParser` takes the bytes
 * and answers with plain JSON that the page validates before anything is stored. pdf.js runs inside this worker
 * the way `pdf.ts` runs it on the page: its worker module is preloaded into `globalThis.pdfjsWorker`, so no
 * nested worker is started and nothing is fetched.
 */
import { importing } from "@opesvault/domain";
import { browserExtractor } from "./pdf.ts";

importing.parserWorker.serveParser(self as unknown as importing.parserWorker.WorkerPort, browserExtractor());
