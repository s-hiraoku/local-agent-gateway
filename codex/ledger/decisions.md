# Decisions

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
