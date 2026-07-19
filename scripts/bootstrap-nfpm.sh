#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-nfpm.sh --arch amd64|arm64 --prefix PATH
EOF
}

arch=
prefix=

while (($#)); do
  case "$1" in
    --arch) arch=${2:?}; shift 2 ;;
    --prefix) prefix=${2:?}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$arch" != "amd64" && "$arch" != "arm64" ]]; then
  echo "Unsupported nFPM architecture: $arch" >&2
  exit 2
fi
if [[ -z "$prefix" ]]; then
  usage >&2
  exit 2
fi
for command in curl dpkg-deb sha256sum; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "$command is required to bootstrap nFPM" >&2
    exit 1
  }
done

version=$(tr -d '[:space:]' < "$repository_root/packaging/NFPM_VERSION")
asset="nfpm_${version}_${arch}.deb"
base_url="https://github.com/goreleaser/nfpm/releases/download/v${version}"
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/kubecode-nfpm.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT

curl -fsSL "$base_url/checksums.txt" -o "$temporary_directory/checksums.txt"
curl -fsSL "$base_url/$asset" -o "$temporary_directory/$asset"

awk -v asset="$asset" '$2 == asset { print; found = 1 } END { exit !found }' \
  "$temporary_directory/checksums.txt" \
  > "$temporary_directory/selected-checksum.txt"
(
  cd "$temporary_directory"
  sha256sum --check selected-checksum.txt
)

mkdir -p "$prefix"
dpkg-deb --extract "$temporary_directory/$asset" "$prefix"
test -x "$prefix/usr/bin/nfpm"
