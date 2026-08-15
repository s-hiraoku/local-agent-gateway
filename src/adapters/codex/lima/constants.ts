export const DEFAULT_LIMA_INSTANCE = "codexgw";
export const GUEST_SUPERVISOR = "codexgw";
export const GUEST_TOOL_USER = "codexgw-tool";
export const GUEST_CODEX_HOME = "/var/lib/codexgw/home";
export const GUEST_SNAPSHOT_ROOT = "/var/lib/codexgw/snapshots";

// Public HTTPS is allowed only after private ranges are denied. Hostname
// pinning remains a follow-up; the residual is recorded in the design doc.
export const GUEST_NFTABLES_POLICY = `
flush ruleset
table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    iif lo accept
    ct state established,related accept
    tcp dport 22 accept
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
  }
  chain output {
    type filter hook output priority 0; policy drop;
    oif lo accept
    ct state established,related accept
    ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } drop
    ip6 daddr { fc00::/7, fe80::/10 } drop
    udp dport 53 accept
    tcp dport 53 accept
    tcp dport 443 accept
  }
}
`.trim();
