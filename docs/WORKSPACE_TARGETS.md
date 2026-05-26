# Workspace Targets

Workspace targets are a future server-side abstraction for selecting where a task runs without exposing raw filesystem paths to public clients.

This design is intentionally client-neutral. A workspace target can be used by a CLI tool, web dashboard, desktop app, automation bot, MCP integration, CI helper, or other developer tool.

## Goals

- Keep public APIs free of raw `cwd` values and arbitrary absolute paths.
- Allow external clients to reference task targets by opaque IDs.
- Preserve repo allowlist, token scope, sandbox mode, audit, and path scrubbing.
- Support future diff artifacts, task control, and task resume flows.

## Proposed Model

Introduce opaque IDs:

- `workspaceId`: a stable registered workspace target.
- `targetId`: an optional task-specific target derived from a workspace.

The Gateway stores the internal absolute path server-side. Clients pass only opaque IDs.

Every stored path must validate against one of:

- an allowlisted repo root; or
- an explicitly configured allowlisted workspace root.

The Gateway must reject:

- public absolute paths;
- relative paths that escape a registered root;
- symlink-resolved paths outside allowed roots;
- targets whose repo scope does not match the caller's token;
- targets whose requested task mode exceeds repo or target policy.

## API Sketch

No workspace target API is implemented in G1. A future version could add:

```text
GET /v1/workspaces
POST /v1/workspaces
GET /v1/workspaces/:workspaceId
POST /v1/tasks
```

`POST /v1/tasks` could accept either the current `repo` field or a future `workspaceId`, but never a raw path.

Until that registry exists:

- `POST /v1/tasks` accepts `repo` only and rejects `workspaceId`, `workspacePath`, raw `cwd`, or other target shortcuts through strict request validation.
- `GET /v1/workspaces`, `POST /v1/workspaces`, and `GET /v1/workspaces/:workspaceId` are not public endpoints.
- Clients must not send absolute paths or workspace roots to task APIs.

## Required Registry Model

A safe workspace registry must be server-side only. It should store:

- opaque `workspaceId`;
- repo ID and mode ceiling;
- internal absolute path;
- symlink-resolved real path;
- allowed root that authorized the path;
- creation and update timestamps.

The registry must validate every stored path before task creation:

- resolve symlinks before policy checks;
- require the real path to stay under an allowlisted repo root or configured workspace root;
- require the caller to hold `repo:<repoId>`;
- require requested task mode to be allowed by both repo policy and workspace policy;
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
