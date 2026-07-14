# Architecture Direction

Local Agent Gateway is intended to become a private AI capability gateway for trusted applications, not a generic proxy for Codex App Server or the OpenAI API.

The current implementation exposes a constrained Codex task API. The target architecture keeps that coding path and adds selected image and audio capabilities through the OpenAI Platform API. Authentication, billing, execution protocols, and policy remain explicit for each capability.

## Product Boundary

The Gateway is the only service that clients call. Clients authenticate with Gateway-issued tokens and never receive or submit backend credentials.

```text
trusted client
    |
    | Gateway token
    v
Local Agent Gateway
    |-- coding --------> Codex App Server ----> ChatGPT/Codex subscription access
    |-- image ---------> OpenAI Platform API -> API-key billing
    |-- audio ---------> OpenAI Platform API -> API-key billing
    `-- realtime ------> short-lived session -> API-key billing
```

This split is intentional:

- Codex App Server is the coding-agent backend. It owns Codex threads, turns, sandboxing, and coding events.
- OpenAI Platform APIs provide image generation, image editing, transcription, speech generation, and future explicitly approved capabilities.
- ChatGPT/Codex subscription usage and OpenAI Platform API usage are separate billing and quota domains.
- Gateway tokens authorize client actions but are never used as upstream OpenAI credentials.

The Gateway must not imply that ChatGPT subscription access is a general replacement for the OpenAI Platform API.

## Current And Target State

Implemented today:

- authenticated Codex task creation and task control;
- repo and workspace allowlists;
- `read-only` and `workspace-write` policy ceilings;
- process-local task queues and live event fan-out;
- persisted task events, audit logs, and diff artifacts;
- ChatGPT device-code login through Codex App Server.

Target capabilities, not yet implemented:

- image generation and editing;
- file-based speech-to-text and text-to-speech;
- managed binary artifacts;
- OpenAI Platform usage and budget controls;
- realtime audio sessions;
- a provider-neutral job model above the existing Codex task model.

Documentation and public APIs must keep this distinction clear.

## Architecture Principles

### Share Gateway Infrastructure, Not Backend Protocols

The following concerns should be shared across all capabilities:

- Gateway authentication and scoped authorization;
- request validation and public error normalization;
- audit records without secrets or full sensitive inputs;
- job status, queues, concurrency, and cancellation where supported;
- normalized public events;
- artifact ownership, retention, and download authorization;
- rate, size, duration, and budget limits.

Backend-specific behavior stays behind capability adapters:

- Codex threads, turns, sandbox modes, repos, and changed files belong to coding;
- image size, quality, input images, and image outputs belong to image operations;
- audio format, duration, voice, transcripts, and realtime sessions belong to audio operations.

Do not force image or audio work through the existing `TaskRunner` contract. Its `cwd`, sandbox mode, thread, and changed-file concepts are intentionally coding-specific.

### Expose Capabilities, Not Generic Proxies

Public APIs should describe allowed user operations, for example:

```text
POST /v1/coding/tasks
POST /v1/images/generations
POST /v1/images/edits
POST /v1/audio/transcriptions
POST /v1/audio/speech
GET  /v1/jobs/:id
GET  /v1/jobs/:id/events
GET  /v1/artifacts/:id
```

The existing `/v1/tasks` API remains the compatibility surface for Codex tasks unless an explicit breaking change is approved.

Do not add a generic `/v1/openai/*`, arbitrary upstream URL, raw request-body forwarding, or unrestricted model proxy. Each new capability needs a strict schema, an explicit scope, a server-side model and option policy, normalized output, audit coverage, and deny-path tests.

### Separate Jobs From Coding Tasks

A future `job` is the minimal lifecycle shared by heterogeneous work:

- Gateway job ID;
- owner token ID;
- capability or job kind;
- public provider ID;
- `queued`, `running`, `completed`, or `failed` status;
- timestamps and normalized public error;
- input and output artifact references.

Capability-specific records hold the rest. Codex task rows retain repo, workspace, mode, and internal thread state. Image and audio records hold only their relevant options and artifacts.

The initial job kinds should be explicit rather than dynamically invented:

```text
coding.task
image.generate
image.edit
audio.transcribe
audio.speech
```

### Treat Binary Output As Artifacts

Generated images and audio should not be embedded in normal job responses or stored as large SQLite blobs.

SQLite should store artifact metadata such as owner, media type, size, hash, internal storage reference, timestamps, and retention state. File bytes should live in a Gateway-managed storage directory or a future object store. Public APIs expose opaque artifact IDs, never internal paths.

Artifact handling must include:

- upload and output size limits;
- content-based media validation rather than trusting file names;
- authorization on every read and delete;
- retention and cleanup policy;
- safe download headers;
- SSRF protection if remote inputs are ever supported.

### Keep Streaming Modes Purpose-Specific

SSE remains suitable for normalized job progress and partial image events. Binary results should be downloaded through artifact endpoints.

Realtime audio has a different lifecycle. A browser or mobile client should normally receive a short-lived session credential created by the Gateway and connect using the supported realtime transport. The long-lived OpenAI API key must remain server-side. Realtime media forwarding should not be added to Fastify by default merely to make every capability look like an SSE task.

## Credentials And Billing

Backend credentials are server-side configuration and must never appear in Gateway request bodies, public events, audit logs, or responses.

| Backend | Credential source | Usage domain |
| --- | --- | --- |
| Codex App Server | local ChatGPT/Codex login or an explicitly supported Codex credential | ChatGPT/Codex plan limits or its configured authentication mode |
| OpenAI Platform APIs | server-side Platform API credential | OpenAI Platform project billing and rate limits |
| Gateway clients | Gateway-issued scoped token | Gateway authorization only |

Operational usage records should keep subscription-backed Codex work separate from Platform API usage. The Gateway should enforce its own per-token and per-capability limits in addition to upstream limits, including concurrency, request rate, file size, audio duration, image count or quality, and configurable spend ceilings.

## Authorization Direction

Prefer capability scopes over a single broad provider scope:

```text
coding:create
coding:read
coding:control
image:generate
image:edit
audio:transcribe
audio:speech
realtime:create
artifact:read
```

Existing `task:*`, repo, workspace, mode, and provider scopes remain valid for the current Codex API. Any migration must be additive until a separately documented compatibility plan exists.

Holding an operation scope must not bypass model, repo, workspace, cost, size, duration, or storage policy.

## Capability Choices

For images, use the Image API for bounded single-request generation or editing. Use image generation through the Responses API only when conversational or multi-turn image editing is an actual product requirement.

For audio, begin with request-based transcription and speech generation. Add realtime sessions separately when live, low-latency interaction is required. Realtime is not merely a faster file-upload endpoint and should have its own policy and session lifecycle.

For general stateful text and tool workflows, evaluate the Responses API as a distinct capability. Do not route them through Codex solely to consume ChatGPT subscription access; Codex remains the coding-agent backend.

Relevant upstream guidance:

- [Codex App Server](https://learn.chatgpt.com/docs/app-server.md)
- [OpenAI authentication for Codex](https://learn.chatgpt.com/docs/auth.md)
- [Image generation](https://developers.openai.com/api/docs/guides/image-generation)
- [Audio and speech](https://developers.openai.com/api/docs/guides/audio)
- [Responses API](https://developers.openai.com/api/reference/responses/overview)

## Security Invariants

Future capability work must preserve the current deny-by-default boundary:

- no arbitrary shell execution;
- no `danger-full-access` public mode;
- no public raw `cwd` or arbitrary local path;
- no generic Codex App Server JSON-RPC proxy;
- no generic OpenAI API proxy;
- no client-supplied OpenAI API key, ChatGPT token, refresh token, or Codex session secret;
- no backend-native thread, session, request, or storage identifiers unless explicitly normalized and proven safe;
- no full sensitive prompt, audio transcript, or binary input in audit logs;
- no capability without positive and negative authorization tests.

When convenience conflicts with an unambiguous authorization, credential, cost, filesystem, or retention policy, deny the request.

## Delivery Sequence

A safe incremental path is:

1. Introduce the provider-neutral job and artifact concepts without breaking `/v1/tasks`.
2. Add bounded image generation, then image editing.
3. Add file-based transcription, then speech generation.
4. Add Platform API usage accounting, per-token limits, and spend controls.
5. Add realtime session creation only after its credential and lifecycle policy is documented.
6. Add conversational image or general Responses API workflows only for concrete product needs.
7. Improve Codex thread durability and resume independently from media capabilities.

Each phase should ship with strict schemas, explicit scopes, audit behavior, storage and cleanup rules, denial tests, client documentation, and the verification required by [`QUALITY.md`](QUALITY.md).
