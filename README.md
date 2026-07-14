# local-agent-gateway

Personal Local Agent Gateway API server for safely delegating work from external tools to local agent workflows.

The gateway is the only HTTP API that should be exposed outside the machine. Codex App Server internals, repository paths, raw `cwd` values, and dangerous execution modes stay behind server-side policy.

OpenAI's Codex App Server WebSocket transport is documented as experimental and unsupported, and non-loopback WebSocket listeners require explicit auth before remote exposure. This project therefore runs App Server as a private internal process over stdio and exposes only this authenticated Gateway API.

## User Guide

The GitHub Pages-ready user guide lives in [`docs/index.md`](docs/index.md). The target multi-capability Gateway design is documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), operational quality gates are in [`docs/QUALITY.md`](docs/QUALITY.md), and the Codex-facing repository policy template is [`policy_template.md`](policy_template.md). Pages is deployed by `.github/workflows/pages.yml` whenever `main` changes the docs or the workflow.

## Development

Requirements:

- Node.js 24
- npm

Install dependencies:

```bash
npm install
```

Copy environment defaults:

```bash
cp .env.example .env
```

Set `CODEXGW_ALLOWED_REPOS_JSON` to the repos this gateway may operate on, and set a long random `TOKEN_PEPPER`. `BOOTSTRAP_ADMIN_TOKEN` is only for local bootstrap and is refused in production.
By default the gateway starts `codex app-server` using `CODEX_APP_SERVER_COMMAND=codex`. Set `CODEX_APP_SERVER_MODEL` when the local Codex config points at a model that is not supported by the authenticated account or installed CLI.
Set `CODEXGW_MAX_PARALLEL_READ_TASKS` to bound concurrent read-only Codex runs; the default is `4`.
Set `CODEXGW_WORKSPACES_JSON` when you want stable workspace IDs with mode/provider ceilings. If omitted, the gateway derives one workspace per allowed repo.

Example repo allowlist:

```json
[
  {
    "id": "local-agent-gateway",
    "path": "/absolute/path/to/local-agent-gateway",
    "defaultMode": "read-only",
    "allowedModes": ["read-only", "workspace-write"]
  }
]
```

Run checks:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run smoke
scripts/verify.sh
```

Start the server:

```bash
npm run dev
```

Health check:

```bash
curl http://127.0.0.1:8787/healthz
```

Smoke check the MVP API contract without connecting to a real Codex App Server:

```bash
npm run smoke
```

The smoke check uses an in-memory database and fake Codex runner to verify health, bootstrap token creation, scoped repo listing, task creation, task polling, and that public task responses do not expose internal Codex thread IDs.

## Bootstrap

Set `BOOTSTRAP_ADMIN_TOKEN` temporarily, start the server, and create a real admin token. Include the `token:*` scopes if this token will create, list, or revoke other tokens after bootstrap:

```bash
curl -X POST http://127.0.0.1:8787/v1/tokens \
  -H "Authorization: Bearer $BOOTSTRAP_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "admin",
    "scopes": [
      "task:create",
      "task:read",
      "task:control",
      "audit:read",
      "thread:create",
      "thread:write",
      "token:create",
      "token:read",
      "token:revoke",
      "codex:account:read",
      "codex:account:login",
      "codex:account:logout",
      "repo:local-agent-gateway",
      "workspace:local-agent-gateway",
      "mode:read-only",
      "mode:workspace-write",
      "provider:codex"
    ],
    "expiresInDays": 90
  }'
```

The raw token is returned only once. Remove `BOOTSTRAP_ADMIN_TOKEN` from `.env` after bootstrap.

## API

Unauthenticated:

- `GET /healthz`

Authenticated:

- `GET /v1/repos` requires `task:read`; returns only repos covered by the caller's `repo:<repoId>` scopes.
- `GET /v1/workspaces` requires `task:read`; returns workspace IDs covered by both `workspace:<workspaceId>` and matching `repo:<repoId>` scopes without raw paths.
- `GET /v1/providers` requires `task:read`; returns available task provider IDs and public capabilities without backend internals.
- `POST /v1/tokens` requires `token:create`; tokens cannot mint scopes they do not already have, and child tokens cannot outlive their issuer.
- `GET /v1/tokens` requires `token:read`; never returns raw tokens or token hashes.
- `DELETE /v1/tokens/:id` requires `token:revoke`; revokes without physical deletion.
- `GET /v1/codex/account` requires `codex:account:read`; returns sanitized Codex account state.
- `POST /v1/codex/account/login/device-code` requires `codex:account:login`; starts ChatGPT device-code login and returns only `loginId`, `verificationUrl`, and `userCode`.
- `POST /v1/codex/account/login/cancel` requires `codex:account:login`; cancels a pending device-code login by `loginId`.
- `POST /v1/codex/account/logout` requires `codex:account:logout`; signs Codex out through App Server.
- `POST /v1/tasks` requires `task:create`, a repo target or workspace target, and `mode:<mode>`. Workspace targets require both `workspace:<workspaceId>` and the matching `repo:<repoId>`. Optional `provider` defaults to the target policy. Non-default providers require `provider:<providerId>`. Returns `202 Accepted` with a Gateway `taskId`.
- `GET /v1/tasks` requires `task:read`; lists sanitized tasks for repos covered by the caller's `repo:<repoId>` scopes, with optional `repo`, `status`, and `limit` filters.
- `GET /v1/tasks/:id` allows the creating token to read its own task; other tokens require `task:read` and matching repo scope.
- `GET /v1/tasks/:id/events` requires the same authorization as `GET /v1/tasks/:id`; replays sanitized task events as Server-Sent Events.
- `GET /v1/tasks/:id/diff` requires the same authorization as `GET /v1/tasks/:id`; returns the stored sanitized generic diff artifact captured when the task completed.
- `POST /v1/tasks/:id/interrupt` controls only active tasks. The creating token can interrupt its own task; other tokens require `task:read`, `task:control`, and matching repo scope.
- `POST /v1/tasks/:id/steer` accepts `{ "message": "..." }` for active tasks with the same control authorization. Steering text is not stored in full in audit logs or events.
- `GET /v1/audit-logs` requires `audit:read`; lists sanitized audit records with optional `action`, `repo`, `status`, `taskId`, and `limit` filters.

Task example:

```bash
curl -X POST http://127.0.0.1:8787/v1/tasks \
  -H "Authorization: Bearer $CODEXGW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "local-agent-gateway",
    "provider": "codex",
    "prompt": "READMEを読んで改善案を出してください",
    "mode": "read-only"
  }'
```

Workspace task example:

```bash
curl -X POST http://127.0.0.1:8787/v1/tasks \
  -H "Authorization: Bearer $CODEXGW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceId": "local-agent-gateway",
    "prompt": "READMEを読んで改善案を出してください",
    "mode": "read-only"
  }'
```

Poll the Gateway task until it leaves `queued` or `pending`:

```bash
curl http://127.0.0.1:8787/v1/tasks/task_... \
  -H "Authorization: Bearer $CODEXGW_TOKEN"
```

List recent completed tasks for a repo:

```bash
curl 'http://127.0.0.1:8787/v1/tasks?repo=local-agent-gateway&status=completed&limit=20' \
  -H "Authorization: Bearer $CODEXGW_TOKEN"
```

## Security

- No raw `cwd` API.
- Repositories resolve only through the server-side allowlist in `CODEXGW_ALLOWED_REPOS_JSON`; production startup refuses a missing allowlist.
- Workspace targets resolve only through the server-side registry in `CODEXGW_WORKSPACES_JSON` or the derived repo workspace registry; public APIs never accept workspace paths.
- Default task mode is `read-only`.
- Public task modes are only `read-only` and `workspace-write`.
- Public task providers are selected by registered provider IDs. The default provider is `codex`; future non-default providers require explicit `provider:<providerId>` scopes.
- Per-repo mode ceilings prevent sensitive repos from being made writeable by scope composition alone.
- `danger-full-access` is not accepted.
- No arbitrary shell execution endpoint exists.
- Tokens are stored as `sha256(token + TOKEN_PEPPER)`, never as plaintext.
- Authorization headers are redacted from logs.
- Prompt hashes are stored for audit; prompt previews are truncated and never store a short prompt in full.
- Responses and stored task output are scrubbed for common local absolute path patterns.
- Production config rejects the default pepper, rejects bootstrap admin token configuration, and requires an explicit repo allowlist.
- Codex App Server is called through an internal stdio JSON-RPC transport with fixed server-side options: allowlisted working directory, fixed sandbox policy, `approvalPolicy: "never"`, and no network access.
- Task runs use isolated App Server stdio connections so streamed turn events cannot cross between concurrent Gateway requests.
- `workspace-write` tasks are serialized per repo by an in-process queue. `read-only` tasks can still run while a write task is active.
- `read-only` tasks are capped by `CODEXGW_MAX_PARALLEL_READ_TASKS`; excess tasks are queued in process.
- The gateway does not expose a generic App Server JSON-RPC proxy, App Server filesystem APIs, command APIs, or `thread/shellCommand`.
- OpenAI API keys and ChatGPT access tokens are not accepted through public Gateway request bodies.
- Public task responses expose Gateway `taskId` only, not Codex thread IDs.
- Task control and queues use process-local handles. On startup, any previously `queued` or `pending` tasks are marked failed because prompts and runner handles are not persisted.

## Client Integration

External client integration is documented in [`docs/CLIENT_INTEGRATION.md`](docs/CLIENT_INTEGRATION.md), [`docs/EVENT_STREAMING.md`](docs/EVENT_STREAMING.md), [`docs/WORKSPACE_TARGETS.md`](docs/WORKSPACE_TARGETS.md), and [`docs/TASK_CONTROL.md`](docs/TASK_CONTROL.md). The Gateway exposes sanitized task events for clients such as CLI tools, dashboards, desktop apps, mobile apps, automation bots, MCP integrations, and CI helpers:

```bash
curl http://127.0.0.1:8787/v1/tasks/task_.../events \
  -H "Authorization: Bearer $CODEXGW_TOKEN" \
  -H "Accept: text/event-stream"
```

Diff artifacts are also available for clients that need a generic review surface:

```bash
curl http://127.0.0.1:8787/v1/tasks/task_.../diff \
  -H "Authorization: Bearer $CODEXGW_TOKEN"
```

Events and stored diff artifacts use Gateway task IDs and repo-relative paths only. Raw `cwd`, Codex thread IDs, App Server JSON-RPC payloads, and shell commands are not exposed.

For active tasks, the event endpoint keeps the SSE response open after replay and streams newly persisted Gateway events until the task reaches a terminal state. If the Gateway process restarts, clients should reconnect with `Last-Event-ID`; active in-memory fan-out is intentionally process-local.

Prefer publishing through Tailscale, Cloudflare Tunnel, or another identity-aware private access layer. Opening a home Mac port directly to the internet is not recommended.

## Harness

This repository has a project-local copy of selected files from [`s-hiraoku/codex-harnesses`](https://github.com/s-hiraoku/codex-harnesses):

- `AGENTS.md`
- `policies/default.yaml`
- `policies/experimental.yaml`
- `policies/strict.yaml`
- `scripts/verify.sh`
- `scripts/checkpoint.sh`
- `codex/skills/`
- `codex/hooks/`
- `codex/ledger/`

The hook payloads are not automatically enforced. They are included so they can be reviewed, adapted, and wired into a supported Codex lifecycle configuration later.
