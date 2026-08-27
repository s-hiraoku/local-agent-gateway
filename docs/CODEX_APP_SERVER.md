# Codex App Server

Codex App Server is a private backend of Local Agent Gateway, not a public API. Clients authenticate to the Gateway and call `/v2` (or the optional `/v1/responses` facade). They never start `codex app-server`, send JSON-RPC, name a working directory, or see Codex thread or turn IDs.

The adapter lives in `src/adapters/codex/`. The wire protocol is Codex CLI App Server over stdio. Upstream reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server.md).

## When the Gateway uses it

| Job or probe | Uses App Server? |
| --- | --- |
| `coding.turn` (`POST /v2/coding/runs`, `POST /v2/conversations/:id/turns`) | Always. Read-only repository sandboxing is a Codex App Server guarantee that Claude, Grok, and Cursor adapters do not reproduce. |
| `inference.turn` (`POST /v2/inference/runs`, optional `POST /v1/responses`) | Only when `CODEXGW_INFERENCE_PROVIDER=codex` (the default). Claude, Grok, and Cursor inference do not start App Server. |
| `GET /readyz` | Always. Readiness starts an App Server probe even when inference uses another provider, because coding turns still require Codex. |

## Operator setup

Install a Codex CLI inside the range in `src/adapters/codex/compatibility.ts` (currently 0.128.0–0.149.99). Authenticate a **dedicated** home, not `~/.codex`:

```bash
mkdir -p "$HOME/.codex-gateway"
chmod 700 "$HOME/.codex-gateway"
CODEX_HOME="$HOME/.codex-gateway" codex login
```

That home must not contain `config.toml`. Gateway startup rejects it so personal MCP or CLI settings cannot leak into jobs.

Point the service at that home (defaults shown):

```text
CODEXGW_CODEX_COMMAND=codex
CODEXGW_CODEX_HOME=$HOME/.codex-gateway
```

`GET /readyz` is ready only when:

- `codex --version` parses inside `SUPPORTED_CODEX_CLI_RANGE`;
- App Server `account/read` reports `account.type === "chatgpt"`.

API-key Codex sessions are rejected. Coding is meant to stay on the ChatGPT/Codex subscription boundary. Install and login details for a macOS LaunchAgent are in [Local production](LOCAL_PRODUCTION.md).

## Client usage

Clients do not choose App Server. They call Gateway capabilities.

```bash
curl -X POST http://127.0.0.1:8787/v2/coding/runs \
  -H "Authorization: Bearer $CODEXGW_API_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"repositoryId":"gateway","prompt":"Review the architecture."}'
```

The workspace is never a client field. Coding uses the server-side repository registry; Codex-backed inference uses a Gateway-owned empty directory under `CODEXGW_INFERENCE_WORKSPACE_ROOT`. Request and job bodies still expose only Gateway IDs.

See [Client integration](CLIENT_INTEGRATION.md) for conversations, jobs, SSE, and retries.

## Internal turn (adapter contract)

This section describes how the Gateway talks to App Server. It is not a public interface. Do not add these methods, thread IDs, or raw notifications to HTTP routes.

Each Codex job starts one process:

- host executor: `codex app-server` with an environment allowlist (`CODEX_HOME`, `PATH`, `HOME`, `TMPDIR`, locale, user, and `SHELL`; plus `NO_COLOR` and `TERM`). Gateway secrets are not inherited.
- Lima executor (`CODEXGW_CODEX_EXECUTOR=lima`): `limactl shell` → `codex app-server` against a per-job snapshot. Claude, Grok, and Cursor inference stay on the host even when Lima is enabled.

Then the adapter:

1. Sends `initialize` (client name `local-agent-gateway`, `experimentalApi: false`) and notifies `initialized`.
2. Maps the Gateway conversation to an App Server thread: `thread/start` on the first turn, `thread/resume` afterward. Policy is fixed: `approvalPolicy: never`, `sandbox: read-only`.
3. Starts the turn with `turn/start`. Input is a single text item (the Gateway prompt). Optional `outputSchema` is forwarded only after the Gateway has accepted a bounded JSON Schema subset.
4. Collects notifications for that thread and turn only: `item/agentMessage/delta`, `item/completed`, `turn/completed`. Those are normalized, path-redacted, encrypted, and exposed as Gateway SSE events. Raw App Server payloads are not forwarded.
5. On cancel or shutdown, sends `turn/interrupt`, then terminates the process.

Readiness uses the same transport for `account/read` (`refreshToken: false`) and then closes the process. Conversation turns are claimed one at a time so the internal thread cannot fork.

## What this Gateway does not do

- Expose a generic App Server JSON-RPC endpoint, Codex IDs, stderr, command lines, or raw `cwd`.
- Accept `danger-full-access`, write sandboxing, or client-selected executables.
- Proxy `POST /v1/chat/completions` or other CLIProxyAPI-style dialects.
- Treat read-only plus `approvalPolicy: never` as a confidentiality boundary. Lima is opt-in; the default LaunchAgent still runs Codex on the host. See [Readable-root isolation](READABLE_ROOT_ISOLATION.md).

## Related documents

- [Architecture](ARCHITECTURE.md): why coding is Codex-only and how jobs are layered.
- [Client integration](CLIENT_INTEGRATION.md): public `/v2` workflow.
- [Event streaming](EVENT_STREAMING.md): normalized SSE, not App Server replay.
- [Quality and operations](QUALITY.md): CLI pin, `/readyz`, and per-job process rule.
- [OpenAI Responses compatibility](OPENAI_RESPONSES_COMPATIBILITY.md): optional text facade over the same inference pipeline.
