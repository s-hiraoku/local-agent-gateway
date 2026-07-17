# Verification Log

Use this file to record meaningful verification runs.

## Template

### YYYY-MM-DD HH:MM

- Command:
- Scope:
- Result:
- Notes:

## Runs

### 2026-05-05 11:11

- Command: `npm run typecheck`
- Scope: TypeScript project
- Result: Passed
- Notes: Initial development foundation.

### 2026-05-05 11:11

- Command: `npm test`
- Scope: Vitest health route test
- Result: Passed
- Notes: Initial run passed.

### 2026-05-05 11:11

- Command: `npm run lint`
- Scope: ESLint project
- Result: Passed
- Notes: Initial run passed.

### 2026-05-05 11:11

- Command: `npm run build`
- Scope: TypeScript emit
- Result: Passed
- Notes: Initial run passed; build script was then narrowed to `tsconfig.build.json` so tests are not emitted.

### 2026-05-05 11:11

- Command: `scripts/verify.sh`
- Scope: Harness verification entrypoint
- Result: Passed
- Notes: Ran lint, typecheck, test, and build.

### 2026-05-05 11:12

- Command: `scripts/verify.sh`
- Scope: Harness verification entrypoint after config cleanup
- Result: Passed
- Notes: Confirmed Vitest excludes generated `dist/**` tests and build uses `tsconfig.build.json`.

### 2026-05-05 11:12

- Command: `npm run dev` and `curl -sS http://127.0.0.1:8787/healthz`
- Scope: Local development server smoke test
- Result: Passed
- Notes: Server returned `{"ok":true}`. Dev process was stopped after the smoke test.

### 2026-05-05 11:17

- Command: `bash -n scripts/checkpoint.sh && bash -n scripts/verify.sh`
- Scope: Repository-managed harness scripts
- Result: Passed
- Notes: Confirmed shell syntax for both harness scripts.

### 2026-05-05 11:17

- Command: `scripts/verify.sh`
- Scope: Repository-managed harness verification
- Result: Passed
- Notes: Ran lint, typecheck, test, and build after adding `codex/README.md` and `scripts/checkpoint.sh`.

### 2026-05-05 11:34

- Command: `scripts/verify.sh`
- Scope: Secure Gateway MVP
- Result: Passed
- Notes: Ran lint, typecheck, 26 Vitest tests, and build after final security-review fixes.

### 2026-05-05 11:35

- Command: `npm run dev` and `curl -sS http://127.0.0.1:8787/healthz`
- Scope: Local development server smoke test
- Result: Passed
- Notes: Server returned `{"ok":true}`. Dev process was stopped after the smoke test.

### 2026-05-05 11:41

- Command: `scripts/verify.sh`
- Scope: Node 24 runtime requirement update
- Result: Passed
- Notes: Ran lint, typecheck, 26 Vitest tests, and build with local Node `v24.12.0`.

### 2026-05-06 11:00

- Command: `scripts/verify.sh`
- Scope: Codex App Server backend migration and account auth routes
- Result: Passed
- Notes: Ran lint, typecheck, 34 Vitest tests, and build after adding stdio JSON-RPC App Server adapter, scoped account routes, and provider/backend task metadata.

### 2026-05-06 11:10

- Command: `./node_modules/.bin/codex app-server generate-ts --out /private/tmp/codex-app-server-schema`
- Scope: Local Codex App Server protocol schema check
- Result: Passed
- Notes: Confirmed app-server protocol generation works for local `codex-cli 0.128.0`; adjusted sandbox and params wire shapes to generated schema.

### 2026-05-06 11:10

- Command: `node --input-type=module -e '<app-server initialize/account-read smoke test>'`
- Scope: Real local Codex App Server stdio smoke test
- Result: Passed
- Notes: Spawned local app-server, completed `initialize`/`initialized`, and verified `account/read` returns an object without printing account details.

### 2026-05-06 11:11

- Command: `node --input-type=module -e '<app-server thread/turn smoke test>'`
- Scope: Real local Codex App Server turn execution smoke test
- Result: Passed
- Notes: First sandboxed attempt could not access `~/.codex/sessions`; reran outside the sandbox with approval, then completed `thread/start`, `turn/start`, and `turn/completed` with read-only sandbox policy.

### 2026-05-06 11:10

- Command: `scripts/verify.sh`
- Scope: App Server schema alignment and per-task connection update
- Result: Passed
- Notes: Ran lint, typecheck, 34 Vitest tests, and build after changing task runs to isolated App Server stdio connections.

### 2026-05-06 11:41

- Command: `scripts/verify.sh`
- Scope: PR #3 rebase onto updated `origin/main`
- Result: Passed
- Notes: Ran lint, typecheck, 34 Vitest tests, and build after resolving README conflict and preserving user guide plus token/account bootstrap scopes.

### 2026-05-06 11:42

- Command: `scripts/verify.sh`
- Scope: PR #3 guardian feedback fix
- Result: Passed
- Notes: Ran lint, typecheck, 35 Vitest tests, and build after adding immediate JSON-RPC error responses for unsupported app-server initiated requests.

### 2026-05-06 11:48

- Command: `scripts/verify.sh`
- Scope: Documentation coverage for Codex App Server account/backend behavior
- Result: Passed
- Notes: Ran lint, typecheck, 35 Vitest tests, and build after updating `docs/index.md` to cover internal App Server transport, account auth endpoints/scopes, and new backend configuration.

### 2026-05-07 09:04

- Command: `scripts/verify.sh`
- Scope: MVP async task flow, CI workflow, GitHub Pages guide, and codex-harnesses import
- Result: Passed
- Notes: Ran lint, typecheck, 37 Vitest tests, and build after changing task creation to return `202 Accepted` with background execution and polling.

### 2026-05-07 09:20

- Command: `scripts/verify.sh`
- Scope: PR #6 guardian review feedback
- Result: Passed
- Notes: Ran lint, typecheck, 39 Vitest tests, and build after allowing creating tokens to poll their own async tasks without broad `task:read`.

### 2026-05-07 20:03

- Command: `npm run lint && npm run typecheck && npm test && npm run build && npm run smoke`
- Scope: MVP local API smoke check
- Result: Passed
- Notes: Added an in-process smoke check for health, bootstrap token creation, scoped repo listing, async task creation/polling, and internal thread ID non-exposure.

### 2026-05-07 20:03

- Command: `scripts/verify.sh`
- Scope: Repository verification after MVP smoke docs update
- Result: Passed
- Notes: Ran lint, typecheck, 39 Vitest tests, and build.

### 2026-05-07 20:10

- Command: `npm run smoke && npm run lint && npm run typecheck && scripts/verify.sh`
- Scope: Codex review feedback fix for smoke allowlist isolation
- Result: Passed
- Notes: Confirmed the smoke check seeds its own allowlist before importing app code; also passed with an unrelated `CODEXGW_ALLOWED_REPOS_JSON` already present in the environment.

### 2026-05-08 21:45

- Command: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run smoke`, `scripts/verify.sh`
- Scope: Workspace target guardrails
- Result: Passed
- Notes: Added regression coverage for rejecting workspace target request fields and keeping `/v1/workspaces` endpoints absent until a server-side registry exists.

### 2026-05-25 06:56

- Command: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `scripts/verify.sh`
- Scope: Active task control and audit log API
- Result: Passed
- Notes: Added process-local task control handles, interrupt/steer endpoints, audit log listing, docs, and regression coverage. Full suite reports 65 Vitest tests.

### 2026-05-26 08:18

- Command: `node --input-type=module -e '<live Codex App Server steer/interrupt smoke>'`
- Scope: Real Codex App Server task control
- Result: Passed
- Notes: Verified live `turn/steer` and `turn/interrupt` through `CodexAppServerClient` with `CODEX_APP_SERVER_MODEL=gpt-5.4-mini`; both completed with no changed files. An initial run without a model override exposed a local default model/account mismatch, so `CODEX_APP_SERVER_MODEL` was added to make Gateway runs reproducible.

### 2026-05-26 08:18

- Command: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `scripts/verify.sh`
- Scope: Model override hardening after live control smoke
- Result: Passed
- Notes: Full suite reports 66 Vitest tests after adding `CODEX_APP_SERVER_MODEL` config, docs, and `.env.example` coverage.

### 2026-05-27 07:34

- Command: `npx vitest run tests/config.test.ts tests/tasks.test.ts`
- Scope: Operational readiness task lifecycle changes
- Result: Passed
- Notes: Targeted coverage for read-only queueing, startup stale task failure, and new config validation. Targeted run reports 34 Vitest tests.

### 2026-05-27 07:34

- Command: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run smoke`, `scripts/verify.sh`
- Scope: Practical local operation and quality policy documentation
- Result: Passed
- Notes: Full suite reports 69 Vitest tests. `scripts/verify.sh` now also checks that `policy_template.md` and `docs/QUALITY.md` are present.

### 2026-06-08 00:13

- Command: `npm rebuild better-sqlite3`, `npx vitest run tests/authorize.test.ts tests/auth.test.ts tests/tasks.test.ts tests/providers.test.ts`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `npm run smoke`, `scripts/verify.sh`
- Scope: Task provider selection groundwork for future non-Codex agent integrations
- Result: Passed
- Notes: Rebuilt the local native sqlite dependency after a Node ABI mismatch. Targeted provider/auth/task coverage passed, full suite reports 71 Vitest tests, smoke passed with the existing Node `module.register()` deprecation warning, and repository verification completed.

### 2026-06-09 00:24

- Command: `npx vitest run tests/policy.test.ts tests/auth.test.ts tests/authorize.test.ts tests/config.test.ts tests/providers.test.ts`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`, `scripts/verify.sh`
- Scope: Workspace target registry and provider adapter contract
- Result: Passed
- Notes: Added server-side workspace target selection, workspace scopes, workspace listing, task creation by `workspaceId`, provider adapter typing, docs, and regression coverage. Full suite reports 75 Vitest tests. Smoke passed with the existing Node `module.register()` deprecation warning.

### 2026-07-14 11:03

- Command: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm smoke`, `scripts/verify.sh`; Decision-Agent `python -m unittest discover -s tests`, `uv run pyright`; cross-repository HTTP process E2E
- Scope: Gateway V2 structured one-shot coding runs and Decision-Agent migration
- Result: Passed except real subscription authentication
- Notes: Gateway reports 26 Vitest tests. Decision-Agent reports 60 unittest cases and zero pyright errors. An actual Decision-Agent CLI request completed through the running Gateway, SQLite job worker, and a separate fake App Server stdio process. `codex-cli 0.144.0` is installed, but the dedicated `~/.codex-gateway` reports `Not logged in`, so a real ChatGPT subscription turn remains an operator verification step.

### 2026-07-15

- Command: live Decision-Agent CLI review through a temporary Gateway V2 process and `codex-cli 0.144.0` App Server
- Scope: Dedicated `CODEX_HOME` ChatGPT authentication, readiness, and subscription-backed structured output
- Result: Passed
- Notes: `CODEX_HOME=~/.codex-gateway` reported `Logged in using ChatGPT`; `/readyz` passed its real `account/read` probe. Decision-Agent completed a live structured review through the Gateway and returned a schema-valid `revise` verdict with confidence `0.99`. Gateway bearer and encryption secrets existed only in the temporary process environment, and the temporary database was removed after the run.

### 2026-07-15 (release continuation)

- Command: live structured coding run, terminal SSE fetch, Gateway restart with the same SQLite database, idempotent replay; `scripts/verify.sh`; `pnpm smoke`; Decision-Agent unittest and pyright
- Scope: Local single-owner MVP release readiness
- Result: Passed for trusted local operation
- Notes: A second real subscription-backed job completed with `{ "ok": true }`. Unauthenticated repository access returned 401, terminal SSE included `job.completed` without exposing the configured absolute repository path, and the encrypted completed result remained readable after a full Gateway restart. Reusing the same request and idempotency key returned the original job with `replayed: true`. Gateway reports 26 passing Vitest tests plus successful lint, typecheck, build, policy, and smoke checks. Decision-Agent reports 60 passing tests and zero pyright errors. The dedicated Codex directory is mode 0700 and `auth.json` is mode 0600; no database, auth file, or `.env` was left in either repository.

### 2026-07-16

- Command: PR Guardian feedback fixes; `scripts/verify.sh`; `pnpm smoke`; live structured Codex App Server turn
- Scope: PR #18 Codex and CodeRabbit review feedback
- Result: Passed
- Notes: Replaced readline protocol buffering with byte-bounded framing, bounded queued notification bytes, consumed final agent text from `item/completed`, hardened cross-chunk path redaction, bounded final messages, normalized Codex error variants, and made cancellation terminal transitions atomic. All 33 Vitest tests, lint, typecheck, build, policy checks, and smoke passed. A real ChatGPT-authenticated structured turn completed with `{ "ok": true }` after the protocol changes.

### 2026-07-16 (PR Guardian continuation)

- Command: `scripts/verify.sh`; Decision-Agent `PYTHONPATH=src python -m unittest discover -s tests`, `uv run pyright`
- Scope: GitHub Actions Node 24 runtime warnings on PR #18 and Decision-Agent PR #6
- Result: Passed
- Notes: Updated affected CI actions to current Node 24-compatible releases and pinned each action to an immutable commit. Refined output sanitization so API routes and HTTP URLs remain valid while local paths and file URLs stay redacted. Crash recovery now atomically emits the terminal cancellation event for interrupted cancelled jobs. Gateway reports 35 passing Vitest tests plus successful lint, typecheck, build, and policy checks. Decision-Agent reports 60 passing tests and zero pyright errors.

### 2026-07-15 (local production)

- Command: `scripts/verify.sh`; installed macOS LaunchAgent; `gatewayctl status`; authenticated and unauthenticated repository requests; forced process crash; `gatewayctl backup`; live Decision-Agent LLM review
- Scope: Single-owner local-production deployment through a versioned release, login Keychain, and launchd
- Result: Passed after installer portability fixes
- Notes: Gateway reports 37 passing Vitest tests plus successful lint, typecheck, build, policy, and zsh syntax checks. The installed service uses a copied Node 26 arm64 runtime and matching arm64 better-sqlite3 addon, listens only on `127.0.0.1:8787`, returns 401 without the bearer token and 200 with it, recovered after SIGKILL, and produced a mode-0600 stopped-service SQLite backup. A live Decision-Agent request completed through the resident Gateway with `engine: llm:gateway:codex`. Initial installation attempts safely exposed and then fixed Codex status stderr handling, Volta shim resolution, native-addon architecture reuse, and asynchronous backup restart readiness.
