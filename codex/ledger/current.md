# Current Task Ledger

## Current Goal

- Goal: Operate and harden a secure personal Codex Gateway API server.
- Owner: Codex
- Started: 2026-05-05
- Status: Trusted local V2 is operational; confidentiality hardening remains in progress.

## Context

- Repository: local-agent-gateway
- Target branch: `main`
- Related PRs: #23 (merged metrics), #25 (hardening documentation and Renovate), #13 (superseded Renovate onboarding), #33 (readable-root VM)
- Important files: `README.md`, `docs/THREAT_MODEL.md`, `docs/READABLE_ROOT_ISOLATION.md`, `docs/LOCAL_PRODUCTION.md`, `src/`, `tests/`, `scripts/verify.sh`

## Delivered

- [x] Authenticated read-only coding conversations and atomic structured runs
- [x] Repository-free structured inference runs
- [x] Durable encrypted SQLite jobs, attempts, events, idempotency, and retention
- [x] Bounded Codex App Server execution, cancellation, recovery, and SSE
- [x] Authenticated SQLite-derived operational metrics
- [x] Windowed rate-limit hits by backend in `/v2/metrics` (Issue #32)
- [x] Restart-durable retention-sweep timestamp and deleted-row metrics (Issue #24)
- [x] Transactional encryption-key rotation with a stored sentinel (Issue #31)
- [x] Versioned macOS LaunchAgent deployment, backup, rollback, and Keychain secrets
- [x] CI, smoke tests, policy checks, and local-production verification

## Active Hardening

- [x] Record the readable-root threat and an implementation-ready isolation design
- [x] Define a conservative Renovate policy with no automerge
- [x] Codex CLI version pin and App Server contract checks (`CODEX_UNSUPPORTED_VERSION`)
- [x] Select Lima (`vz`) and implement the opt-in executor (`CODEXGW_CODEX_EXECUTOR=lima`)
- [x] Guest `bwrap` wrapper, hostname-resolved egress, and fail-closed isolation probe
- [ ] Verify real Codex login and structured runs inside that boundary
- [ ] Prove a real Codex tool subprocess cannot read `CODEX_HOME`
- [ ] Migrate the installed service only after backup and rollback rehearsal

## Deferred Backlog

- Codex CLI generated-schema compatibility checks beyond the version pin
- write-capable worktrees and patch/commit artifacts
- image, audio, and realtime capability adapters
- artifact retention and telemetry exporters
- multi-user identity, tenant isolation, and per-owner policy

These are explicit follow-up projects, not omissions from the current hardening task.

## Blockers

- Live Lima acceptance evidence and LaunchAgent migration still require operator-run VM work. The default executor remains `host`.

## Next Step

- Create the Lima instance from `scripts/lima/codexgw.yaml`, run `scripts/lima/install-guest-helpers.sh` and `scripts/lima/accept.sh`, authenticate the guest Codex home, and record live coding/inference evidence before treating untrusted prompts or repositories as supported.

## Checkpoints

`scripts/checkpoint.sh` appends entries here.
