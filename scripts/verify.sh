#!/usr/bin/env bash
set -euo pipefail

STRICT_MODE="${CODEX_HARNESSES_STRICT:-0}"
MISSING_CHECKS=0

mark_missing_check() {
  local message="$1"
  echo "${message}"
  if [[ "${STRICT_MODE}" == "1" ]]; then
    MISSING_CHECKS=1
  fi
}

run_if_script_exists() {
  local script_name="$1"

  if ! command -v node >/dev/null 2>&1; then
    mark_missing_check "node not found; skipping package.json script checks"
    return
  fi

  if node -e 'const scripts = require("./package.json").scripts ?? {}; process.exit(scripts[process.argv[1]] ? 0 : 1)' "${script_name}"; then
    echo "Running node --run ${script_name}"
    node --run "${script_name}"
  else
    echo "No npm script '${script_name}' detected"
  fi
}

run_python_checks() {
  local ran_check=0

  if command -v ruff >/dev/null 2>&1; then
    echo "Running ruff check ."
    ruff check .
    ran_check=1
  fi

  if command -v mypy >/dev/null 2>&1; then
    echo "Running mypy ."
    mypy .
    ran_check=1
  fi

  if command -v pytest >/dev/null 2>&1 && compgen -G "tests/test*.py" >/dev/null; then
    echo "Running pytest"
    pytest
    ran_check=1
  fi

  if [[ "${ran_check}" -eq 0 ]]; then
    mark_missing_check "pyproject.toml detected, but no supported Python checks were available"
  fi
}

run_policy_docs_check() {
  local missing=0

  for required_doc in policy_template.md docs/QUALITY.md; do
    if [[ ! -s "${required_doc}" ]]; then
      echo "Required policy document missing or empty: ${required_doc}"
      missing=1
    fi
  done

  if [[ "${missing}" -ne 0 ]]; then
    return 1
  fi

  echo "Policy documentation check passed"
}

main() {
  local detected=0

  if [[ -f package.json ]]; then
    detected=1
    run_if_script_exists lint
    run_if_script_exists typecheck
    run_if_script_exists test
    run_if_script_exists build
  fi

  if [[ -f pyproject.toml ]]; then
    detected=1
    run_python_checks
  fi

  if [[ -f mkdocs.yml ]]; then
    detected=1
    if command -v mkdocs >/dev/null 2>&1; then
      echo "Running mkdocs build --strict"
      mkdocs build --strict
    else
      mark_missing_check "mkdocs.yml detected, but mkdocs was not available"
    fi
  fi

  run_policy_docs_check

  if [[ -x /bin/zsh ]]; then
    echo "Checking local-production shell syntax"
    /bin/zsh -n scripts/local-production/launcher.sh scripts/local-production/gatewayctl.sh
  fi

  if [[ "${detected}" -eq 0 ]]; then
    mark_missing_check "No project-specific verification detected"
  fi

  if [[ "${MISSING_CHECKS}" -ne 0 ]]; then
    echo "Strict mode failed because no supported verification checks were available"
    return 1
  fi

  echo "Verification script completed"
}

main "$@"
