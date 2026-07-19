#!/bin/sh
set -eu

repository="Bayes-Cluster/kubecode"
release_base_url=${KUBECODE_RELEASE_BASE_URL:-"https://github.com/$repository/releases/download"}
latest_url=${KUBECODE_RELEASES_LATEST_URL:-"https://github.com/$repository/releases/latest"}
prefix=${HOME:+"$HOME/.local"}
version=
dry_run=0

usage() {
  cat <<'EOF'
Install a Kubecode standalone release.

Usage: install.sh [options]

Options:
  --version VERSION  Install a specific version (with or without a leading v).
  --prefix PATH      Install below PATH (default: ~/.local).
  --dry-run          Print the selected release and install paths without changing them.
  -h, --help         Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) version=${2-}; shift 2 ;;
    --prefix) prefix=${2-}; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$prefix" ]; then
  echo "HOME is not set; pass --prefix with an absolute path" >&2
  exit 1
fi
case "$prefix" in
  /*) ;;
  *) echo "--prefix must be an absolute path: $prefix" >&2; exit 1 ;;
esac

operating_system=${KUBECODE_INSTALL_OS:-$(uname -s)}
machine=${KUBECODE_INSTALL_ARCH:-$(uname -m)}
case "$operating_system" in
  Linux) ;;
  *) echo "Kubecode standalone releases currently support Linux only" >&2; exit 1 ;;
esac
case "$machine" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "Unsupported Linux architecture: $machine" >&2; exit 1 ;;
esac

if [ -z "$version" ]; then
  command -v curl >/dev/null 2>&1 || {
    echo "curl is required to resolve the latest Kubecode release" >&2
    exit 1
  }
  effective_url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$latest_url")
  version=${effective_url##*/}
fi
version=${version#v}
if ! printf '%s\n' "$version" | grep -Eq '^[0-9][0-9A-Za-z.-]*$'; then
  echo "Invalid version: $version" >&2
  exit 1
fi

archive="kubecode-${version}-linux-${arch}.tar.gz"
checksums="kubecode-${version}-SHA256SUMS"
release_url="$release_base_url/v${version}"
install_dir="$prefix/lib/kubecode-${version}"
bin_link="$prefix/bin/kubecode"

if [ "$dry_run" -eq 1 ]; then
  printf 'Release: %s/%s\n' "$release_url" "$archive"
  printf 'Install directory: %s\n' "$install_dir"
  printf 'Command link: %s\n' "$bin_link"
  exit 0
fi

if [ -e "$bin_link" ] && [ ! -L "$bin_link" ]; then
  echo "Cannot replace non-symlink command: $bin_link" >&2
  exit 1
fi

for command in curl tar; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "$command is required to install Kubecode" >&2
    exit 1
  }
done

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/kubecode-install.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

curl -fL "$release_url/$archive" -o "$temporary_directory/$archive"
curl -fL "$release_url/$checksums" -o "$temporary_directory/$checksums"

expected=$(awk -v archive="$archive" '$2 == archive { print; exit }' "$temporary_directory/$checksums")
if [ -z "$expected" ]; then
  echo "Release checksum file does not contain $archive" >&2
  exit 1
fi
expected_hash=$(printf '%s\n' "$expected" | awk '{print $1}')
if command -v sha256sum >/dev/null 2>&1; then
  actual_hash=$(sha256sum "$temporary_directory/$archive" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual_hash=$(shasum -a 256 "$temporary_directory/$archive" | awk '{print $1}')
else
  echo "sha256sum or shasum is required to verify Kubecode" >&2
  exit 1
fi
if [ "$actual_hash" != "$expected_hash" ]; then
  echo "Checksum verification failed for $archive" >&2
  exit 1
fi

tar -xzf "$temporary_directory/$archive" -C "$temporary_directory"
extracted="$temporary_directory/kubecode-${version}-linux-${arch}"
if [ ! -x "$extracted/bin/kubecode" ]; then
  echo "Release archive does not contain bin/kubecode" >&2
  exit 1
fi

mkdir -p "$prefix/lib" "$prefix/bin"
staged="$prefix/lib/.kubecode-${version}.$$"
mv "$extracted" "$staged"
if [ -e "$install_dir" ]; then
  rm -rf "$install_dir"
fi
mv "$staged" "$install_dir"

ln -sfn "$install_dir/bin/kubecode" "$bin_link"

printf 'Kubecode %s installed at %s\n' "$version" "$install_dir"
printf 'Run: %s\n' "$bin_link"
