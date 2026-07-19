#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

usage() {
  cat <<'EOF'
Usage: scripts/build-deb.sh \
  --version VERSION \
  --arch amd64|arm64 \
  --standalone-dir PATH \
  [--output-dir PATH]
EOF
}

version=
arch=
standalone_dir=
output_dir="$repository_root/release"
nfpm_bin=${NFPM_BIN:-nfpm}

while (($#)); do
  case "$1" in
    --version) version=${2:?}; shift 2 ;;
    --arch) arch=${2:?}; shift 2 ;;
    --standalone-dir) standalone_dir=${2:?}; shift 2 ;;
    --output-dir) output_dir=${2:?}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$version" || -z "$arch" || -z "$standalone_dir" ]]; then
  usage >&2
  exit 2
fi
if [[ ! "$version" =~ ^[0-9][0-9A-Za-z.+~:-]*$ ]]; then
  echo "Invalid Debian package version: $version" >&2
  exit 2
fi
if [[ "$arch" != "amd64" && "$arch" != "arm64" ]]; then
  echo "Unsupported Debian architecture: $arch" >&2
  exit 2
fi
if [[ ! -d "$standalone_dir" ]]; then
  echo "Standalone directory does not exist: $standalone_dir" >&2
  exit 1
fi

standalone_dir="$(cd "$standalone_dir" && pwd)"
for required in \
  VERSION \
  bin/kubecode \
  lib/kubecode/kubecode-server \
  lib/kubecode/node \
  lib/kubecode/dist/index.html \
  libexec/kubecode/claude-agent-acp \
  libexec/kubecode/codex-acp; do
  if [[ ! -f "$standalone_dir/$required" ]]; then
    echo "Standalone runtime is missing: $required" >&2
    exit 1
  fi
done
standalone_version=$(tr -d '[:space:]' < "$standalone_dir/VERSION")
if [[ "$standalone_version" != "$version" ]]; then
  echo "Standalone version $standalone_version does not match Debian version $version" >&2
  exit 1
fi
if [[ ! -x "$nfpm_bin" ]] && ! command -v "$nfpm_bin" >/dev/null 2>&1; then
  echo "nFPM is required to build a Debian package: $nfpm_bin" >&2
  exit 1
fi

mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
package="$output_dir/kubecode_${version}_${arch}.deb"
rm -f "$package"

export KUBECODE_VERSION="$version"
export KUBECODE_DEB_ARCH="$arch"
export KUBECODE_STANDALONE_DIR="$standalone_dir"
export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}

"$nfpm_bin" package \
  --config packaging/deb/nfpm.yaml \
  --packager deb \
  --target "$package"

if [[ ! -f "$package" ]]; then
  echo "nFPM did not create the expected package: $package" >&2
  exit 1
fi

printf '%s\n' "$package"
