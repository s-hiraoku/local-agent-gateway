# Local Agent Gateway Policy Template

Use this template as the Codex task policy for changes to this repository. It is intentionally stricter than a generic Node.js service policy because this server is the public boundary around local agent execution.

## Mission

Build a personal Gateway API that lets external clients delegate work to local Codex workflows without exposing Codex App Server internals, local filesystem paths, raw working directories, tokens, or unsafe execution controls.

## Non-Negotiable Constraints

- Do not expose Codex thread IDs, turn IDs, App Server JSON-RPC payloads, raw `cwd`, absolute local paths, token hashes, raw tokens, full prompts, or full steering text through public APIs, events, logs, or artifacts.
- Do not add arbitrary shell execution, raw filesystem APIs, public App Server proxying, public `thread/shellCommand`, or `danger-full-access`.
- Do not accept OpenAI API keys, ChatGPT access tokens, refresh tokens, or session secrets in Gateway request bodies.
- Resolve repos and future workspaces only through server-side allowlists and opaque public IDs.
- Select task providers only through registered public provider IDs; never expose provider-native session IDs, transports, or raw payloads.
- Prefer denial when auth, scope, repo, workspace target, sandbox, token lifetime, or audit behavior is ambiguous.

## Task Execution Policy

- Public task modes are only `read-only` and `workspace-write`.
- Public task providers must declare capabilities before use. Non-default providers require explicit `provider:<providerId>` scopes.
- Codex execution must use `approvalPolicy: "never"`.
- Codex execution must disable network access unless a future policy explicitly proves a narrower safe alternative.
- `workspace-write` access must be limited to the allowlisted repo or workspace root.
- Active task control must use Gateway task IDs and server-side handles only.
- After Gateway startup, stale `queued` or `pending` tasks must fail closed unless prompts and runner handles have a durable recovery design.

## API Compatibility Policy

- Preserve existing public API shapes unless the task explicitly requests a breaking change.
- New client-facing behavior should be additive and documented.
- Request schemas should reject unknown fields when they carry policy or security meaning.
- Public responses should remain client-neutral; do not leak implementation backend choices beyond documented provider capability metadata.

## Quality Gates

Run the narrowest useful tests while iterating, then the full verification set before finalizing meaningful changes:

```bash
npm run lint
npm run typecheck
npm test
npm run build
scripts/verify.sh
```

For behavior changes, add or update tests first enough to define the contract. For security-sensitive changes, add negative tests for forbidden inputs, missing scopes, and redaction.

## Documentation Gates

Update docs when behavior, commands, configuration, API shape, task lifecycle, security policy, or operational expectations change.

Minimum docs to consider:

- `README.md` for developer/operator quickstart and security summary.
- `docs/index.md` for user-facing API and operations guidance.
- Focused docs under `docs/` for client integration, event streaming, task control, workspace targeting, and quality process.
- This `policy_template.md` when the governing policy itself changes.

## Commit Policy

Prefer small ordered commits:

1. Contract or policy docs.
2. Focused implementation.
3. Tests and verification updates.
4. Follow-up docs cleanup.

Do not mix unrelated refactors with behavior changes.
