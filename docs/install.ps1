#!/usr/bin/env pwsh
#
# Jaiph Windows installer — the native counterpart to docs/install (the POSIX
# curl installer, which rejects Windows and points here). Downloads the pinned
# release's jaiph-windows-x64.exe + SHA256SUMS, verifies the checksum, installs
# to %LOCALAPPDATA%\jaiph\bin\jaiph.exe, and adds that dir to the user PATH.
#
#   irm https://jaiph.org/install.ps1 | iex
#
# Overrides mirror docs/install (env, or first argument for the ref):
#   JAIPH_REPO_REF          release ref (default: current stable tag)
#   JAIPH_BIN_DIR           install dir (default: %LOCALAPPDATA%\jaiph\bin)
#   JAIPH_RELEASE_BASE_URL  base URL for the release assets; a local directory
#                           or file:// URL installs offline (used by the tests,
#                           same technique as e2e/tests/07_installer_binary.sh).

param([string]$RepoRef)

$ErrorActionPreference = "Stop"

# ── Output helpers (honour NO_COLOR, same as docs/install) ────────────────────
$UseColor = -not (Test-Path Env:\NO_COLOR)
function Write-Line { param([string]$Text, [string]$Color)
  if ($UseColor -and $Color) { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text }
}
function Print-Step    { param([string]$m) Write-Line "> $m" "DarkGray" }
function Print-Success { param([string]$m) Write-Line "+ $m" "Green" }
function Print-Warning { param([string]$m) Write-Line "! $m" "Yellow" }
function Print-Error   { param([string]$m) Write-Line "x $m" "Red" }

# A local directory or file:// URL resolves to a filesystem path we copy from;
# anything else is fetched over the network. Mirrors curl's native file:// support.
function Resolve-LocalBase {
  param([string]$BaseUrl)
  if ($BaseUrl -like "file://*") { return ([uri]$BaseUrl).LocalPath }
  if (Test-Path -LiteralPath $BaseUrl -PathType Container) { return (Resolve-Path -LiteralPath $BaseUrl).Path }
  return $null
}

function Get-ReleaseAsset {
  param([string]$BaseUrl, [string]$Name, [string]$OutFile)
  $localBase = Resolve-LocalBase $BaseUrl
  if ($localBase) {
    $src = Join-Path $localBase $Name
    if (-not (Test-Path -LiteralPath $src)) { throw "Failed to download $BaseUrl/$Name" }
    Copy-Item -LiteralPath $src -Destination $OutFile -Force
  } else {
    Invoke-WebRequest -Uri "$BaseUrl/$Name" -OutFile $OutFile -UseBasicParsing
  }
}

# Resolve the expected hash for $Name from a sha256sum-format SHA256SUMS file
# (mirrors the installer's awk lookup: match the name, tolerate a `*` prefix).
function Get-ExpectedSum {
  param([string]$SumsFile, [string]$Name)
  foreach ($line in Get-Content -LiteralPath $SumsFile) {
    $parts = $line -split "\s+", 2
    if ($parts.Count -lt 2) { continue }
    $entry = $parts[1].Trim().TrimStart("*")
    if ($entry -eq $Name) { return $parts[0].Trim() }
  }
  return $null
}

Write-Host ""
Write-Line "Jaiph installer (Windows)" "White"
Write-Host ""

# ── Platform gate: Windows ships x64 only (Bun has no windows-arm64 target) ───
$rawArch = if ($env:PROCESSOR_ARCHITECTURE) { $env:PROCESSOR_ARCHITECTURE } else { "" }
if ($rawArch.ToUpper() -ne "AMD64" -and $rawArch.ToUpper() -ne "X64") {
  Print-Error "Unsupported platform: windows $rawArch"
  Write-Host "jaiph ships a Windows binary for x64 only."
  Write-Host "Build from source per https://jaiph.org/contributing#installing-from-source"
  exit 1
}

$RepoRef = if ($RepoRef) { $RepoRef } elseif ($env:JAIPH_REPO_REF) { $env:JAIPH_REPO_REF } else { "v0.11.0" }
$BinName = "jaiph-windows-x64.exe"
$BaseUrl = if ($env:JAIPH_RELEASE_BASE_URL) { $env:JAIPH_RELEASE_BASE_URL } else { "https://github.com/jaiphlang/jaiph/releases/download/$RepoRef" }
$BinDir  = if ($env:JAIPH_BIN_DIR) { $env:JAIPH_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "jaiph\bin" }
$Target  = Join-Path $BinDir "jaiph.exe"

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("jaiph-install-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
try {
  Print-Step "Downloading $BinName ($RepoRef)..."
  try { Get-ReleaseAsset $BaseUrl $BinName (Join-Path $tmpDir $BinName) }
  catch { Print-Error "Failed to download $BaseUrl/$BinName"; exit 1 }

  Print-Step "Downloading SHA256SUMS..."
  try { Get-ReleaseAsset $BaseUrl "SHA256SUMS" (Join-Path $tmpDir "SHA256SUMS") }
  catch { Print-Error "Failed to download $BaseUrl/SHA256SUMS"; exit 1 }

  Print-Step "Downloading SHA256SUMS.minisig..."
  try { Get-ReleaseAsset $BaseUrl "SHA256SUMS.minisig" (Join-Path $tmpDir "SHA256SUMS.minisig") }
  catch {
    Print-Error "Failed to download $BaseUrl/SHA256SUMS.minisig"
    Write-Host "The release signature file is missing. This may indicate a compromised or incomplete release." -ForegroundColor Red
    Write-Host "Install manually from source: https://jaiph.org/contributing#installing-from-source"
    exit 1
  }

  # Jaiph release signing public key (minisign).
  # Releases are signed with: minisign -S -s jaiph.key -m SHA256SUMS
  # Verify manually:          minisign -V -P <pubkey> -m SHA256SUMS
  # Key generation/rotation:  see docs/contributing.md -> "Release signing"
  $JaiphMinisignKey = if ($env:JAIPH_MINISIGN_PUBLIC_KEY) { $env:JAIPH_MINISIGN_PUBLIC_KEY } else { "" }
  $minisignCmd = Get-Command "minisign" -ErrorAction SilentlyContinue
  if ($JaiphMinisignKey -and $minisignCmd) {
    Print-Step "Verifying release signature..."
    $verifyResult = & minisign -V -P $JaiphMinisignKey `
        -m (Join-Path $tmpDir "SHA256SUMS") `
        -x (Join-Path $tmpDir "SHA256SUMS.minisig") 2>&1
    if ($LASTEXITCODE -ne 0) {
      Print-Error "Release signature verification failed for SHA256SUMS"
      Write-Host "The signature does not match the release signing key." -ForegroundColor Red
      Write-Host "This may indicate a tampered download. Do not proceed."
      exit 1
    }
    Print-Success "Release signature verified"
  } else {
    Print-Warning "Skipping detached-signature verification (minisign not installed or key not configured)"
    Write-Host "  Install minisign for full verification: https://jedisct1.github.io/minisign/"
    Write-Host "  Or set JAIPH_MINISIGN_PUBLIC_KEY to the project public key."
  }

  Print-Step "Verifying checksum..."
  $expected = Get-ExpectedSum (Join-Path $tmpDir "SHA256SUMS") $BinName
  if (-not $expected) { Print-Error "No checksum entry for $BinName in SHA256SUMS"; exit 1 }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $tmpDir $BinName)).Hash
  if ($actual -ine $expected) {
    Print-Error "Checksum mismatch for $BinName"
    Write-Host "  expected: $expected"
    Write-Host "  got:      $actual"
    exit 1
  }

  Print-Step "Installing binary to $Target..."
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $tmpDir $BinName) -Destination $Target -Force
} finally {
  Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

$version = try { & $Target --version } catch { "jaiph ($RepoRef)" }
Write-Host ""
Print-Success "Installed $version to $Target"

# Add the install dir to the user PATH if it is not already there.
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$segments = if ($userPath) { $userPath -split ";" | Where-Object { $_ -ne "" } } else { @() }
if ($segments -contains $BinDir) {
  Print-Success "$BinDir is already on PATH"
  Write-Host ""
  Write-Host "Try:"
  Write-Host "  jaiph --version"
  Write-Host "  jaiph --help"
} else {
  $newPath = if ($userPath) { "$userPath;$BinDir" } else { $BinDir }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  $env:Path = "$env:Path;$BinDir"
  Print-Warning "Added $BinDir to your user PATH"
  Write-Host ""
  Write-Host "Open a new terminal, then try:"
  Write-Host "  jaiph --version"
  Write-Host "  jaiph --help"
}
Write-Host ""
