# Risks

## Open Risks

### 2026-07-18: Host files remain readable to Codex

- Risk: The current macOS LaunchAgent runs as the interactive owner. Read-only mode prevents mutation but does not prove that Codex cannot read HOME, credentials, or other repositories.
- Impact: A malicious prompt or repository instruction could exfiltrate host-readable data through a model response.
- Likelihood: Material whenever prompts or repositories are not fully trusted.
- Mitigation: Restrict current use to trusted clients and repositories. The opt-in Lima executor copies one snapshot into a dedicated VM, hides guest `CODEX_HOME` from Codex `bwrap` tools, and fail-closes `/readyz` unless that probe passes. Live Codex tool-path evidence and LaunchAgent migration are still required before expanding trust.
- Status: Open; release-blocking for untrusted input.

### 2026-07-18: Encryption key has no rotation workflow

- Risk: Encrypted SQLite payloads depend on one long-lived Keychain key.
- Impact: Losing the key makes stored payloads unavailable; exposing the key with the database exposes them.
- Likelihood: Low in normal local operation, with high recovery impact.
- Mitigation: `pnpm rotate-key` re-encrypts payloads and the sentinel in one SQLite transaction. Startup decrypts the sentinel and fails closed on a mismatched key. Keep an encrypted recovery copy of the current key separate from the database.
- Status: Mitigated; operator must stop the service and replace the Keychain item after rotation.

### 2026-07-18: Codex App Server protocol compatibility is not pinned

- Risk: A Codex CLI update may change JSON-RPC behavior or schemas beyond current normalization tests.
- Impact: Readiness or jobs may fail after an operator upgrade.
- Likelihood: Medium over the service lifetime.
- Mitigation: `/readyz` and each turn fail closed outside `SUPPORTED_CODEX_CLI_RANGE`. Fake-server contract tests lock the initialize payload and method surface. Bump the range only after verification. Generated App Server schemas remain a follow-up.
- Status: Mitigated for the pinned range; still open for untested newer CLIs.

## Closed Risks

### 2026-07-18: Metrics endpoint materialized all window durations

- Risk: Repeated metrics polling could make application memory and latency grow with completed jobs in the selected window.
- Mitigation: PR #23 was amended so SQLite ranks the bounded set and returns only the p50/p95 rows; a 20-row nearest-rank regression test was added.
- Status: Closed by commit `606bfde` and merge commit `6b56f0d`.
