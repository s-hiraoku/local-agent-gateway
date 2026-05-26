# Task Control

Task control covers `interrupt` and `steer` operations for active Gateway tasks.

## Public APIs

```text
POST /v1/tasks/:id/interrupt
POST /v1/tasks/:id/steer
```

`interrupt` accepts an empty JSON object. `steer` accepts:

```json
{
  "message": "Please focus on tests before editing docs."
}
```

`message` must be 1 to 2,000 characters. Unknown fields are rejected.

## Session Model

The Gateway keeps a process-local active task session registry. It maps Gateway `taskId` values to internal runner control handles. The handle owns the Codex App Server `turn/interrupt` and `turn/steer` calls and never exposes Codex thread IDs, turn IDs, raw `cwd`, or raw JSON-RPC payloads to clients.

The registry tracks enough server-side context to authorize and clean up an active task:

- Gateway `taskId`
- owning token ID
- repo ID
- task mode
- runner/session control handle

If the Gateway process restarts, active controls fail closed with `CONFLICT` during the restart window. On startup, any stale `queued` or `pending` task rows are marked `failed` because the Gateway does not persist prompts or runner handles. Clients cannot recover control by submitting hidden Codex IDs.

## Authorization

Authorization matches task ownership before control-specific checks:

- the creating token can control its own active task;
- a different token requires `task:read`, `task:control`, and `repo:<task.repo>`.

Control APIs only operate on `pending` tasks with an active in-process control handle. `queued`, `completed`, `failed`, and post-restart tasks return `CONFLICT`.

## Audit And Events

Control requests append normalized events:

- `task.interrupted` after an interrupt request is accepted by the active handle;
- `task.steered` after a steer request is accepted by the active handle.

If an interrupt later causes the runner to fail, the normal terminal `task.failed` event is still emitted. If the runner exits cleanly, the normal `task.completed` event is emitted.

Steering text follows the same storage discipline as task creation:

- audit logs store a hash and omitted preview only;
- task events store an omitted preview only;
- full steering text is sent to the active runner handle but is not persisted.

## APIs Not To Add

Do not add any of the following as shortcuts for task control:

- raw `cwd` control APIs;
- arbitrary process signal APIs;
- arbitrary shell execution APIs;
- public `thread/interrupt`, `turn/steer`, or `thread/shellCommand` pass-through;
- generic App Server JSON-RPC proxying;
- request bodies that contain Codex internal thread IDs;
- request bodies that contain OpenAI API keys, ChatGPT access tokens, refresh tokens, or session secrets.
