# Quality and Operations

This project is security-sensitive local infrastructure. Quality is defined by preserving the Gateway boundary while making local operation predictable.

## Source of Policy

`policy_template.md` is the Codex-facing policy template for repository work. Use it as the short contract for task prompts, reviews, and future automation. The detailed user-facing behavior remains in this docs directory and `README.md`.

## Operational Guarantees

- Gateway startup fails any stale `queued` or `pending` tasks because prompts and active runner handles are not persisted.
- `workspace-write` tasks are serialized per repo.
- `read-only` tasks are limited by `CODEXGW_MAX_PARALLEL_READ_TASKS`.
- Workspace target selection uses server-side public IDs and requires matching workspace and repo scopes.
- Task provider selection uses registered public IDs. Non-default providers require explicit provider scopes.
- Active task control is process-local; after restart, interrupt and steer fail closed.
- Task events and diff artifacts are stored as Gateway artifacts, not Codex internal payloads.

## Verification Matrix

| Change type | Required checks |
| --- | --- |
| Auth, token, scope, repo policy, or sandbox behavior | Targeted tests plus `npm test`, `npm run typecheck`, `npm run lint` |
| Task lifecycle, queueing, events, control, or diff artifacts | Targeted task tests plus full `npm test` |
| Config or startup behavior | Config tests, startup/task tests, docs update |
| Public API shape or docs-visible behavior | Tests for compatibility or rejection, docs update |
| Release readiness | `scripts/verify.sh` |

## Review Checklist

- Public responses do not expose raw paths, Codex IDs, tokens, full prompts, or raw App Server payloads.
- New request fields are scoped, validated, documented, and reject unknown unsafe alternatives.
- Workspace targets never accept raw client paths and must preserve repo/provider/mode ceilings.
- New task providers declare capabilities before they can run tasks, and unsupported modes fail closed.
- Any new execution capability has an explicit deny case.
- Startup and restart behavior is documented.
- Tests include both allowed and denied paths for security-sensitive behavior.
- Docs describe operational limits rather than implying durable capabilities that do not exist.

## Known Limits

- Queued task prompts are not persisted, so queued tasks cannot be resumed after restart.
- Active Codex sessions are not durable across process restarts.
- Diff artifacts are captured from git state at task completion. Tracked staged and unstaged changes are included; untracked files may appear in `changedFiles` without a patch.
- This repository does not include a first-party CLI or dashboard client.
