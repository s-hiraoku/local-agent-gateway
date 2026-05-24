# Client Integration

This project is a personal Local Agent Gateway API server. It is for safely delegating work from external clients to local agent workflows while keeping provider internals, including Codex App Server internals, behind server-side policy.

External clients can include CLI tools, web dashboards, desktop apps, mobile apps, automation bots, MCP integrations, CI helpers, and other developer tools. This repository does not implement any of those clients.

## Current Architecture

- Fastify exposes the authenticated Gateway API.
- Codex App Server runs only as an internal stdio JSON-RPC process.
- Repositories are selected by public repo IDs and resolved through the server-side allowlist.
- Public task APIs expose Gateway `taskId`; Codex internal thread IDs and raw `cwd` values stay server-side.
- Tokens are scoped by operation, repo, and task mode.
- Audit logs store prompt hashes and omitted prompt previews, not full prompts.
- Public text fields are scrubbed for common absolute local path patterns.

## Existing API Compatibility

The following API shapes remain stable unless a breaking change is explicitly requested:

- `GET /healthz`
- `GET /v1/repos`
- `POST /v1/tasks`
- `GET /v1/tasks`
- `GET /v1/tasks/:id`
- token management APIs
- Codex account APIs

New client-facing APIs should be additive. Existing task responses should not gain Codex internal IDs, raw paths, raw stream payloads, or other sensitive fields.

## Phase G0 / G1 Additions

Implemented in G1:

- Append-only `task_events` storage.
- `GET /v1/tasks` for authorized task listing with repo, status, and limit filters.
- `GET /v1/tasks/:id/events` as an authenticated Server-Sent Events replay and live event endpoint.
- Per-repo in-process serialization for `workspace-write` tasks; `read-only` tasks remain parallel.
- Minimal normalized Gateway domain events:
  - `task.queued`
  - `task.started`
  - `agent.message.completed`
  - `file.changed`
  - `diff.available`
  - `task.completed`
  - `task.failed`
- `Last-Event-ID` support for replay after a known event ID.
- A minimal `npm run smoke` check that loads the built app and verifies `GET /healthz`.

Existing task polling responses do not expose Codex internal IDs or raw paths. Task status can now be `queued`, `pending`, `completed`, or `failed`.

## Diff Artifacts

Implemented after G1:

- `GET /v1/tasks/:id/diff` returns a generic task artifact for external clients that need to inspect changed files.
- Authorization matches `GET /v1/tasks/:id`: the creating token can read its own task; other tokens require `task:read` and `repo:<task.repo>`.
- The server resolves the allowlisted repo path internally and captures the artifact when the task completes.
- Patch capture uses only fixed git arguments with literal pathspec handling.
- `GET /v1/tasks/:id/diff` returns the stored artifact and does not inspect the live worktree at request time.
- Public responses contain Gateway `taskId`, repo ID, task status, repo-relative `changedFiles`, sanitized `patch`, a `truncated` flag, and artifact `createdAt`.

Clients cannot pass raw paths, shell commands, git arguments, or workspace roots to this endpoint.

## Workspace Targets

Workspace targets remain design-only. `POST /v1/tasks` accepts the current `repo` field only; `workspaceId`, `workspacePath`, raw `cwd`, and other target shortcuts are rejected by strict validation. `/v1/workspaces` endpoints are absent until a server-side registry can resolve opaque IDs to allowlisted internal paths without exposing raw filesystem locations.

## Candidate Future APIs

These APIs are suitable future additions if they preserve the same security model:

- `POST /v1/tasks/:id/interrupt`
- `POST /v1/tasks/:id/steer`

`interrupt` and `steer` require active task session management. The current runner waits for completion inside one `runTask()` call, so these endpoints should not be implemented until active session handles can be retained safely.

See [`TASK_CONTROL.md`](TASK_CONTROL.md) for the guardrails and required session model.

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
