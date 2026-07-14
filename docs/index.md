# Local Agent Gateway V2

Local Agent Gateway V2 is a clean rewrite for connecting trusted external applications to local AI capabilities without exposing backend protocols or credentials.

The first vertical slice implements subscription-backed, read-only coding through Codex App Server. Image and audio operations remain planned OpenAI Platform API adapters; they are not implemented by the current server.

## Documents

- [Architecture](ARCHITECTURE.md): product boundary, capability adapters, and delivery sequence.
- [Threat model](THREAT_MODEL.md): trusted parties, protected assets, security invariants, and unresolved isolation work.
- [Client integration](CLIENT_INTEGRATION.md): V2 API workflow and retry contract.
- [Event streaming](EVENT_STREAMING.md): SSE event format and reconnect behavior.
- [Quality and operations](QUALITY.md): supported runtime, verification, execution guarantees, and release gates.

The public surface is intentionally small:

```text
GET  /healthz
GET  /readyz
GET  /v2/capabilities
GET  /v2/repositories
POST /v2/conversations
POST /v2/conversations/:id/turns
POST /v2/coding/runs
GET  /v2/jobs/:id
GET  /v2/jobs/:id/events
POST /v2/jobs/:id/cancel
```

OpenAPI documentation is served from `/docs` by a running Gateway.
