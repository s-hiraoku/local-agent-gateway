# Client Integration

V2 is a breaking replacement for the old `/v1/tasks` API. Clients use Gateway conversations and jobs; they never send repository paths, Codex IDs, backend credentials, model-provider requests, or raw JSON-RPC payloads.

## Workflow

1. Discover an allowlisted repository through `GET /v2/repositories`.
2. Create a conversation for its public `repositoryId`.
3. Submit a turn with a unique `Idempotency-Key`.
4. Store the returned Gateway `jobId`.
5. poll `GET /v2/jobs/:id` or connect to its SSE endpoint.
6. Reconnect SSE with `Last-Event-ID` after a network interruption.

Every `/v2` request requires:

```text
Authorization: Bearer <gateway owner token>
```

## Submission guarantees

Turn submission is idempotent within the owner boundary:

- same key and same request: returns the original job;
- same key and different request: `409 IDEMPOTENCY_CONFLICT`;
- queue capacity exhausted: `429 QUEUE_FULL` with `retryable: true`.

Codex execution is at-least-once. If the Gateway crashes after sending a read-only turn but before recording completion, the recovered job is attempted again. Attempt history records the restart, but upstream subscription work may be consumed more than once. Future write jobs must not inherit this retry rule without isolated worktrees and an explicit commit/apply protocol.

## Public job

```json
{
  "id": "job_...",
  "conversationId": "cnv_...",
  "repositoryId": "gateway",
  "kind": "coding.turn",
  "status": "completed",
  "createdAt": "2026-07-14T00:00:00.000Z",
  "startedAt": "2026-07-14T00:00:01.000Z",
  "completedAt": "2026-07-14T00:00:08.000Z",
  "result": "...",
  "error": null
}
```

Statuses are `queued`, `running`, `completed`, `failed`, and `cancelled`. Codex thread IDs, turn IDs, process details, command output, stderr, raw paths, and encrypted storage values are never part of this representation.

## Error envelope

```json
{
  "error": {
    "code": "CODEX_RATE_LIMITED",
    "message": "Codex plan usage limit was reached",
    "retryable": true
  }
}
```

Clients must branch on `code`, not message text. Current stable codes include authentication, validation, not-found, idempotency, queue, cancellation, Codex authentication/rate/overload/timeout/execution, and internal failures.
