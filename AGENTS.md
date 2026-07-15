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

## Final Response

Summarize changed files, verification results, remaining risks, and follow-up work. Do not claim a check passed unless the command completed successfully.
