#!/bin/zsh
set -eu
setopt no_xtrace
umask 077

LABEL="com.s-hiraoku.local-agent-gateway"
BASE="${HOME}/Library/Application Support/local-agent-gateway"
RELEASE="${0:A:h:h}"
CONFIG="${RELEASE}/config"
ACCOUNT="${USER}"

fail() {
  print -u2 -- "local-agent-gateway: $1"
  exit 1
}

[[ -d "${RELEASE}" ]] || fail "no active release"
[[ -f "${CONFIG}/repositories.json" ]] || fail "repository registry is missing"
[[ -f "${CONFIG}/codex-command" ]] || fail "Codex command configuration is missing"
[[ -f "${CONFIG}/codex-home" ]] || fail "Codex home configuration is missing"

CODEX_COMMAND="$(/bin/cat "${CONFIG}/codex-command")"
CODEX_HOME="$(/bin/cat "${CONFIG}/codex-home")"
[[ -x "${CODEX_COMMAND}" ]] || fail "configured Codex executable is unavailable"
[[ -d "${CODEX_HOME}" ]] || fail "dedicated Codex home is unavailable"
[[ -O "${CODEX_HOME}" ]] || fail "dedicated Codex home must be owned by the current user"
[[ "$(/usr/bin/stat -f '%Lp' "${CODEX_HOME}")" == "700" ]] || fail "dedicated Codex home must have mode 0700"
[[ ! -e "${CODEX_HOME}/config.toml" ]] || fail "dedicated Codex home must not contain config.toml"

OPENAI_COMPATIBILITY="false"
if [[ -f "${CONFIG}/openai-compatibility" ]]; then
  OPENAI_COMPATIBILITY="$(/bin/cat "${CONFIG}/openai-compatibility")"
fi
[[ "${OPENAI_COMPATIBILITY}" == "true" || "${OPENAI_COMPATIBILITY}" == "false" ]] \
  || fail "OpenAI compatibility configuration must be true or false"

INFERENCE_PROVIDER="codex"
if [[ -f "${CONFIG}/inference-provider" ]]; then
  INFERENCE_PROVIDER="$(/bin/cat "${CONFIG}/inference-provider")"
fi
[[ "${INFERENCE_PROVIDER}" == "codex" || "${INFERENCE_PROVIDER}" == "claude" || "${INFERENCE_PROVIDER}" == "grok" ]] \
  || fail "inference provider configuration must be codex, claude, or grok"

CLAUDE_COMMAND=""
if [[ -f "${CONFIG}/claude-command" ]]; then
  CLAUDE_COMMAND="$(/bin/cat "${CONFIG}/claude-command")"
fi
if [[ "${INFERENCE_PROVIDER}" == "claude" ]]; then
  [[ -n "${CLAUDE_COMMAND}" ]] || fail "the claude inference provider requires a configured Claude executable"
  [[ -x "${CLAUDE_COMMAND}" ]] || fail "configured Claude executable is unavailable"
fi

GROK_COMMAND=""
if [[ -f "${CONFIG}/grok-command" ]]; then
  GROK_COMMAND="$(/bin/cat "${CONFIG}/grok-command")"
fi
if [[ "${INFERENCE_PROVIDER}" == "grok" ]]; then
  [[ -n "${GROK_COMMAND}" ]] || fail "the grok inference provider requires a configured Grok executable"
  [[ -x "${GROK_COMMAND}" ]] || fail "configured Grok executable is unavailable"
fi

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
export CODEXGW_OPENAI_COMPATIBILITY_ENABLED="${OPENAI_COMPATIBILITY}"
export CODEXGW_INFERENCE_PROVIDER="${INFERENCE_PROVIDER}"
if [[ -n "${CLAUDE_COMMAND}" ]]; then
  export CODEXGW_CLAUDE_COMMAND="${CLAUDE_COMMAND}"
fi
if [[ -f "${CONFIG}/claude-model" ]]; then
  export CODEXGW_CLAUDE_MODEL="$(/bin/cat "${CONFIG}/claude-model")"
fi
if [[ -n "${GROK_COMMAND}" ]]; then
  export CODEXGW_GROK_COMMAND="${GROK_COMMAND}"
fi
if [[ -f "${CONFIG}/grok-model" ]]; then
  export CODEXGW_GROK_MODEL="$(/bin/cat "${CONFIG}/grok-model")"
fi
export LOG_LEVEL="info"
if [[ -n "${GROK_COMMAND}" ]]; then
  export PATH="$(/usr/bin/dirname "${GROK_COMMAND}"):$(/usr/bin/dirname "${CODEX_COMMAND}"):${RELEASE}/runtime:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
else
  export PATH="$(/usr/bin/dirname "${CODEX_COMMAND}"):${RELEASE}/runtime:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
fi

unset API_TOKEN ENCRYPTION_KEY
cd "${RELEASE}"
exec "${RELEASE}/runtime/node" "${RELEASE}/dist/index.js"
