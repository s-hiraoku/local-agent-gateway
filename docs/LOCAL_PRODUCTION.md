# Local production on macOS

This deployment is for one trusted owner on one Mac. It binds only to
`127.0.0.1`, keeps bearer authentication enabled, and runs coding turns with
the Gateway's read-only Codex policy. It is not a confidentiality boundary for
untrusted prompts or repositories.

## Install

Requirements:

- Node.js 26 and pnpm 11.13;
- the current Codex CLI;
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

The installer runs the full verification suite, builds JavaScript, creates a
versioned release, installs production-only dependencies, and starts a user
LaunchAgent. It refuses a dirty Git worktree and does not run production from
the mutable checkout.

## Files and secrets

Runtime files live under:

```text
~/Library/Application Support/local-agent-gateway/
  current -> releases/<timestamp>-<commit>
  releases/
  config/repositories.json
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
runtime from the active release. Keychain protects secrets at rest; it does not
protect them from another process already running as the same compromised user.

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

`backup` unloads the LaunchAgent before copying SQLite, then starts it again.
The backup contains the encrypted database, repository registry, and release
identifier; it deliberately does not export the Keychain encryption key.

`uninstall` removes only the LaunchAgent. It preserves releases, data, logs,
configuration, backups, and Keychain items.

## Decision-Agent

Retrieve the bearer token only when configuring a trusted client:

```bash
export DECISION_AGENT_GATEWAY_URL=http://127.0.0.1:8787
export DECISION_AGENT_GATEWAY_TOKEN="$("$GATEWAYCTL" token)"
export DECISION_AGENT_GATEWAY_REPO=reviews
```

Then run Decision-Agent with `--engine llm`. Decision-Agent never receives the
ChatGPT login or the Gateway encryption key.

## Verification and recovery

After installation:

```bash
"$GATEWAYCTL" status
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

The listener must be `127.0.0.1:8787`. `/readyz` verifies SQLite, the job
processor, and the dedicated ChatGPT-authenticated Codex App Server.

If startup fails, inspect `gateway.error.log`. Keychain retrieval failure,
missing Codex, an unsafe Codex home, or invalid repository configuration causes
a closed startup failure. launchd throttles crash restarts to at least 30
seconds.

Restore by uninstalling or stopping the service, restoring
`gateway-v2.sqlite`, restoring the matching encryption key to Keychain, and
starting the service. Do not copy a live SQLite database or omit its WAL state;
use `gatewayctl backup` for normal backups.
