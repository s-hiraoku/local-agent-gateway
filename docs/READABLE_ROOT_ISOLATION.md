# Readable-root isolation design

## Status

This is the required design for a future confidentiality boundary. It is not implemented by the current macOS LaunchAgent. Until the acceptance tests below pass, the Gateway supports only trusted clients, prompts, and repositories.

## Security objective

A Codex job must be unable to read the host owner's HOME, SSH and cloud credentials, other repositories, Gateway secrets, backups, or arbitrary host paths. A denial must come from the execution environment rather than prompt policy or output filtering.

The boundary must preserve:

- ChatGPT-authenticated Codex App Server operation;
- one explicitly selected repository mounted read-only for coding jobs;
- Gateway-owned single-use directories for inference jobs;
- encrypted job persistence and bounded backup/restore;
- loopback-only client access and Gateway bearer authentication.

## Target architecture

Split the deployment into two security zones:

- The host control plane runs Gateway, bearer/encryption secrets, SQLite, retention, and the loopback HTTP listener. It never exposes those files or environment variables to the executor.
- A dedicated lightweight VM runs only Codex CLI/App Server, its dedicated `CODEX_HOME`, one explicitly selected read-only repository, and disposable inference workspaces. A fixed administrator-configured transport carries the existing bounded App Server protocol between Gateway and the executor.

Do not mount the host HOME, Gateway data, logs, backups, SSH agent, cloud configuration, personal Codex home, Docker socket, or the parent directory containing registered repositories. Authenticate Codex interactively inside the VM so plaintext authentication state is never copied from the host.

Repository sharing must fail closed. Each public repository ID maps to one exact guest path. Prefer a read-only snapshot copied into the VM; if the selected VM supports read-only mounts with enforceable semantics, verify attempted writes and sibling traversal empirically before relying on them.

The executor still contains the dedicated Codex authentication state needed by App Server. A VM alone does not prevent a tool subprocess running as the same guest identity from reading that file. The selected executor therefore needs an inner privilege boundary: a credential-owning supervisor or upstream-supported auth broker must be separate from the unprivileged tool executor, and the tool environment and inherited file descriptors must be scrubbed. App Server tool processes must be proven able to read the repository but unable to read `CODEX_HOME`. If that denial cannot be demonstrated, the design protects host and Gateway assets but remains incomplete for malicious prompts.

Guest networking must also fail closed. The host-to-guest App Server transport must be private and mutually authenticated. The guest must not reach the host control-plane listener, Keychain services, metadata endpoints, or other private networks. Outbound internet access must be denied by default or restricted to the minimum documented endpoints required for Codex operation; the acceptance evidence must record the effective policy. Otherwise any guest-readable credential remains exfiltratable even when host mounts are absent.

## Controls that do not satisfy the objective

- `cwd` selection or string path validation;
- Codex read-only sandbox mode;
- `approvalPolicy: never`;
- a separate `CODEX_HOME` under the same host user;
- environment allowlisting;
- prompt instructions or response redaction;
- a dedicated macOS account without an additional sandbox;
- `sandbox-exec` profiles that depend on deprecated or private host behavior.

These remain useful defense in depth, but none proves that unrelated readable host files are absent.

## Provisioning sequence

1. Select and pin a VM runtime, guest image, mutually authenticated App Server transport, and deny-by-default network policy. Record their versions and update policy.
2. Install a pinned Codex CLI inside the guest; keep Gateway and SQLite on the host control plane.
3. Create separate guest paths for `CODEX_HOME` and disposable inference workspaces with restrictive permissions and no host-parent mount.
4. Authenticate the dedicated Codex home interactively inside the guest and verify that it contains no personal `config.toml` or MCP configuration.
5. Copy or mount one test repository read-only. Do not expose a parent directory or the host checkout containing Gateway secrets.
6. Add an executor adapter that starts only the fixed VM transport; clients must not select a command, guest path, or VM.
7. Separate the credential-owning supervisor from the tool executor, scrub inherited environment/file descriptors, and prove that tool subprocesses cannot read `CODEX_HOME` before using real authentication with untrusted prompts.
8. Run the remaining acceptance suite and a backup/restore rehearsal before migrating the resident service.

## Acceptance tests

The boundary is not complete until evidence records all of the following:

- a real subscription-backed structured coding run succeeds against the allowed repository;
- a real inference run succeeds in a private single-use guest directory;
- attempts to read host HOME, SSH material, cloud configuration, another repository, Gateway secrets, and backup paths fail at the filesystem boundary;
- attempts by a Codex tool subprocess to read `CODEX_HOME`, its authentication file, or a same-directory canary fail at the guest filesystem boundary while App Server authentication still works;
- tool subprocesses receive no authentication-bearing environment variables or inherited file descriptors;
- guest egress matches the documented allowlist, and attempts to reach the host control plane, private host services, metadata endpoints, or unrelated networks fail;
- `..`, symlink, file-URL, absolute-path, and process-environment probes do not escape the shared repository;
- the repository is non-writable from the Codex process;
- the Gateway listener is reachable only through host `127.0.0.1` and still requires its bearer token;
- VM restart preserves authentication, while host Gateway restart preserves encrypted SQLite results;
- backup and restore preserve the database and matching encryption key without exporting Codex or Gateway credentials into the repository;
- removing a repository mapping makes its guest data unavailable before the next job starts.

Use synthetic canary files rather than real credentials for denial tests. Store commands, versions, results, and residual limitations in `codex/ledger/verification.md`.

## Migration and rollback

Before migration, stop the current LaunchAgent and create a `gatewayctl backup`. Keep the current versioned release and Keychain items unchanged until the guest passes readiness and one live job. Switch clients only after health, authorization denial, and restore checks succeed.

Rollback by stopping host port forwarding, restarting the existing LaunchAgent release, and verifying `/healthz` and `/readyz`. Do not delete the old database, Keychain items, or releases during the first migration. Database writes must never be active in both host and guest instances against the same files.

## Operator decisions still required

- VM runtime, lifecycle manager, and private mutually authenticated App Server transport;
- the guest credential supervisor/auth broker and privilege-separation mechanism that hides Codex authentication from tool subprocesses;
- the minimum Codex network allowlist and its enforcement point;
- repository copy versus verified read-only mount;
- guest secret storage and encrypted backup destination;
- guest update cadence and Codex CLI pinning;
- whether the residual operational cost is acceptable for the trusted-input deployment.

Those choices affect host state and credentials and therefore require an explicit migration task; they must not be inferred from ordinary repository maintenance.
