#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

usage() {
  cat <<'EOF'
Usage: scripts/build-standalone.sh \
  --version VERSION \
  --arch amd64|arm64 \
  --server-bin PATH \
  --node-bin PATH \
  --node-license PATH \
  [--output-dir PATH]
EOF
}

version=
arch=
server_bin=
node_bin=
node_license=
output_dir="$repository_root/release"

while (($#)); do
  case "$1" in
    --version) version=${2:?}; shift 2 ;;
    --arch) arch=${2:?}; shift 2 ;;
    --server-bin) server_bin=${2:?}; shift 2 ;;
    --node-bin) node_bin=${2:?}; shift 2 ;;
    --node-license) node_license=${2:?}; shift 2 ;;
    --output-dir) output_dir=${2:?}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$version" || -z "$arch" || -z "$server_bin" || -z "$node_bin" || -z "$node_license" ]]; then
  usage >&2
  exit 2
fi
if [[ "$arch" != "amd64" && "$arch" != "arm64" ]]; then
  echo "Unsupported architecture: $arch" >&2
  exit 2
fi

for required in "$server_bin" "$node_bin" "$node_license" dist/index.html LICENSE README.md; do
  if [[ ! -f "$required" ]]; then
    echo "Required file is missing: $required" >&2
    exit 1
  fi
done

expected_node_version=$(tr -d '[:space:]' < packaging/NODE_VERSION)
actual_node_version=$("$node_bin" -p 'process.versions.node')
if [[ "$actual_node_version" != "$expected_node_version" ]]; then
  echo "Node runtime $actual_node_version does not match pinned version $expected_node_version" >&2
  exit 1
fi

package_version=$(node -p 'require("./package.json").version')
cargo_version=$(sed -n 's/^version = "\(.*\)"/\1/p' server/Cargo.toml | head -n 1)
adapter_version=$(node -p 'require("./packaging/adapter-runtime/package.json").version')
if [[ "$version" != "$package_version" || "$version" != "$cargo_version" || "$version" != "$adapter_version" ]]; then
  echo "Release version $version does not match package.json ($package_version), Cargo.toml ($cargo_version), and adapter runtime ($adapter_version)" >&2
  exit 1
fi

name="kubecode-${version}-linux-${arch}"
stage="$output_dir/$name"
archive="$output_dir/$name.tar.gz"
rm -rf "$stage" "$archive"
mkdir -p "$output_dir"
adapter_stage=$(mktemp -d "$output_dir/.adapter-runtime.XXXXXX")
cleanup() {
  if [[ -n "$adapter_stage" ]]; then
    rm -rf "$adapter_stage"
  fi
}
trap cleanup EXIT
mkdir -p \
  "$stage/bin" \
  "$stage/lib/kubecode" \
  "$stage/libexec/kubecode" \
  "$stage/licenses/node"

cp packaging/bin/kubecode "$stage/bin/kubecode"
cp packaging/bin/claude-agent-acp "$stage/libexec/kubecode/claude-agent-acp"
cp packaging/bin/codex-acp "$stage/libexec/kubecode/codex-acp"
printf '%s\n' "$version" > "$stage/VERSION"
cp "$server_bin" "$stage/lib/kubecode/kubecode-server"
cp "$node_bin" "$stage/lib/kubecode/node"
cp -R dist "$stage/lib/kubecode/dist"
cp LICENSE README.md packaging/THIRD_PARTY_NOTICES.md "$stage/"
cp "$node_license" "$stage/licenses/node/LICENSE"
chmod 755 \
  "$stage/bin/kubecode" \
  "$stage/lib/kubecode/kubecode-server" \
  "$stage/lib/kubecode/node" \
  "$stage/libexec/kubecode/claude-agent-acp" \
  "$stage/libexec/kubecode/codex-acp"

pnpm --filter @kubecode/adapter-runtime deploy \
  --prod \
  --no-optional \
  "$adapter_stage"
mv "$adapter_stage" "$stage/lib/kubecode/adapter-runtime"
adapter_stage=

if find "$stage/lib/kubecode/adapter-runtime/node_modules" \
  \( -name '*claude-agent-sdk-linux-*' -o -name '*codex-linux-*' \) \
  -print -quit | grep -q .; then
  echo "Standalone archive unexpectedly contains a provider-native Agent binary" >&2
  exit 1
fi

source_date_epoch=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  tar \
    --sort=name \
    --mtime="@$source_date_epoch" \
    --owner=0 \
    --group=0 \
    --numeric-owner \
    --format=gnu \
    -C "$output_dir" \
    -cf - \
    "$name" | gzip -n > "$archive"
else
  # BSD tar is useful for local package validation; official Linux releases use
  # the deterministic GNU tar path above.
  tar -C "$output_dir" -czf "$archive" "$name"
fi

printf '%s\n' "$archive"
