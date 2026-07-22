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

The curl installer downloads a per-platform standalone binary from the current stable GitHub Release. Node and npm are **not** required to run that binary; it self-contains the runtime and the agent skill.

## Prerequisites

- A POSIX `sh` on `PATH` — the runtime uses `sh -c` for inline shell lines inside workflows. Any `script` step also needs the interpreter named by its shebang on `PATH` (`bash` by default). The runtime spawns that interpreter explicitly rather than relying on the file's exec bit, so scripts still run under `noexec` mounts.
- For the curl installer (step 1): `curl` and either `shasum` or `sha256sum` on `PATH`.
- For the PowerShell installer (step 1, Windows): PowerShell (`irm`/`Invoke-WebRequest` and `Get-FileHash` are built in).
- For the npm alternative (step 1): Node.js and npm on the host.
- (Optional) [`minisign`](https://jedisct1.github.io/minisign/) and the project public key in `JAIPH_MINISIGN_PUBLIC_KEY` to cryptographically verify the detached release signature. Without them the installer still **requires** the signature file to be present (it fails closed when it is missing) but skips signature verification and falls back to checksum-only with a warning.

## 1. Install the binary

Use the curl installer:

```bash
curl -fsSL https://jaiph.org/install | bash
```

This downloads `jaiph-{darwin|linux}-{arm64|x64}`, `SHA256SUMS`, and the detached signature `SHA256SUMS.minisig` from the current stable Release, verifies the checksum (and the signature when `minisign` is available — see [Verify the release signature](#verify-the-release-signature)), and installs the binary to `~/.local/bin/jaiph`. The installer **fails closed** if `SHA256SUMS.minisig` cannot be downloaded. Override the install location with `JAIPH_BIN_DIR`.

**Windows (PowerShell):** the curl installer rejects Windows and points you here. Use the PowerShell one-liner instead:

```powershell
irm https://jaiph.org/install.ps1 | iex
```

This downloads `jaiph-windows-x64.exe`, `SHA256SUMS`, and `SHA256SUMS.minisig` from the current stable Release, verifies the checksum with `Get-FileHash` (and the signature when `minisign` is available — see [Verify the release signature](#verify-the-release-signature)), installs the binary to `%LOCALAPPDATA%\jaiph\bin\jaiph.exe`, and adds that directory to your user `PATH` (open a new terminal to pick it up). Override the ref with `JAIPH_REPO_REF` (or the first argument) and the install location with `JAIPH_BIN_DIR`. Windows ships an x64 binary only — Bun has no Windows arm64 target, so ARM Windows exits with an unsupported-platform message.

(Alternative) Install via npm when you already have Node on the host and want package-manager-tracked installs:

```bash
npm install -g jaiph
```

The npm package exposes `dist/src/cli.js` as the `jaiph` command (Node executes it) plus the compiled runtime tree under `dist/src/`.

## 2. Add jaiph to PATH (if needed)

If `jaiph --version` reports `command not found`, add the install directory to `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"   # curl installer
```

or prepend npm's global bin directory: `export PATH="$(npm prefix -g)/bin:$PATH"`.

## 3. (Optional) Switch versions

```bash
jaiph use nightly      # rolling nightly prerelease
jaiph use 0.11.0       # reinstalls the v0.11.0 release binary
```

`jaiph use` re-invokes the step-1 installer (`JAIPH_INSTALL_COMMAND`, default `curl -fsSL https://jaiph.org/install | bash`) with `JAIPH_REPO_REF` set to `nightly` or `v<version>`, then replaces `~/.local/bin/jaiph` (or `JAIPH_BIN_DIR`). Override `JAIPH_INSTALL_COMMAND` for forks, offline bundles, or local scripts.

## Verification

```bash
jaiph --version
```

This prints `jaiph <version>` (sourced from the installed release at build time). After `jaiph use <version>`, re-run `jaiph --version` and confirm the printed version matches (for example `jaiph 0.11.0` after `jaiph use 0.11.0`).

## Verify the release signature

Every release ships a `SHA256SUMS` file covering all binaries plus a detached [minisign](https://jedisct1.github.io/minisign/) signature `SHA256SUMS.minisig`. The installer downloads both and always requires the signature file to be present; when `minisign` and the project public key are available it also verifies the signature before touching any binary.

To enable full verification during install, install `minisign` and export the project public key first:

```bash
export JAIPH_MINISIGN_PUBLIC_KEY="RW..."   # the single-line minisign public key
curl -fsSL https://jaiph.org/install | bash
```

On PowerShell, set `$env:JAIPH_MINISIGN_PUBLIC_KEY` before running the installer.

To verify a release manually (for example an asset downloaded from the GitHub Release page):

```bash
minisign -V -P "$JAIPH_MINISIGN_PUBLIC_KEY" -m SHA256SUMS
```

For the signing trust model, the project public key, and key-rotation policy, see [Contributing — Release signing](contributing.md#release-signing).

## Related

- [Architecture — Distribution: Node vs Bun standalone](architecture.md#distribution-node-vs-bun-standalone) — what the installer downloads and why the binary is self-contained.
- [Why Jaiph](why-jaiph.md) — the design context behind the single-binary distribution.
