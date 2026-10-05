# OpesVault web

The web version of OpesVault (docs/18): zero-knowledge, TypeScript, React. Porting rules are in
[PORTING.md](PORTING.md). Security is specified in `docs/19_SEGURANCA_WEB.md` (normative) and
self-hosting in `docs/20_HOSPEDAGEM.md`.

```
pnpm install
pnpm check                 # format, lint, typecheck and tests
pnpm dev                   # the app (Vite)
pnpm server                # the self-hosted server (development)
pnpm --filter @opesvault/server build   # the server as one bundle (dist/server.mjs)
docker compose up -d --build            # server + app behind Caddy (docs/20)
uv run python -m scripts.golden.generate   # from the repository root: reference files from the Python domain
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
