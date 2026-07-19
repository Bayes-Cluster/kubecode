#!/usr/bin/env bash
set -euo pipefail

archive=${1:?Usage: scripts/smoke-standalone.sh ARCHIVE}
archive=$(cd "$(dirname "$archive")" && pwd)/$(basename "$archive")
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/kubecode-smoke.XXXXXX")
server_pid=

cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid"
    wait "$server_pid" || true
  fi
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

tar -xzf "$archive" -C "$temporary_directory"
package_directory=$(find "$temporary_directory" -mindepth 1 -maxdepth 1 -type d -name 'kubecode-*-linux-*' -print -quit)
if [[ -z "$package_directory" ]]; then
  echo "Standalone archive has no package directory" >&2
  exit 1
fi

test "$(cat "$package_directory/VERSION")" = "$("$package_directory/bin/kubecode" --version | awk '{print $2}')"
PATH=/usr/bin:/bin "$package_directory/bin/kubecode" --version | grep -F "kubecode "
PATH=/usr/bin:/bin "$package_directory/libexec/kubecode/claude-agent-acp" --version | grep -Fx "0.59.0"
PATH=/usr/bin:/bin "$package_directory/libexec/kubecode/codex-acp" --version | grep -Fx "@agentclientprotocol/codex-acp 1.1.2"

workspace="$temporary_directory/workspace"
state="$temporary_directory/state"
mkdir -p "$workspace"
port=41742
PATH=/usr/bin:/bin "$package_directory/bin/kubecode" \
  --host 127.0.0.1 \
  --port "$port" \
  --workspace-root "$workspace" \
  --state-dir "$state" \
  >"$temporary_directory/server.log" 2>&1 &
server_pid=$!

for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$port/readyz" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    cat "$temporary_directory/server.log" >&2
    exit 1
  fi
  sleep 0.1
done

curl -fsS "http://127.0.0.1:$port/readyz" | grep -Fx "ok"
curl -fsS "http://127.0.0.1:$port/" | grep -F "<div id=\"root\"></div>"
curl -fsS "http://127.0.0.1:$port/api/v1/agents" | grep -F '"id":"codex"'
test -f "$state/kubecode.sqlite3"
