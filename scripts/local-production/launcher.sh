#!/bin/zsh
set -eu
setopt no_xtrace
umask 077

LABEL="com.s-hiraoku.local-agent-gateway"
BASE="${HOME}/Library/Application Support/local-agent-gateway"
CONFIG="${BASE}/config"
CURRENT="${BASE}/current"
ACCOUNT="${USER}"

fail() {
  print -u2 -- "local-agent-gateway: $1"
  exit 1
}

[[ -d "${CURRENT}" ]] || fail "no active release"
[[ -f "${CONFIG}/repositories.json" ]] || fail "repository registry is missing"
[[ -f "${CONFIG}/codex-command" ]] || fail "Codex command configuration is missing"
[[ -f "${CONFIG}/codex-home" ]] || fail "Codex home configuration is missing"

CODEX_COMMAND="$(/bin/cat "${CONFIG}/codex-command")"
CODEX_HOME="$(/bin/cat "${CONFIG}/codex-home")"
[[ -x "${CODEX_COMMAND}" ]] || fail "configured Codex executable is unavailable"
[[ -d "${CODEX_HOME}" ]] || fail "dedicated Codex home is unavailable"
[[ ! -e "${CODEX_HOME}/config.toml" ]] || fail "dedicated Codex home must not contain config.toml"

API_TOKEN="$(/usr/bin/security find-generic-password -a "${ACCOUNT}" -s "${LABEL}.api-token" -w)" \
  || fail "API token could not be read from the login Keychain"
ENCRYPTION_KEY="$(/usr/bin/security find-generic-password -a "${ACCOUNT}" -s "${LABEL}.encryption-key" -w)" \
  || fail "encryption key could not be read from the login Keychain"

export CODEXGW_HOST="127.0.0.1"
export CODEXGW_PORT="8787"
export CODEXGW_DATABASE_PATH="${BASE}/data/gateway-v2.sqlite"
export CODEXGW_API_TOKEN="${API_TOKEN}"
export CODEXGW_DATA_ENCRYPTION_KEY="${ENCRYPTION_KEY}"
export CODEXGW_REPOSITORIES_JSON="$(/bin/cat "${CONFIG}/repositories.json")"
export CODEXGW_CODEX_COMMAND="${CODEX_COMMAND}"
export CODEXGW_CODEX_HOME="${CODEX_HOME}"
export LOG_LEVEL="info"
export PATH="$(/usr/bin/dirname "${CODEX_COMMAND}"):${CURRENT}/runtime:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

unset API_TOKEN ENCRYPTION_KEY
cd "${CURRENT}"
exec "${CURRENT}/runtime/node" "${CURRENT}/dist/index.js"
