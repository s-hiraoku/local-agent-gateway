export const DEFAULT_LIMA_INSTANCE = "codexgw";
export const GUEST_SUPERVISOR = "codexgw";
export const GUEST_TOOL_USER = "codexgw-tool";
export const GUEST_CODEX_HOME = "/var/lib/codexgw/home";
export const GUEST_SNAPSHOT_ROOT = "/var/lib/codexgw/snapshots";
export const GUEST_HELPER_BIN = "/usr/local/lib/codexgw/bin";
export const GUEST_ISOLATION_PROBE = "/usr/local/lib/codexgw/prove-tool-isolation";
export const GUEST_APP_SERVER_PATH = `${GUEST_HELPER_BIN}:/usr/sbin:/usr/bin:/sbin:/bin`;
export const GUEST_SSL_CERT_FILE = "/etc/ssl/certs/ca-certificates.crt";

export const GUEST_EGRESS_HOSTS = [
  "chatgpt.com",
  "www.chatgpt.com",
  "ws.chatgpt.com",
  "ab.chatgpt.com",
  "cdn.oaistatic.com",
  "persistent.oaistatic.com",
  "api.openai.com",
  "auth.openai.com",
  "setup.auth.openai.com",
  "auth0.openai.com"
] as const;

// TCP 443 is allowed only to resolved allowlist addresses. Shared CDN IPs and
// open DNS remain residuals; the acceptance script records them.
export const GUEST_NFTABLES_POLICY = `
flush ruleset
table inet filter {
  set codex4 {
    type ipv4_addr
    flags interval
  }
  set codex6 {
    type ipv6_addr
    flags interval
  }
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
    udp dport 53 accept
    tcp dport 53 accept
    ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } drop
    ip6 daddr { fc00::/7, fe80::/10 } drop
    tcp dport 443 ip daddr @codex4 accept
    tcp dport 443 ip6 daddr @codex6 accept
    tcp dport 443 reject with tcp reset comment "codexgw-https-fastfail"
  }
}
`.trim();
