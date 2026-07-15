#!/bin/zsh
set -eu
setopt no_xtrace
umask 077

LABEL="com.s-hiraoku.local-agent-gateway"
BASE="${HOME}/Library/Application Support/local-agent-gateway"
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
  token)
    exec /usr/bin/security find-generic-password -a "${USER}" -s "${LABEL}.api-token" -w
    ;;
  repositories)
    exec /bin/cat "${BASE}/config/repositories.json"
    ;;
  backup)
    destination="${2:-${BASE}/backups/$(/bin/date -u +%Y%m%dT%H%M%SZ)}"
    was_loaded=0
    if loaded; then
      was_loaded=1
      stop
    fi
    restore_service() {
      if [[ "${was_loaded}" -eq 1 ]]; then start; fi
    }
    trap restore_service EXIT INT TERM
    /bin/mkdir -p "${destination}"
    /bin/chmod 700 "${destination}"
    if [[ -f "${BASE}/data/gateway-v2.sqlite" ]]; then
      /bin/cp -p "${BASE}/data/gateway-v2.sqlite" "${destination}/"
    fi
    /bin/cp -p "${BASE}/config/repositories.json" "${destination}/"
    /usr/bin/readlink "${BASE}/current" > "${destination}/release.txt"
    /bin/chmod 600 "${destination}"/*
    print -- "backup: ${destination}"
    print -- "The encryption key remains in Keychain and must be backed up separately in an encrypted recovery store."
    ;;
  rollback)
    current="$(cd "${BASE}/current" && pwd -P)"
    previous=""
    for candidate in "${BASE}"/releases/*(N/om); do
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
    print -u2 -- "usage: gatewayctl {start|stop|restart|status|logs [lines]|token|repositories|backup [directory]|rollback|uninstall}"
    exit 2
    ;;
esac
