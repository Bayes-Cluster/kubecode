# Installation

[Documentation](../README.md) · [简体中文](../zh-CN/guides/installation.md)

## Requirements

Requirements:

- Linux amd64 or arm64 with glibc 2.28 or newer;
- Git for Git status, diff, and worktree features;
- at least one installed and authenticated Claude Code, Codex, or OpenCode CLI.

## Debian package

Download `kubecode_<version>_amd64.deb` or
`kubecode_<version>_arm64.deb` from GitHub Releases. Confirm the local
architecture with `dpkg --print-architecture`, then install the matching file:

```bash
sudo apt install ./kubecode_0.1.1_amd64.deb
kubecode
```

The package installs the command at `/usr/bin/kubecode` and its private runtime
below `/usr/lib/kubecode`. It does not install or enable a systemd service,
create a user, or start a network listener. Remove it with:

```bash
sudo apt remove kubecode
```

Removal preserves user state and provider-native history. Kubecode does not
currently publish an APT repository, so upgrades require downloading a newer
package from GitHub Releases.

## Rootless standalone install

Install the latest release without root access:

```bash
curl -fsSL https://raw.githubusercontent.com/Bayes-Cluster/kubecode/main/install.sh | sh
~/.local/bin/kubecode
```

The installer downloads the archive and checksum from GitHub Releases, verifies
it, installs the version below `~/.local/lib`, and links
`~/.local/bin/kubecode`. It does not install a service or modify shell startup
files.

Useful options:

```bash
./install.sh --version 0.1.1
./install.sh --prefix /absolute/custom/prefix
./install.sh --version 0.1.1 --dry-run
```

To uninstall the application, remove the installed version directory and
command symlink. Application state is separate and is not deleted
automatically.

## Manual archive installation

Download `kubecode-<version>-linux-amd64.tar.gz` or
`kubecode-<version>-linux-arm64.tar.gz` and the matching
`kubecode-<version>-SHA256SUMS` from GitHub Releases. Verify the checksum,
extract the archive, and run:

```bash
./kubecode-<version>-linux-<arch>/bin/kubecode
```

The archive contains the React application, Rust server, Node.js runtime, and
pinned Claude/Codex ACP adapters. It does not contain provider Agent CLIs,
credentials, Git, or a shell.

## Server options and state

Run `kubecode --help` for the complete command line:

```text
--host
--port
--base-path
--workspace-root
--state-dir
```

Kubecode listens on `127.0.0.1:8888` by default. It has no built-in
authentication, so exposing a non-loopback listener requires an authenticated
reverse proxy or another trusted access boundary.

The default directory picker root is `$HOME`. State is stored at
`$XDG_DATA_HOME/kubecode`, or `$HOME/.local/share/kubecode` when
`XDG_DATA_HOME` is unset. Back up this directory to preserve Project
registrations, Sessions, Teams, normalized Agent events, and private worktrees.
Provider credentials remain in CLI-owned locations.

The release is a user-space Linux application. Kubecode does not publish or
maintain an official container, Kubernetes resource, or Kubeflow Notebook
manifest. Downstream environments may package the standalone archive and are
responsible for their own user, filesystem, routing, authentication, and
persistence policies.

## Agent discovery

Kubecode scans the inherited `PATH`, common install locations, and login-shell
paths at server startup. Discovery can be overridden with:

```text
KUBECODE_CLAUDE_PATH
KUBECODE_CODEX_PATH
KUBECODE_OPENCODE_PATH
KUBECODE_CLAUDE_ACP_PATH
KUBECODE_CODEX_ACP_PATH
```

The standalone launcher configures the two ACP adapter paths automatically.
Install and authenticate Agent CLIs using their official documentation. Never
put provider API keys in Kubecode configuration.

To validate a real adapter without sending a prompt:

```bash
KUBECODE_REAL_AGENT=opencode pnpm test:agents:real
```

Use `claude_code`, `codex`, or `all` to select another Agent.

## Source development

Source requirements are Node.js 22+, pnpm 10, stable Rust, and Git:

```bash
pnpm install
pnpm dev:server
```

In a second terminal:

```bash
pnpm dev
```

Open <http://127.0.0.1:5202>. Vite proxies API and terminal WebSocket traffic
to port 8888. Development state is written below `.local/`.

For a production-style source run:

```bash
pnpm build
cargo build --locked --manifest-path server/Cargo.toml
server/target/debug/kubecode-server \
  --workspace-root "$PWD/.local/workspace" \
  --state-dir "$PWD/.local/state"
```
