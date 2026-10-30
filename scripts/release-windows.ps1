#!/usr/bin/env pwsh
# Cut a Windows release in one command: assemble, build, install, assert.
#
#   powershell -ExecutionPolicy Bypass -File scripts/release-windows.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/release-windows.ps1 -SkipRuntime
#   powershell -ExecutionPolicy Bypass -File scripts/release-windows.ps1 --skip-ml
#
# scripts/build-windows.ps1 stops one step short of a release: it proves the
# installer carries the runtime and copies it to Downloads, but never opens it.
# That leaves three things unproven, and all three only fail after someone else
# has the file: the installer's own icon, the icon Windows draws on the taskbar
# (which comes from the exe, not from the installer), and whether the installed
# copy, as opposed to the build tree, still has a runtime it can start.
#
# So this script runs the build, installs the result silently the way a user
# would, and then measures the installed copy: icon fingerprints for the
# installer, the exe and the Start menu shortcut, the eleven runtime files, the
# shortcut's target, and a real launch that has to produce a window.
#
# Assertions run in one place at the end, so a failed release reports every
# problem it found rather than the first one.
[CmdletBinding()]
param(
  [switch]$SkipRuntime,
  [switch]$NoLaunch,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$AssemblerArgs = @()
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$appName = 'Immich Desktop'
# The shortcut carries the product name; the installed binary keeps the crate's
# name, which is what tauri.conf.json's bundle names.
$exeName = 'immich-desktop.exe'
$installDir = Join-Path $env:LOCALAPPDATA $appName
$shortcutPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$appName.lnk"
# The art to compare against: a plain PNG, so nothing has to decode an .ico.
$iconSource = Join-Path $root 'src-tauri/icons/32x32.png'

# The runtime the supervisor needs, mirrored from scripts/build-windows.ps1. It
# is repeated rather than imported because this checks the *installed* tree; a
# shared list would let a typo pass both places.
$required = @(
  'node/node.exe',
  'pg/bin/postgres.exe',
  'pg/lib/vector.dll',
  'pg/share/extension/vector.control',
  'pg/share/extension/uuid-ossp.control',
  'ffmpeg/bin/ffmpeg.exe',
  'immich/server/dist/main.js',
  'immich/server/node_modules/kysely/package.json',
  'www/index.html',
  'plugins/immich-plugin-core/dist/plugin.wasm',
  'ml/index.mjs'
)

$failures = New-Object System.Collections.Generic.List[string]
$checks = New-Object System.Collections.Generic.List[string]

function Pass {
  param([string]$Label)
  $checks.Add($Label)
  Write-Host "  ok  $Label" -ForegroundColor DarkGreen
}

function Fail {
  param([string]$Label)
  $failures.Add($Label)
  Write-Host "  FAIL  $Label" -ForegroundColor Red
}

# Icons differ by a pixel or two between the art, the exe resource and the
# installer resource because each carries its own scaled copy, so compare an
# 8x8 grid of average colour and allow a small delta instead of hashing bytes.
#
# The exe and installer bitmaps come from ExtractIconEx, which reads the file's
# own resource. SHGetFileInfo would be shorter but answers from the shell's icon
# cache, and that cache is keyed by path: a rebuilt installer at the same path
# keeps reporting the icon of the file it replaced.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class ExeIcon {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern uint ExtractIconEx(string file, int index, IntPtr[] large, IntPtr[] small, uint count);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr handle);

  public static System.Drawing.Bitmap Get(string path) {
    IntPtr[] large = new IntPtr[1];
    IntPtr[] small = new IntPtr[1];
    uint count = ExtractIconEx(path, 0, large, small, 1);
    if (count < 1 || large[0] == IntPtr.Zero) return null;
    using (System.Drawing.Icon icon = System.Drawing.Icon.FromHandle(large[0])) {
      System.Drawing.Bitmap bitmap = icon.ToBitmap();
      DestroyIcon(large[0]);
      return bitmap;
    }
  }
}
'@ -ReferencedAssemblies System.Drawing

function Get-IconGrid {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  if ($Path.EndsWith('.png')) {
    $image = [System.Drawing.Image]::FromFile($Path)
    $bitmap = New-Object System.Drawing.Bitmap $image
    $image.Dispose()
  }
  else {
    $bitmap = [ExeIcon]::Get($Path)
  }
  if (-not $bitmap) { return $null }
  try {
    $cells = @()
    $cellW = [math]::Max(1, [math]::Floor($bitmap.Width / 8))
    $cellH = [math]::Max(1, [math]::Floor($bitmap.Height / 8))
    for ($gy = 0; $gy -lt 8; $gy++) {
      for ($gx = 0; $gx -lt 8; $gx++) {
        $r = 0; $g = 0; $b = 0; $n = 0
        for ($y = $gy * $cellH; $y -lt ($gy + 1) * $cellH; $y++) {
          for ($x = $gx * $cellW; $x -lt ($gx + 1) * $cellW; $x++) {
            $c = $bitmap.GetPixel($x, $y)
            $r += $c.R; $g += $c.G; $b += $c.B; $n++
          }
        }
        $cells += , @([int]($r / $n), [int]($g / $n), [int]($b / $n))
      }
    }
    return $cells
  }
  finally {
    $bitmap.Dispose()
  }
}

function Get-GridDelta {
  param($A, $B)
  if (-not $A -or -not $B) { return 999 }
  $worst = 0
  for ($i = 0; $i -lt [math]::Min($A.Count, $B.Count); $i++) {
    for ($c = 0; $c -lt 3; $c++) {
      $delta = [math]::Abs($A[$i][$c] - $B[$i][$c])
      if ($delta -gt $worst) { $worst = $delta }
    }
  }
  return $worst
}

Push-Location $root
try {
  # 1. Build. build-windows.ps1 owns npm install, the runtime, typecheck, the
  # Tauri build and the bundle checks; calling it keeps one copy of that logic.
  Write-Host '> build' -ForegroundColor Cyan
  $buildArgs = @{}
  if ($SkipRuntime) { $buildArgs['SkipRuntime'] = $true }
  if ($AssemblerArgs.Count -gt 0) { $buildArgs['AssemblerArgs'] = $AssemblerArgs }
  & (Join-Path $PSScriptRoot 'build-windows.ps1') @buildArgs
  if (-not $?) { throw 'the build failed; nothing to install.' }

  $bundle = Join-Path $root 'src-tauri/target/release/bundle/nsis'
  $installer = Get-ChildItem -LiteralPath $bundle -Filter *.exe |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $installer) { throw "no installer in $bundle." }

  $version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version

  # 2. Install the way a user does: silently, per user, no administrator. A copy
  # already running holds its own exe open, so close it first.
  Get-Process -Name ([System.IO.Path]::GetFileNameWithoutExtension($exeName)) -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "> closing the running $appName (pid $($_.Id))" -ForegroundColor Cyan
    $_.CloseMainWindow() | Out-Null
    if (-not $_.WaitForExit(15000)) { Stop-Process -Id $_.Id -Force }
  }

  Write-Host "> install $($installer.Name)" -ForegroundColor Cyan
  $install = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
  if ($install.ExitCode -ne 0) {
    throw "the installer exited $($install.ExitCode). A per-user NSIS run needs no elevation, so a non-zero code here is a broken installer."
  }

  Write-Host ''
  Write-Host '> assertions' -ForegroundColor Cyan

  # 3. The installed copy, not the build tree.
  $exe = Join-Path $installDir $exeName
  if (Test-Path -LiteralPath $exe) { Pass "installed $exe" } else { Fail "missing $exe" }

  if ($exe -and (Test-Path -LiteralPath $exe)) {
    $fileVersion = (Get-Item -LiteralPath $exe).VersionInfo.FileVersion
    if ($fileVersion -like "$version*") { Pass "exe version $fileVersion" }
    else { Fail "exe version is '$fileVersion', expected $version" }
  }

  if (Test-Path -LiteralPath (Join-Path $installDir 'uninstall.exe')) {
    Pass 'uninstaller installed'
  }
  else { Fail 'no uninstall.exe, so the install cannot be removed from Apps' }

  $missing = @()
  foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $installDir "runtime/$relative"))) {
      $missing += $relative
    }
  }
  if ($missing.Count -eq 0) { Pass "runtime complete ($($required.Count) files)" }
  else { Fail ("installed runtime is missing: " + ($missing -join ', ')) }

  # 4. Icons. Windows draws the taskbar from the exe and the Start menu from
  # whichever icon the shortcut names, so both are measured against the art.
  $art = Get-IconGrid $iconSource
  if (-not $art) { Fail "cannot read $iconSource" }

  if ($exe -and (Test-Path -LiteralPath $exe)) {
    $delta = Get-GridDelta $art (Get-IconGrid $exe)
    if ($delta -le 24) { Pass "taskbar icon matches the source art (delta $delta)" }
    else { Fail "the exe icon does not match the source art (delta $delta)" }
  }

  $delta = Get-GridDelta $art (Get-IconGrid $installer.FullName)
  if ($delta -le 24) { Pass "installer icon matches the source art (delta $delta)" }
  else { Fail "the installer still draws the default icon (delta $delta)" }

  # 5. Start menu entry, and where it points.
  if (-not (Test-Path -LiteralPath $shortcutPath)) {
    Fail "no Start menu shortcut at $shortcutPath"
  }
  else {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($shortcutPath)
    if ($lnk.TargetPath -eq $exe) { Pass 'Start menu shortcut points at the installed exe' }
    else { Fail "Start menu shortcut points at '$($lnk.TargetPath)'" }
    # NSIS writes ',0' when the shortcut should take its icon from the target,
    # so an empty path in front of the comma is the expected answer, not a miss.
    $iconPath = ($lnk.IconLocation -split ',')[0]
    if (-not $iconPath -or $iconPath -eq $exe) {
      Pass 'Start menu shortcut uses the exe icon'
    }
    else { Fail "Start menu shortcut icon is '$($lnk.IconLocation)'" }
  }

  # 6. It starts. The installed runtime is what the supervisor loads, so a
  # window appearing means the runtime travelled, not just the binary.
  if (-not $NoLaunch -and (Test-Path -LiteralPath $exe)) {
    Write-Host '> launching the installed app' -ForegroundColor Cyan
    $app = Start-Process -FilePath $exe -PassThru
    $deadline = (Get-Date).AddSeconds(90)
    $title = ''
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 500
      $app.Refresh()
      if ($app.HasExited) { break }
      if ($app.MainWindowTitle) { $title = $app.MainWindowTitle; break }
    }
    if ($title -eq $appName) { Pass "window appeared: $title" }
    elseif ($app.HasExited) { Fail "the app exited with code $($app.ExitCode) before showing a window" }
    else { Fail "no window after 90s (title '$title')" }

    # Leave the machine as it was found: closing the window lets the supervisor
    # stop Postgres and the server itself, which a force-kill would strand.
    if (-not $app.HasExited) {
      $app.CloseMainWindow() | Out-Null
      if (-not $app.WaitForExit(20000)) { Stop-Process -Id $app.Id -Force }
    }
  }
  elseif ($NoLaunch) {
    Write-Host '  --  launch skipped (-NoLaunch)' -ForegroundColor DarkGray
  }

  $hash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash
  Write-Host ''
  if ($failures.Count -eq 0) {
    Write-Host "RELEASED  $($installer.FullName)" -ForegroundColor Green
    Write-Host "          $([math]::Round($installer.Length / 1MB)) MB, SHA-256 $hash"
    Write-Host "          installed to $installDir, $($checks.Count) checks passed"
  }
  else {
    Write-Host "FAILED  $($failures.Count) of $($failures.Count + $checks.Count) checks" -ForegroundColor Red
    foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Red }
    exit 1
  }
}
finally {
  Pop-Location
}
