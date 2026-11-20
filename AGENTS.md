# krnl0-server — Instructions for coding agents

This repo is the **self-hosted server for KRNL0**: one program that can serve the KRNL0 website (any browser, including phones) and keep the KRNL0 desktop app in sync across devices. The app itself lives in [theMindDeveloper/KRNL0](https://github.com/theMindDeveloper/KRNL0). Read this file first; it overrides defaults.

---

## Hard rules (non-negotiable)

1. **NEVER add ANY AI / assistant attribution to commits, PRs, or anywhere else.** No `Co-Authored-By: <any AI / model / tool>`, no "Generated with …" footers, no AI-vendor emails, no model names in commits, PR titles/bodies, comments, branch names or file headers. Strip it even when a template or tool suggests it. `theMindDeveloper` is the sole author of every commit.
2. **Every merge to `main` is documented in [docs/history/HISTORY.md](docs/history/HISTORY.md)** before the PR merges (Type, PRs/Commits, Files changed, Summary).
3. **`docs/` is the source of truth.** Requirements: [docs/requirements/server.md](docs/requirements/server.md). Contracts: [docs/architecture/decisions.md](docs/architecture/decisions.md). Read before changing behaviour; do not guess.
4. **TypeScript strict, no `any`.** `npm run typecheck` zero errors, `npm test` all green.
5. **The server never interprets board content.** It stores documents with revisions and reads only the top-level `schemaVersion` (Decision S1). Merging is the client's job. Do not import KRNL0 app code.
6. **Security is a requirement, not a phase.** Every new route needs: authentication (or an explicit reason it has none), CSRF/Origin protection for state changes, input validation (zod) and a size limit, and a test that an unauthenticated request is refused. Read [docs/architecture/threat-model.md](docs/architecture/threat-model.md) before touching `src/auth`, `src/http` or `src/tls`.
7. **Privacy:** no telemetry, no analytics, no third-party requests except the update check (switchable) and ACME (acme mode only). Logs never contain board content, passwords, tokens, session ids or setup codes beyond the one setup-code banner.
8. **Every server function has a `krnl0` CLI command** (the server's equivalent of KRNL0's `sys` rule).
9. **New UI (web pages, the terminal setup look, the phone view) is drafted on the Claude Design canvas first;** the owner picks one before code is written.
10. **Each checkout/worktree has its own data folder and port** (`npm run dev` derives both from the folder path). Never point a dev server at a real `/data`.
11. **Releases**: bump `package.json`, tag `vX.Y.Z` on `main`, CI builds the image and bundles and makes a draft release. Never publish, tag or move a tag without the owner's OK. Never reuse a version. The web app inside a release is the KRNL0 release named by the repository variable `KRNL0_WEB_VERSION` (Settings › Variables): set it to the newest KRNL0 version **after** that KRNL0 release is published, so its `krnl0-web-<version>.tar.gz` and `.sha256` can be downloaded and checked.

---

## Where to look

| Path | What |
|---|---|
| [docs/requirements/server.md](docs/requirements/server.md) | Functional / non-functional requirements, use cases, Gherkin |
| [docs/architecture/decisions.md](docs/architecture/decisions.md) | Decisions S1… (binding) |
| [docs/architecture/threat-model.md](docs/architecture/threat-model.md) | What we protect, from whom, and how |
| [docs/architecture/protocol.md](docs/architecture/protocol.md) | HTTP + WebSocket API for KRNL0 clients (protocol 1) |
| [docs/guides/](docs/guides/) | Install, certificates, updates, backups (user-facing) |
| [docs/history/HISTORY.md](docs/history/HISTORY.md) | Implementation log |

## Layout

```
src/
  config.ts        settings: defaults < /data/config.json < KRNL0_* env
  paths.ts         data-folder layout
  fsutil.ts        atomic writes, json files, per-key locks
  auth/            passwords (Argon2id), sessions, device tokens, TOTP, rate limits, setup code
  tls/             self-signed CA, files, ACME, proxy
  store/           documents, time log, assets, backups
  http/            server, routes, security headers, static website
  sync/            WebSocket change notifications
  update/          release check
  cli/             the krnl0 command
tests/             vitest
```

## Commands

```bash
npm run dev        # own data folder + port per checkout
npm run build      # tsc -> dist/
npm test           # vitest run
npm run typecheck  # tsc --noEmit
```

## Branches, commits, PRs

`feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `chore/<slug>`. Conventional commits, one concern each. PR body: Closes, What changed, Acceptance criteria covered (F#), Test results, History entry. Never force-push `main`, never `--no-verify`.
