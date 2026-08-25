# local-agent-gateway

Local Agent Gateway is a private, single-owner API for using local AI capabilities from trusted external applications. Version 2 is a clean rewrite: coding runs through Codex App Server over private stdio; inference can use Codex, Claude Code, Grok Build, or the Cursor SDK; future image and audio capabilities will use the OpenAI Platform API behind separate adapters.

The public API never exposes a raw working directory, Codex thread ID, App Server JSON-RPC method, upstream credential, arbitrary shell endpoint, or `danger-full-access` mode.

## V2 status

Implemented:

- authenticated, read-only coding conversations on Codex;
- atomic one-shot coding runs for stateless clients such as Decision-Agent;
- repository-free inference turns on Codex, Claude Code, Grok Build, or Cursor;
- JSON Schema-constrained output with strict local result validation;
- durable SQLite jobs and attempt history;
- encrypted prompt, result, and event payloads;
- required `Idempotency-Key` submission;
- bounded queue, concurrency, result, event, stderr, RPC, and turn handling;
- parallel conversations with strict in-order execution inside each conversation;
- reconnectable Server-Sent Events;
- authenticated, restart-durable operational metrics;
- opt-in, loopback-only OpenAI Responses compatibility for trusted text clients;
- one isolated App Server process per job with an environment allowlist;
- graceful cancellation and shutdown;
- OpenAPI documentation at `/docs`.

Not implemented yet:

- write-capable worktrees and patch artifacts;
- Cursor IDE as a custom OpenAI provider pointed at this Gateway;
- `/v1/chat/completions` and other CLIProxyAPI-style inbound dialects;
- image, audio, realtime, or general OpenAI Platform Responses API adapters;
- multi-user identity or token administration;
- Codex account login endpoints and usage reporting;
- a completed readable-root boundary (opt-in Lima and a fail-closed guest isolation probe exist; default LaunchAgent is still host-local);
- artifact retention and telemetry exporters.

V2 is a production-shaped foundation, not production-ready for untrusted users or untrusted repositories. See [Architecture](docs/ARCHITECTURE.md) and [Threat model](docs/THREAT_MODEL.md).

## Backends

Clients authenticate only to the Gateway. They never name a working directory, CLI, or upstream token. The Gateway selects a runner by job kind.

| Job | Backend | Credential | Scope |
| --- | --- | --- | --- |
| `coding.turn` | Codex App Server only | dedicated ChatGPT/Codex login in `CODEX_HOME` | Read-only review of a registered repository: conversations, `/v2/coding/runs`, structured output, SSE |
| `inference.turn` | `CODEXGW_INFERENCE_PROVIDER`: `codex` (default), `claude`, `grok`, or `cursor` | matching local CLI login, or a Cursor Dashboard API key for `cursor` | Text-in / JSON-out against a private empty directory. No `repositoryId` |

`GET /readyz` always probes Codex (supported CLI version and ChatGPT login), and also probes the selected inference backend when it is not Codex. Authentication of Claude, Grok, or Cursor is not probed on every poll, because that would consume subscription usage; a missing login or key fails on the first real turn.

Cursor here is `@cursor/sdk` billed against the owner's Cursor plan. Pointing the Cursor IDE at this Gateway as a custom OpenAI provider is not implemented. Lima isolation is Codex coding only and remains opt-in.

## Requirements

- Node.js 26 (`.node-version` pins the preferred patch)
- pnpm 11.13
- a current Codex CLI with App Server support, pinned inside the range in `src/adapters/codex/compatibility.ts` (currently 0.128.0–0.149.99). Required even when inference uses Claude, Grok, or Cursor, because `/readyz` and coding turns always use Codex
- a dedicated `CODEX_HOME` authenticated with the intended ChatGPT/Codex account
- optional: Claude Code (`claude auth login`) when `CODEXGW_INFERENCE_PROVIDER=claude`
- optional: Grok Build (`grok login`) when `CODEXGW_INFERENCE_PROVIDER=grok`. Uses `~/.grok/auth.json`, not `XAI_API_KEY`
- optional: a Cursor user or service-account API key (`CODEXGW_CURSOR_API_KEY`) when `CODEXGW_INFERENCE_PROVIDER=cursor`. Create it at Cursor Dashboard → Integrations. Do not commit the key.

The dedicated home must not contain `config.toml`; Gateway startup rejects it to prevent accidental MCP or personal configuration inheritance.

Authenticate that dedicated home before starting the service:

```bash
mkdir -p "$HOME/.codex-gateway"
CODEX_HOME="$HOME/.codex-gateway" codex login
```

`GET /readyz` starts an App Server health probe and reports ready only when the Codex CLI version is inside the supported range and this home contains a ChatGPT account login. An unsupported or unreadable CLI version fails closed with `CODEX_UNSUPPORTED_VERSION`. API-key-backed Codex sessions are intentionally rejected because coding is meant to use the ChatGPT/Codex subscription boundary.

Install and verify:

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm smoke
```

## Configuration

Generate secrets without writing them into the repository:

```bash
openssl rand -base64 32
openssl rand -hex 32
```

Required environment variables:

| Variable | Purpose |
| --- | --- |
| `CODEXGW_API_TOKEN` | Single-owner bearer token, at least 32 characters. |
| `CODEXGW_DATA_ENCRYPTION_KEY` | Exactly 32 random bytes encoded as base64. Losing it makes stored payloads unrecoverable. Stop the service and run `pnpm rotate-key` with `CODEXGW_DATA_ENCRYPTION_KEY_NEW` to rotate. |
| `CODEXGW_REPOSITORIES_JSON` | Server-side repository registry such as `[{"id":"gateway","path":"/absolute/repo"}]`. |

Important optional variables:

| Variable | Default |
| --- | --- |
| `CODEXGW_HOST` | `127.0.0.1` |
| `CODEXGW_PORT` | `8787` |
| `CODEXGW_DATABASE_PATH` | `./data/gateway-v2.sqlite` |
| `CODEXGW_CODEX_COMMAND` | `codex` |
| `CODEXGW_CODEX_HOME` | `~/.codex-gateway` |
| `CODEXGW_CODEX_MODEL` | Codex account/config default |
| `CODEXGW_OPENAI_COMPATIBILITY_ENABLED` | `false`; enables the loopback-only text Responses subset |
| `CODEXGW_INFERENCE_PROVIDER` | `codex`; set to `claude`, `grok`, or `cursor` to run inference turns on that backend |
| `CODEXGW_CLAUDE_COMMAND` | `claude` |
| `CODEXGW_CLAUDE_MODEL` | Claude account/config default |
| `CODEXGW_GROK_COMMAND` | `grok` |
| `CODEXGW_GROK_MODEL` | Grok account/config default |
| `CODEXGW_CURSOR_API_KEY` | required when inference is `cursor`; user or service-account key from the Cursor dashboard |
| `CODEXGW_CURSOR_MODEL` | `composer-2.5` |
| `CODEXGW_CODEX_EXECUTOR` | `host`; set to `lima` only after installing Lima (`brew install lima`) and creating the VM |
| `CODEXGW_LIMA_COMMAND` | `limactl` |
| `CODEXGW_LIMA_INSTANCE` | `codexgw` |
| `CODEXGW_LIMA_ALLOW_UNPROVEN_TOOL_ISOLATION` | `false`; if the guest isolation probe fails, `/readyz` stays closed unless this is `true` |
| `CODEXGW_MAX_QUEUED_JOBS` | `100` |
| `CODEXGW_MAX_CONCURRENT_JOBS` | `2` |
| `CODEXGW_MAX_PROMPT_BYTES` | `65536` |
| `CODEXGW_MAX_RESULT_BYTES` | `1048576` |
| `CODEXGW_MAX_EVENT_BYTES` | `65536` |
| `CODEXGW_MAX_EVENTS_PER_JOB` | `10000` |
| `CODEXGW_RPC_TIMEOUT_MS` | `30000` |
| `CODEXGW_TURN_TIMEOUT_MS` | `1800000` |
| `CODEXGW_RETENTION_DAYS` | `14` |
| `CODEXGW_INFERENCE_WORKSPACE_ROOT` | `~/.codex-gateway-inference` |

An hourly retention sweep deletes terminal jobs (with their events, attempts, and idempotency records) older than `CODEXGW_RETENTION_DAYS`, plus conversations that no longer have jobs and have not been touched within the window. Queued and running jobs are never touched. The latest successful sweep time and deleted job/conversation counts are persisted atomically and exposed through the metrics endpoint. Two consequences to know: reusing an `Idempotency-Key` after its record is pruned re-executes the request instead of replaying the stored job, and the SQLite file does not shrink on disk — freed pages are reused by new writes.

Copy [.env.example](.env.example) as a local reference, then start the service through your secret manager or service definition:

```bash
pnpm dev
```

For an always-on, single-owner macOS installation, use the versioned LaunchAgent deployment instead of `pnpm dev`. It stores secrets in the login Keychain, keeps data outside the release, and provides status, backup, and rollback commands. See [Local production on macOS](docs/LOCAL_PRODUCTION.md).

## API walkthrough

```bash
curl -H "Authorization: Bearer $CODEXGW_API_TOKEN" \
  http://127.0.0.1:8787/v2/repositories
```

For a stateless structured request, submit an atomic one-shot run. The Gateway creates its internal conversation and job in one transaction:

```bash
curl -X POST http://127.0.0.1:8787/v2/coding/runs \
  -H "Authorization: Bearer $CODEXGW_API_TOKEN" \
  -H "Idempotency-Key: decision-review-019f" \
  -H "Content-Type: application/json" \
  -d '{
    "repositoryId":"reviews",
    "prompt":"Return a review verdict.",
    "outputSchema":{
      "type":"object",
      "properties":{"verdict":{"type":"string","enum":["accept","revise","reject"]}},
      "required":["verdict"],
      "additionalProperties":false
    }
  }'
```

On completion, `GET /v2/jobs/:id` contains both the exact JSON text in `result` and the validated value in `structuredOutput`. Invalid JSON or schema mismatch fails with `STRUCTURED_OUTPUT_INVALID`; the Gateway does not repair or extract JSON from Markdown.

For a pure text-in/JSON-out request that does not inspect any repository — a review or classification over supplied text — use the inference endpoint. It takes no `repositoryId`; the Gateway runs it read-only against a private, single-use working directory the client never names, so no repository needs to be registered:

```bash
curl -X POST http://127.0.0.1:8787/v2/inference/runs \
  -H "Authorization: Bearer $CODEXGW_API_TOKEN" \
  -H "Idempotency-Key: decision-review-019f" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt":"Return a review verdict.",
    "outputSchema":{
      "type":"object",
      "properties":{"verdict":{"type":"string","enum":["accept","revise","reject"]}},
      "required":["verdict"],
      "additionalProperties":false
    }
  }'
```

Inference jobs poll and read `structuredOutput` exactly like coding runs (`kind` is `inference.turn`, `repositoryId` is `null`).

Inference turns can run on Claude Code, Grok Build, or the Cursor SDK instead of Codex. Coding turns are
unaffected and always run on Codex, because repository sandboxing is
Codex-specific. Authenticate the chosen backend once, then:

```bash
CODEXGW_INFERENCE_PROVIDER=claude pnpm dev
# or
CODEXGW_INFERENCE_PROVIDER=grok pnpm dev
# or
CODEXGW_INFERENCE_PROVIDER=cursor CODEXGW_CURSOR_API_KEY=cursor_... pnpm dev
```

Grok uses the owner's `grok login` session (`~/.grok/auth.json`), not an
`XAI_API_KEY`. Cursor uses a Dashboard API key and bills the same request
pools as the IDE; spend appears under the SDK tag. Both run with built-in
tools disabled against the same private single-use working directory. Request
bodies never carry an upstream key. Readiness (`/readyz`) probes every active
backend for presence, so a missing CLI or SDK package surfaces there;
authentication is deliberately not probed, because doing so on every poll
would consume subscription usage. An unauthenticated backend fails on the
first real turn (`CLAUDE_UNAUTHORIZED`, `GROK_UNAUTHORIZED`, or
`CURSOR_UNAUTHORIZED`).

For trusted OpenAI SDK clients on the same host, the optional compatibility surface exposes `GET /v1/models` and `POST /v1/responses`. Enable it only while binding to loopback:

```bash
CODEXGW_OPENAI_COMPATIBILITY_ENABLED=true pnpm dev
```

Merging the implementation does not enable or redeploy an installed Gateway.
For the macOS LaunchAgent deployment, install the merged revision with the
persistent compatibility option:

```bash
pnpm local:install -- --openai-compatibility true
```

The development environment variable affects only the process started by
`pnpm dev`. The production installer writes the option into the versioned
release configuration and restarts the local service. When disabled, `/v1`
compatibility routes return `404`; when enabled, an unauthenticated request
returns `401`.

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.CODEXGW_API_TOKEN,
  baseURL: "http://127.0.0.1:8787/v1"
});

const response = await client.responses.create({
  model: "codex-subscription", // grok-subscription or cursor-subscription when that provider is selected
  input: "Summarize this text: ..."
});
```

This is a strict text-only Responses subset, not `/v1/chat/completions` and not an OpenAI Platform API replacement. The public model alias is `codex-subscription` for Codex or Claude inference, `grok-subscription` when `CODEXGW_INFERENCE_PROVIDER=grok`, and `cursor-subscription` when inference is Cursor. Unsupported fields are rejected. See [OpenAI Responses compatibility](docs/OPENAI_RESPONSES_COMPATIBILITY.md).

Create a conversation:

```bash
curl -X POST http://127.0.0.1:8787/v2/conversations \
  -H "Authorization: Bearer $CODEXGW_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repositoryId":"gateway"}'
```

Submit a turn. Reusing the same key and body returns the original job; reusing the key with different input returns `409`.

```bash
curl -X POST http://127.0.0.1:8787/v2/conversations/cnv_.../turns \
  -H "Authorization: Bearer $CODEXGW_API_TOKEN" \
  -H "Idempotency-Key: 019f-example-request" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Review this repository architecture."}'
```

Poll or stream the returned job:

```bash
curl -H "Authorization: Bearer $CODEXGW_API_TOKEN" \
  http://127.0.0.1:8787/v2/jobs/job_...

curl -N -H "Authorization: Bearer $CODEXGW_API_TOKEN" \
  http://127.0.0.1:8787/v2/jobs/job_.../events
```

## Metrics

`GET /v2/metrics` (authenticated, same bearer token as every `/v2/*` route) returns a JSON snapshot **derived entirely from SQLite**, so it stays accurate across restarts — unlike in-memory counters, which would reset to zero on every redeploy of an always-on service:

```bash
curl -H "Authorization: Bearer $CODEXGW_API_TOKEN" \
  'http://127.0.0.1:8787/v2/metrics?windowHours=24'
```

It reports job counts by status and by kind, queue depth and the oldest queued job's age, the number of retried jobs (a Codex-flakiness signal), and — over a window (default 24h, 1–168) — failures grouped by error code, rate-limit hits by backend (`codex` / `claude` / `grok` / `cursor`), and completed-job duration percentiles (p50/p95). `retention.lastRunAt` and `retention.lastPruned` report the latest successful retention sweep across restarts; before any sweep completes they are `null` and zero counts. The percentile query is backed by a `(status, completedAt)` index. `windowHours` bounds both the query cost and the freshness of the latency figures.

## Security boundary

Gateway credentials and backend credentials are separate. Clients submit only Gateway bearer tokens. App Server inherits a small environment allowlist and a dedicated `CODEX_HOME`; OpenAI API keys are not accepted by public request bodies.

The optional `/v1` compatibility routes use the same Gateway bearer token. They do not expose OAuth endpoints or OAuth tokens, and cannot be enabled on a non-loopback bind address.

`read-only` prevents writes and, with `approvalPolicy: never`, rejects interactive escalation. It is not by itself proof that Codex cannot read host files outside the repository. An opt-in Lima executor (`CODEXGW_CODEX_EXECUTOR=lima`) copies one repository snapshot into a dedicated VM and fail-closes `/readyz` unless the guest tool-isolation probe passes. The default LaunchAgent still runs Codex on the host. Until the acceptance tests in [Readable-root isolation](docs/READABLE_ROOT_ISOLATION.md) pass, run this only as a dedicated local service account against trusted repositories and trusted client applications. Do not expose the port directly to the public internet.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): product boundary, capability adapters, and delivery sequence
- [Threat model](docs/THREAT_MODEL.md): trusted parties, protected assets, and security invariants
- [Readable-root isolation](docs/READABLE_ROOT_ISOLATION.md): Lima executor decisions and acceptance tests
- [Client integration](docs/CLIENT_INTEGRATION.md): V2 API workflow and retry contract
- [Event streaming](docs/EVENT_STREAMING.md): SSE event format and reconnect behavior
- [Quality and operations](docs/QUALITY.md): supported runtime, verification, and release gates
- [OpenAI Responses compatibility](docs/OPENAI_RESPONSES_COMPATIBILITY.md): opt-in text Responses subset
- [Local production on macOS](docs/LOCAL_PRODUCTION.md): LaunchAgent install, backup, and rollback
- [Docs index](docs/index.md): full document list and public route surface
