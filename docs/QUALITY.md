# Quality and Operations

## Supported baseline

- Node.js 26 only; `.node-version` pins the preferred patch.
- pnpm 11.13 with a frozen lockfile.
- TypeScript 7 strict ESM.
- Fastify 5, TypeBox/Ajv, Kysely, and better-sqlite3.
- One Gateway process and one SQLite writer on a private single host.

Native dependency build scripts are denied by pnpm except for the version-locked `better-sqlite3` and `esbuild` packages. Newly published packages are subject to the repository supply-chain age policy; the two initial pinned exceptions are explicit in `pnpm-workspace.yaml`.

## Execution guarantees

- API submission is idempotent when clients preserve `Idempotency-Key`.
- Stateless run conversation creation and submission are one transaction.
- Structured results are exact-JSON parsed and locally schema-validated before completion.
- `/readyz` always probes Codex App Server, requires a dedicated ChatGPT login, and fails closed when the Codex CLI version is outside the supported range. When inference is not Codex, it also probes that backend for presence (CLI binary or Cursor SDK), not authentication. Operator login, job routing, and the private App Server method surface are in [Codex App Server](CODEX_APP_SERVER.md).
- Read-only coding and repository-free inference are at-least-once across Gateway crashes.
- Only read-only modes are enabled.
- Each Codex job starts one App Server process. Claude and Grok start one CLI process. Cursor runs `@cursor/sdk` in-process.
- Queue and concurrency are bounded.
- RPC, turn, result, event, notification, and stderr paths are bounded or timed out.
- Prompts, results, and event payloads are AES-256-GCM encrypted in SQLite with record/field context bound as authenticated data.
- SQLite uses WAL, foreign keys, busy timeout, schema versioning, and mode `0600` for the main database file.
- Active jobs receive cancellation on graceful shutdown; shutdown waits up to 30 seconds.
- The latest successful retention-sweep timestamp and deleted-row counts survive Gateway restarts.

Back up the encryption key separately from the database. Rotate it only while the Gateway is stopped, using `pnpm rotate-key` with `CODEXGW_DATA_ENCRYPTION_KEY_NEW`. Losing the key loses stored payloads; exposing both key and database exposes them. After rotation, discard the old key and treat existing `Idempotency-Key` hashes as new requests.

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
scripts/verify.sh
```

CI repeats clean installation, lint, typecheck, tests, build, and harness verification on Node.js 26.

## Trusted-local release evidence

- Real structured coding runs pass with the dedicated ChatGPT-authenticated `CODEX_HOME`. Inference evidence uses that same Codex path by default, or the selected Claude, Grok, or Cursor backend.
- Startup rejects a dedicated home containing `config.toml`; App Server receives an explicit environment allowlist.
- Cancellation, shutdown, crash recovery, SSE replay, retention, encrypted restart recovery, backup, rollback, and idempotent replay have automated or recorded live verification.
- The versioned macOS deployment binds to `127.0.0.1`, keeps bearer authentication enabled, and stores runtime secrets in the login Keychain.
- The optional Responses compatibility surface has exact-field rejection tests and is parsed end to end by the official OpenAI JavaScript SDK in synchronous and SSE modes.

## Remaining gates before untrusted external use

- Record live Lima acceptance evidence with `scripts/lima/accept.sh` plus ChatGPT-authenticated coding and Codex-backed inference runs. Lima wraps Codex App Server only; Claude, Grok, and Cursor stay on the host. The opt-in executor fail-closes `/readyz` unless the guest tool-isolation probe passes. The default LaunchAgent still runs Codex on the host.
- Verify authentication expiry and logout behavior inside the selected boundary.
- Keep the Codex CLI pin inside `SUPPORTED_CODEX_CLI_RANGE` after verifying a new CLI; generated version-specific App Server schemas remain a follow-up.
- Exercise slow-consumer behavior with a real network client under production limits.
- Rehearse recovery after an encryption-key rotation on the installed service, including Keychain replacement.

Until those gates pass, the service is suitable only for trusted clients, a dedicated local service identity, and trusted repositories.
