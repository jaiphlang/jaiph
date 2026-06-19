---
title: Install & switch versions
permalink: /how-to/install
diataxis: how-to
redirect_from:
  - /setup
  - /setup.md
---

# Install & switch versions

This recipe installs the `jaiph` CLI onto your `PATH`, verifies it, and switches between releases (stable, nightly, or a specific version).

The installer downloads a per-platform standalone binary from the matching GitHub Release. Node and npm are **not** required to run `jaiph`; the binary self-contains the runtime and the agent skill.

## Prerequisites

- `curl` and either `shasum` or `sha256sum` on `PATH`.
- A POSIX `sh` (the runtime uses `sh -c` for inline shell lines inside workflows; emitted `script` steps follow their own shebang).

## 1. Install the binary

Use the curl installer:

```bash
curl -fsSL https://jaiph.org/install | bash
```

This downloads `jaiph-{darwin|linux}-{arm64|x64}` and `SHA256SUMS` from the current stable Release, verifies the checksum, and installs the binary to `~/.local/bin/jaiph`. Override the install location with `JAIPH_BIN_DIR`.

(Alternative) Install via npm when you already have Node on the host and want package-manager-tracked installs:

```bash
npm install -g jaiph
```

The npm package ships `node dist/src/cli.js` as the `jaiph` binary plus the runtime tree alongside it.

## 2. Add jaiph to PATH (if needed)

If `jaiph --version` reports `command not found`, add the install directory to `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"   # curl installer
```

or use the npm global bin directory (`npm bin -g`).

## 3. (Optional) Switch versions

```bash
jaiph use nightly      # rolling nightly prerelease
jaiph use 0.9.4        # reinstalls the v0.9.4 release binary
```

`jaiph use` runs the configured installer (`curl -fsSL https://jaiph.org/install | bash` by default) with `JAIPH_REPO_REF` set to the requested ref. Override the installer command via `JAIPH_INSTALL_COMMAND` for forks, offline bundles, or local scripts.

## Verification

```bash
jaiph --version
```

This prints the version string baked into the binary at build time. After `jaiph use <ref>`, re-run `jaiph --version` and confirm the value matches the requested ref.

## Related

- [Architecture — Distribution: Node vs Bun standalone](architecture.md#distribution-node-vs-bun-standalone) — what the installer downloads and why the binary is self-contained.
- [Why Jaiph](why-jaiph.md) — the design context behind the single-binary distribution.
