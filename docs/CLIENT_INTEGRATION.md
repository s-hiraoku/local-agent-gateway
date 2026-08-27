# Client Integration

V2 is a breaking replacement for the old `/v1/tasks` API. Clients use Gateway coding runs, inference runs, conversations, and jobs; they never send repository paths, Codex IDs, backend credentials, model-provider requests, or raw JSON-RPC payloads.

The separately versioned, optional `/v1/models` and `/v1/responses` routes are an OpenAI SDK compatibility namespace, not a revival of the old Gateway V1 task API. Their strict text-only contract is documented in [OpenAI Responses compatibility](OPENAI_RESPONSES_COMPATIBILITY.md).

`GET /v2/capabilities` advertises `coding.turn` and `inference.turn` as enabled, read-only, and structured-output capable. It does not name the active inference provider.

## Stateless structured runs

Clients that need one independent result over a registered repository, including Decision-Agent, should use `POST /v2/coding/runs`. The request requires `repositoryId`, `prompt`, `Idempotency-Key`, and may include `outputSchema`. Conversation creation and job submission are atomic, and the response returns both `jobId` and the internal `conversationId`. Coding always runs on Codex App Server.

Clients that need a repository-free text-in/JSON-out result should use `POST /v2/inference/runs`. The request requires `prompt` and `Idempotency-Key`, and may include `outputSchema`. Do not send `repositoryId`; extra body fields are ignored and the job still runs against a private empty directory (`kind` is `inference.turn`, `repositoryId` is `null`). The inference backend is `CODEXGW_INFERENCE_PROVIDER` (`codex`, `claude`, `grok`, or `cursor`). Inference conversations cannot receive later `/v2/conversations/:id/turns`.

When `outputSchema` is supplied, the Gateway accepts a bounded JSON Schema subset, forwards it to Codex, Claude, or Grok, or appends it to the Cursor prompt, then parses the final message as exact JSON and validates it again locally. It never strips Markdown fences or repairs malformed output. Successful jobs expose `structuredOutput`; failures use `STRUCTURED_OUTPUT_INVALID`.

## Workflow

1. Discover advertised capabilities through `GET /v2/capabilities`.
2. For coding: discover an allowlisted repository through `GET /v2/repositories`, then create a conversation or submit `POST /v2/coding/runs`.
3. For inference: submit `POST /v2/inference/runs` with no repository.
4. Store the returned Gateway `jobId`.
5. Poll `GET /v2/jobs/:id` or connect to its SSE endpoint.
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

Replaying a key always returns its original job, including when that job failed or was cancelled. A deliberate new attempt therefore requires a new key. Property order in `outputSchema` does not affect request identity.

Read-only execution is at-least-once for every backend. If the Gateway crashes after sending a turn but before recording completion, the recovered job is attempted again. Attempt history records the restart, but upstream subscription work may be consumed more than once. Future write jobs must not inherit this retry rule without isolated worktrees and an explicit commit/apply protocol.

The supported schema subset is intentionally small: object/array/scalar types, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, descriptions, and basic numeric/string/array bounds. References, formats, regular-expression keywords, composition keywords, and remote schemas are rejected.

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
  "structuredOutput": null,
  "error": null
}
```

Statuses are `queued`, `running`, `completed`, `failed`, and `cancelled`. For inference jobs `repositoryId` is `null`. Codex thread IDs, turn IDs, process details, command output, stderr, raw paths, and encrypted storage values are never part of this representation.

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

Clients must branch on `code`, not message text. Current stable `/v2` codes include:

- `AUTH_REQUIRED`, `FORBIDDEN`, `NOT_FOUND`, `INVALID_REQUEST`;
- `IDEMPOTENCY_CONFLICT`, `QUEUE_FULL`, `JOB_NOT_CANCELLABLE`;
- `STRUCTURED_OUTPUT_INVALID`, `ENCRYPTION_KEY_MISMATCH`, `INTERNAL_ERROR`;
- Codex: `CODEX_NOT_CONFIGURED`, `CODEX_UNSUPPORTED_VERSION`, `CODEX_UNAUTHORIZED`, `CODEX_RATE_LIMITED`, `CODEX_OVERLOADED`, `CODEX_TIMEOUT`, `CODEX_EXECUTION_FAILED`;
- Claude: `CLAUDE_NOT_CONFIGURED`, `CLAUDE_UNAUTHORIZED`, `CLAUDE_RATE_LIMITED`, `CLAUDE_TIMEOUT`, `CLAUDE_EXECUTION_FAILED`;
- Grok: `GROK_NOT_CONFIGURED`, `GROK_UNAUTHORIZED`, `GROK_RATE_LIMITED`, `GROK_TIMEOUT`, `GROK_EXECUTION_FAILED`;
- Cursor: `CURSOR_NOT_CONFIGURED`, `CURSOR_UNAUTHORIZED`, `CURSOR_RATE_LIMITED`, `CURSOR_TIMEOUT`, `CURSOR_EXECUTION_FAILED`.

`/readyz` always probes Codex. It uses `CODEX_UNSUPPORTED_VERSION` when the installed CLI is outside the supported range or cannot be parsed, and `CODEX_UNAUTHORIZED` when the dedicated home is not a ChatGPT login. When the selected inference provider is not Codex, `/readyz` also probes that backend for presence (`CLAUDE_NOT_CONFIGURED`, `GROK_NOT_CONFIGURED`, `CURSOR_NOT_CONFIGURED`); it does not consume a paid turn to check login. When the opt-in Lima executor is enabled, a missing instance or a failed guest tool-isolation probe uses `CODEX_NOT_CONFIGURED`. Job execution does not wait on `/readyz`; a Codex-down Gateway can still run Claude, Grok, or Cursor inference turns.
