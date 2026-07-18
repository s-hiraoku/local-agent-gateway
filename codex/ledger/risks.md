# Risks

## Open Risks

### 2026-07-18: Host files remain readable to Codex

- Risk: The current macOS LaunchAgent runs as the interactive owner. Read-only mode prevents mutation but does not prove that Codex cannot read HOME, credentials, or other repositories.
- Impact: A malicious prompt or repository instruction could exfiltrate host-readable data through a model response.
- Likelihood: Material whenever prompts or repositories are not fully trusted.
- Mitigation: Restrict current use to trusted clients and repositories. Implement and verify the split host/VM boundary, inner credential privilege separation, and deny-by-default guest networking in `docs/READABLE_ROOT_ISOLATION.md` before expanding trust.
- Status: Open; release-blocking for untrusted input.

### 2026-07-18: Encryption key has no rotation workflow

- Risk: Encrypted SQLite payloads depend on one long-lived Keychain key.
- Impact: Losing the key makes stored payloads unavailable; exposing the key with the database exposes them.
- Likelihood: Low in normal local operation, with high recovery impact.
- Mitigation: Keep an encrypted recovery copy separate from the database and use bounded retention. Design transactional re-encryption before rotation is required.
- Status: Open; accepted for trusted single-owner operation.

### 2026-07-18: Codex App Server protocol compatibility is not pinned

- Risk: A Codex CLI update may change JSON-RPC behavior or schemas beyond current normalization tests.
- Impact: Readiness or jobs may fail after an operator upgrade.
- Likelihood: Medium over the service lifetime.
- Mitigation: Pin the deployed Codex CLI operationally, retain fake-server contract tests, and add generated-schema/version compatibility checks before automatic upgrades.
- Status: Open.

## Closed Risks

### 2026-07-18: Metrics endpoint materialized all window durations

- Risk: Repeated metrics polling could make application memory and latency grow with completed jobs in the selected window.
- Mitigation: PR #23 was amended so SQLite ranks the bounded set and returns only the p50/p95 rows; a 20-row nearest-rank regression test was added.
- Status: Closed by commit `606bfde` and merge commit `6b56f0d`.
