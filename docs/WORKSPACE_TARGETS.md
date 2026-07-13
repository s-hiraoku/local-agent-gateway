# Workspace Targets

Workspace targets are a server-side abstraction for selecting where a task runs without exposing raw filesystem paths to public clients.

This design is intentionally client-neutral. A workspace target can be used by a CLI tool, web dashboard, desktop app, automation bot, MCP integration, CI helper, or other developer tool.

## Goals

- Keep public APIs free of raw `cwd` values and arbitrary absolute paths.
- Allow external clients to reference task targets by opaque IDs.
- Preserve repo allowlist, token scope, sandbox mode, audit, and path scrubbing.
- Support future diff artifacts, task control, and task resume flows.

## Implemented Model

Implemented opaque ID:

- `workspaceId`: a stable registered workspace target.

The Gateway resolves a workspace to an allowlisted repo and target policy server-side. Clients pass only opaque IDs.

Current registry fields:

- `workspaceId`;
- repo ID;
- default and allowed task modes;
- default and allowed provider IDs.

The Gateway must reject:

- public absolute paths;
- targets whose repo scope does not match the caller's token;
- targets whose workspace scope does not match the caller's token;
- targets whose requested task mode exceeds repo or target policy.

## API

Implemented endpoint:

```text
GET /v1/workspaces
```

`GET /v1/workspaces` requires `task:read` and returns only workspaces for which the caller has both `workspace:<workspaceId>` and matching `repo:<repoId>`.

Implemented task creation:

```text
POST /v1/tasks
```

`POST /v1/tasks` accepts either `repo` or `workspaceId`, never both. It still rejects `workspacePath`, raw `cwd`, and other target shortcuts through strict request validation.

## Configuration

If `CODEXGW_WORKSPACES_JSON` is omitted, the Gateway derives one workspace per allowlisted repo with the same public ID as the repo. To set stricter ceilings, configure a JSON array:

```json
[
  {
    "id": "main",
    "repo": "local-agent-gateway",
    "defaultMode": "read-only",
    "allowedModes": ["read-only"],
    "defaultProvider": "codex",
    "allowedProviders": ["codex"]
  }
]
```

## Future Registry Model

A richer workspace registry can remain server-side only and add:

- internal absolute path;
- symlink-resolved real path;
- allowed root that authorized the path;
- creation and update timestamps.

The registry must validate every stored path before task creation:

- resolve symlinks before policy checks;
- require the real path to stay under an allowlisted repo root or configured workspace root;
- require the caller to hold `repo:<repoId>`;
- require the caller to hold `workspace:<workspaceId>`;
- require requested task mode to be allowed by both repo policy and workspace policy;
- require requested provider to be allowed by workspace policy;
- never echo internal paths in public responses, audit logs, or events.

If a workspace target cannot be resolved or authorized unambiguously, deny the request.

## Diff Artifact Design

Implemented endpoint:

```text
GET /v1/tasks/:id/diff
```

Authorization should match `GET /v1/tasks/:id`.

Diff artifact capture:

- use fixed git operations only;
- use server-side target paths only;
- treat changed file pathspecs as literal paths;
- store the artifact when the task completes;
- never inspect the live worktree while serving `GET /v1/tasks/:id/diff`;
- return repo-relative file paths;
- scrub public text for absolute paths;
- never accept arbitrary command arguments;
- never expose raw `cwd`.

The response should be a generic task artifact, not editor-specific UI state.

## Interrupt And Steer

```text
POST /v1/tasks/:id/interrupt
POST /v1/tasks/:id/steer
```

These generic task control APIs operate on the active task session registry. They do not accept workspace paths, raw `cwd`, Codex thread IDs, or Codex turn IDs from clients. See [`TASK_CONTROL.md`](TASK_CONTROL.md) for the dedicated control API guardrails.
