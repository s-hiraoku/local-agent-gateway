# local-agent-gateway

Local Agent Gateway is a private, single-owner API for using local AI capabilities from trusted external applications. Version 2 is a clean rewrite: coding runs through Codex App Server over private stdio; future image and audio capabilities will use the OpenAI Platform API behind separate adapters.

The public API never exposes a raw working directory, Codex thread ID, App Server JSON-RPC method, upstream credential, arbitrary shell endpoint, or `danger-full-access` mode.

## V2 status

Implemented:

- authenticated, read-only coding conversations;
- atomic one-shot coding runs for stateless clients such as Decision-Agent;
- JSON Schema-constrained output with strict local result validation;
- durable SQLite jobs and attempt history;
- encrypted prompt, result, and event payloads;
- required `Idempotency-Key` submission;
- bounded queue, concurrency, result, event, stderr, RPC, and turn handling;
- parallel conversations with strict in-order execution inside each conversation;
- reconnectable Server-Sent Events;
- one isolated App Server process per job with an environment allowlist;
- graceful cancellation and shutdown;
- OpenAPI documentation at `/docs`.

Not implemented yet:

- write-capable worktrees and patch artifacts;
- image, audio, realtime, or general Responses API adapters;
- multi-user identity or token administration;
- Codex account login endpoints and usage reporting;
- an OS-level readable-root boundary around Codex;
- artifact retention and telemetry exporters.

V2 is a production-shaped foundation, not production-ready for untrusted users or untrusted repositories. See [Architecture](docs/ARCHITECTURE.md) and [Threat model](docs/THREAT_MODEL.md).

## Requirements

- Node.js 26 (`.node-version` pins the preferred patch)
- pnpm 11.13
- a current Codex CLI with App Server support
- a dedicated `CODEX_HOME` authenticated with the intended ChatGPT/Codex account

The dedicated home must not contain `config.toml`; Gateway startup rejects it to prevent accidental MCP or personal configuration inheritance.

Authenticate that dedicated home before starting the service:

```bash
mkdir -p "$HOME/.codex-gateway"
CODEX_HOME="$HOME/.codex-gateway" codex login
```

`GET /readyz` starts an App Server health probe and reports ready only when this home contains a ChatGPT account login. API-key-backed Codex sessions are intentionally rejected because coding is meant to use the ChatGPT/Codex subscription boundary.

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
| `CODEXGW_DATA_ENCRYPTION_KEY` | Exactly 32 random bytes encoded as base64. Losing it makes stored payloads unrecoverable. |
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
| `CODEXGW_MAX_QUEUED_JOBS` | `100` |
| `CODEXGW_MAX_CONCURRENT_JOBS` | `2` |
| `CODEXGW_MAX_PROMPT_BYTES` | `65536` |
| `CODEXGW_MAX_RESULT_BYTES` | `1048576` |
| `CODEXGW_MAX_EVENT_BYTES` | `65536` |
| `CODEXGW_MAX_EVENTS_PER_JOB` | `10000` |
| `CODEXGW_RPC_TIMEOUT_MS` | `30000` |
| `CODEXGW_TURN_TIMEOUT_MS` | `1800000` |

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

## Security boundary

Gateway credentials and backend credentials are separate. Clients submit only Gateway bearer tokens. App Server inherits a small environment allowlist and a dedicated `CODEX_HOME`; OpenAI API keys are not accepted by public request bodies.

`read-only` prevents writes and, with `approvalPolicy: never`, rejects interactive escalation. It is not by itself proof that Codex cannot read host files outside the repository. Until an OS-level readable-root boundary is implemented and tested, run this only as a dedicated local service account against trusted repositories and trusted client applications. Do not expose the port directly to the public internet.
