# Readable-root isolation design

## Status

Operator choices for the first VM milestone are recorded below. An opt-in Lima executor copies one repository snapshot into a dedicated guest and starts Codex App Server over `limactl shell` stdio. The default executor remains the host process so the existing LaunchAgent is unchanged.

This milestone isolates host and Gateway assets from the Codex process. It is not a completed confidentiality boundary:

- the default LaunchAgent still runs Codex on the host;
- guest tool subprocesses still run as the credential-owning supervisor, so they can read `CODEX_HOME` until that inner denial is proven;
- guest egress allows any public HTTPS (TCP 443) after private ranges are denied; hostname pinning is a residual;
- live VM acceptance evidence is not yet recorded.

Until the acceptance tests below pass, the Gateway supports only trusted clients, prompts, and repositories.

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

## Recorded operator decisions

These choices were made for issue #33. They are not inferred from ordinary repository maintenance.

| Topic | Decision |
| --- | --- |
| VM | One long-lived Lima `vz` instance. Gateway, SQLite, and secrets stay on the host. The guest runs Codex only. |
| Transport | Lima SSH + stdio (`limactl shell` → `codex app-server`). Clients cannot pick the command, path, or VM. |
| Repositories | Per-job read-only snapshot copy into the guest. No host-parent mount. |
| Network | Deny by default. Block RFC1918, link-local, and metadata ranges. Allow DNS and TCP 443. Hostname pinning remains a residual. |
| Credentials | Two guest users (`codexgw` owns `CODEX_HOME`; `codexgw-tool` is reserved for tools). App Server currently runs as the supervisor, so tool isolation is not proven. |
| Auth backup | Guest `CODEX_HOME` stays in the VM. Host backup remains the database and Keychain. Recreating the VM requires `codex login` in the guest. |
| CLI pin | Bump the guest CLI only together with the supported host Codex CLI range. |
| Default | Executor `host` so the existing LaunchAgent does not break. Lima is opt-in through `CODEXGW_CODEX_EXECUTOR=lima`. |

Runtime model: one long-lived Lima VM; one App Server process and one snapshot per job; delete the snapshot after the turn.

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

1. Install Lima and create the pinned instance once from `scripts/lima/codexgw.yaml`. Do not auto-create the VM from `/readyz`.
2. Install a pinned Codex CLI on the guest `PATH`. Keep Gateway and SQLite on the host control plane.
3. Confirm guest paths: `CODEX_HOME=/var/lib/codexgw/home`, snapshots under `/var/lib/codexgw/snapshots`, no host-parent mount, and no guest `config.toml`.
4. Authenticate interactively inside the guest as `codexgw`. Do not copy host authentication state.
5. Set `CODEXGW_CODEX_EXECUTOR=lima`. The adapter starts only the fixed `limactl` transport; clients still select a public repository ID.
6. Separate the credential-owning supervisor from the tool executor, scrub inherited environment/file descriptors, and prove that tool subprocesses cannot read `CODEX_HOME` before using real authentication with untrusted prompts.
7. Run the remaining acceptance suite and a backup/restore rehearsal before migrating the resident LaunchAgent.

Create and authenticate the instance:

```bash
limactl start --name=codexgw scripts/lima/codexgw.yaml
# install a pinned Codex CLI on the guest PATH, then:
limactl shell codexgw -- sudo -u codexgw -H env CODEX_HOME=/var/lib/codexgw/home codex login
```

If the named instance is missing, readiness fails closed with `CODEX_NOT_CONFIGURED`. A `Stopped` instance is started; the Gateway does not create a new VM.

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

Rollback by setting the executor back to `host`, restarting the existing LaunchAgent release, and verifying `/healthz` and `/readyz`. Do not delete the old database, Keychain items, or releases during the first migration. Database writes must never be active in both host and guest instances against the same files.

## Remaining residuals

- Prove that guest tool subprocesses cannot read `CODEX_HOME` while App Server authentication still works.
- Replace public-HTTPS allowance with a hostname allowlist once the required Codex endpoints are known.
- Wire Lima into the versioned LaunchAgent only after live acceptance evidence exists.
- Record the acceptance-suite evidence in `codex/ledger/verification.md`.
