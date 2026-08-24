# Local production on macOS

This deployment is for one trusted owner on one Mac. It binds only to
`127.0.0.1`, keeps bearer authentication enabled, and runs coding turns with
the Gateway's read-only Codex policy. It is not a confidentiality boundary for
untrusted prompts or repositories.

For the untrusted-input boundary, see [Readable-root isolation design](READABLE_ROOT_ISOLATION.md). Installing the LaunchAgent does not enable Lima; the resident service stays on the host executor until that path is wired and the acceptance suite is recorded.

## Install

Requirements:

- Node.js 26 and pnpm 11.13;
- a Codex CLI pinned inside the supported range in `src/adapters/codex/compatibility.ts`;
- `~/.codex-gateway` authenticated with ChatGPT and mode `0700`;
- no `config.toml` inside that dedicated Codex home.

Authenticate once if needed:

```bash
mkdir -p "$HOME/.codex-gateway"
chmod 700 "$HOME/.codex-gateway"
CODEX_HOME="$HOME/.codex-gateway" codex login
```

Install the default `reviews` scratch workspace:

```bash
pnpm install --frozen-lockfile
pnpm local:install
```

To register explicit repositories during installation, pass the public IDs and
absolute server-side paths as JSON. Clients receive only the IDs:

```bash
pnpm local:install -- --repositories-json '[
  {"id":"reviews","path":"/absolute/scratch/path"},
  {"id":"decision-agent","path":"/absolute/path/to/Decision-Agent"}
]'
```

To enable the loopback-only OpenAI Responses compatibility subset for trusted local clients, add:

```bash
pnpm local:install -- --openai-compatibility true
```

To run inference turns on Claude Code, Grok Build, or Cursor instead of Codex, add:

```bash
pnpm local:install -- --inference-provider claude
# or
pnpm local:install -- --inference-provider grok
# or
CODEXGW_CURSOR_API_KEY=cursor_... pnpm local:install -- --inference-provider cursor
```

The installer resolves the `claude` or `grok` executable with `which` and pins its
absolute path into the release configuration, so the LaunchAgent does not
depend on its own `PATH`. Pass `--claude-command` / `--grok-command` to select a
specific binary or `--claude-model` / `--grok-model` / `--cursor-model` to pin a
model. The Cursor API key is stored in the login Keychain and is never written
to a release config file. Coding turns are unaffected and continue to run on
Codex. Authenticate the selected CLI, or export `CODEXGW_CURSOR_API_KEY` for
Cursor, as the same user that runs the LaunchAgent before installing, and pass
`--inference-provider codex` on a later installation to switch back.

This command is also the upgrade path for an existing installation after the
implementation has been merged. Run it from a clean checkout of the intended
revision. A merge or `git pull` alone does not update the running LaunchAgent,
and setting `CODEXGW_OPENAI_COMPATIBILITY_ENABLED` in a shell does not modify an
already installed release.

The installer preserves the existing repository registry when
`--repositories-json` is omitted. The compatibility setting is persisted in the
new versioned release configuration. Pass `--openai-compatibility false` on a
later installation to disable it. Enabling or disabling a local installation is
an operational configuration change outside the source checkout, so it does
not create a Git diff or require a separate source commit. See
[OpenAI Responses compatibility](OPENAI_RESPONSES_COMPATIBILITY.md) before
enabling it.

The installer runs the full verification suite, builds JavaScript, creates a
versioned release, installs production-only dependencies, and starts a user
LaunchAgent. It refuses a dirty Git worktree and does not run production from
the mutable checkout.

## Files and secrets

Runtime files live under:

```text
~/Library/Application Support/local-agent-gateway/
  current -> releases/<timestamp>-<commit>
  releases/<timestamp>-<commit>/
    bin/{launcher.sh,gatewayctl}
    config/{repositories.json,codex-command,codex-home,openai-compatibility,inference-provider[,claude-command,claude-model,grok-command,grok-model,cursor-model]}
    dist/
    runtime/
  data/gateway-v2.sqlite
  logs/
  backups/
  bin/gatewayctl
```

The bearer token and 32-byte data-encryption key are generated on first install
and stored as login Keychain generic-password items:

- `com.s-hiraoku.local-agent-gateway.api-token`
- `com.s-hiraoku.local-agent-gateway.encryption-key`

The LaunchAgent plist contains no credentials. The launcher reads both items
once, exports them to the Gateway process, and then executes the pinned Node 26
runtime from the release that selected the launcher. The dedicated Codex home
remains shared authenticated state; releases version only its configured path.
Keychain protects secrets at rest; it does not protect them from another process
already running as the same compromised user.

Losing the encryption key makes existing encrypted jobs unreadable. Store a
copy in a separate encrypted recovery vault. Bearer-token rotation is safe;
encryption-key rotation is not supported because existing rows are not
re-encrypted.

## Operate

Set a convenience variable:

```bash
GATEWAYCTL="$HOME/Library/Application Support/local-agent-gateway/bin/gatewayctl"
```

Common commands:

```bash
"$GATEWAYCTL" status
"$GATEWAYCTL" restart
"$GATEWAYCTL" logs 200
"$GATEWAYCTL" repositories
"$GATEWAYCTL" backup
"$GATEWAYCTL" rollback
```

`backup` registers its restart handler before unloading the LaunchAgent, then
copies SQLite and any existing WAL, shared-memory, or journal companions before
starting the service again. The backup also contains the active release's
repository registry and release identifier; it deliberately does not export the
Keychain encryption key. Each backup requires a destination path that does not
already exist, preventing stale SQLite sidecars from being mixed into a new
snapshot.

`uninstall` removes only the LaunchAgent. It preserves releases, data, logs,
configuration, backups, and Keychain items.

## Decision-Agent

Retrieve the bearer token only when configuring a trusted client:

```bash
export DECISION_AGENT_GATEWAY_URL=http://127.0.0.1:8787
DECISION_AGENT_GATEWAY_TOKEN="$("$GATEWAYCTL" rotate-token)"
export DECISION_AGENT_GATEWAY_TOKEN
export DECISION_AGENT_GATEWAY_REPO=reviews
```

`rotate-token` replaces the Keychain token, restarts the Gateway, and prints the
new value once. Capture it directly into the trusted client's secret storage;
the control command does not provide a read-back operation for existing tokens.

Then run Decision-Agent with `--engine llm`. Decision-Agent never receives the
ChatGPT login or the Gateway encryption key.

## Verification and recovery

After installation:

```bash
"$GATEWAYCTL" status
lsof -nP -iTCP:8787 -sTCP:LISTEN
curl -i http://127.0.0.1:8787/healthz
curl -i http://127.0.0.1:8787/v1/models
```

The listener must be `127.0.0.1:8787`. `/readyz` verifies SQLite, the job
processor, the Codex CLI version pin, and the dedicated ChatGPT-authenticated
Codex App Server. An unsupported CLI version returns `CODEX_UNSUPPORTED_VERSION`
and is not ready. Bump `SUPPORTED_CODEX_CLI_RANGE` only after the fake-server
contract tests and a live App Server probe succeed. With
compatibility enabled, the unauthenticated `/v1/models` check must return
`401`; `404` means the installed release has compatibility disabled. A trusted
client configured with the Gateway bearer token must receive `200` and the
active compatibility model (`codex-subscription`, `grok-subscription` when
the installed inference provider is Grok, or `cursor-subscription` when it is
Cursor). Do not use or expose upstream OAuth
tokens for this check.

If startup fails, inspect `gateway.error.log`. Keychain retrieval failure,
missing Codex, an unsafe Codex home, or invalid repository configuration causes
a closed startup failure. launchd throttles crash restarts to at least 30
seconds.

Restore by uninstalling or stopping the service, restoring
`gateway-v2.sqlite`, restoring the matching encryption key to Keychain, and
starting the service. Do not copy a live SQLite database or omit its WAL state;
use `gatewayctl backup` for normal backups.

To rotate the encryption key, stop the service, keep a backup, then:

```bash
CODEXGW_DATABASE_PATH="$HOME/Library/Application Support/local-agent-gateway/data/gateway-v2.sqlite" \
CODEXGW_DATA_ENCRYPTION_KEY="<current-key>" \
CODEXGW_DATA_ENCRYPTION_KEY_NEW="$(openssl rand -base64 32)" \
pnpm rotate-key
```

Replace the Keychain encryption-key item with the new value before starting the
service. Discard the old key after `/readyz` succeeds. A mismatched key fails
startup with `ENCRYPTION_KEY_MISMATCH` instead of failing per row. Rotation
rewrites idempotency hashes' underlying key, so reusing an `Idempotency-Key`
after rotation starts a new job.
