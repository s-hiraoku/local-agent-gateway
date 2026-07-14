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
- Coding execution is at-least-once across Gateway crashes.
- Only read-only coding is enabled.
- One App Server process is created per job.
- Queue and concurrency are bounded.
- RPC, turn, result, event, notification, and stderr paths are bounded or timed out.
- Prompts, results, and event payloads are AES-256-GCM encrypted in SQLite with record/field context bound as authenticated data.
- SQLite uses WAL, foreign keys, busy timeout, schema versioning, and mode `0600` for the main database file.
- Active jobs receive cancellation on graceful shutdown; shutdown waits up to 30 seconds.

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

## Release gates before real external use

- Run an actual ChatGPT-authenticated Codex App Server turn with the dedicated `CODEX_HOME`.
- Verify authentication persistence, expiry, logout behavior, and error normalization.
- Prove that personal MCP configuration is not loaded.
- Add and test an OS-level readable-root boundary that hides HOME, SSH, cloud credentials, other repositories, and Gateway secrets.
- Test cancel/complete/shutdown races and App Server crash recovery.
- Add Codex CLI compatibility checks based on generated version-specific App Server schemas.
- Exercise SSE reconnect and slow-consumer behavior with a real network client.
- Define encrypted-payload key rotation, retention cleanup, backup, and restore procedures.

Until those gates pass, the service is suitable only for trusted clients, a dedicated local service identity, and trusted repositories.
