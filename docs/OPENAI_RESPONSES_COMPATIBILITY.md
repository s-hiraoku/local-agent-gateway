# OpenAI Responses Compatibility Interface

Status: **implemented for explicit trusted-local opt-in**

This document defines the first compatibility interface for using the operator's local ChatGPT/Codex subscription from OpenAI Responses API clients. It is a narrow adapter over the existing inference job pipeline, not a general OpenAI API proxy and not a replacement for the metered OpenAI Platform API.

Normative terms such as **MUST**, **MUST NOT**, and **SHOULD** describe the contract. The routes are registered only when the compatibility option is enabled.

## Scope

The first version supports:

- one local operator and the existing Gateway bearer token;
- a server-selected Codex model exposed through one stable model alias;
- stateless text input and text output;
- synchronous Responses requests;
- Responses-compatible Server-Sent Events;
- the existing encrypted inference job, queue, limit, and retention mechanisms.

It does not support:

- public OAuth, login, callback, token, or account-management endpoints;
- `POST /v1/chat/completions` or legacy completions;
- arbitrary client-selected models;
- message-array, image, audio, file, or multimodal input;
- function calling, built-in tools, MCP tools, or web search;
- `previous_response_id`, conversations, or stored-response retrieval;
- structured output, sampling controls, or reasoning controls;
- authoritative token usage or billing-equivalent accounting;
- multiple accounts, account pooling, load balancing, or multi-user tenancy.

Unknown request properties MUST be rejected. The Gateway MUST NOT silently accept an unsupported field or imply that it affected execution.

## Authentication boundary

OAuth authentication belongs to Codex, not to the public Gateway API:

```text
OpenAI-compatible client
        |
        | Authorization: Bearer <Gateway token>
        v
Local Agent Gateway
        |
        | private Codex App Server stdio
        v
Dedicated CODEX_HOME
        |
        | operator-created ChatGPT OAuth session
        v
ChatGPT/Codex subscription
```

The operator authenticates the dedicated home before enabling the compatibility interface:

```bash
mkdir -p "$HOME/.codex-gateway"
CODEX_HOME="$HOME/.codex-gateway" codex login
```

The Gateway MUST continue to verify that the dedicated home contains a ChatGPT account login. API-key-backed Codex sessions MUST be rejected. OAuth access tokens, refresh tokens, ID tokens, and account identifiers MUST NOT appear in public requests, responses, logs, or audit events.

Every `/v1` request requires the existing Gateway credential:

```text
Authorization: Bearer <gateway owner token>
```

The client MAY place the Gateway token in an SDK's `apiKey` option. This value authenticates only to Local Agent Gateway; it is not an OpenAI Platform API key.

## Availability and configuration

The interface MUST be disabled by default. The proposed opt-in is:

```text
CODEXGW_OPENAI_COMPATIBILITY_ENABLED=true
```

The Gateway MUST refuse to start with this option enabled unless `CODEXGW_HOST` is `127.0.0.1`, `::1`, or `localhost`. Non-loopback and multi-user deployment are outside this specification.

When disabled, compatibility routes are not registered and return `404`. Enabling the interface does not weaken the existing queue, rate, prompt, result, event, concurrency, timeout, encryption, or retention limits.

## Model contract

The public model ID is always:

```text
codex-subscription
```

This alias maps to `CODEXGW_CODEX_MODEL` when configured, otherwise to the default selected by Codex for the authenticated account. A request cannot override the server-selected upstream model.

The Gateway MUST NOT enumerate upstream account entitlements or expose private upstream model metadata.

## `GET /v1/models`

Returns the models accepted by this compatibility interface.

### Response

```json
{
  "object": "list",
  "data": [
    {
      "id": "codex-subscription",
      "object": "model",
      "created": 0,
      "owned_by": "local-agent-gateway"
    }
  ]
}
```

The response MUST contain only the stable Gateway alias. `created: 0` means that the alias has no meaningful upstream creation timestamp.

## `POST /v1/responses`

Creates one stateless, repository-free inference run. The Gateway executes it in the same private single-use inference workspace used by `POST /v2/inference/runs`.

### Headers

| Header | Required | Contract |
| --- | --- | --- |
| `Authorization` | yes | Existing Gateway bearer token. |
| `Content-Type` | yes | `application/json`. |
| `Idempotency-Key` | no | When present, 8–128 characters and subject to the existing owner-scoped replay rules. |

If `Idempotency-Key` is omitted, the Gateway creates an internal unique key and every request is a new run. If it is provided, the same key and same normalized generation request replay the original response; the same key with different input returns `409`. `stream` is a delivery preference and is excluded from generation identity, so a completed job may be replayed in either delivery mode. Replay guarantees expire with the configured retention window.

### Request body

```json
{
  "model": "codex-subscription",
  "instructions": "Answer concisely.",
  "input": "Explain why the sky is blue.",
  "stream": false
}
```

| Property | Required | Type | Contract |
| --- | --- | --- | --- |
| `model` | yes | string | Must equal `codex-subscription`. |
| `input` | yes | string | Non-empty plain-text user input. |
| `instructions` | no | string | Non-empty plain-text instructions placed in a separately delimited Gateway prompt section. This approximates, but does not claim full parity with, an upstream developer message. |
| `stream` | no | boolean | Defaults to `false`; when true, returns Responses SSE events. |

`input` and `instructions` are bounded together by `CODEXGW_MAX_PROMPT_BYTES` after conversion to the internal prompt. Limits are measured in UTF-8 bytes, not JavaScript string length.

The first version accepts exactly these properties. For example, `tools`, `text`, `reasoning`, `temperature`, `store`, `metadata`, `previous_response_id`, and array-valued `input` return `400 INVALID_REQUEST`.

### Synchronous response

A non-streaming request waits for the durable inference job to reach a terminal state and returns `200` with a Responses-shaped object:

```json
{
  "id": "resp_019f...",
  "object": "response",
  "created_at": 1784736000,
  "status": "completed",
  "completed_at": 1784736008,
  "error": null,
  "incomplete_details": null,
  "instructions": "Answer concisely.",
  "max_output_tokens": null,
  "model": "codex-subscription",
  "output": [
    {
      "id": "msg_019f...",
      "type": "message",
      "status": "completed",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "...",
          "annotations": []
        }
      ]
    }
  ],
  "parallel_tool_calls": false,
  "previous_response_id": null,
  "reasoning": {
    "effort": null,
    "summary": null
  },
  "store": false,
  "text": {
    "format": {
      "type": "text"
    }
  },
  "tool_choice": "none",
  "tools": [],
  "temperature": null,
  "top_p": null,
  "truncation": "disabled",
  "usage": null,
  "user": null,
  "metadata": {}
}
```

`usage` is `null` because the current Codex App Server adapter does not provide verified token accounting. The Gateway MUST NOT estimate or fabricate token counts. `temperature` and `top_p` are also `null` because this interface does not expose sampling controls. `store: false` means there is no OpenAI-compatible response retrieval API; the underlying encrypted job remains subject to Gateway retention.

The `resp_` and `msg_` identifiers are opaque, Gateway-generated compatibility identifiers. They MUST be stable for an idempotent replay and MUST NOT expose Codex thread IDs, turn IDs, or raw Gateway database values. The first implementation derives distinct response and message suffixes from the internal job identifier through the existing keyed digest.

### Streaming response

When `stream` is true, the response uses:

```text
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
```

The successful text-only event order is:

```text
response.created
response.in_progress
response.output_item.added
response.content_part.added
response.output_text.delta     # zero or more
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

Each frame contains an event name and one JSON object:

```text
event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_019f...","output_index":0,"content_index":0,"delta":"Hello"}

```

The stream MUST contain only events constructed by the compatibility adapter. Raw App Server notifications, stderr, internal event types, local paths, working directories, Codex IDs, and encrypted storage values MUST NOT be forwarded.

If execution fails after HTTP headers are sent, the stream ends with `response.failed`. Responses streams do not use the Chat Completions `[DONE]` sentinel.

Client disconnect triggers best-effort cancellation. Cancellation is not proof that upstream subscription work was not consumed. A gateway restart may retry an interrupted read-only job under the existing at-least-once execution contract.

## Error contract

Errors before a streaming `200` use an OpenAI-shaped envelope:

```json
{
  "error": {
    "message": "Only the codex-subscription model is available",
    "type": "invalid_request_error",
    "param": "model",
    "code": "INVALID_REQUEST"
  }
}
```

Clients MUST branch primarily on HTTP status and `error.code`; message text is not stable.

| HTTP status | `type` | Representative Gateway codes |
| --- | --- | --- |
| `400` | `invalid_request_error` | `INVALID_REQUEST` |
| `401` | `authentication_error` | `AUTH_REQUIRED` |
| `404` | `invalid_request_error` | `NOT_FOUND` |
| `409` | `invalid_request_error` | `IDEMPOTENCY_CONFLICT`, cancellation conflict |
| `429` | `rate_limit_error` | `QUEUE_FULL`, `CODEX_RATE_LIMITED` |
| `502` | `api_error` | `CODEX_EXECUTION_FAILED`, `CODEX_OVERLOADED` |
| `503` | `api_error` | `CODEX_UNAUTHORIZED`, dependency not ready |
| `504` | `api_error` | Codex or compatibility wait timeout |

The compatibility envelope intentionally omits the `/v2` `retryable` property. HTTP status and stable code carry retry semantics for OpenAI-compatible clients.

## Lifecycle and limits

The compatibility request is a synchronous facade over the existing asynchronous job system:

1. Validate authentication, request shape, model alias, and byte limits.
2. Create or replay an encrypted `inference.turn` job.
3. Wake the existing bounded processor.
4. Wait for completion or translate allowlisted deltas to SSE.
5. Return a newly constructed Responses object or error.

The following existing controls remain authoritative:

- `CODEXGW_MAX_QUEUED_JOBS`;
- `CODEXGW_MAX_CONCURRENT_JOBS`;
- `CODEXGW_MAX_PROMPT_BYTES`;
- `CODEXGW_MAX_RESULT_BYTES`;
- `CODEXGW_MAX_EVENT_BYTES`;
- `CODEXGW_MAX_EVENTS_PER_JOB`;
- `CODEXGW_RPC_TIMEOUT_MS`;
- `CODEXGW_TURN_TIMEOUT_MS`;
- `CODEXGW_RETENTION_DAYS`;
- the global HTTP rate limit.

Compatibility requests appear in existing metrics as `inference.turn`; the first version does not add a separate job kind or expose subscription quota accounting.

## SDK usage

The intended JavaScript client configuration is:

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.CODEXGW_API_TOKEN,
  baseURL: "http://127.0.0.1:8787/v1"
});

const response = await client.responses.create({
  model: "codex-subscription",
  input: "Summarize this paragraph: ..."
});

console.log(response.output_text);
```

SDK compatibility is not established by this document. Release requires integration tests against a current official OpenAI JavaScript SDK for both synchronous and streaming calls.

## Compatibility matrix

| Surface | First version |
| --- | --- |
| `GET /v1/models` | supported |
| `POST /v1/responses` with string input | supported |
| Responses SSE | supported |
| OpenAI-shaped errors | supported |
| `POST /v1/chat/completions` | not supported |
| Message-array input | not supported |
| Structured output | not supported |
| Function and built-in tools | not supported |
| Image, file, and audio input | not supported |
| Stateful response chaining | not supported |
| Stored-response retrieval | not supported |
| Verified token usage | not available |
| Arbitrary model selection | prohibited |

## Security and release gates

This interface increases the value of a stolen Gateway bearer token because it grants use of the operator's authenticated subscription. It MUST remain private, single-owner, authenticated, rate-limited, and loopback-only.

Before the interface is enabled for untrusted prompts, verification MUST demonstrate that adversarial prompts cannot:

- read the dedicated `CODEX_HOME` or OAuth state;
- read unrelated host files, environment secrets, or registered repositories;
- invoke shell, network, MCP, or approval-requiring operations;
- cause raw local paths or internal protocol data to appear in output.

The current read-only sandbox prevents mutation but is not proof of readable-root isolation. Until the OS-account, container, or VM boundary in [Readable-root isolation](READABLE_ROOT_ISOLATION.md) is implemented and verified, the compatibility interface is limited to explicitly enabled, trusted local clients and trusted input. It MUST NOT be exposed to untrusted users or prompts.

This project does not claim that a ChatGPT/Codex subscription is contractually interchangeable with OpenAI Platform API usage. Operators are responsible for applicable account terms and MUST NOT use this single-owner interface for resale, account pooling, or an untrusted public service.

## Acceptance criteria

The trusted-local implementation is complete only when all of the following are true:

- the interface is disabled by default and cannot bind non-loopback;
- OAuth tokens never enter the public Gateway contract;
- request schemas reject all unspecified fields;
- the model alias cannot change the upstream model selected by the server;
- sync responses and SSE parse through the official OpenAI JavaScript SDK;
- disconnect, timeout, queue-full, replay, conflict, cancellation, and failure paths are tested;
- streamed data is built from an explicit allowlist and contains no internal payloads;
- credential and internal-protocol non-disclosure tests pass, while the unresolved host-readable-root limitation remains prominently documented;
- README, architecture, threat model, client integration, OpenAPI, and operations docs describe the implemented opt-in and its boundary;
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `scripts/verify.sh` complete successfully.

## References

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [OpenAI Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Architecture](ARCHITECTURE.md)
- [Threat model](THREAT_MODEL.md)
- [Client integration](CLIENT_INTEGRATION.md)
- [Readable-root isolation](READABLE_ROOT_ISOLATION.md)
