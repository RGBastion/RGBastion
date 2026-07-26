# Build RedGalaxy Bastion for Windows (.exe / .zip) via Electron.
# Prefer Git Bash or WSL so prepare_redgalaxy_story_web.sh can run.
param(
  [ValidateSet("auto", "zip", "portable", "nsis", "dir", "all")]
  [string]$Target = "auto"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$WinDir = Join-Path $ProjectDir "tools\windows-bastion"
$OutDir = Join-Path $ProjectDir "dist\windows-bastion"
$DistDir = Join-Path $ProjectDir "dist"
$PrepareSh = Join-Path $ScriptDir "prepare_redgalaxy_story_web.sh"

function Need-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

Need-Command node
Need-Command npm

Write-Host "==> Preparing story web assets..."
$bash = Get-Command bash -ErrorAction SilentlyContinue
if ($bash) {
  & bash $PrepareSh
} elseif (Get-Command wsl -ErrorAction SilentlyContinue) {
  $wslPath = (& wsl wslpath -a $PrepareSh).Trim()
  & wsl bash $wslPath
} else {
  throw "Need Git Bash or WSL to run prepare_redgalaxy_story_web.sh"
}

$Index = Join-Path $ProjectDir "artifacts\redgalaxy-story-web\index.html"
if (-not (Test-Path $Index)) { throw "Story web assets missing after prepare." }
$IndexText = Get-Content -Raw $Index
foreach ($needle in @("__RG_STORY_MODE__", "/story/i18n.js", "/story/autopilot.js")) {
  if ($IndexText -notlike "*$needle*") {
    throw "ERROR: $needle missing from index.html"
  }
}

Write-Host "==> Installing Electron build deps..."
Push-Location $WinDir
try {
  npm install --no-audit --no-fund
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

  $targets = switch ($Target) {
    "auto" { @("zip", "portable") }
    "all"  { @("zip", "portable", "nsis") }
    default { @($Target) }
  }
  Write-Host "==> Packaging Windows targets: $($targets -join ' ')"

  foreach ($t in $targets) {
    Write-Host "---- building $t ----"
    & npx electron-builder --win $t --x64
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed for target $t" }
  }
}
finally {
  Pop-Location
}

Write-Host "==> Publishing convenience copies under dist/"
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
Get-ChildItem -Path $OutDir -Filter "RedGalaxy-Bastion*" -File -ErrorAction SilentlyContinue | ForEach-Object {
  Copy-Item -Force $_.FullName (Join-Path $DistDir $_.Name)
  Write-Host "Copied: $(Join-Path $DistDir $_.Name)"
}

$portable = Join-Path $OutDir "RedGalaxy-Bastion.exe"
if (Test-Path $portable) {
  Copy-Item -Force $portable (Join-Path $DistDir "RedGalaxy-Bastion.exe")
  Write-Host "Copied: $(Join-Path $DistDir 'RedGalaxy-Bastion.exe')"
}

Write-Host ""
Write-Host "Done. Artifacts in $OutDir and $DistDir"
Get-ChildItem $OutDir -ErrorAction SilentlyContinue | Format-Table Name, Length
