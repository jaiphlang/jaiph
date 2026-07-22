#!/usr/bin/env pwsh
#
# Acceptance for docs/install.ps1 (the Windows PowerShell installer), the native
# counterpart to e2e/tests/07_installer_binary.sh. Network-free: it points the
# installer at a local release directory via JAIPH_RELEASE_BASE_URL and shims the
# architecture via PROCESSOR_ARCHITECTURE (same technique as the bash test's
# file:// base URL and fake `uname`). It covers each acceptance bullet with a
# check that fails when the contract is violated:
#   - checksum mismatch -> non-zero exit, nothing installed
#   - unsupported arch  -> non-zero exit with the documented message
#   - happy path        -> installs and `jaiph --version` works with no
#                          Node/npm/Bun on PATH (self-contained binary)
#
# The happy-path case needs a real jaiph-windows-x64.exe; set
# JAIPH_TEST_WINDOWS_EXE to a prebuilt binary to run it. Without it that case is
# skipped, mirroring the bun-gated parity section of the bash test.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$InstallScript = Join-Path $RepoRoot "docs\install.ps1"

$script:Failures = 0
function Report-Pass { param([string]$m) Write-Host "PASS: $m" -ForegroundColor Green }
function Report-Fail { param([string]$m) Write-Host "FAIL: $m" -ForegroundColor Red; $script:Failures++ }
function Assert-Equal {
  param($Actual, $Expected, [string]$Message)
  if ($Actual -eq $Expected) { Report-Pass $Message }
  else { Report-Fail "$Message (expected '$Expected', got '$Actual')" }
}
function Assert-Contains {
  param([string]$Haystack, [string]$Needle, [string]$Message)
  if ($Haystack -like "*$Needle*") { Report-Pass $Message }
  else { Report-Fail "$Message (missing '$Needle')`n---`n$Haystack`n---" }
}

# Run docs/install.ps1 as a child process so its `exit` does not stop this
# runner. Env overrides are inherited from the current process.
function Invoke-Installer {
  $out = & pwsh -NoProfile -ExecutionPolicy Bypass -File $InstallScript 2>&1 | Out-String
  return [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
}

$OrigArch = $env:PROCESSOR_ARCHITECTURE
$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("jaiph-ps-test-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $Work -Force | Out-Null

try {
  $BinName = "jaiph-windows-x64.exe"

  # ── Checksum mismatch ───────────────────────────────────────────────────────
  Write-Host "`n== Checksum mismatch fails and installs nothing =="
  $relBad = Join-Path $Work "release-mismatch"
  $binBad = Join-Path $Work "bin-mismatch"
  New-Item -ItemType Directory -Path $relBad, $binBad -Force | Out-Null
  Set-Content -Path (Join-Path $relBad $BinName) -Value "real-binary-bytes" -NoNewline
  # Wrong hash so the installer reaches verify and fails (not a download error).
  Set-Content -Path (Join-Path $relBad "SHA256SUMS") `
    -Value ("0000000000000000000000000000000000000000000000000000000000000000  $BinName")
  # Placeholder sig so the installer proceeds past the sig-download step and
  # reaches checksum verification (the real test target here).
  Set-Content -Path (Join-Path $relBad "SHA256SUMS.minisig") -Value "placeholder-sig"

  $env:PROCESSOR_ARCHITECTURE = "AMD64"
  $env:JAIPH_RELEASE_BASE_URL = $relBad
  $env:JAIPH_BIN_DIR = $binBad
  $bad = Invoke-Installer
  Assert-Equal $bad.Code 1 "checksum mismatch exits non-zero"
  Assert-Contains $bad.Out "Checksum mismatch" "checksum mismatch is reported"
  if (Test-Path (Join-Path $binBad "jaiph.exe")) {
    Report-Fail "installer left a binary on checksum failure"
  } else {
    Report-Pass "checksum mismatch leaves no binary"
  }

  # ── Unsupported arch ────────────────────────────────────────────────────────
  Write-Host "`n== Unsupported arch exits with the documented message =="
  $binArm = Join-Path $Work "bin-arm"
  New-Item -ItemType Directory -Path $binArm -Force | Out-Null
  $env:PROCESSOR_ARCHITECTURE = "ARM64"
  $env:JAIPH_BIN_DIR = $binArm
  $arm = Invoke-Installer
  Assert-Equal $arm.Code 1 "unsupported arch exits non-zero"
  Assert-Contains $arm.Out "Unsupported platform: windows ARM64" "error names the detected arch"
  Assert-Contains $arm.Out "contributing" "error points at the from-source instructions"
  if (Test-Path (Join-Path $binArm "jaiph.exe")) {
    Report-Fail "installer left a binary on unsupported arch"
  } else {
    Report-Pass "unsupported arch leaves no binary"
  }
  $env:PROCESSOR_ARCHITECTURE = "AMD64"

  # ── Happy path (needs a real windows binary) ────────────────────────────────
  Write-Host "`n== Happy path installs and --version works with no Node/npm/Bun =="
  $exe = $env:JAIPH_TEST_WINDOWS_EXE
  if (-not $exe -or -not (Test-Path $exe)) {
    Write-Host "SKIP: JAIPH_TEST_WINDOWS_EXE not set — skipping happy-path install"
  } else {
    $relOk = Join-Path $Work "release-ok"
    $binOk = Join-Path $Work "bin-ok"
    New-Item -ItemType Directory -Path $relOk, $binOk -Force | Out-Null
    Copy-Item -LiteralPath $exe -Destination (Join-Path $relOk $BinName) -Force
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $relOk $BinName)).Hash.ToLower()
    Set-Content -Path (Join-Path $relOk "SHA256SUMS") -Value "$hash  $BinName"
    # Placeholder sig — signature verification itself only runs when minisign
    # is installed and JAIPH_MINISIGN_PUBLIC_KEY is set, neither of which apply
    # here; the installer just needs the file present to proceed.
    Set-Content -Path (Join-Path $relOk "SHA256SUMS.minisig") -Value "placeholder-sig"

    $env:JAIPH_RELEASE_BASE_URL = $relOk
    $env:JAIPH_BIN_DIR = $binOk
    $ok = Invoke-Installer
    Assert-Equal $ok.Code 0 "happy path exits zero"

    $Target = Join-Path $binOk "jaiph.exe"
    if (Test-Path $Target) { Report-Pass "installed $Target" } else { Report-Fail "no binary installed at $Target" }
    Assert-Contains $ok.Out "Added $binOk to your user PATH" "adds the install dir to PATH"

    # Run the installed binary with only the Windows system dirs on PATH: it must
    # work with no Node/npm/Bun visible (self-contained, like the bash parity check).
    # (`$env:SystemRoot` is Windows-only; off-Windows local runs skip the PATH
    # strip and just confirm the binary runs, since the separator/system dirs differ.)
    $cleanPath = if ($env:SystemRoot) { "$env:SystemRoot\System32;$env:SystemRoot" } else { $env:Path }
    if ($env:SystemRoot) {
      foreach ($tool in "node", "npm", "bun") {
        $visible = & pwsh -NoProfile -Command "`$env:Path = '$cleanPath'; [bool](Get-Command $tool -ErrorAction SilentlyContinue)"
        if ($visible -eq "True") { Report-Fail "$tool unexpectedly visible on stripped PATH" }
      }
    }
    $verOut = (& pwsh -NoProfile -Command "`$env:Path = '$cleanPath'; & '$Target' --version" | Out-String).Trim()
    $pkgVersion = (Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json).version
    Assert-Equal $verOut "jaiph $pkgVersion" "jaiph --version works without Node/npm/Bun on PATH"
  }
} finally {
  $env:PROCESSOR_ARCHITECTURE = $OrigArch
  Remove-Item Env:\JAIPH_RELEASE_BASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:\JAIPH_BIN_DIR -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
if ($script:Failures -gt 0) {
  Write-Host "$($script:Failures) check(s) failed" -ForegroundColor Red
  exit 1
}
Write-Host "All PowerShell installer checks passed" -ForegroundColor Green
exit 0
