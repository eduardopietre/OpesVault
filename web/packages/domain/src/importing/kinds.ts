/** Import modules that register persisted kinds (part of `registry.ts`). */
import "./model.ts";
import "./rules.ts";
// TODO(W6-integration): `attachment` is a domain kind (`domain/attachments.py` is in the desktop's
// registry.MODULES); move this import to `domain/kinds.ts`, owned by the W4 port.
import "../domain/attachments.ts";
