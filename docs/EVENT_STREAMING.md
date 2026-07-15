# Event Streaming

`GET /v2/jobs/:jobId/events` returns encrypted-at-rest, normalized Gateway events through Server-Sent Events. It never replays raw App Server messages.

```text
id: 3
event: agent.message.delta
data: {"sequence":3,"type":"agent.message.delta","data":{"delta":"..."},"createdAt":"..."}
```

Current event types:

- `job.queued`
- `job.started`
- `agent.message.delta`
- `job.completed`
- `job.failed`
- `job.cancelled`

Event sequence numbers increase monotonically per job and are persisted before delivery. To resume after disconnect:

```bash
curl -N http://127.0.0.1:8787/v2/jobs/job_.../events \
  -H "Authorization: Bearer $CODEXGW_API_TOKEN" \
  -H "Last-Event-ID: 3"
```

The Gateway replays events with a greater sequence, then waits for new events until the job is terminal. Heartbeats are sent every 15 seconds. Socket backpressure is observed before more events are written.

Each reconnect is authenticated. Event payloads may contain model-produced text, so clients must still render them as untrusted content. They never contain full prompts, Gateway secrets, raw Codex IDs, raw commands, or unnormalized JSON-RPC payloads by design.

Limits are controlled by `CODEXGW_MAX_EVENT_BYTES` and `CODEXGW_MAX_EVENTS_PER_JOB`. Overflow fails the job explicitly; terminal notifications are not silently discarded.
