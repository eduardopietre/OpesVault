# OpesVault web

The web version of OpesVault (docs/18): zero-knowledge, TypeScript, React. How the domain was ported from the former desktop app, and what the
frozen reference files are, is in [PORTING.md](PORTING.md). Security is specified in `docs/19_SEGURANCA_WEB.md` (normative) and
self-hosting in `docs/20_HOSPEDAGEM.md`.

```
pnpm install
pnpm check                 # format, lint, typecheck and tests
pnpm dev                   # the app (Vite)
pnpm server                # the self-hosted server (development)
pnpm --filter @opesvault/app e2e        # end-to-end tests of the production build (fake services), at 1280x800 in light
pnpm --filter @opesvault/app e2e:full   # the same at every size (1920, 1280, 900, 768, 390), light and dark; before closing a phase
pnpm --filter @opesvault/app e2e:real   # the same build against the real server and SQLite (sign up, project, sync, plaintext scan)
pnpm --filter @opesvault/app perf       # a generated 50 000-entry project: opening, memory, Livro (build/perf/results.json, ~6 min)
pnpm --filter @opesvault/server build   # the server as one bundle (dist/server.mjs)
docker compose up -d --build            # server + app behind Caddy (docs/20)
```

| Folder                  | What                                                                              |
| ----------------------- | --------------------------------------------------------------------------------- |
| `packages/domain`       | Pure domain: money, ledger, cards, investments, tax, import, AI client, assistant |
| `packages/crypto`       | Argon2id, HKDF, AES-256-GCM, key envelope                                         |
| `packages/vault`        | Encrypted records, IndexedDB cache, offline queue, `SyncBackend` port             |
| `packages/backend-http` | `SyncBackend` over the self-hosted server                                         |
| `packages/ui`           | Design system: tokens, components, animations, charts                             |
| `apps/app`              | The React application                                                             |
| `apps/server`           | The self-hosted server (Hono)                                                     |
