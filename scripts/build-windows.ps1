#!/usr/bin/env pwsh
# Build Immich Desktop on Windows and drop the installer in Downloads.
#
#   powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1 -SkipRuntime
#   powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1 --skip-ml
#
# -SkipRuntime reuses the runtime/ already on disk, which is what a UI or Rust
# change needs; everything after it (typecheck, build, assertions) still runs.
# Every other option goes to scripts/prepare-runtime-windows.mjs unchanged.
#
# Needs, once: Node 20+, Rust with the MSVC toolchain (rustup), and Visual
# Studio Build Tools with the C++ workload — the assembler compiles pgvector
# with MSVC, and the Rust target links against the same toolchain.
#
# The point of this file is the checks after the build, not the build: an
# installer that lost runtime/ weighs a few megabytes and installs an app that
# starts nothing, and Tauri reports success for both.
[CmdletBinding()]
param(
  [switch]$SkipRuntime,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$AssemblerArgs = @()
)

$ErrorActionPreference = 'Stop'
$LASTEXITCODE = 0

# `bundle.createUpdaterArtifacts` signs the app as it is built, so a build needs
# the private key even on a machine that is only checking its own work. Locally
# it is the gitignored one; CI passes the same key from a repository secret.
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
  $env:TAURI_SIGNING_PRIVATE_KEY = Join-Path (Split-Path -Parent $PSScriptRoot) '.secrets/tauri-signing.key'
}

# The runtime the app starts, as the supervisor sees it (src-tauri/src/runtime.rs).
# A path here is a promise the bundle carries it, so a build that drops one fails
# below instead of at first launch on someone else's machine.
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

# The runtime is 1.4 GB and LZMA takes it to several hundred; a build missing it
# lands in single digits. Wide enough not to break on a --skip-ml build, narrow
# enough that an empty installer cannot pass.
$minInstallerMB = 250

function Invoke-Step {
  param([string]$Label, [scriptblock]$Action)
  Write-Host "> $Label" -ForegroundColor Cyan
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed (exit $LASTEXITCODE)."
  }
}

# Windows keeps a freshly written executable open while it scans it, and the
# bundler deletes the previous installer before it writes the next one. That
# collision is reported as `os error 32` and kills the build, so the file is
# removed here instead, waiting out the scan rather than dying on it.
function Remove-WithWait {
  param([string]$Path, [int]$Seconds = 60, [switch]$Recurse)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $deadline = (Get-Date).AddSeconds($Seconds)
  while (Test-Path -LiteralPath $Path) {
    try {
      Remove-Item -LiteralPath $Path -Force -Recurse:$Recurse -ErrorAction Stop
    }
    catch {
      if ((Get-Date) -gt $deadline) {
        throw ("cannot clear ${Path}: something still has it open. Another build, or the " +
          'app itself, has to finish first.')
      }
      Start-Sleep -Seconds 3
    }
  }
}

function Clear-StaleInstaller {
  foreach ($dir in @('src-tauri/target/release/bundle/nsis', 'src-tauri/target/release/nsis/x64')) {
    $full = Join-Path $root $dir
    if (-not (Test-Path -LiteralPath $full)) { continue }
    foreach ($file in @(Get-ChildItem -LiteralPath $full -File -ErrorAction SilentlyContinue)) {
      Remove-WithWait -Path $file.FullName
    }
  }
}

function Invoke-Bundle {
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    Clear-StaleInstaller
    Write-Host "> tauri build (NSIS), attempt $attempt" -ForegroundColor Cyan
    npm run tauri build -- --bundles nsis
    if ($LASTEXITCODE -eq 0) { return }
    if ($attempt -eq 1) {
      Write-Host ('  the bundler gave up on a file Windows was holding; clearing it and ' +
        'trying once more') -ForegroundColor Yellow
      Start-Sleep -Seconds 5
    }
  }
  throw 'tauri build (NSIS) failed twice; the error above is the real one.'
}

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  foreach ($tool in @('node', 'npm', 'cargo')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
      throw "$tool is required and not on PATH."
    }
  }

  if ($SkipRuntime -and $AssemblerArgs.Count -gt 0) {
    throw '-SkipRuntime ignores the runtime assembler options; pass one or the other.'
  }

  Invoke-Step 'npm install' { npm install }

  if ($SkipRuntime) {
    Write-Host '> runtime: reused as it is (-SkipRuntime)' -ForegroundColor Cyan
  }
  else {
    Invoke-Step 'runtime for this machine' {
      node scripts/prepare-runtime-windows.mjs @AssemblerArgs
    }
  }

  Invoke-Step 'typecheck' { npm run typecheck }

  # tauri-build writes icons/icon.ico into the exe through a build script, and
  # Cargo only reruns that script when something it watches changes. Replacing
  # the icon alone does not count, so a rebuild keeps the previous icon and the
  # release ships art nobody drew. Compare the art against the hash the last
  # build recorded, and drop this crate's build output when they differ.
  $icon = Join-Path $root 'src-tauri/icons/icon.ico'
  $stamp = Join-Path $root 'src-tauri/target/.icon-stamp'
  $iconHash = (Get-FileHash -LiteralPath $icon -Algorithm SHA256).Hash
  $builtWith = if (Test-Path -LiteralPath $stamp) {
    (Get-Content -LiteralPath $stamp -Raw).Trim()
  } else { '' }
  if ($iconHash -ne $builtWith) {
    Invoke-Step 'window resource (the icon changed)' {
      # `cargo clean -p` leaves the build script's own output in place, and the
      # icon resource lives there (`out/resource.lib`), so a rebuild relinks the
      # previous icon. Remove this crate's build output and fingerprint instead;
      # that makes Cargo rerun build.rs, which recompiles the icon resource.
      foreach ($dir in @('src-tauri/target/release/build', 'src-tauri/target/release/.fingerprint')) {
        $full = Join-Path $root $dir
        if (-not (Test-Path -LiteralPath $full)) { continue }
        Get-ChildItem -LiteralPath $full -Directory -Filter 'immich-desktop-*' -ErrorAction SilentlyContinue |
          ForEach-Object { Remove-WithWait -Path $_.FullName -Recurse }
      }
    }
  }

  # One target, named here as well as in tauri.windows.conf.json: `all` would
  # also build the MSI, which is per-machine, needs admin, and would copy 1.4 GB
  # into Program Files.
  Invoke-Bundle
  # Recorded only after a build that took, so a failed one cleans again next time.
  Set-Content -LiteralPath $stamp -Value $iconHash -NoNewline

  $release = Join-Path $root 'src-tauri/target/release'
  $runtime = Join-Path $release 'runtime'
  # The crate's binary name, which is what the bundler stages and packs; the
  # installer's shortcut is the product name, the file is not.
  $exe = Join-Path $release 'immich-desktop.exe'

  $missing = @()
  if (-not (Test-Path -LiteralPath $exe)) {
    $missing += 'immich-desktop.exe'
  }
  foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $runtime $relative))) {
      $missing += "runtime\$relative"
    }
  }
  if ($missing.Count -gt 0) {
    throw ("the bundle is incomplete; it would install and start nothing:`n  " +
      ($missing -join "`n  "))
  }

  $nsis = Join-Path $release 'bundle/nsis'
  $installer = Get-ChildItem -LiteralPath $nsis -Filter *.exe -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $installer) {
    throw "no NSIS installer in $nsis; the build reported success and produced nothing."
  }

  $megabytes = [math]::Round($installer.Length / 1MB)
  if ($megabytes -lt $minInstallerMB) {
    throw ("the installer is $megabytes MB, under the $minInstallerMB MB floor: " +
      'its runtime is missing or truncated.')
  }

  # The checks above read the tree the installer was packed from. 7-Zip can read
  # the pack itself, which is the only way to see that the runtime really is
  # inside it; without 7-Zip the floor above is what stands in for that.
  $sevenZip = $null
  $candidates = @(Join-Path $env:ProgramFiles '7-Zip\7z.exe')
  if (${env:ProgramFiles(x86)}) {
    $candidates += Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe'
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      $sevenZip = $candidate
      break
    }
  }
  if (-not $sevenZip) {
    $found = Get-Command 7z -ErrorAction SilentlyContinue
    if ($found) { $sevenZip = $found.Source }
  }

  if ($sevenZip) {
    $listing = (& $sevenZip l -ba $installer.FullName) -join "`n"
    if ($LASTEXITCODE -ne 0) {
      throw "7-Zip could not read the installer at $($installer.FullName)."
    }
    $expected = @('immich-desktop.exe') +
      ($required | ForEach-Object { 'runtime\' + ($_ -replace '/', '\') })
    $absent = @($expected | Where-Object { $listing -notmatch [regex]::Escape($_) })
    if ($absent.Count -gt 0) {
      throw ("the installer does not contain:`n  " + ($absent -join "`n  ") +
        "`nIt would install and start nothing.")
    }
    Write-Host "> installer contents verified with 7-Zip ($($expected.Count) required paths)" -ForegroundColor Cyan
  }
  else {
    Write-Host '> installer contents: 7-Zip not found, checked the staging tree only' -ForegroundColor Yellow
  }

  # Proof the bundled runtime is the one that was just assembled, not a leftover
  # from an earlier build that happened to still be sitting in target/release.
  if (-not $SkipRuntime) {
    $newest = (Get-ChildItem -LiteralPath $runtime -Recurse -File |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1).LastWriteTime
    if ($installer.LastWriteTime -lt $newest) {
      throw "the installer predates the runtime it should contain ($($newest.ToString('u')))."
    }
  }

  $target = Join-Path $env:USERPROFILE 'Downloads'
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Copy-Item -LiteralPath $installer.FullName -Destination $target -Force

  $hash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash
  Write-Host ''
  Write-Host "OK  $($installer.FullName)" -ForegroundColor Green
  Write-Host "    $megabytes MB, SHA-256 $hash"
  Write-Host "    copied to $target"

  @"

Next, on this machine or another one:
  1. Run the installer. SmartScreen shows "Windows protected your PC" because the
     build is unsigned: More info, then Run anyway. If the button is missing, the
     file was blocked by policy — right-click the installer, Properties, Unblock.
  2. It installs per user into %LOCALAPPDATA%\Immich Desktop, no administrator
     prompt. Allow the Windows Firewall prompt for private networks, or phones
     cannot reach the library.
  3. Pick a library folder on the internal disk, not OneDrive or a network share.
  4. Create the account, open the Library, upload something.
  5. Turn "phones on this network" on and scan the QR with the Immich app.

The runtime inside is this machine's: it cannot be copied to a Mac or installed
from another platform's build.
"@ | Write-Host
}
finally {
  Pop-Location
}
