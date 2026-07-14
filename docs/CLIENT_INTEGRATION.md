# Client Integration

This project is a personal Local Agent Gateway API server. It is for safely delegating work from external clients to local agent workflows while keeping provider internals, including Codex App Server internals, behind server-side policy.

External clients can include CLI tools, web dashboards, desktop apps, mobile apps, automation bots, MCP integrations, CI helpers, and other developer tools. This repository does not implement any of those clients.

## Current Architecture

- Fastify exposes the authenticated Gateway API.
- Codex App Server runs only as an internal stdio JSON-RPC process.
- Repositories are selected by public repo IDs and resolved through the server-side allowlist.
- Workspaces are selected by public workspace IDs and resolved through the server-side workspace registry.
- Task providers are selected by registered public provider IDs. The default is `codex`; non-default providers require explicit `provider:<providerId>` scopes.
- Public task APIs expose Gateway `taskId`; Codex internal thread IDs and raw `cwd` values stay server-side.
- Tokens are scoped by operation, repo, workspace, task mode, and non-default provider use.
- Audit logs store prompt hashes and omitted prompt previews, not full prompts.
- Public text fields are scrubbed for common absolute local path patterns.
- Startup marks stale `queued` or `pending` tasks as failed because prompts and active runner handles are not durable.

## Existing API Compatibility

The following API shapes remain stable unless a breaking change is explicitly requested:

- `GET /healthz`
- `GET /v1/repos`
- `GET /v1/workspaces`
- `POST /v1/tasks`
- `GET /v1/tasks`
- `GET /v1/tasks/:id`
- `POST /v1/tasks/:id/interrupt`
- `POST /v1/tasks/:id/steer`
- `GET /v1/audit-logs`
- token management APIs
- Codex account APIs

New client-facing APIs should be additive. Existing task responses should not gain Codex internal IDs, raw paths, raw stream payloads, or other sensitive fields.

## Phase G0 / G1 Additions

Implemented in G1:

- Append-only `task_events` storage.
- `GET /v1/tasks` for authorized task listing with repo, status, and limit filters.
- `GET /v1/tasks/:id/events` as an authenticated Server-Sent Events replay and live event endpoint.
- Per-repo in-process serialization for `workspace-write` tasks; `read-only` tasks remain parallel.
- Configurable `read-only` concurrency with `CODEXGW_MAX_PARALLEL_READ_TASKS`.
- Minimal normalized Gateway domain events:
  - `task.queued`
  - `task.started`
  - `task.interrupted`
  - `task.steered`
  - `agent.message.completed`
  - `file.changed`
  - `diff.available`
  - `task.completed`
  - `task.failed`
- `Last-Event-ID` support for replay after a known event ID.
- A minimal `npm run smoke` check that loads the built app and verifies `GET /healthz`.

Existing task polling responses do not expose Codex internal IDs or raw paths. Task status can now be `queued`, `pending`, `completed`, or `failed`.

## Provider Selection

Implemented provider contract:

- `GET /v1/providers` returns public provider IDs and capabilities only.
- `POST /v1/tasks` accepts optional `provider`; omitted means `codex`.
- Unknown providers, registered providers without a connected runner, or provider/mode capability mismatches fail closed.
- Non-default providers require `provider:<providerId>` in addition to `task:create`, `repo:<repoId>`, and `mode:<mode>`.
- Gateway events and task responses may include public provider IDs, but never backend names, raw transports, or provider-native session IDs.

## Workspace Targets

Implemented workspace contract:

- `GET /v1/workspaces` returns public workspace IDs and policy ceilings only.
- `POST /v1/tasks` accepts exactly one target field: `repo` or `workspaceId`.
- Workspace tasks require both `workspace:<workspaceId>` and matching `repo:<repoId>` scopes.
- Unknown workspaces, mode ceilings, provider ceilings, raw `cwd`, and `workspacePath` fail closed.
- Public responses do not expose internal workspace paths or symlink-resolved paths.

## Diff Artifacts

Implemented after G1:

- `GET /v1/tasks/:id/diff` returns a generic task artifact for external clients that need to inspect changed files.
- Authorization matches `GET /v1/tasks/:id`: the creating token can read its own task; other tokens require `task:read` and `repo:<task.repo>`.
- The server resolves the allowlisted repo path internally and captures the artifact when the task completes.
- Patch capture uses only fixed git arguments with literal pathspec handling.
- `GET /v1/tasks/:id/diff` returns the stored artifact and does not inspect the live worktree at request time.
- Public responses contain Gateway `taskId`, repo ID, task status, repo-relative `changedFiles`, sanitized `patch`, a `truncated` flag, and artifact `createdAt`.

Clients cannot pass raw paths, shell commands, git arguments, or workspace roots to this endpoint.

## Structured Output

Implemented after task control:

- `POST /v1/tasks` accepts an optional `outputSchema` JSON Schema object (at most 16,000 serialized characters). The provider must declare the `structuredOutput` capability; requesting a schema from a provider without it fails closed with `PROVIDER_NOT_ALLOWED`.
- When a schema is set, the task's final answer is parsed as JSON and stored as a structured artifact. A final answer that does not parse fails the task with `STRUCTURED_OUTPUT_INVALID` — it never completes silently without the promised structure.
- `GET /v1/tasks/:id` returns the artifact as `structuredOutput` (`null` for tasks created without a schema). String leaf values are path-sanitized on egress with a JSON-aware pass, so clients always receive structurally valid JSON.
- Interrupted tasks skip structured parsing and complete without `structuredOutput`.

This is the integration surface for machine clients that need typed answers (for example, a review tool that requires `{verdict, confidence, summary, issues[]}`) instead of free text. Poll `GET /v1/tasks/:id` until terminal, then read `structuredOutput`.

## Task Control And Audit Logs

Implemented after diff artifacts:

- `POST /v1/tasks/:id/interrupt` controls only active process-local task sessions.
- `POST /v1/tasks/:id/steer` accepts a small `{ "message": "..." }` body for active sessions.
- The creating token can control its own task. A different token requires `task:read`, `task:control`, and `repo:<task.repo>`.
- Control requests append sanitized `task.interrupted` or `task.steered` events.
- `GET /v1/audit-logs` requires `audit:read` and returns sanitized records with optional filters.

These APIs still do not expose Codex internal thread IDs, turn IDs, raw `cwd`, or raw App Server payloads. Steering text is not stored in full.

See [`TASK_CONTROL.md`](TASK_CONTROL.md) for the control API guardrails and session model. See [`QUALITY.md`](QUALITY.md) for operational quality gates and known limits.

## APIs Not To Implement

Do not add:

- raw `cwd` APIs.
- public request fields that accept arbitrary absolute paths.
- arbitrary shell execution APIs.
- `danger-full-access` as a public task mode.
- public `thread/shellCommand`.
- generic Codex App Server JSON-RPC proxying.
- public App Server filesystem APIs.
- request bodies that accept OpenAI API keys, ChatGPT access tokens, refresh tokens, or session secrets.
- responses that expose Codex internal thread IDs.
- audit logs that store full prompts or secrets.

When authorization, repo policy, sandbox mode, workspace target policy, or token handling is unclear, deny the request.
