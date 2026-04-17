#!/usr/bin/env bash
# harden-production-dirs.sh — Lock down production paths against agent users.
#
# Usage:
#   sudo ./scripts/harden-production-dirs.sh
#
# Ensures:
#   - /Users/nordini/ is owned by nordini and not world-writable
#   - /Users/nordini/agent-hq/ is owned by nordini and not world-writable
#   - Each agent-* home directory is 700 (no cross-agent access)
#   - No agent-* user has write access to production paths
#
# Idempotent: safe to re-run.
#
# Requires: sudo (must be run as root)
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Error: this script must be run as root (sudo)." >&2
  exit 1
fi

PRODUCTION_OWNER="nordini"
PRODUCTION_HOME="/Users/${PRODUCTION_OWNER}"
PRODUCTION_REPO="${PRODUCTION_HOME}/atlas-hq"
OPENCLAW_DIR="${PRODUCTION_HOME}/.openclaw"

echo "============================================================"
echo " Hardening production directories"
echo "============================================================"

# ── Step 1: Lock down production home ──────────────────────────────────────────
echo ""
echo "==> Hardening ${PRODUCTION_HOME}..."
chown "${PRODUCTION_OWNER}:staff" "${PRODUCTION_HOME}"
# Remove world and group write; keep owner + group read/execute for Homebrew, etc.
chmod 750 "${PRODUCTION_HOME}"
echo "    Owner: ${PRODUCTION_OWNER}:staff, perms: 750"

# ── Step 2: Lock down atlas-hq repo ───────────────────────────────────────────
if [[ -d "$PRODUCTION_REPO" ]]; then
  echo "==> Hardening ${PRODUCTION_REPO}..."
  chown -R "${PRODUCTION_OWNER}:staff" "${PRODUCTION_REPO}"
  # Remove world-write bits recursively (preserve existing read/execute)
  find "${PRODUCTION_REPO}" -type d -exec chmod o-w {} +
  find "${PRODUCTION_REPO}" -type f -exec chmod o-w {} +
  echo "    Removed world-write bits from ${PRODUCTION_REPO}"
fi

# ── Step 3: Lock down .openclaw directory ──────────────────────────────────────
if [[ -d "$OPENCLAW_DIR" ]]; then
  echo "==> Hardening ${OPENCLAW_DIR}..."
  chown "${PRODUCTION_OWNER}:staff" "${OPENCLAW_DIR}"
  chmod 750 "${OPENCLAW_DIR}"
  echo "    Owner: ${PRODUCTION_OWNER}:staff, perms: 750"

  # Lock down openclaw.json specifically
  if [[ -f "${OPENCLAW_DIR}/openclaw.json" ]]; then
    chmod 600 "${OPENCLAW_DIR}/openclaw.json"
    echo "    openclaw.json: 600 (owner-only)"
  fi
fi

# ── Step 4: Ensure agent home directories are isolated ─────────────────────────
echo ""
echo "==> Verifying agent home isolation..."
for agent_home in /Users/agent-*/; do
  if [[ -d "$agent_home" ]]; then
    agent_user=$(basename "$agent_home")
    chown "${agent_user}:staff" "${agent_home}"
    chmod 700 "${agent_home}"
    echo "    ${agent_home} → 700 (${agent_user} only)"
  fi
done

# ── Step 5: Verify no agent can write to production ────────────────────────────
echo ""
echo "==> Verification: checking agent write access to production paths..."
FAILED=0
for agent_home in /Users/agent-*/; do
  if [[ -d "$agent_home" ]]; then
    agent_user=$(basename "$agent_home")
    # Test write access using sudo -u
    for path in "${PRODUCTION_HOME}" "${PRODUCTION_REPO}" "${OPENCLAW_DIR}"; do
      if [[ -d "$path" ]]; then
        if sudo -u "${agent_user}" test -w "$path" 2>/dev/null; then
          echo "    ⚠️  ${agent_user} CAN write to ${path} — FAIL"
          FAILED=1
        else
          echo "    ✓  ${agent_user} cannot write to ${path}"
        fi
      fi
    done
  fi
done

echo ""
echo "============================================================"
if [[ "$FAILED" -ne 0 ]]; then
  echo " ⚠️  Some agents have write access to production paths!"
  echo " Review the output above and fix permissions manually."
  exit 1
else
  echo " Production directories hardened successfully."
fi
echo "============================================================"
