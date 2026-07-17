#!/bin/zsh
set -eu
setopt no_xtrace
umask 077

LABEL="com.s-hiraoku.local-agent-gateway"
BASE="${HOME}/Library/Application Support/local-agent-gateway"
RELEASE="${0:A:h:h}"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(/usr/bin/id -u)"
SERVICE="${DOMAIN}/${LABEL}"

loaded() {
  /bin/launchctl print "${SERVICE}" >/dev/null 2>&1
}

wait_ready() {
  for _ in {1..45}; do
    if /usr/bin/curl --silent --fail http://127.0.0.1:8787/readyz >/dev/null 2>&1; then
      return 0
    fi
    /bin/sleep 1
  done
  print -u2 -- "Gateway did not become ready within 45 seconds"
  return 1
}

start() {
  if ! loaded; then
    /bin/launchctl bootstrap "${DOMAIN}" "${PLIST}"
  fi
  /bin/launchctl kickstart -k "${SERVICE}"
  wait_ready
}

stop() {
  if loaded; then
    /bin/launchctl bootout "${DOMAIN}" "${PLIST}"
  fi
}

case "${1:-status}" in
  start)
    start
    ;;
  stop)
    stop
    ;;
  restart)
    stop
    start
    ;;
  status)
    if loaded; then
      print -- "service: loaded"
      /usr/bin/curl --silent --show-error --fail http://127.0.0.1:8787/healthz
      print
      /usr/bin/curl --silent --show-error --fail http://127.0.0.1:8787/readyz
      print
    else
      print -- "service: stopped"
      exit 1
    fi
    ;;
  logs)
    exec /usr/bin/tail -n "${2:-100}" -F "${BASE}/logs/gateway.log" "${BASE}/logs/gateway.error.log"
    ;;
  rotate-token)
    new_token="$(/usr/bin/openssl rand -hex 32)"
    /usr/bin/security add-generic-password -U -a "${USER}" -s "${LABEL}.api-token" \
      -l "${LABEL}.api-token" -j "Local Agent Gateway local-production secret" -w "${new_token}" >/dev/null \
      || { unset new_token; print -u2 -- "Failed to update token in Keychain"; exit 1; }
    print -r -- "${new_token}"
    unset new_token
    stop >&2
    start >&2
    ;;
  repositories)
    exec /bin/cat "${RELEASE}/config/repositories.json"
    ;;
  backup)
    destination="${2:-${BASE}/backups/$(/bin/date -u +%Y%m%dT%H%M%SZ)}"
    [[ ! -e "${destination}" && ! -L "${destination}" ]] \
      || { print -u2 -- "Backup destination must be new"; exit 1; }
    was_loaded=0
    if loaded; then
      was_loaded=1
    fi
    restore_service() {
      local status=$?
      trap - EXIT INT TERM
      if [[ "${was_loaded}" -eq 1 ]] && ! start; then
        print -u2 -- "Backup cleanup could not restart the Gateway"
        return 1
      fi
      return "${status}"
    }
    trap restore_service EXIT INT TERM
    if [[ "${was_loaded}" -eq 1 ]]; then
      stop
      if loaded; then
        print -u2 -- "Gateway is still loaded; refusing an inconsistent backup"
        exit 1
      fi
    fi
    /bin/mkdir "${destination}"
    [[ -d "${destination}" && ! -L "${destination}" ]] \
      || { print -u2 -- "Backup destination is not a private directory"; exit 1; }
    /bin/chmod 700 "${destination}"
    if [[ -f "${BASE}/data/gateway-v2.sqlite" ]]; then
      /bin/cp -p "${BASE}/data/gateway-v2.sqlite" "${destination}/"
      for suffix in -wal -shm -journal; do
        if [[ -f "${BASE}/data/gateway-v2.sqlite${suffix}" ]]; then
          /bin/cp -p "${BASE}/data/gateway-v2.sqlite${suffix}" "${destination}/"
        fi
      done
    fi
    /bin/cp -p "${RELEASE}/config/repositories.json" "${destination}/"
    /usr/bin/readlink "${BASE}/current" > "${destination}/release.txt"
    /bin/chmod 600 "${destination}"/*
    trap - EXIT INT TERM
    if [[ "${was_loaded}" -eq 1 ]] && ! start; then
      print -u2 -- "Backup completed but the Gateway could not be restarted"
      exit 1
    fi
    print -- "backup: ${destination}"
    print -- "The encryption key remains in Keychain and must be backed up separately in an encrypted recovery store."
    ;;
  rollback)
    current="$(cd "${BASE}/current" && pwd -P)"
    previous=""
    for candidate in "${BASE}"/releases/*(N/om); do
      [[ -e "${candidate}/.pending-activation" ]] && continue
      if [[ "${candidate}" != "${current}" ]]; then
        previous="${candidate}"
        break
      fi
    done
    [[ -n "${previous}" ]] || { print -u2 -- "No previous release is available"; exit 1; }
    temporary="${BASE}/.current.$RANDOM"
    /bin/ln -s "releases/${previous:t}" "${temporary}"
    /bin/mv -h "${temporary}" "${BASE}/current"
    stop
    start
    print -- "active release: ${previous:t}"
    ;;
  uninstall)
    stop
    /bin/rm -f "${PLIST}"
    print -- "LaunchAgent removed. Releases, data, logs, configuration, and Keychain items were preserved."
    ;;
  *)
    print -u2 -- "usage: gatewayctl {start|stop|restart|status|logs [lines]|rotate-token|repositories|backup [directory]|rollback|uninstall}"
    exit 2
    ;;
esac
