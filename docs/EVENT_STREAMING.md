# Event Streaming

Task events are Gateway domain events for external clients. They are not tied to any specific UI.

## Endpoint

```text
GET /v1/tasks/:id/events
```

Authorization matches `GET /v1/tasks/:id`:

- The task creator can read its own event stream without `task:read`.
- Other tokens require both `task:read` and `repo:<task.repo>`.

The endpoint returns Server-Sent Events. It replays persisted events and supports `Last-Event-ID`. If the task is not terminal yet, the response remains open and streams newly persisted Gateway events from the in-process live event bus until a terminal task event is emitted. If the Gateway process restarts or the connection closes, clients should reconnect with the latest event ID to resume from persisted events.

## SSE Format

Each event uses the Gateway event ID and normalized event type:

```text
id: 12
event: task.completed
data: {"id":"12","taskId":"task_...","type":"task.completed","payload":{"provider":"codex","summary":"Task completed"},"createdAt":"..."}
```

Public event data contains:

- `id`: Gateway event ID as a string.
- `taskId`: Gateway task ID.
- `type`: normalized event type.
- `payload`: sanitized event payload.
- `createdAt`: event timestamp.

Payloads may contain public provider IDs such as `codex`. They must not contain backend names, raw transports, or provider-native session IDs.

Public event data must not contain:

- Codex internal thread IDs.
- raw `cwd` or absolute local paths.
- Authorization headers or tokens.
- raw App Server JSON-RPC payloads.
- full prompts.

## Event Types

The initial type set is intentionally small and client-neutral:

- `task.queued`
- `task.started`
- `task.interrupted`
- `task.steered`
- `task.completed`
- `task.failed`
- `agent.message.delta`
- `agent.message.completed`
- `tool.started`
- `tool.completed`
- `file.changed`
- `diff.available`
- `approval.requested`
- `approval.resolved`

G1 persists these events when available:

- `task.queued`
- `task.started`
- `task.interrupted`
- `task.steered`
- `agent.message.completed`
- `file.changed`
- `diff.available`
- `task.completed`
- `task.failed`

## Normalized Codex Mapping

Codex App Server stream notifications are mapped inside the Gateway before persistence:

| App Server signal | Gateway event |
| --- | --- |
| write task inserted behind an active write task for the same repo | `task.queued` |
| runner starts executing the task | `task.started` |
| accepted interrupt request | `task.interrupted` |
| accepted steer request | `task.steered` |
| `item/completed` with `agentMessage` | `agent.message.completed` |
| `item/completed` with completed file changes | `file.changed`, then `diff.available` |
| runner result / turn completed successfully | `task.completed` |
| runner or turn failure | `task.failed` |

The Gateway stores only normalized and scrubbed payloads. It does not store or replay raw JSON-RPC payloads.

## Replay And Reconnect

Clients can pass `Last-Event-ID` to fetch only events with a greater event ID:

```bash
curl http://127.0.0.1:8787/v1/tasks/task_.../events \
  -H "Authorization: Bearer $CODEXGW_TOKEN" \
  -H "Accept: text/event-stream" \
  -H "Last-Event-ID: 12"
```

Responses include a `retry: 2000` SSE directive so clients have a default reconnect interval. For non-terminal tasks, a closed connection means the client should reconnect with `Last-Event-ID` to catch up.

Live fan-out is process-local. It does not expose Codex internal thread IDs or session handles, and it does not imply that task control APIs are available. If the Gateway restarts, active live subscriptions are lost, but persisted events remain replayable.

On startup, the Gateway marks stale `queued` or `pending` tasks as `failed` and appends a `task.failed` event with a startup recovery payload. Clients should treat this as terminal and create a new task if the work still needs to run.
