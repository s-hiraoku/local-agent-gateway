# Decisions

## 2026-08-15: Fail-closed guest tool isolation and hostname-resolved egress

- Decision: When `CODEXGW_CODEX_EXECUTOR=lima`, put a `bwrap` wrapper first on the guest App Server PATH so Codex tool sandboxes hide `CODEX_HOME`. `/readyz` runs a synthetic isolation probe and fails closed unless it passes or the operator sets `CODEXGW_LIMA_ALLOW_UNPROVEN_TOOL_ISOLATION=true`. Guest TCP 443 is limited to resolved names in `scripts/lima/guest/egress-hosts`.
- Context: Issue #33 required proof that tool subprocesses cannot read guest authentication state, plus hostname pinning after private ranges were already denied.
- Alternatives considered: Changing App Server's UID, writing guest `config.toml`, treating Codex `read-only` as sufficient, allowing all public HTTPS, and migrating LaunchAgent immediately.
- Rationale: Codex Linux tools already enter `bwrap` and separate options with `--`, so hide-mounts can be injected without a guest config file. Prefer denial when the probe fails. IP sets are an increment over open 443; SNI inspection remains a follow-up.
- Consequences: Lima readiness now depends on installed guest helpers. Live Codex tool-path evidence and LaunchAgent migration remain blocked. Shared CDN IPs and open DNS are documented residuals.

## 2026-08-15: Opt-in Lima executor for the first readable-root milestone

- Decision: Add `CODEXGW_CODEX_EXECUTOR=lima` as an opt-in Codex executor. One long-lived Lima `vz` VM runs Codex only. Gateway, SQLite, and secrets stay on the host. Each job copies a read-only snapshot over `limactl shell` stdio. The default executor remains `host`.
- Context: Issue #33 required explicit operator choices before implementation. The existing LaunchAgent must not break.
- Alternatives considered: Defaulting the LaunchAgent to Lima, mounting the host repository read-only, exposing a client-selected VM or command, and treating two guest users as a completed credential boundary.
- Rationale: A copied snapshot avoids host-parent mounts. Lima SSH stdio reuses the existing App Server contract. Keeping `host` as the default preserves the installed service. Two guest users are reserved, but App Server still runs as the supervisor until tool isolation is proven.
- Consequences: Host/Gateway files are out of the guest filesystem when Lima is enabled. Malicious prompts remain out of scope until tool subprocesses cannot read guest `CODEX_HOME` and hostname-pinned egress is proven. Recreating the VM requires a guest `codex login`. Live acceptance evidence is still required before LaunchAgent migration.

## 2026-07-18: Use a VM for the readable-root security boundary

- Decision: Treat a split host control plane and dedicated VM executor as the target confidentiality boundary. Gateway secrets and SQLite remain outside the executor; the VM receives only Codex App Server traffic, its dedicated authentication state, one repository, and disposable inference storage.
- Context: The existing LaunchAgent runs as the interactive user. Application path checks, `cwd`, read-only mode, output filtering, and a separate `CODEX_HOME` do not constrain OS-level reads.
- Alternatives considered: Prompt policy, output filtering, `sandbox-exec`, a dedicated macOS account, containers, and a lightweight VM.
- Rationale: A VM provides a testable host-filesystem boundary without relying on deprecated/private host sandbox profiles. Keeping the control plane outside the VM also prevents repository instructions from reaching Gateway data. Because App Server still needs guest authentication state, the design additionally requires proof that its tool subprocesses cannot read `CODEX_HOME`.
- Consequences: Current deployment remains trusted-input only. Executor support, guest sandbox proof, host provisioning, and credential migration require an explicit operator-approved change with backup and rollback.

## 2026-07-18: Activate Renovate conservatively

- Decision: Add repository-owned Renovate configuration with no automerge, a weekly Asia/Tokyo schedule, low PR concurrency, and Node/pnpm major-version constraints.
- Context: The default onboarding PR would activate the broad `config:recommended` preset without project-specific operational limits.
- Alternatives considered: Leave Renovate disabled, merge the default onboarding PR unchanged, or enable unrestricted updates.
- Rationale: Automated discovery is useful, while explicit review and CI must remain the merge gate for this security-sensitive service.
- Consequences: Renovate may open a small number of scheduled PRs. Major Node and pnpm migrations remain intentional projects.
