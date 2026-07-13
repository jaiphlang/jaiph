#!/usr/bin/env pwsh
#
# Native Windows smoke test for the standalone jaiph.exe (the `windows-native-smoke`
# CI job runs this on windows-latest). Developing Jaiph on Windows is out of scope;
# this proves that *running* a workflow natively — with Git for Windows' sh.exe as
# the POSIX shell and no WSL — works. It covers each acceptance bullet with a check
# that fails when the contract is violated:
#
#   1. A sample workflow runs host-only (JAIPH_UNSAFE=true) covering an inline
#      shell line, a `script` step with a non-bash lang tag (```node), string
#      interpolation, and `log` output. Assertions run against the real jaiph.exe
#      stdout (exit code + expected `log` lines).
#   2. A mid-run cancellation cleans up the process tree: we start `jaiph run`,
#      record the workflow leader's descendant PIDs, deliver a real Ctrl-C, and
#      fail if any descendant survives termination (the win32 taskkill /T /F path).
#   3. A `prompt`-step workflow with a configured backend but no credentials fails
#      fast with the documented E_AGENT_CREDENTIALS error rather than hanging.
#
# The binary under test is provided via JAIPH_TEST_WINDOWS_EXE (same convention as
# installer_powershell.ps1). Without it the test cannot run and exits non-zero.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Hard ban: this smoke test must never touch WSL — exercising the Linux binary is
# e2e-wsl's job. Shadow `wsl` so any accidental invocation in this session throws
# loudly instead of silently succeeding.
function wsl {
  throw "WSL must not be used in the native Windows smoke test (e2e-wsl covers WSL)"
}

$script:Failures = 0
function Report-Pass { param([string]$m) Write-Host "PASS: $m" -ForegroundColor Green }
function Report-Fail { param([string]$m) Write-Host "FAIL: $m" -ForegroundColor Red; $script:Failures++ }
function Assert-Equal {
  param($Actual, $Expected, [string]$Message)
  if ($Actual -eq $Expected) { Report-Pass $Message }
  else { Report-Fail "$Message (expected '$Expected', got '$Actual')" }
}
function Assert-True {
  param([bool]$Condition, [string]$Message)
  if ($Condition) { Report-Pass $Message } else { Report-Fail $Message }
}
function Assert-Contains {
  param([string]$Haystack, [string]$Needle, [string]$Message)
  if ($Haystack -like "*$Needle*") { Report-Pass $Message }
  else { Report-Fail "$Message (missing '$Needle')`n---`n$Haystack`n---" }
}

$Exe = $env:JAIPH_TEST_WINDOWS_EXE
if (-not $Exe -or -not (Test-Path $Exe)) {
  Write-Host "FAIL: JAIPH_TEST_WINDOWS_EXE is not set to an existing jaiph.exe" -ForegroundColor Red
  exit 1
}
$Exe = (Resolve-Path $Exe).Path

# Host-only: the Docker sandbox is out of scope on win32 (resolveDockerConfig
# forces host mode), but be explicit so this never probes for a daemon.
$env:JAIPH_UNSAFE = "true"
$env:JAIPH_DOCKER_ENABLED = "false"

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("jaiph-winsmoke-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $Work -Force | Out-Null

# Enumerate the full descendant tree of a PID via the parent/child links in
# Win32_Process (procps-free, unlike `pgrep`, and portable across runner images).
function Get-DescendantPids {
  param([int]$RootPid)
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $result = New-Object System.Collections.Generic.List[int]
  $frontier = @($RootPid)
  while ($frontier.Count -gt 0) {
    $next = New-Object System.Collections.Generic.List[int]
    foreach ($proc in $all) {
      if ($frontier -contains [int]$proc.ParentProcessId) {
        $childPid = [int]$proc.ProcessId
        if (-not $result.Contains($childPid)) {
          $result.Add($childPid)
          $next.Add($childPid)
        }
      }
    }
    $frontier = $next.ToArray()
  }
  return $result.ToArray()
}

function Test-PidAlive {
  param([int]$TargetPid)
  return [bool](Get-Process -Id $TargetPid -ErrorAction SilentlyContinue)
}

# Ctrl-C delivery. To signal only the jaiph leader (never the CI runner shell),
# we detach from our own console, attach to the leader's own console, make the
# attached process ignore Ctrl-C, then GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)
# — which hits every process in that (isolated) console — and finally reattach to
# our parent console so the rest of the script can still write output.
Add-Type -Namespace JaiphSmoke -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetConsoleCtrlHandler(System.IntPtr HandlerRoutine, bool Add);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern bool AttachConsole(uint dwProcessId);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern bool FreeConsole();
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern bool AllocConsole();
'@

$CTRL_C_EVENT = 0
$ATTACH_PARENT_PROCESS = [uint32]"0xFFFFFFFF"
$leaderPid = $null  # referenced in the outer finally under Set-StrictMode

# Send a real Ctrl-C to $TargetPid's console only, sparing this process' console.
function Send-CtrlC {
  param([int]$TargetPid)
  [JaiphSmoke.Native]::FreeConsole() | Out-Null
  $attached = [JaiphSmoke.Native]::AttachConsole([uint32]$TargetPid)
  if (-not $attached) {
    # Nothing to attach to (child already gone / no console); restore and bail.
    [JaiphSmoke.Native]::AttachConsole($ATTACH_PARENT_PROCESS) | Out-Null
    return $false
  }
  [JaiphSmoke.Native]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $true) | Out-Null
  $sent = [JaiphSmoke.Native]::GenerateConsoleCtrlEvent($CTRL_C_EVENT, 0)
  # Restore our own console so Write-Host works again after this call.
  [JaiphSmoke.Native]::FreeConsole() | Out-Null
  if (-not [JaiphSmoke.Native]::AttachConsole($ATTACH_PARENT_PROCESS)) {
    [JaiphSmoke.Native]::AllocConsole() | Out-Null
  }
  [JaiphSmoke.Native]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $false) | Out-Null
  return [bool]$sent
}

try {
  # ── 1. Sample workflow: inline shell + node script + interpolation + log ─────
  Write-Host "`n== Sample workflow runs host-only against jaiph.exe =="

  $sampleWf = Join-Path $Work "sample.jh"
  Set-Content -LiteralPath $sampleWf -Encoding utf8 -Value @'
script node_step = ```node
process.stdout.write("node-step-output\n");
```

workflow default() {
  const who = "Windows"
  echo "inline shell for ${who}"
  run node_step()
  log "smoke greeting for ${who}"
}
'@

  $sampleOut = Join-Path $Work "sample.out"
  $sampleErr = Join-Path $Work "sample.err"
  $sample = Start-Process -FilePath $Exe -ArgumentList @("run", $sampleWf) `
    -NoNewWindow -PassThru -Wait -WorkingDirectory $Work `
    -RedirectStandardOutput $sampleOut -RedirectStandardError $sampleErr
  $sampleStdout = Get-Content -LiteralPath $sampleOut -Raw
  $sampleStderr = Get-Content -LiteralPath $sampleErr -Raw

  Assert-Equal $sample.ExitCode 0 "sample workflow exits 0"
  # Assert against stdout: the interpolated `log` line and the success footer.
  Assert-Contains $sampleStdout "smoke greeting for Windows" "log line (with interpolation) is on stdout"
  Assert-Contains $sampleStdout "PASS workflow default" "success footer is on stdout"
  if ($script:Failures -gt 0) {
    Write-Host "sample stderr was:`n$sampleStderr"
  }

  # ── 2. Mid-run cancellation cleans up the process tree ───────────────────────
  Write-Host "`n== Mid-run cancellation leaves no orphaned child processes =="

  $cancelWf = Join-Path $Work "cancel.jh"
  Set-Content -LiteralPath $cancelWf -Encoding utf8 -Value @'
script long_sleep = ```node
setInterval(() => {}, 1000);
```

workflow default() {
  run long_sleep()
}
'@

  # Launch the leader in its OWN (hidden) console so the Ctrl-C we send later is
  # isolated to its process group and never reaches the CI runner shell. We do
  # not redirect its stdio here — the cancellation contract is about the process
  # tree, not output — because redirection would force a shared console.
  $leader = Start-Process -FilePath $Exe -ArgumentList @("run", $cancelWf) `
    -WindowStyle Hidden -PassThru -WorkingDirectory $Work
  $leaderPid = $leader.Id

  # Wait for the workflow to spawn its child tree (detached runner -> node child).
  $descendants = @()
  for ($i = 0; $i -lt 100; $i++) {
    Start-Sleep -Milliseconds 200
    $descendants = Get-DescendantPids -RootPid $leaderPid
    if ($descendants.Count -ge 1) { break }
  }
  Assert-True ($descendants.Count -ge 1) "workflow leader spawned a child process tree"

  # Deliver a real Ctrl-C to the leader's console only, then wait for it to exit.
  Send-CtrlC -TargetPid $leaderPid | Out-Null
  $exited = $leader.WaitForExit(15000)
  Assert-True $exited "workflow leader exits after Ctrl-C (no hang)"

  # Give the win32 teardown (taskkill /T /F) a moment to reap the tree.
  Start-Sleep -Milliseconds 1500
  $survivors = @($descendants | Where-Object { Test-PidAlive -TargetPid $_ })
  Assert-True ($survivors.Count -eq 0) "no child of the workflow leader survives termination"
  if ($survivors.Count -gt 0) {
    Write-Host "surviving PIDs: $($survivors -join ', ')"
    # Best-effort reap so the CI runner is not left with orphans.
    foreach ($p in $survivors) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  }

  # ── 3. prompt-step credential pre-flight fails fast (no hang) ─────────────────
  Write-Host "`n== prompt-step pre-flight fails with the documented error, not a hang =="

  $promptWf = Join-Path $Work "prompt.jh"
  Set-Content -LiteralPath $promptWf -Encoding utf8 -Value @'
config {
  agent.backend = "codex"
}

workflow default() {
  const answer = prompt "Say hello"
  log answer
}
'@

  # The credential pre-flight is skipped under JAIPH_UNSAFE (that flag means
  # "trust my host env"), so drop it here — on win32 resolveDockerConfig already
  # forces host-only mode, so the run stays host-only without it. codex has no
  # login fallback: with OPENAI_API_KEY unset the pre-flight hard-fails before any
  # backend call, so this fails fast with E_AGENT_CREDENTIALS instead of hanging.
  $origOpenAi = $env:OPENAI_API_KEY
  $origUnsafe = $env:JAIPH_UNSAFE
  Remove-Item Env:\OPENAI_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:\JAIPH_UNSAFE -ErrorAction SilentlyContinue
  try {
    $promptOut = Join-Path $Work "prompt.out"
    $promptErr = Join-Path $Work "prompt.err"
    $prompt = Start-Process -FilePath $Exe -ArgumentList @("run", $promptWf) `
      -NoNewWindow -PassThru -WorkingDirectory $Work `
      -RedirectStandardOutput $promptOut -RedirectStandardError $promptErr
    $promptExited = $prompt.WaitForExit(30000)
    if (-not $promptExited) {
      $prompt.Kill($true)
      Report-Fail "prompt pre-flight hung (did not exit within 30s)"
    } else {
      $promptStderr = Get-Content -LiteralPath $promptErr -Raw
      Assert-True ($prompt.ExitCode -ne 0) "prompt pre-flight exits non-zero"
      Assert-Contains $promptStderr "E_AGENT_CREDENTIALS" "pre-flight names the documented error code"
      Assert-Contains $promptStderr "OPENAI_API_KEY" "pre-flight names the missing credential"
    }
  } finally {
    if ($null -ne $origOpenAi) { $env:OPENAI_API_KEY = $origOpenAi }
    if ($null -ne $origUnsafe) { $env:JAIPH_UNSAFE = $origUnsafe }
  }
} finally {
  # Defensive: if the cancellation contract regressed (or the harness threw mid-run),
  # force-kill the leader's tree so the CI runner is never left with orphans.
  if ($null -ne $leaderPid) {
    & taskkill.exe /PID $leaderPid /T /F 2>&1 | Out-Null
  }
  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
if ($script:Failures -gt 0) {
  Write-Host "$($script:Failures) check(s) failed" -ForegroundColor Red
  exit 1
}
Write-Host "All native Windows smoke checks passed" -ForegroundColor Green
exit 0
