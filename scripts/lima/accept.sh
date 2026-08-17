#!/usr/bin/env bash
# Operator-run Lima acceptance probes for issue #33.
# Records filesystem, tool-isolation, and egress denials. Does not run a
# subscription-backed coding turn and does not migrate the LaunchAgent.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
INSTANCE="${CODEXGW_LIMA_INSTANCE:-codexgw}"
LIMA="${CODEXGW_LIMA_COMMAND:-limactl}"

if ! command -v "$LIMA" >/dev/null 2>&1; then
  echo "limactl is not available. On macOS 13+: brew install lima" >&2
  echo "Then open a new shell and retry. Apple Silicon PATH is /opt/homebrew/bin." >&2
  exit 1
fi

if ! "$LIMA" list --json | grep -Fq "\"name\":\"$INSTANCE\""; then
  echo "Lima instance $INSTANCE is missing. Create it with:" >&2
  echo "  limactl start --name=$INSTANCE $ROOT/codexgw.yaml" >&2
  exit 1
fi

"$ROOT/install-guest-helpers.sh"

guest() {
  "$LIMA" shell "$INSTANCE" -- sudo "$@"
}

echo "== mounts"
if guest findmnt -n /Users >/dev/null 2>&1; then
  echo "unexpected host home mount in the guest" >&2
  exit 1
fi
guest findmnt --real -n -o TARGET,OPTIONS | sed -n '1,40p'

echo "== tool isolation"
guest /usr/local/lib/codexgw/prove-tool-isolation

echo "== private egress denials"
for dest in 10.0.0.1 192.168.1.1 169.254.169.254; do
  if guest timeout 3 bash -c "echo >/dev/tcp/$dest/443" 2>/dev/null; then
    echo "guest reached private or metadata address $dest" >&2
    exit 1
  fi
done

echo "== dns"
guest getent ahosts chatgpt.com >/dev/null

echo "== login egress"
guest /usr/local/lib/codexgw/prove-login-egress

echo
echo "Filesystem, tool-isolation, private-egress, and login-egress probes passed."
echo "Still required before treating #33 as complete:"
echo "  1. Install a pinned Codex CLI on the guest PATH"
echo "  2. limactl shell $INSTANCE -- sudo -u codexgw -H env CODEX_HOME=/var/lib/codexgw/home SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt PATH=/usr/local/bin:/usr/bin:/bin codex login"
echo "  3. Record a live structured coding run and an inference run"
echo "  4. Keep the LaunchAgent on host until those live runs are recorded"
echo "Append commands, versions, and residuals to codex/ledger/verification.md"
