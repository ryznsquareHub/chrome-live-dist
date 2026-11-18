<#
  chrome-live installer / updater for Windows (no git, no GitHub account, no token).
  Downloads the PUBLIC release repo ryznsquareHub/chrome-live-dist as a zip, copies it into a folder,
  runs `npm ci`, copies the Claude skill, adds the Startup-folder autostart, (re)starts the daemon and
  registers the MCP server for Claude Code. Running it again = update (same folder, user data kept).

  Usage (PowerShell):
    irm https://raw.githubusercontent.com/ryznsquareHub/chrome-live-dist/main/install.ps1 | iex
  with options:
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ryznsquareHub/chrome-live-dist/main/install.ps1))) -Dir 'D:\tools\chrome-live'
  or, from an extracted copy:
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-Dir <folder>] [options]

  Options: -Dir <folder>   install folder (default: the folder the existing autostart points to, else %USERPROFILE%\chrome-live)
           -ZipUrl <url|file>  another zip (default: the dist repo's main branch)
           -NoStart -NoAutostart -NoSkill -NoMcp   skip those steps
           -NoNodeInstall  do not install Node.js with winget when it is missing
           -Force          allow installing over a folder that is a git checkout (normally refused)
  Kept on update: %LOCALAPPDATA%\chrome-live (auth.json, vault.dat, memory, recipes ...) and, in the install folder,
  config.json, server.log, events.jsonl, chat\threads, chat\work, extension\panel-token.json (none of them are in the zip,
  and the copy never deletes). A running daemon is restarted ONLY when no side-panel chat is running; otherwise nothing
  is changed and you are told to run this again later (a restart ends that chat, and Chrome asks "allow" once more).
  This file is ASCII-only on purpose (Windows PowerShell 5.1 misreads UTF-8 without BOM). Never use `exit` here (iex).
#>
param(
  [string]$Dir = '',
  [string]$ZipUrl = 'https://codeload.github.com/ryznsquareHub/chrome-live-dist/zip/refs/heads/main',
  [switch]$NoStart,
  [switch]$NoAutostart,
  [switch]$NoSkill,
  [switch]$NoMcp,
  [switch]$NoNodeInstall,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$OwnerPath = 'C:\path\to\chrome-live'   # placeholder folder written in the docs (AGENTS.md / SKILL.md)
$StartupVbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'chrome-live.vbs'

function Say([string]$m) { Write-Host "[chrome-live] $m" }
function Warn([string]$m) { Write-Host "[chrome-live] $m" -ForegroundColor Yellow }
function Fail([string]$m) { Write-Host "[chrome-live] ERROR: $m" -ForegroundColor Red; throw "chrome-live install failed: $m" }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }

# ---- 1. Node.js 18+ (winget if missing) ----------------------------------------------------------
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node -and -not $NoNodeInstall) {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($winget) {
    Say 'Node.js not found: installing Node.js LTS with winget (may ask for permission) ...'
    & winget.exe install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
    Refresh-Path
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
  }
}
if (-not $node) { Fail 'Node.js not found. Install it:  winget install OpenJS.NodeJS.LTS  (or https://nodejs.org)  then open a NEW PowerShell and run this again.' }
$nodeVer = (& node.exe -v).Trim()
$major = [int]($nodeVer.TrimStart('v').Split('.')[0])
if ($major -lt 18) { Fail "Node.js $nodeVer is too old (need 18+). winget upgrade OpenJS.NodeJS.LTS" }
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { Fail 'npm.cmd not found next to Node.js. Reinstall Node.js LTS.' }
Say "Node.js $nodeVer OK"

# ---- 2. install folder ------------------------------------------------------------------------
if (-not $Dir) {
  if (Test-Path $StartupVbs) {
    $m = [regex]::Match((Get-Content -Raw $StartupVbs), '""([^"]+?)\\(start-hidden\.vbs|server\.js)""')
    if ($m.Success) { $Dir = $m.Groups[1].Value; Say "existing install found via autostart: $Dir" }
  }
  if (-not $Dir) { $Dir = Join-Path $env:USERPROFILE 'chrome-live' }
}
$Dir = [IO.Path]::GetFullPath($Dir).TrimEnd('\')
if ((Test-Path (Join-Path $Dir '.git')) -and -not $Force) {
  Fail "$Dir is a git checkout (developer copy). Update it with git instead, or pass -Force."
}
$oldVer = $null
try { $oldVer = (Get-Content -Raw (Join-Path $Dir 'package.json') | ConvertFrom-Json).version } catch {}
Say ("install folder: $Dir" + $(if ($oldVer) { " (installed v$oldVer)" } else { '' }))

# ---- 3. a daemon running from this folder: restart only if no side-panel chat is running --------
$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like ('*' + $Dir + '\server.js*') })
$wasRunning = $running.Count -gt 0
if ($wasRunning) {
  # the daemon's children: worker.js (Chrome connection) + conhost; anything else = a panel chat (claude / codex) or the
  # recipe writer at work. Restarting would end it, so change nothing and ask to run again later.
  $busy = @()
  foreach ($p in $running) {
    $busy += @(Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $p.ProcessId) -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ne 'conhost.exe' -and -not ($_.CommandLine -and $_.CommandLine -like '*worker.js*') })
  }
  if ($busy.Count -gt 0) {
    Warn ('A side-panel chat (or background recipe work) is running in the daemon: ' + (($busy | ForEach-Object { $_.Name }) -join ', '))
    Fail 'Nothing was changed. Run this again after the chat has finished (updating restarts the daemon and would end it).'
  }
}

# ---- 4. download (public zip, no auth) --------------------------------------------------------------
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$tmp = Join-Path $env:TEMP ('chrome-live-dl-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
$zip = Join-Path $tmp 'src.zip'
if (Test-Path -LiteralPath $ZipUrl) { Copy-Item -LiteralPath $ZipUrl $zip; Say "using local zip $ZipUrl" }
else {
  Say "downloading $ZipUrl"
  try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing -Uri $ZipUrl -OutFile $zip -Headers @{ 'User-Agent' = 'chrome-live-installer' }
  } catch {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    Fail ("download failed: " + $_.Exception.Message + ' (internet / proxy?)')
  }
}
$x = Join-Path $tmp 'x'
Expand-Archive -Path $zip -DestinationPath $x -Force
$tops = @(Get-ChildItem -Directory $x)
if ($tops.Count -ne 1 -or -not (Test-Path (Join-Path $tops[0].FullName 'server.js'))) { Fail 'unexpected zip layout (no single top folder with server.js).' }
$src = $tops[0].FullName
$newVer = (Get-Content -Raw (Join-Path $src 'package.json') | ConvertFrom-Json).version
Say "downloaded chrome-live v$newVer"

# ---- 5. stop the daemon (checked idle above): an update replaces its code and node_modules ------------
foreach ($p in $running) { Say ("stopping running daemon pid " + $p.ProcessId); & taskkill.exe /PID $p.ProcessId /T /F | Out-Null }

# ---- 6. copy code (no deletions; config.json / logs / chat history are not in the zip) ---------------
New-Item -ItemType Directory -Force $Dir | Out-Null
$oldLock = $null
$lockPath = Join-Path $Dir 'package-lock.json'
if (Test-Path $lockPath) { $oldLock = (Get-FileHash $lockPath).Hash }
& robocopy.exe $src $Dir /E /NFL /NDL /NJH /NJS /NP /XD node_modules .git /XF config.json | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "copy failed (robocopy code $LASTEXITCODE)" }
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Say 'code copied'

# docs for Codex name a placeholder folder; point them at this one
if ($Dir -ne $OwnerPath) {
  $agents = Join-Path $Dir 'AGENTS.md'
  if (Test-Path $agents) {
    $t = [IO.File]::ReadAllText($agents)
    [IO.File]::WriteAllText($agents, $t.Replace($OwnerPath, $Dir), (New-Object Text.UTF8Encoding $false))
  }
}

# ---- 7. dependencies ---------------------------------------------------------------------------
$newLock = (Get-FileHash $lockPath).Hash
if (($newLock -ne $oldLock) -or -not (Test-Path (Join-Path $Dir 'node_modules\playwright-core'))) {
  Say 'npm ci ...'
  Push-Location $Dir
  try { & npm.cmd ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { Fail "npm ci failed (code $LASTEXITCODE)" } }
  finally { Pop-Location }
} else { Say 'dependencies unchanged (npm ci skipped)' }

# ---- 8. Claude skill -----------------------------------------------------------------------------
if (-not $NoSkill) {
  & cmd.exe /c ('"' + (Join-Path $Dir 'skill\sync-skill.cmd') + '"')
  if ($LASTEXITCODE -ne 0) { Warn 'WARNING: skill copy failed (run skill\sync-skill.cmd later)' }
}

# ---- 9. autostart at logon -----------------------------------------------------------------------
if (-not $NoAutostart) {
  $line = 'CreateObject("WScript.Shell").Run "wscript.exe //nologo ""' + (Join-Path $Dir 'start-hidden.vbs') + '""", 0, False'
  [IO.File]::WriteAllText($StartupVbs, $line + "`r`n", [Text.Encoding]::ASCII)
  Say "autostart: $StartupVbs"
}

# ---- 10. start the daemon ------------------------------------------------------------------------
$cli = Join-Path $Dir 'cli.js'
$started = $false
if (-not $NoStart) {
  & wscript.exe //nologo (Join-Path $Dir 'start-hidden.vbs')
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    $out = & node.exe $cli status 2>$null
    if ($LASTEXITCODE -eq 0) { $started = $true; break }
  }
  if ($started) { Say 'daemon running' } else { Warn ('WARNING: daemon did not answer; check ' + (Join-Path $Dir 'server.log')) }
} elseif ($wasRunning) { Warn 'daemon was stopped and NOT started again (-NoStart).' }

# ---- 11. Claude Code MCP server (token from auth.json goes straight into claude; never printed) ----
if (-not $NoMcp) {
  $claude = Get-Command claude -ErrorAction SilentlyContinue
  $authFile = Join-Path $env:LOCALAPPDATA 'chrome-live\auth.json'
  if (-not $claude) { Say 'Claude Code CLI not found: MCP registration skipped (the skill + cli.js still work).' }
  elseif (-not (Test-Path $authFile)) { Say 'auth.json not created yet (daemon not started): MCP registration skipped. Run install again after starting it.' }
  else {
    $auth = Get-Content -Raw $authFile | ConvertFrom-Json
    $want = 'Bearer ' + $auth.token
    $have = $null
    try {
      $cj = Get-Content -Raw (Join-Path $env:USERPROFILE '.claude.json') | ConvertFrom-Json
      $have = $cj.mcpServers.'chrome-live'.headers.Authorization
    } catch {}
    if ($have -eq $want) { Say 'MCP server chrome-live already registered' }
    else {
      if ($have) { & claude mcp remove chrome-live -s user *> $null }
      & claude mcp add --transport http -s user chrome-live 'http://127.0.0.1:18931/mcp' --header ('Authorization: ' + $want) *> $null
      if ($LASTEXITCODE -eq 0) { Say 'MCP server chrome-live registered (user scope). Restart Claude Code to load it.' }
      else { Warn 'WARNING: claude mcp add failed; see INSTALL.md (MCP) to do it by hand.' }
    }
    $auth = $null; $want = $null
  }
}

# ---- 12. summary ---------------------------------------------------------------------------------------
if ($oldVer) { Say "updated v$oldVer -> v$newVer in $Dir" } else { Say "installed v$newVer in $Dir" }
if ($wasRunning -and $started) {
  Say 'daemon restarted: on the next Chrome command, Chrome shows the "allow remote debugging" prompt once -> click Allow.'
  Say 'side panel: it reloads itself when it sees the new extension version (if not: chrome://extensions -> chrome-live -> reload).'
}
if (-not $oldVer) {
  Say 'Manual steps left (INSTALL.md section 4): 1) chrome://inspect/#remote-debugging -> allow  2) load the extension'
  Say ("   (chrome://extensions -> Developer mode -> Load unpacked -> " + (Join-Path $Dir 'extension') + ") in every profile  3) click Allow in Chrome on first use.")
}
$global:LASTEXITCODE = 0   # robocopy's "files copied" code (1-7) is success; don't leak it as the exit code
