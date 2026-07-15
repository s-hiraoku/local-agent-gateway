# V2 Architecture

Local Agent Gateway is a private capability gateway for trusted applications, not a generic proxy for Codex App Server or the OpenAI API. V2 is a clean rewrite with a breaking `/v2` API.

```text
trusted external app
        |
        | Gateway bearer token
        v
Local Agent Gateway
  |-- identity and policy
  |-- durable jobs and encrypted events
  |-- capability adapters
        |-- coding -> Codex App Server -> ChatGPT/Codex subscription
        |-- image  -> OpenAI Platform API -> project billing (planned)
        `-- audio  -> OpenAI Platform API -> project billing (planned)
```

Clients authenticate only to the Gateway. Backend credentials, billing domains, protocols, and policy remain explicit per capability. ChatGPT/Codex subscription access is not presented as a replacement for the OpenAI Platform API.

## Layering

The codebase separates four concerns:

- `domain`: provider-neutral IDs, job states, events, and public errors;
- `application`: conversations, durable submission, job claiming, cancellation, and recovery;
- `adapters`: Codex App Server protocol translation;
- `infrastructure`: configuration, encryption, SQLite, HTTP, logging, and lifecycle.

The domain never exposes Codex thread or turn IDs. The Codex adapter maps a Gateway conversation to an internal App Server thread. A future OpenAI adapter will implement separate capability contracts instead of being forced through coding concepts such as repositories and sandboxes.

## Current vertical slice

V2 currently supports `coding.turn` in read-only mode:

1. A client creates a conversation for a server-registered repository ID.
2. A turn is submitted with an `Idempotency-Key` and stored as an encrypted durable job.
3. The worker claims the job and records an attempt.
4. A fresh App Server process starts with a dedicated `CODEX_HOME` and environment allowlist.
5. The adapter initializes App Server, starts or resumes its internal thread, and starts a turn with fixed read-only/never-approve policy.
6. Buffered JSON-RPC notifications are normalized and encrypted before SSE delivery.
7. The final result is encrypted at rest and returned through the Gateway job resource.
8. The child process is terminated. Cancellation and shutdown interrupt active turns.

Different conversations may run concurrently. Turns within one conversation are claimed strictly one at a time so its internal Codex thread cannot fork or be overwritten by racing jobs.

`POST /v2/coding/runs` is the stateless facade over the same model. It creates a private conversation and its first job in one transaction, avoiding partial creation and cross-request idempotency for clients that need a single answer. Optional structured output is a capability contract, not raw App Server passthrough: the Gateway limits the schema, forwards it, and independently validates exact final JSON before completing the job.

At-least-once recovery is intentional for read-only jobs: an interrupted attempt is marked failed and the job is requeued. This may consume subscription work twice. Write mode must use a different recovery contract.

## Public API principles

Expose capabilities, not upstream protocols:

```text
POST /v2/conversations
POST /v2/conversations/:id/turns
POST /v2/coding/runs
GET  /v2/jobs/:id
GET  /v2/jobs/:id/events
POST /v2/jobs/:id/cancel

# planned
POST /v2/images/generations
POST /v2/images/edits
POST /v2/audio/transcriptions
POST /v2/audio/speech
GET  /v2/artifacts/:id
```

Never add a generic `/openai/*`, arbitrary upstream URL, raw request forwarding, generic App Server JSON-RPC endpoint, raw filesystem API, or client-selected executable.

## Persistence

SQLite is the source of truth for conversations, jobs, attempts, idempotency records, and event order. Prompt, result, and event bodies are AES-256-GCM encrypted. Operational metadata such as job state, timestamps, repository ID, attempt number, and event type remains queryable.

The initial deployment model is one Gateway process on one private host. SQLite uses conditional transactional claims, WAL, foreign keys, busy timeout, schema versioning, and restricted file permissions. A distributed worker system is unnecessary until horizontal execution is a real requirement.

Generated binary media will not be stored as SQLite blobs. A future artifact layer will store opaque metadata in SQLite and bytes in a Gateway-owned directory or object store with size, media, hash, ownership, and retention checks.

## Security invariants

- no arbitrary shell execution API;
- no public raw `cwd`, absolute path, Codex ID, command, stderr, or JSON-RPC payload;
- no `danger-full-access` mode;
- no client-supplied ChatGPT token, OpenAI API key, or refresh token;
- no full prompt in logs or plaintext persistence;
- no personal MCP/config inheritance by default;
- no unbounded queues, output, events, stderr, or protocol waits;
- no write mode without task-specific workspace isolation;
- no capability without positive and negative authorization tests.

Read-only is not considered a complete confidentiality boundary. The required host-readable-root isolation is documented in [Threat model](THREAT_MODEL.md).

## Credential and usage boundaries

| Backend | Credential source | Usage domain |
| --- | --- | --- |
| Codex App Server | dedicated local ChatGPT/Codex login | ChatGPT/Codex plan limits |
| OpenAI Platform adapters | server-side project credential | Platform billing and rate limits |
| Gateway clients | Gateway-issued identity/token | Gateway authorization only |

Usage records must keep subscription-backed coding separate from Platform API spend. Gateway limits apply in addition to upstream limits.

## Delivery sequence

1. Prove OS-level execution isolation and real dedicated-`CODEX_HOME` subscription authentication.
2. Add Codex CLI version/schema contract tests, account status, rate-limit visibility, retention, and telemetry.
3. Implement write turns in isolated worktrees with patch/commit artifacts and no blind crash retry.
4. Add encrypted artifact storage and bounded image generation/editing.
5. Add file transcription and speech generation.
6. Add Platform usage budgets and per-capability policy.
7. Add realtime sessions only with a concrete low-latency client requirement.
8. Add multi-user identity only after tenant isolation and audit requirements are defined.

Each phase must update public schemas, denial tests, threat model, operational limits, and verification evidence.

## Upstream references

- [Codex App Server](https://learn.chatgpt.com/docs/app-server.md)
- [Codex authentication](https://learn.chatgpt.com/docs/auth.md)
- [OpenAI image generation](https://developers.openai.com/api/docs/guides/image-generation)
- [OpenAI audio and speech](https://developers.openai.com/api/docs/guides/audio)
