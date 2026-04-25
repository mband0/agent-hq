#!/usr/bin/env bash
set -euo pipefail

REPO_PATH="${repo_path:-${REPO_PATH:-}}"
DEV_REPO_PATH="${dev_repo_path:-${DEV_REPO_PATH:-/Users/nordini/agent-hq-dev}}"
SERVICES="${services:-${SERVICES:-both}}"
HEALTH_CHECK="${health_check:-${HEALTH_CHECK:-true}}"
STATE_DIR="${STATE_DIR:-/Users/nordini/.agent-hq-dev-deploy}"
STATE_FILE="$STATE_DIR/current-target.json"
LOCK_DIR="$STATE_DIR/lock"
CANONICAL_ROOT="${CANONICAL_ROOT:-/Users/nordini/agent-hq}"
API_NAME="${API_NAME:-agent-hq-dev-api}"
UI_NAME="${UI_NAME:-agent-hq-dev-ui}"
API_PORT="${API_PORT:-3511}"
UI_PORT="${UI_PORT:-3510}"
DEV_DB_PATH="${DEV_DB_PATH:-$DEV_REPO_PATH/agent-hq-dev.db}"

json_error() {
  python3 - "$1" <<'PY2'
import json, sys
print(json.dumps({"ok": False, "error": sys.argv[1]}))
PY2
}

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

copy_if_missing() {
  rel="$1"
  src="$CANONICAL_ROOT/$rel"
  dest="$DEV_REPO_PATH/$rel"
  if [ -e "$src" ] && [ ! -e "$dest" ]; then
    mkdir -p "$(dirname "$dest")"
    cp -pR "$src" "$dest"
  fi
}

ensure_package_scripts() {
  python3 - "$DEV_REPO_PATH/api/package.json" "$DEV_REPO_PATH/ui/package.json" <<'PY2'
import json, sys
api = json.load(open(sys.argv[1]))
ui = json.load(open(sys.argv[2]))
errors = []
if 'build' not in api.get('scripts', {}):
    errors.append('api/package.json missing build script')
if 'start' not in api.get('scripts', {}):
    errors.append('api/package.json missing start script')
if 'build' not in ui.get('scripts', {}):
    errors.append('ui/package.json missing build script')
if 'start-dev' not in ui.get('scripts', {}):
    errors.append('ui/package.json missing start-dev script')
if errors:
    print(json.dumps({"ok": False, "errors": errors}))
    raise SystemExit(1)
PY2
}

ensure_deps() {
  package_dir="$1"
  if [ ! -d "$package_dir/node_modules" ]; then
    (cd "$package_dir" && npm install --production=false)
  fi
}

capture_pm2() {
  pm2 jlist | python3 - "$1" <<'PY2'
import json, sys
name = sys.argv[1]
items = json.load(sys.stdin)
for item in items:
    env = item.get('pm2_env', {})
    if env.get('name') == name or item.get('name') == name:
        print(json.dumps({
            'cwd': env.get('pm_cwd'),
            'args': env.get('args') or [],
            'exec_path': env.get('pm_exec_path'),
            'name': item.get('name') or env.get('name'),
        }))
        raise SystemExit(0)
print('null')
PY2
}

mkdir -p "$STATE_DIR"
if [ -z "$REPO_PATH" ]; then
  json_error "repo_path is required"
  exit 1
fi
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  json_error "deploy lock already held"
  exit 1
fi

case "$SERVICES" in
  api|ui|both|api,ui|ui,api) ;;
  *) json_error "services must be one of: api, ui, both, api,ui"; exit 1 ;;
esac
[ "$SERVICES" = "both" ] && SERVICES="api,ui"
[ "$SERVICES" = "ui,api" ] && SERVICES="api,ui"

[ -d "$REPO_PATH" ] || { json_error "repo_path does not exist"; exit 1; }
[ -d "$CANONICAL_ROOT" ] || { json_error "canonical repo root does not exist"; exit 1; }

SOURCE_ROOT="$(git -C "$REPO_PATH" rev-parse --show-toplevel 2>/dev/null)" || {
  json_error "repo_path is not inside a git checkout"
  exit 1
}
[ -f "$SOURCE_ROOT/package.json" ] || { json_error "source repo root missing package.json"; exit 1; }
[ -f "$SOURCE_ROOT/api/package.json" ] || { json_error "source api/package.json missing"; exit 1; }
[ -f "$SOURCE_ROOT/ui/package.json" ] || { json_error "source ui/package.json missing"; exit 1; }

SOURCE_STATUS="$(git -C "$SOURCE_ROOT" status --porcelain=v1 --untracked-files=all)"
if [ -n "$SOURCE_STATUS" ]; then
  python3 - "$SOURCE_STATUS" <<'PY2'
import json, sys
print(json.dumps({
  "ok": False,
  "error": "repo_path has uncommitted or untracked changes; commit or clean the workspace before deploying to dev",
  "status": sys.argv[1].splitlines(),
}))
PY2
  exit 1
fi

SOURCE_SHA="$(git -C "$SOURCE_ROOT" rev-parse HEAD)"
SOURCE_BRANCH="$(git -C "$SOURCE_ROOT" branch --show-current || true)"

if [ ! -e "$DEV_REPO_PATH" ]; then
  mkdir -p "$(dirname "$DEV_REPO_PATH")"
  git clone "$CANONICAL_ROOT" "$DEV_REPO_PATH"
fi
[ -d "$DEV_REPO_PATH" ] || { json_error "dev_repo_path is not a directory"; exit 1; }
git -C "$DEV_REPO_PATH" rev-parse --show-toplevel >/dev/null 2>&1 || {
  json_error "dev_repo_path is not a git checkout"
  exit 1
}

copy_if_missing "agent-hq-dev.db"
copy_if_missing ".env"
copy_if_missing ".env.local"
copy_if_missing "api/.env"
copy_if_missing "api/.env.local"
copy_if_missing "ui/.env"
copy_if_missing "ui/.env.local"

[ -f "$DEV_REPO_PATH/package.json" ] || { json_error "dev repo root missing package.json"; exit 1; }
[ -f "$DEV_REPO_PATH/api/package.json" ] || { json_error "dev repo api/package.json missing"; exit 1; }
[ -f "$DEV_REPO_PATH/ui/package.json" ] || { json_error "dev repo ui/package.json missing"; exit 1; }
ensure_package_scripts

if ! git -C "$DEV_REPO_PATH" diff --quiet || ! git -C "$DEV_REPO_PATH" diff --cached --quiet; then
  json_error "dev repo has tracked modifications; clean or commit it before promotion"
  exit 1
fi
DEV_UNTRACKED="$(git -C "$DEV_REPO_PATH" ls-files --others --exclude-standard)"
if [ -n "$DEV_UNTRACKED" ]; then
  python3 - "$DEV_UNTRACKED" <<'PY2'
import json, sys
print(json.dumps({
  "ok": False,
  "error": "dev repo has untracked non-ignored files; remove or ignore them before promotion",
  "files": sys.argv[1].splitlines(),
}))
PY2
  exit 1
fi

PREV_DEV_SHA="$(git -C "$DEV_REPO_PATH" rev-parse HEAD 2>/dev/null || true)"
PREV_API="$(capture_pm2 "$API_NAME")"
PREV_UI="$(capture_pm2 "$UI_NAME")"

git -C "$DEV_REPO_PATH" fetch --no-tags "$SOURCE_ROOT" HEAD
FETCH_SHA="$(git -C "$DEV_REPO_PATH" rev-parse FETCH_HEAD)"
if [ "$FETCH_SHA" != "$SOURCE_SHA" ]; then
  json_error "failed to fetch the exact source HEAD into the dev repo"
  exit 1
fi
git -C "$DEV_REPO_PATH" reset --hard "$SOURCE_SHA"

rm -rf "$DEV_REPO_PATH/api/dist" "$DEV_REPO_PATH/ui/.next"

if echo "$SERVICES" | grep -q 'api'; then
  ensure_deps "$DEV_REPO_PATH/api"
  (cd "$DEV_REPO_PATH/api" && npm run build)
  pm2 delete "$API_NAME" >/dev/null 2>&1 || true
  PORT="$API_PORT" \
    AGENT_HQ_DB_PATH="$DEV_DB_PATH" \
    OPENCLAW_GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-https://127.0.0.1:18789}" \
    OPENCLAW_HOOKS_TOKEN="${OPENCLAW_HOOKS_TOKEN:-}" \
    GATEWAY_TOKEN="${GATEWAY_TOKEN:-}" \
    GATEWAY_WS_URL="${GATEWAY_WS_URL:-wss://127.0.0.1:18789}" \
    GATEWAY_URL="${GATEWAY_URL:-https://localhost:18789}" \
    NODE_TLS_REJECT_UNAUTHORIZED="${NODE_TLS_REJECT_UNAUTHORIZED:-0}" \
    pm2 start npm --name "$API_NAME" --cwd "$DEV_REPO_PATH/api" -- start >/dev/null
fi

if echo "$SERVICES" | grep -q 'ui'; then
  ensure_deps "$DEV_REPO_PATH/ui"
  (cd "$DEV_REPO_PATH/ui" && npm run build)
  pm2 delete "$UI_NAME" >/dev/null 2>&1 || true
  NEXT_PUBLIC_API_URL="http://localhost:$API_PORT" \
    pm2 start npm --name "$UI_NAME" --cwd "$DEV_REPO_PATH/ui" -- run start-dev >/dev/null
fi

HEALTH_RESULTS="{}"
if [ "$HEALTH_CHECK" = "true" ]; then
  HEALTH_RESULTS="$(python3 - "$SERVICES" "$API_PORT" "$UI_PORT" <<'PY2'
import json, sys, time, urllib.request
services, api_port, ui_port = sys.argv[1:4]
checks = []
if 'api' in services:
    checks.append(('api', f'http://127.0.0.1:{api_port}/health'))
if 'ui' in services:
    checks.append(('ui', f'http://127.0.0.1:{ui_port}'))
results = {}
for name, url in checks:
    ok = False
    detail = None
    for _ in range(45):
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                detail = r.status
                ok = True
                break
        except Exception as e:
            detail = str(e)
            time.sleep(1)
    results[name] = {'ok': ok, 'detail': detail, 'url': url}
print(json.dumps(results))
if not all(v['ok'] for v in results.values()):
    raise SystemExit(1)
PY2
)"
fi

python3 - "$STATE_FILE" "$SOURCE_ROOT" "$SOURCE_BRANCH" "$SOURCE_SHA" "$DEV_REPO_PATH" "$PREV_DEV_SHA" "$PREV_API" "$PREV_UI" "$SERVICES" "$HEALTH_RESULTS" <<'PY2'
import json, sys
state_path, source_root, source_branch, source_sha, dev_repo_path, prev_dev_sha, prev_api_raw, prev_ui_raw, services, health_raw = sys.argv[1:11]

def parse(raw, fallback):
    if not raw or raw == 'null':
        return fallback
    try:
        return json.loads(raw)
    except Exception:
        return fallback

state = {
  'previous': {
    'dev_sha': prev_dev_sha or None,
    'api': parse(prev_api_raw, None),
    'ui': parse(prev_ui_raw, None),
  },
  'current': {
    'source_path': source_root,
    'source_branch': source_branch or None,
    'source_sha': source_sha,
    'dev_repo_path': dev_repo_path,
    'services': services.split(','),
    'api': {'cwd': f'{dev_repo_path}/api', 'name': 'agent-hq-dev-api', 'args': ['start']},
    'ui': {'cwd': f'{dev_repo_path}/ui', 'name': 'agent-hq-dev-ui', 'args': ['run', 'start-dev']},
  }
}
with open(state_path, 'w', encoding='utf-8') as f:
    json.dump(state, f, indent=2)

print(json.dumps({
  'ok': True,
  'source_path': source_root,
  'source_branch': source_branch or None,
  'source_sha': source_sha,
  'dev_repo_path': dev_repo_path,
  'state_file': state_path,
  'health': parse(health_raw, {}),
}))
PY2
