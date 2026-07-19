#!/usr/bin/env bash
set -euo pipefail

package=${1:?Usage: scripts/smoke-deb.sh PACKAGE}
package="$(cd "$(dirname "$package")" && pwd)/$(basename "$package")"
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/kubecode-deb-smoke.XXXXXX")
server_pid=
installed=0

if [[ $EUID -eq 0 ]]; then
  elevate=()
elif command -v sudo >/dev/null 2>&1; then
  elevate=(sudo)
else
  echo "Root access or sudo is required for the Debian installation smoke test" >&2
  exit 1
fi

cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid"
    wait "$server_pid" || true
  fi
  if [[ "$installed" -eq 1 ]]; then
    "${elevate[@]}" dpkg --remove kubecode >/dev/null || true
  fi
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

test "$(dpkg-deb --field "$package" Package)" = kubecode
dpkg-deb --field "$package" Version | grep -Eq '^[0-9]'
test "$(dpkg-deb --field "$package" Architecture)" = "$(dpkg --print-architecture)"
dpkg-deb --field "$package" Depends | grep -F "libc6 (>= 2.28)"
dpkg-deb --contents "$package" > "$temporary_directory/contents.txt"
grep -F "./usr/bin/kubecode" "$temporary_directory/contents.txt"
grep -F "./usr/lib/kubecode/lib/kubecode/kubecode-server" "$temporary_directory/contents.txt"
if grep -q '\.service$' "$temporary_directory/contents.txt"; then
  echo "Debian package unexpectedly contains a system service" >&2
  exit 1
fi

"${elevate[@]}" apt-get install -y "$package" >/dev/null
installed=1

PATH=/usr/bin:/bin kubecode --version | grep -F "kubecode "

workspace="$temporary_directory/workspace"
state="$temporary_directory/state"
mkdir -p "$workspace"
port=41743
PATH=/usr/bin:/bin kubecode \
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
curl -fsS "http://127.0.0.1:$port/" | grep -F '<div id="root"></div>'
test -f "$state/kubecode.sqlite3"
