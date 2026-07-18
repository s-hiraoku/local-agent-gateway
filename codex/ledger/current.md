# Current Task Ledger

## Current Goal

- Goal: Operate and harden a secure personal Codex Gateway API server.
- Owner: Codex
- Started: 2026-05-05
- Status: Trusted local V2 is operational; confidentiality hardening remains in progress.

## Context

- Repository: local-agent-gateway
- Target branch: `main`
- Related PRs: #23 (merged metrics), #25 (hardening documentation and Renovate), #13 (superseded Renovate onboarding)
- Important files: `README.md`, `docs/THREAT_MODEL.md`, `docs/READABLE_ROOT_ISOLATION.md`, `docs/LOCAL_PRODUCTION.md`, `src/`, `tests/`, `scripts/verify.sh`

## Delivered

- [x] Authenticated read-only coding conversations and atomic structured runs
- [x] Repository-free structured inference runs
- [x] Durable encrypted SQLite jobs, attempts, events, idempotency, and retention
- [x] Bounded Codex App Server execution, cancellation, recovery, and SSE
- [x] Authenticated SQLite-derived operational metrics
- [x] Versioned macOS LaunchAgent deployment, backup, rollback, and Keychain secrets
- [x] CI, smoke tests, policy checks, and local-production verification

## Active Hardening

- [x] Record the readable-root threat and an implementation-ready isolation design
- [x] Define a conservative Renovate policy with no automerge
- [ ] Select and provision the VM/runtime used for the readable-root boundary
- [ ] Verify real Codex login and structured runs inside that boundary
- [ ] Migrate the installed service only after backup and rollback rehearsal

## Deferred Backlog

- Codex CLI generated-schema/version compatibility checks
- transactional encryption-key rotation
- durable retention-sweep observability (Issue #24)
- write-capable worktrees and patch/commit artifacts
- image, audio, and realtime capability adapters
- artifact retention and telemetry exporters
- multi-user identity, tenant isolation, and per-owner policy

These are explicit follow-up projects, not omissions from the current hardening task.

## Blockers

- A real readable-root boundary requires an operator-selected VM/runtime, credential supervisor, network policy, and host-level migration. Repository changes alone cannot safely provision or authenticate it.
- Decision owner: the human operator must approve the VM/runtime, guest networking, credential migration, backup, and rollback plan before host changes begin.

## Next Step

- Review `docs/READABLE_ROOT_ISOLATION.md`, choose the VM/runtime, and run the documented proof before treating untrusted prompts or repositories as supported.

## Checkpoints

`scripts/checkpoint.sh` appends entries here.
