---
type: ADR
id: "0195"
title: "Debian package distribution"
status: active
date: 2026-07-19
supersedes: "0194 where Debian packages were deferred"
---

## Context

The standalone Linux archive is the canonical Kubecode runtime, but installing
and upgrading it manually does not integrate with Debian-family package
management. Maintaining a separately assembled Debian runtime would allow the
archive and package contents to drift.

Kubecode has no built-in authentication, and its Agent discovery and
credentials belong to the interactive user. Automatically enabling a system
service would therefore create ambiguous ownership for `HOME`, `PATH`, state,
Projects, and provider credentials.

## Decision

Each native Linux release job wraps the already smoke-tested standalone
directory in an `amd64` or `arm64` Debian package. Kubecode uses the pinned nFPM
version in `packaging/NFPM_VERSION`; CI downloads its official Debian artifact
and verifies the upstream SHA-256 checksum before use.

The package installs a system command at `/usr/bin/kubecode`, the unchanged
standalone runtime below `/usr/lib/kubecode`, and notices below
`/usr/share/doc/kubecode`. It depends on Git, glibc 2.28 or newer, and the GNU
C++ runtime required by bundled Node.js. Provider Agent CLIs and credentials
remain external.

The package does not install, enable, or start a system or user service. It
does not create users, state directories, configuration files, or network
listeners during installation. Running `kubecode` preserves the standalone
defaults: loopback networking, the invoking user's home directory, and
XDG-managed state.

Release checksums cover both standalone archives and Debian packages. Release
publication explicitly names the GitHub repository and uploads with replacement
when a partial Release already exists, making failed publish jobs rerunnable.

## Consequences

- Debian and Ubuntu users can install and upgrade Kubecode through `apt` or
  `dpkg` using downloaded package files.
- Archive and Debian installations execute the same runtime layout.
- Package removal leaves user-owned Kubecode state and provider history intact.
- Kubecode does not yet publish an APT repository or package-signing key.
- RPM, macOS, Windows, and service integration remain future work.
