---
title: Install & switch versions
permalink: /how-to/install
diataxis: how-to
redirect_from:
  - /setup
  - /setup.md
---

# Install & switch versions

This guide installs the `jaiph` CLI onto your `PATH` and verifies it. It also shows how to switch between releases: the stable release, the nightly prerelease, or a specific version.

The curl installer downloads a standalone binary built for your platform from the current stable GitHub Release. You do not need Node or npm to run that binary, because it already contains the runtime and the agent skill.

## Prerequisites

- A POSIX `sh` on `PATH`. The runtime uses `sh -c` to run inline shell lines inside workflows. Any `script` step also needs the interpreter named by its shebang on `PATH` (`bash` by default). The runtime spawns that interpreter directly instead of relying on the file's exec bit, so scripts still run under `noexec` mounts.
- For the curl installer (step 1): `curl` and either `shasum` or `sha256sum` on `PATH`.
- For the PowerShell installer (step 1, Windows): PowerShell (`irm`/`Invoke-WebRequest` and `Get-FileHash` are built in).
- For the npm alternative (step 1): Node.js and npm on the host.
- (Optional) [`minisign`](https://jedisct1.github.io/minisign/) on `PATH` to verify the detached release signature. Both installers embed the project public key (`jaiph.pub`). When `minisign` is missing, the installer still requires the signature file to be present and fails if it cannot download that file. It then skips signature verification, checks only the checksum, and prints a warning.

## 1. Install the binary

Use the curl installer:

```bash
curl -fsSL https://jaiph.org/install | bash
```

This downloads three files from the current stable Release: the platform binary `jaiph-{darwin|linux}-{arm64|x64}`, the checksum file `SHA256SUMS`, and the detached signature `SHA256SUMS.minisig`. It verifies the checksum, and it verifies the signature when `minisign` is available (see [Verify the release signature](#verify-the-release-signature)). It then installs the binary to `~/.local/bin/jaiph`. The installer fails closed if it cannot download `SHA256SUMS.minisig`. Override the install location with `JAIPH_BIN_DIR`.

**Windows (PowerShell):** the curl installer rejects Windows and points you here. Use the PowerShell one-liner instead:

```powershell
irm https://jaiph.org/install.ps1 | iex
```

This downloads the same three files from the current stable Release: `jaiph-windows-x64.exe`, `SHA256SUMS`, and `SHA256SUMS.minisig`. It verifies the checksum with `Get-FileHash`, and it verifies the signature when `minisign` is available (see [Verify the release signature](#verify-the-release-signature)). It then installs the binary to `%LOCALAPPDATA%\jaiph\bin\jaiph.exe` and adds that directory to your user `PATH`. Open a new terminal to pick up the new `PATH`. Override the ref with `JAIPH_REPO_REF` (or the first argument), and override the install location with `JAIPH_BIN_DIR`. Windows ships an x64 binary only, because Bun has no Windows arm64 target, so ARM Windows exits with an unsupported-platform message.

(Alternative) Install via npm when you already have Node on the host and want a package-manager-tracked install:

```bash
npm install -g jaiph
```

In the npm package, the `jaiph` command is `dist/src/cli.js`, which Node runs. The compiled runtime tree is under `dist/src/`.

## 2. Add jaiph to PATH (if needed)

If `jaiph --version` reports `command not found`, add the install directory to `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"   # curl installer
```

or prepend npm's global bin directory: `export PATH="$(npm prefix -g)/bin:$PATH"`.

## 3. (Optional) Switch versions

```bash
jaiph use nightly      # rolling nightly prerelease
jaiph use 0.12.0       # reinstalls the v0.12.0 release binary
```

`jaiph use` runs the same installer as step 1 again, with `JAIPH_REPO_REF` set to `nightly` or `v<version>`. By default it does not pipe `curl … | bash`. It downloads the install script from `${JAIPH_SITE}/install` (default `https://jaiph.org`), verifies it against the published `${JAIPH_SITE}/install.sha256`, and runs it only when the checksum matches. A missing or mismatched checksum fails closed. `jaiph use` then replaces the binary at `~/.local/bin/jaiph`, or at the location set by `JAIPH_BIN_DIR`. Set `JAIPH_INSTALL_COMMAND` to run a verbatim command instead for forks, offline bundles, or local scripts.

## Verification

```bash
jaiph --version
```

The command prints `jaiph <version>`, taken from the installed release at build time. After `jaiph use <version>`, run `jaiph --version` again and confirm the printed version matches. For example, you should see `jaiph 0.12.0` after `jaiph use 0.12.0`.

## Verify the release signature

Every release includes `SHA256SUMS` and a detached [minisign](https://jedisct1.github.io/minisign/) signature `SHA256SUMS.minisig`. The installer downloads both files and **requires** a valid signature: on a normal (non-CI) host, a missing `minisign` aborts the install rather than degrading to checksum-only (the checksum ships over the same channel as the binary, so it is not an independent defense). CI hosts (`CI` set) may proceed on checksum-only; for a deliberate non-CI checksum-only install, set `JAIPH_ALLOW_UNSIGNED=1`. An explicitly empty `JAIPH_MINISIGN_PUBLIC_KEY` is a misconfiguration and also fails closed.

From a checkout of this repo:

```bash
minisign -V -P "$(grep '^RW' jaiph.pub)" -m SHA256SUMS -x SHA256SUMS.minisig
```

Override with `JAIPH_MINISIGN_PUBLIC_KEY` only when testing a key rotation before merge.

For maintainer setup, see [Contributing: Release signing](contributing.md#release-signing).

## Install in GitHub Actions (CI)

To install a pinned `jaiph` CLI in a GitHub Actions job, use the reusable [`setup-jaiph`](https://github.com/jaiphlang/jaiph/tree/main/actions/setup-jaiph) composite action instead of writing the installer steps yourself. The action downloads the same standalone per-platform release binary as the curl installer, so the runner does not need Node or npm. It then appends the install directory to `GITHUB_PATH`, so `jaiph` is on `PATH` for every later step.

```yaml
steps:
  - uses: jaiphlang/jaiph/actions/setup-jaiph@v0.12.0
    with:
      version: 0.12.0        # semver, a release tag (v0.12.0), or 'nightly'
  - run: jaiph --version     # jaiph is now on PATH for later steps
```

Pin both the action ref (`@v0.12.0`) and the `version` input to an exact release for reproducible CI. Use `nightly` to track the rolling prerelease. The action supports GitHub-hosted Linux and macOS runners on arm64 and x64, which are the platforms that have release artifacts.

The action follows the installer's [fail-closed policy](#1-install-the-binary). The step fails and installs nothing when there is a checksum mismatch, a missing signature file, or a missing release artifact. It also verifies the signature when [`minisign`](https://jedisct1.github.io/minisign/) is on the runner's `PATH`. For the full list of inputs and outputs, see the [action README](https://github.com/jaiphlang/jaiph/tree/main/actions/setup-jaiph).

## Related

- [Architecture: Distribution, Node vs Bun standalone](architecture.md#distribution-node-vs-bun-standalone): what the installer downloads and why the binary is self-contained.
- [Deploy the runtime image standalone](deploy.md): skip installing entirely and run the prebuilt `ghcr.io/jaiphlang/jaiph-runtime` image directly with `docker run` or Kubernetes.
- [Why Jaiph](why-jaiph.md): the design context behind the single-binary distribution.
