# Local Agent Gateway V2 Policy

This repository is security-sensitive local infrastructure.

## Public boundary

- Public APIs accept Gateway IDs and strict capability schemas, never raw paths or backend payloads.
- Do not expose Codex App Server JSON-RPC, thread/turn IDs, stderr, command lines, local absolute paths, or upstream credentials.
- Never add an arbitrary shell endpoint, generic OpenAI proxy, raw filesystem endpoint, or `danger-full-access` mode.
- Do not accept ChatGPT tokens, OpenAI API keys, XAI API keys, or Cursor API keys in public request bodies.

## Current coding policy

- The only enabled coding mode is `read-only` with `approvalPolicy: never`.
- Repositories are resolved only from the server-side registry.
- App Server starts per job with a dedicated `CODEX_HOME` and environment allowlist.
- Prompts, results, and event payloads remain encrypted at rest and absent from logs.
- Queue, concurrency, protocol, event, result, stderr, and time limits must remain bounded.
- Idempotent API submission and at-least-once read-only execution are distinct guarantees.

Read-only is not a confidentiality boundary. An opt-in Lima executor can keep host and Gateway files out of the Codex VM (coding turns and Codex-backed inference) and fail-closes readiness unless the guest tool-isolation probe passes. Claude, Grok, and Cursor inference stay on the host. The default LaunchAgent still runs on the host. Do not represent the service as production-ready for untrusted prompts or repositories until the readable-root isolation gate in `docs/THREAT_MODEL.md` is verified.

## Current inference policy

- Inference takes no client `repositoryId` and runs against a Gateway-owned empty directory.
- Claude and Grok run headless with filesystem, shell, and network tools disabled. Cursor runs `@cursor/sdk` with built-in tools disabled.
- Do not accept Claude, Grok, XAI, or Cursor credentials in public request bodies.

## Future capabilities

- Write mode requires a job-specific worktree/copy and explicit patch or commit application. Do not blindly retry write attempts.
- Image and audio capabilities require separate OpenAI Platform adapters, scopes, budgets, artifacts, and retention rules.
- Multi-user support requires external identity, per-owner repository policy, quotas, revocation, audit retention, and tenant separation.

## Verification

Run before finalizing meaningful changes:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
scripts/verify.sh
```

Update API, operations, architecture, and threat-model documentation when their corresponding behavior changes.
