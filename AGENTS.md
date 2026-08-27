# local-agent-gateway Guidance

This repository is a personal Local Agent Gateway API server. Treat it as security-sensitive infrastructure.

## Core Rules

- Keep changes small, reviewable, and directly tied to the task.
- Do not expose Codex App Server, Codex SDK internals, local filesystem paths, or raw `cwd` values through public APIs.
- Prefer denial over convenience when authorization, repo policy, sandbox mode, or token handling is unclear.
- Never add an arbitrary shell execution API.
- Never implement or expose `danger-full-access`.
- Do not store API tokens in plaintext, print them in logs, or return them except at creation time.
- Do not store full prompts in audit logs.
- Preserve public API behavior unless a breaking change is explicitly requested.
- Update docs when behavior, commands, configuration, security policy, or API shape changes.

## Harness

Project-local harness files live under `codex/`:

- `codex/skills/`: reusable workflows copied from `codex-harnesses`
- `codex/hooks/`: example hook payloads, not automatically enforced
- `codex/ledger/`: long-running task state and verification notes
- `policies/strict.yaml`: human-readable safety and verification policy
- `scripts/verify.sh`: repository verification entrypoint
- `scripts/checkpoint.sh`: checkpoint appender for `codex/ledger/current.md`

The hook scripts are examples. Review and adapt them before registering them in any Codex lifecycle configuration.

## Verification

Before finalizing meaningful changes, run the relevant checks:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `scripts/verify.sh`

Record important verification runs in `codex/ledger/verification.md` when work spans multiple sessions.

## Pull Requests

- Create normal, review-ready pull requests by default.
- Do not create draft pull requests unless the user explicitly asks for a draft.
- This keeps Codex automatic code review eligible to run when a pull request is opened.
- Cloud agents must create and update GitHub PRs with `gh`, authenticating as `GH_TOKEN="$GH_TOKEN_KAIZEN"` or `GH_TOKEN="$GH_TOKEN_PERSONAL"` (injected secrets). Do not rely on the default Cursor GitHub App token; it cannot create pull requests on this repository. Never print token values.

## Final Response

Summarize changed files, verification results, remaining risks, and follow-up work. Do not claim a check passed unless the command completed successfully.

## Cursor Cloud specific instructions

- Runtime: this project pins Node 26 (`.node-version` = 26.3.1, `engines` = `>=26 <27`) with pnpm 11.13.0. The VM's `/exec-daemon/node` is Node 22 and precedes nvm in `PATH`, so plain `node`/`pnpm` in a fresh non-interactive shell may resolve to the wrong runtime or be missing. Node 26.3.1 (via nvm) and a Node-26 global pnpm are installed in the snapshot; the agent `~/.bashrc` prepends `$HOME/.nvm/versions/node/v26.3.1/bin` to `PATH` so interactive terminals get Node 26 automatically. Node 26 does not bundle `corepack`, which is why pnpm is a global npm install rather than corepack-managed.
- Standard scripts are in `package.json` (`dev`, `build`, `typecheck`, `lint`, `test`, `smoke`, `verify`). `pnpm verify` chains lint + typecheck + test + build. `scripts/verify.sh` additionally checks policy docs and shell syntax.
- The server does NOT auto-load `.env`. `pnpm dev` (`tsx watch src/index.ts`) reads config only from real environment variables. To start it you must export at minimum: `CODEXGW_API_TOKEN` (>= 32 chars), `CODEXGW_DATA_ENCRYPTION_KEY` (exactly 32 bytes, base64), and `CODEXGW_REPOSITORIES_JSON` (required; may be `[]`, e.g. `[{"id":"gateway","path":"/workspace"}]`). Generate secrets with `openssl rand -base64 32`. Default bind is `127.0.0.1:8787`.
- The Codex CLI is not installed in this environment. `GET /readyz` and any endpoint that actually executes a turn (`/v2/conversations/:id/turns`, `/v2/coding/runs`, `/v2/inference/runs`) will not complete without it. Endpoints that exercise auth + encrypted SQLite persistence work without Codex: `GET /healthz`, `GET /v2/repositories`, `POST /v2/conversations`, `GET /v2/metrics`, and the Swagger UI at `/docs`. Use those for smoke-testing a running server. `pnpm smoke` runs fully in-process with a fake runner and needs no Codex CLI.
- GitHub PRs: use `gh` with `GH_TOKEN_KAIZEN` or `GH_TOKEN_PERSONAL`. Example: `GH_TOKEN="$GH_TOKEN_PERSONAL" gh pr create --repo s-hiraoku/local-agent-gateway ...`. The default `gh` login in this VM cannot create pull requests.
