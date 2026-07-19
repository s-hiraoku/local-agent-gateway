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
- `/readyz` probes App Server and requires a dedicated ChatGPT login.
- Coding execution is at-least-once across Gateway crashes.
- Only read-only coding is enabled.
- One App Server process is created per job.
- Queue and concurrency are bounded.
- RPC, turn, result, event, notification, and stderr paths are bounded or timed out.
- Prompts, results, and event payloads are AES-256-GCM encrypted in SQLite with record/field context bound as authenticated data.
- SQLite uses WAL, foreign keys, busy timeout, schema versioning, and mode `0600` for the main database file.
- Active jobs receive cancellation on graceful shutdown; shutdown waits up to 30 seconds.
- The latest successful retention-sweep timestamp and deleted-row counts survive Gateway restarts.

Back up the encryption key separately from the database. There is no key rotation workflow yet. Losing the key loses stored payloads; exposing both key and database exposes them.

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

- Real ChatGPT-authenticated structured coding and inference runs pass with the dedicated `CODEX_HOME`.
- Startup rejects a dedicated home containing `config.toml`; App Server receives an explicit environment allowlist.
- Cancellation, shutdown, crash recovery, SSE replay, retention, encrypted restart recovery, backup, rollback, and idempotent replay have automated or recorded live verification.
- The versioned macOS deployment binds to `127.0.0.1`, keeps bearer authentication enabled, and stores runtime secrets in the login Keychain.

## Remaining gates before untrusted external use

- Implement and prove the OS-level readable-root boundary in [Readable-root isolation design](READABLE_ROOT_ISOLATION.md).
- Verify authentication expiry and logout behavior inside the selected boundary.
- Add Codex CLI compatibility checks based on generated version-specific App Server schemas.
- Exercise slow-consumer behavior with a real network client under production limits.
- Implement transactional encrypted-payload key rotation and rehearse recovery after rotation.

Until those gates pass, the service is suitable only for trusted clients, a dedicated local service identity, and trusted repositories.
