[CmdletBinding()]
param(
  [ValidateSet("Auto", "Remote", "LocalDirectory", "LocalArchive")]
  [string]$Source = "Auto",
  [string]$ReleaseTag = "v0.1.0-dev.1",
  [ValidatePattern("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")]
  [string]$Repository = "hunterzheng1/hunter-pi",
  [string]$LocalSource = "",
  [string]$ArchivePath = "",
  [string]$ChecksumPath = "",
  [string]$InstallRoot = "",
  [ValidateSet("User", "Process", "None")]
  [string]$PathMode = "User",
  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$DefaultReleaseTag = "v0.1.0-dev.1"

function Get-FullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Get-Sha256Hex([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  }
  finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Assert-SafeInstallRoot([string]$Path) {
  if (-not [System.IO.Path]::IsPathRooted($Path)) {
    throw "InstallRoot must be an absolute path."
  }
  $full = Get-FullPath $Path
  $volumeRoot = [System.IO.Path]::GetPathRoot($full)
  if ($full.TrimEnd("\") -eq $volumeRoot.TrimEnd("\")) {
    throw "InstallRoot cannot be a volume root."
  }
  return $full
}

function Assert-PhysicalDirectoryIfPresent([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "$Label must be one physical directory."
  }
}

function Expand-SafeZip([string]$ZipPath, [string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $destinationRoot = (Get-FullPath $Destination).TrimEnd("\") + "\"
  $seen = New-Object "System.Collections.Generic.HashSet[string]" ([StringComparer]::OrdinalIgnoreCase)
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  $entryCount = 0
  [long]$expandedBytes = 0
  try {
    foreach ($entry in $archive.Entries) {
      $entryCount += 1
      $expandedBytes += $entry.Length
      if ($entryCount -gt 100000 -or $expandedBytes -gt 1073741824) {
        throw "Release ZIP exceeds its extraction limits."
      }
      $portablePath = $entry.FullName.Replace("\", "/").TrimEnd("/")
      if (-not [string]::IsNullOrWhiteSpace($portablePath) -and
          ($portablePath -notmatch "^[A-Za-z0-9._@+ -]+(?:/[A-Za-z0-9._@+ -]+)*$" -or
           $portablePath.Split("/") -contains "..")) {
        throw "Release ZIP contains an unsafe path."
      }
      $relativePath = $entry.FullName.Replace("/", "\")
      if ([string]::IsNullOrWhiteSpace($relativePath)) { continue }
      $target = Get-FullPath (Join-Path $Destination $relativePath)
      if (-not $target.StartsWith($destinationRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Release ZIP contains a path outside its extraction root."
      }
      if (-not $seen.Add($target)) {
        throw "Release ZIP contains a duplicate path."
      }
      if ([string]::IsNullOrEmpty($entry.Name)) {
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        continue
      }
      $parent = Split-Path -Parent $target
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
  }
  finally {
    $archive.Dispose()
  }
}

function Get-PhysicalReleaseFiles([string]$Root) {
  $pending = New-Object "System.Collections.Generic.Queue[string]"
  $pending.Enqueue((Get-FullPath $Root))
  $files = New-Object "System.Collections.Generic.List[System.IO.FileInfo]"
  while ($pending.Count -gt 0) {
    $directory = $pending.Dequeue()
    $directoryItem = Get-Item -LiteralPath $directory -Force
    if (-not $directoryItem.PSIsContainer -or
        (($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw "Release file inventory contains a redirected directory."
    }
    foreach ($entry in Get-ChildItem -LiteralPath $directory -Force) {
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Release file inventory contains a redirected entry."
      }
      if ($entry.PSIsContainer) { $pending.Enqueue($entry.FullName) }
      else { $files.Add($entry) }
    }
  }
  return @($files)
}

function Assert-ArchiveChecksum([string]$ZipPath, [string]$ShaPath) {
  if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $ShaPath -PathType Leaf)) {
    throw "Release archive and SHA-256 file are both required."
  }
  $checksumText = (Get-Content -LiteralPath $ShaPath -Raw).Trim()
  if ($checksumText -notmatch "^(?<hash>[0-9a-fA-F]{64})(?:\s+\*?hpi-windows-x64\.zip)?$") {
    throw "Release SHA-256 file has an invalid format."
  }
  $expected = $Matches["hash"].ToLowerInvariant()
  $actual = Get-Sha256Hex $ZipPath
  if ($actual -ne $expected) {
    throw "Release archive checksum verification failed."
  }
}

function Assert-ReleaseFiles([string]$Root) {
  $rootFull = (Get-FullPath $Root).TrimEnd("\")
  $manifestPath = Join-Path $rootFull "release-files.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Release file manifest is missing."
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.schemaVersion -ne "hpi-windows-release-files.v1") {
    throw "Release file manifest is incompatible."
  }
  $expectedEntries = @($manifest.files)
  if ($expectedEntries.Count -lt 1 -or $expectedEntries.Count -gt 100000) {
    throw "Release file manifest has invalid bounds."
  }
  $expected = @{}
  foreach ($entry in $expectedEntries) {
    $relativePath = [string]$entry.path
    if ($relativePath -notmatch "^[A-Za-z0-9._@+ -]+(?:/[A-Za-z0-9._@+ -]+)*$" -or
        $relativePath.Split("/") -contains ".." -or
        $expected.ContainsKey($relativePath.ToLowerInvariant())) {
      throw "Release file manifest contains an unsafe or duplicate path."
    }
    $hash = [string]$entry.sha256
    $byteLength = [long]$entry.byteLength
    if ($hash -notmatch "^[a-f0-9]{64}$" -or $byteLength -lt 0) {
      throw "Release file manifest contains an invalid fingerprint."
    }
    $expected[$relativePath.ToLowerInvariant()] = $entry
  }

  $actualFiles = @(Get-PhysicalReleaseFiles $rootFull | Where-Object {
    $_.FullName -ne $manifestPath
  })
  if ($actualFiles.Count -ne $expectedEntries.Count) {
    throw "Release file inventory does not match its manifest."
  }
  foreach ($file in $actualFiles) {
    if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Release file inventory contains a redirected file."
    }
    $relativePath = $file.FullName.Substring($rootFull.Length + 1).Replace("\", "/")
    $key = $relativePath.ToLowerInvariant()
    if (-not $expected.ContainsKey($key)) {
      throw "Release file inventory contains an undeclared file."
    }
    $entry = $expected[$key]
    if ($file.Length -ne [long]$entry.byteLength -or (Get-Sha256Hex $file.FullName) -ne [string]$entry.sha256) {
      throw "Release file fingerprint verification failed."
    }
  }
}

function Assert-InstalledPayloadMatches([string]$SourceRoot, [string]$InstalledRoot) {
  $manifest = Get-Content -LiteralPath (Join-Path $SourceRoot "release-files.json") -Raw |
    ConvertFrom-Json
  foreach ($entry in @($manifest.files)) {
    $relativePath = ([string]$entry.path).Replace("/", "\")
    $installedPath = Join-Path $InstalledRoot $relativePath
    if (-not (Test-Path -LiteralPath $installedPath -PathType Leaf)) {
      throw "Existing installation is missing a release file."
    }
    $item = Get-Item -LiteralPath $installedPath -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $item.Length -ne [long]$entry.byteLength -or
        (Get-Sha256Hex $installedPath) -ne [string]$entry.sha256) {
      throw "Existing installation has release-file drift."
    }
  }
}

function Read-PortableRelease([string]$Root) {
  $manifestPath = Join-Path $Root "portable-manifest.json"
  $activePath = Join-Path $Root ".hpi-update\active.json"
  $candidatePath = Join-Path $Root "portable-release-candidate.json"
  foreach ($required in @($manifestPath, $activePath, $candidatePath, (Join-Path $Root "hpi.cmd"))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Release payload is incomplete."
    }
  }
  $portable = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $active = Get-Content -LiteralPath $activePath -Raw | ConvertFrom-Json
  $candidate = Get-Content -LiteralPath $candidatePath -Raw | ConvertFrom-Json
  if ($portable.schemaVersion -ne "hpi-windows-portable.v3" -or
      $portable.product -ne "Hunter Pi" -or
      $portable.platform -ne "win32-x64" -or
      $portable.updateChannel -ne "developer-preview" -or
      $portable.installer -ne "PORTABLE_ZIP" -or
      $portable.signed -ne $false) {
    throw "Release portable manifest is incompatible."
  }
  $releaseId = [string]$portable.releaseId
  $productVersion = [string]$portable.productVersion
  if ($releaseId -notmatch "^release_[A-Za-z0-9][A-Za-z0-9.-]*$" -or
      $productVersion -notmatch "^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$" -or
      $portable.versionDirectory -ne "versions/$releaseId" -or
      $active.releaseId -ne $releaseId -or
      $candidate.releaseId -ne $releaseId -or
      $candidate.productVersion -ne $productVersion) {
    throw "Release identity bindings are invalid."
  }
  $versionDirectory = Join-Path $Root ("versions\" + $releaseId)
  if (-not (Test-Path -LiteralPath $versionDirectory -PathType Container) -or
      -not (Test-Path -LiteralPath (Join-Path $versionDirectory ".hpi-candidate.json") -PathType Leaf)) {
    throw "Release version directory is missing."
  }
  return [ordered]@{
    ReleaseId = $releaseId
    ProductVersion = $productVersion
    Signed = $false
  }
}

function Copy-ReleaseTree([string]$SourceRoot, [string]$DestinationRoot) {
  New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
  foreach ($entry in Get-ChildItem -LiteralPath $SourceRoot -Force) {
    Copy-Item -LiteralPath $entry.FullName -Destination $DestinationRoot -Recurse -Force
  }
}

function Write-StableShim([string]$Root) {
  $bin = Join-Path $Root "bin"
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  $shim = Join-Path $bin "hpi.cmd"
  [IO.File]::WriteAllText(
    $shim,
    "@echo off`r`ncall `"%~dp0..\hpi.cmd`" %*`r`nexit /b %errorlevel%`r`n",
    (New-Object System.Text.UTF8Encoding($false))
  )
  return $bin
}

function Get-NormalizedPathEntry([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return "" }
  return (Get-FullPath $Path.Trim().Trim('"')).TrimEnd("\")
}

function Update-Path([string]$StableBin, [string]$Mode) {
  $comparison = [StringComparer]::OrdinalIgnoreCase
  $stable = Get-NormalizedPathEntry $StableBin
  $targetPath = if ($Mode -eq "User") {
    [Environment]::GetEnvironmentVariable("Path", "User")
  } else {
    $env:Path
  }
  $entries = @()
  if (-not [string]::IsNullOrWhiteSpace($targetPath)) {
    $entries = @($targetPath.Split([IO.Path]::PathSeparator) | Where-Object {
      -not [string]::IsNullOrWhiteSpace($_)
    })
  }
  $filtered = New-Object System.Collections.Generic.List[string]
  foreach ($entry in $entries) {
    if (-not $comparison.Equals((Get-NormalizedPathEntry $entry), $stable)) {
      $filtered.Add($entry.Trim())
    }
  }
  $newEntries = @($StableBin) + @($filtered)
  $newPath = $newEntries -join [IO.Path]::PathSeparator
  $changed = $entries.Count -eq 0 -or
    -not $comparison.Equals((Get-NormalizedPathEntry $entries[0]), $stable) -or
    @($entries | Where-Object { $comparison.Equals((Get-NormalizedPathEntry $_), $stable) }).Count -ne 1
  if ($Mode -eq "User" -and $changed) {
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  }
  if ($Mode -ne "None") {
    $processEntries = @($env:Path.Split([IO.Path]::PathSeparator) | Where-Object {
      -not [string]::IsNullOrWhiteSpace($_) -and
      -not $comparison.Equals((Get-NormalizedPathEntry $_), $stable)
    })
    $env:Path = (@($StableBin) + $processEntries) -join [IO.Path]::PathSeparator
  }
  return [bool]$changed
}

function Test-StableCommand([string]$InstallPath, [string]$ExpectedVersion) {
  $shim = Join-Path $InstallPath "bin\hpi.cmd"
  if (-not (Test-Path -LiteralPath $shim -PathType Leaf)) { return $false }
  $output = @(& $shim version --json 2>$null)
  if ($LASTEXITCODE -ne 0 -or $output.Count -eq 0) { return $false }
  try {
    $version = $output[-1] | ConvertFrom-Json
    return $version.product -eq "Hunter Pi" -and $version.productVersion -eq $ExpectedVersion
  }
  catch {
    return $false
  }
}

$temporaryRoot = ""
try {
  if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
      throw "LOCALAPPDATA is required when InstallRoot is omitted."
    }
    $InstallRoot = Join-Path $env:LOCALAPPDATA "HunterPi"
  }
  $InstallRoot = Assert-SafeInstallRoot $InstallRoot
  $resolvedSource = $Source
  if ($resolvedSource -eq "Auto") {
    if (-not [string]::IsNullOrWhiteSpace($ArchivePath)) {
      $resolvedSource = "LocalArchive"
    } elseif (-not [string]::IsNullOrWhiteSpace($LocalSource)) {
      $resolvedSource = "LocalDirectory"
    } elseif (Test-Path -LiteralPath (Join-Path $PSScriptRoot "release-files.json") -PathType Leaf) {
      $resolvedSource = "LocalDirectory"
      $LocalSource = $PSScriptRoot
    } else {
      $resolvedSource = "Remote"
    }
  }

  $checksumStatus = "LOCAL_MANIFEST_ONLY"
  if ($resolvedSource -eq "Remote" -or $resolvedSource -eq "LocalArchive") {
    $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("HunterPiInstall-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
    if ($resolvedSource -eq "Remote") {
      if ($ReleaseTag -notmatch "^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$") {
        throw "ReleaseTag is invalid."
      }
      $ArchivePath = Join-Path $temporaryRoot "hpi-windows-x64.zip"
      $ChecksumPath = Join-Path $temporaryRoot "hpi-windows-x64.zip.sha256"
      $archiveUrl = "https://github.com/$Repository/releases/download/$ReleaseTag/hpi-windows-x64.zip"
      $checksumUrl = "https://github.com/$Repository/releases/download/$ReleaseTag/hpi-windows-x64.zip.sha256"
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri $archiveUrl -OutFile $ArchivePath
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri $checksumUrl -OutFile $ChecksumPath
    } else {
      if ([string]::IsNullOrWhiteSpace($ArchivePath)) { throw "ArchivePath is required." }
      if ([string]::IsNullOrWhiteSpace($ChecksumPath)) { throw "ChecksumPath is required." }
      $ArchivePath = Get-FullPath $ArchivePath
      $ChecksumPath = Get-FullPath $ChecksumPath
    }
    Assert-ArchiveChecksum $ArchivePath $ChecksumPath
    $LocalSource = Join-Path $temporaryRoot "payload"
    Expand-SafeZip $ArchivePath $LocalSource
    $checksumStatus = "VERIFIED"
  } elseif ($resolvedSource -eq "LocalDirectory") {
    if ([string]::IsNullOrWhiteSpace($LocalSource)) { $LocalSource = $PSScriptRoot }
    $LocalSource = Get-FullPath $LocalSource
  } else {
    throw "Source mode is invalid."
  }

  Assert-PhysicalDirectoryIfPresent $LocalSource "Release source"
  Assert-ReleaseFiles $LocalSource
  $release = Read-PortableRelease $LocalSource
  if ($resolvedSource -eq "Remote" -and $ReleaseTag -ne ("v" + $release.ProductVersion)) {
    throw "Downloaded release does not match ReleaseTag."
  }

  $stableBinCandidate = Join-Path $InstallRoot "bin"
  $conflicts = @(Get-Command hpi -All -ErrorAction SilentlyContinue | Where-Object {
    $pathProperty = $_.PSObject.Properties["Path"]
    $sourcePath = if ($null -ne $pathProperty) { [string]$pathProperty.Value } else { [string]$_.Source }
    -not [string]::IsNullOrWhiteSpace($sourcePath) -and
    -not $sourcePath.StartsWith($stableBinCandidate, [StringComparison]::OrdinalIgnoreCase)
  })
  $status = "INSTALLED"
  if (Test-Path -LiteralPath $InstallRoot) {
    Assert-PhysicalDirectoryIfPresent $InstallRoot "Existing installation"
    $installedRelease = Read-PortableRelease $InstallRoot
    if ($installedRelease.ReleaseId -ne $release.ReleaseId) {
      throw "A different Hunter Pi release is active; use hpi update apply instead of overwriting it."
    }
    Assert-InstalledPayloadMatches $LocalSource $InstallRoot
    $status = "ALREADY_INSTALLED"
  } else {
    $parent = Split-Path -Parent $InstallRoot
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Assert-PhysicalDirectoryIfPresent $parent "Install parent"
    $stage = Join-Path $parent (".HunterPi-install-" + [guid]::NewGuid().ToString("N"))
    try {
      Copy-ReleaseTree $LocalSource $stage
      Write-StableShim $stage | Out-Null
      Move-Item -LiteralPath $stage -Destination $InstallRoot
    }
    finally {
      if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force
      }
    }
  }

  $stableBin = Write-StableShim $InstallRoot
  $pathChanged = if ($PathMode -eq "None") { $false } else { Update-Path $stableBin $PathMode }
  $stableCommandReady = Test-StableCommand $InstallRoot $release.ProductVersion
  if (-not $stableCommandReady) {
    throw "Installed hpi command failed its version probe."
  }
  if ($conflicts.Count -gt 0 -and -not $Json) {
    Write-Warning "Another hpi command remains installed. Hunter Pi did not overwrite or uninstall it."
  }
  $receipt = [ordered]@{
    schemaVersion = "hunter-pi-install-receipt.v1"
    status = $status
    releaseId = $release.ReleaseId
    productVersion = $release.ProductVersion
    source = switch ($resolvedSource) {
      "Remote" { "REMOTE" }
      "LocalArchive" { "LOCAL_ARCHIVE" }
      default { "LOCAL_DIRECTORY" }
    }
    checksum = $checksumStatus
    pathMode = $PathMode.ToUpperInvariant()
    pathChanged = [bool]$pathChanged
    stableCommandReady = $true
    conflictDetected = $conflicts.Count -gt 0
    conflictCount = $conflicts.Count
    updateChannel = "developer-preview"
    signed = $false
    providerRequestPerformed = $false
    existingHunterPiStateTouched = $false
  }
  if ($Json) {
    $receipt | ConvertTo-Json -Compress
  } else {
    Write-Output "Hunter Pi $($release.ProductVersion) is installed."
    Write-Output "Open a new terminal and run: hpi version --json"
  }
}
catch {
  Write-Error ("Hunter Pi installation failed: " + $_.Exception.Message)
  exit 1
}
finally {
  if (-not [string]::IsNullOrWhiteSpace($temporaryRoot) -and (Test-Path -LiteralPath $temporaryRoot)) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}
