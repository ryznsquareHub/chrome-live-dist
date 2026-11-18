@echo off
rem Copy skill\SKILL.md (source of truth, in git) to the Claude Code skills folder. Run after editing.
rem SKILL.md is written with the owner's folder C:\path\to\chrome-live; the copy gets THIS install's
rem real folder instead, so the skill works wherever chrome-live was installed (same bytes on the owner's PC).
powershell -NoProfile -ExecutionPolicy Bypass -Command "$here = '%~dp0'; $root = (Resolve-Path (Join-Path $here '..')).Path.TrimEnd('\'); $dst = Join-Path $env:USERPROFILE '.claude\skills\chrome-live'; New-Item -ItemType Directory -Force $dst | Out-Null; $t = [IO.File]::ReadAllText((Join-Path $here 'SKILL.md')); $t = $t.Replace('C:\path\to\chrome-live', $root); [IO.File]::WriteAllText((Join-Path $dst 'SKILL.md'), $t, (New-Object Text.UTF8Encoding $false)); Write-Host ('skill copied -> ' + (Join-Path $dst 'SKILL.md') + ' (folder ' + $root + ')')"
if errorlevel 1 exit /b 1
