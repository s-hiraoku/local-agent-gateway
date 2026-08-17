#!/usr/bin/env bash
# Copy guest isolation helpers into the operator-created Lima instance.
# Does not create the VM, copy host credentials, or enable the LaunchAgent.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
INSTANCE="${CODEXGW_LIMA_INSTANCE:-codexgw}"
LIMA="${CODEXGW_LIMA_COMMAND:-limactl}"

if ! command -v "$LIMA" >/dev/null 2>&1; then
  echo "limactl is not available. On macOS 13+: brew install lima" >&2
  echo "Then open a new shell and retry. Apple Silicon PATH is /opt/homebrew/bin." >&2
  exit 1
fi

echo "installing guest helpers on $INSTANCE"

guest() {
  echo "+ sudo $*"
  "$LIMA" shell "$INSTANCE" -- sudo -n "$@"
}

copy_guest_file() {
  local source="$1"
  local dest="$2"
  local mode="$3"
  local tmp="/tmp/codexgw-$(basename "$dest")"
  echo "copy $source -> $dest"
  "$LIMA" copy "$source" "${INSTANCE}:${tmp}"
  guest mv "$tmp" "$dest"
  guest chmod "$mode" "$dest"
}

guest mkdir -p /usr/local/lib/codexgw/bin /etc/codexgw /var/lib/codexgw/home /var/lib/codexgw/snapshots
copy_guest_file "$ROOT/guest/bwrap" /usr/local/lib/codexgw/bin/bwrap 0755
copy_guest_file "$ROOT/guest/prove-tool-isolation" /usr/local/lib/codexgw/prove-tool-isolation 0755
copy_guest_file "$ROOT/guest/refresh-egress" /usr/local/lib/codexgw/refresh-egress 0755
copy_guest_file "$ROOT/guest/egress-hosts" /etc/codexgw/egress-hosts 0644

unit_dir="$(mktemp -d "${TMPDIR:-/tmp}/codexgw-units.XXXXXX")"
trap 'rm -rf "$unit_dir"' EXIT

cat > "$unit_dir/codexgw-egress-refresh.service" <<'UNIT'
[Unit]
Description=Refresh Codex guest egress hostname allowlist
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/lib/codexgw/refresh-egress
UNIT

cat > "$unit_dir/codexgw-egress-refresh.timer" <<'UNIT'
[Unit]
Description=Refresh Codex guest egress hostname allowlist

[Timer]
OnBootSec=30s
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
UNIT

copy_guest_file "$unit_dir/codexgw-egress-refresh.service" /etc/systemd/system/codexgw-egress-refresh.service 0644
copy_guest_file "$unit_dir/codexgw-egress-refresh.timer" /etc/systemd/system/codexgw-egress-refresh.timer 0644

guest systemctl daemon-reload
guest systemctl enable --now codexgw-egress-refresh.timer
echo "refreshing egress allowlist"
guest /usr/local/lib/codexgw/refresh-egress
echo "running tool isolation probe"
guest /usr/local/lib/codexgw/prove-tool-isolation
echo "guest isolation helpers installed on $INSTANCE"
