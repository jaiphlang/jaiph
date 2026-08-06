# `setup-jaiph` GitHub Action

Install a pinned [Jaiph](https://github.com/jaiphlang/jaiph) CLI onto `PATH` in a
GitHub Actions job. Downloads the standalone per-platform release binary — the
same channel as the [curl installer](https://jaiph.org/how-to/install) — so no
Node/npm is required on the runner.

Supported runners: GitHub-hosted **Linux** and **macOS** (arm64 / x64), covered by
release artifacts.

## Usage

```yaml
steps:
  - uses: jaiphlang/jaiph/actions/setup-jaiph@v0.13.0
    with:
      version: 0.13.0        # semver, a release tag (v0.13.0), or 'nightly'
  - run: jaiph --version     # jaiph is now on PATH for every later step
```

Pin both the action (`@v0.13.0`) and the `version` input to an exact release for
reproducible CI. Use `nightly` to track the rolling prerelease:

```yaml
  - uses: jaiphlang/jaiph/actions/setup-jaiph@nightly
    with:
      version: nightly
```

## Inputs

| Input     | Required | Default   | Description |
|-----------|----------|-----------|-------------|
| `version` | no       | `nightly` | Version to install: a bare semver (`0.13.0`), a release tag (`v0.13.0`), or `nightly`. |

## Outputs

| Output    | Description |
|-----------|-------------|
| `version` | The resolved `jaiph --version` banner of the installed CLI. |

## Security

The action reuses the release installer's fail-closed policy: it verifies the
`SHA256SUMS` checksum for the downloaded binary and the detached
`SHA256SUMS.minisig` signature when [`minisign`](https://jedisct1.github.io/minisign/)
is on `PATH`. A checksum mismatch, a missing signature file, or a missing release
artifact fails the step and installs nothing.
