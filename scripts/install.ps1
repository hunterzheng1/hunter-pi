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

function Get-Sha256Bytes([byte[]]$Bytes) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant()
  }
  finally {
    $algorithm.Dispose()
  }
}

function Assert-ExactProperties([object]$Value, [string[]]$Expected, [string]$Label) {
  if ($null -eq $Value -or -not ($Value -is [System.Management.Automation.PSCustomObject])) {
    throw "$Label must be one JSON object."
  }
  $actual = @($Value.PSObject.Properties.Name)
  $comparison = [StringComparer]::Ordinal
  if ($actual.Count -ne $Expected.Count) {
    throw "$Label schema has unexpected properties."
  }
  foreach ($name in $Expected) {
    if (-not (@($actual | Where-Object { $comparison.Equals($_, $name) }).Count -eq 1)) {
      throw "$Label schema is missing a required property."
    }
  }
}

function Assert-JsonArray([object]$Value, [string]$Label) {
  if (-not ($Value -is [System.Array])) {
    throw "$Label must be one JSON array."
  }
}

function Assert-JsonInteger([object]$Value, [string]$Label, [long]$Minimum) {
  if (-not ($Value -is [byte] -or $Value -is [int16] -or $Value -is [int32] -or
      $Value -is [int64] -or $Value -is [uint16] -or $Value -is [uint32]) -or
      [long]$Value -lt $Minimum -or [long]$Value -gt 9007199254740991) {
    throw "$Label must be a bounded JSON integer."
  }
}

function Assert-Fingerprint([object]$Value, [string]$Label) {
  if (-not ($Value -is [string]) -or $Value -cnotmatch "^sha256:[a-f0-9]{64}$") {
    throw "$Label must be one SHA-256 fingerprint."
  }
}

function Assert-NonEmptyText([object]$Value, [string]$Label) {
  if (-not ($Value -is [string]) -or [string]::IsNullOrWhiteSpace($Value) -or
      $Value.Length -gt 4096 -or
      -not [StringComparer]::Ordinal.Equals($Value, $Value.Trim())) {
    throw "$Label must be trimmed non-empty text no longer than 4096 characters."
  }
}

function Assert-ExactVersion([object]$Value, [string]$Label) {
  if (-not ($Value -is [string]) -or
      $Value -cnotmatch "^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$") {
    throw "$Label must be one exact semantic version."
  }
}

function Assert-PortableReference([object]$Value, [string]$Label) {
  Assert-NonEmptyText $Value $Label
  if ($Value -cmatch "%(?![0-9A-Fa-f]{2})") {
    throw "$Label contains invalid percent encoding."
  }
  try {
    $decoded = [Uri]::UnescapeDataString($Value)
  }
  catch {
    throw "$Label contains invalid percent encoding."
  }
  if ($decoded.StartsWith("/") -or $decoded.StartsWith("\") -or
      $decoded -cmatch "^[A-Za-z]:[\\/]" -or
      $decoded -cmatch "(?:^|[\\/])\.\.(?:[\\/]|$)" -or
      $Value -cmatch "(?:^|[\s`"'])[A-Za-z]:[\\/]" -or
      $Value -cmatch "(?:^|[\s`"'])/(?:Users|home|private|tmp)/") {
    throw "$Label contains an unsafe or private path."
  }
  if ($Value -cmatch "^[A-Za-z][A-Za-z0-9+.-]*:") {
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or
        -not [StringComparer]::OrdinalIgnoreCase.Equals($uri.Scheme, "https") -or
        -not [string]::IsNullOrEmpty($uri.UserInfo)) {
      throw "$Label must use a credential-free HTTPS URL."
    }
  }
}

function Assert-Timestamp([object]$Value, [string]$Label) {
  if (-not ($Value -is [string]) -or
      $Value -cnotmatch "^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$") {
    throw "$Label must be one ISO-8601 timestamp."
  }
  $parsedTimestamp = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse(
      $Value,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind,
      [ref]$parsedTimestamp
    )) {
    throw "$Label must be one real ISO-8601 timestamp."
  }
}

function ConvertTo-CanonicalJson([object]$Value) {
  return ConvertTo-Json -InputObject $Value -Compress -Depth 100
}

function Read-JsonObject([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing."
  }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $item.Length -le 0 -or $item.Length -gt 262144) {
    throw "$Label must be one bounded physical file."
  }
  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  }
  catch {
    throw "$Label is not valid JSON."
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
  $manifestItem = Get-Item -LiteralPath $manifestPath -Force
  if (($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $manifestItem.Length -le 0 -or $manifestItem.Length -gt 33554432) {
    throw "Release file manifest must be one bounded physical file."
  }
  $manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
  try {
    $manifest = [Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
  }
  catch {
    throw "Release file manifest is not valid JSON."
  }
  Assert-ExactProperties $manifest @("schemaVersion", "files") "Release file manifest"
  if (-not [StringComparer]::Ordinal.Equals([string]$manifest.schemaVersion, "hpi-windows-release-files.v1")) {
    throw "Release file manifest is incompatible."
  }
  Assert-JsonArray $manifest.files "Release file manifest files"
  $expectedEntries = @($manifest.files)
  if ($expectedEntries.Count -lt 1 -or $expectedEntries.Count -gt 100000) {
    throw "Release file manifest has invalid bounds."
  }
  $expected = @{}
  foreach ($entry in $expectedEntries) {
    Assert-ExactProperties $entry @("path", "sha256", "byteLength") "Release file entry"
    $relativePath = [string]$entry.path
    if ($relativePath -cnotmatch "^[A-Za-z0-9._@+ -]+(?:/[A-Za-z0-9._@+ -]+)*$" -or
        $relativePath.Split("/") -contains ".." -or
        $expected.ContainsKey($relativePath.ToLowerInvariant())) {
      throw "Release file manifest contains an unsafe or duplicate path."
    }
    $hash = $entry.sha256
    Assert-JsonInteger $entry.byteLength "Release file byte length" 0
    $byteLength = [long]$entry.byteLength
    if (-not ($hash -is [string]) -or $hash -cnotmatch "^[a-f0-9]{64}$") {
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
  return Get-Sha256Bytes $manifestBytes
}

function Assert-InstalledPayloadMatches([string]$SourceRoot, [string]$InstalledRoot) {
  if ((Get-Sha256Hex (Join-Path $SourceRoot "release-files.json")) -ne
      (Get-Sha256Hex (Join-Path $InstalledRoot "release-files.json"))) {
    throw "Existing installation has release-manifest drift."
  }
  $manifest = Get-Content -LiteralPath (Join-Path $SourceRoot "release-files.json") -Raw |
    ConvertFrom-Json
  foreach ($entry in @($manifest.files)) {
    if ([StringComparer]::Ordinal.Equals([string]$entry.path, ".hpi-update/active.json")) {
      continue
    }
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

function Read-StrictReleaseCandidate(
  [string]$Path,
  [string]$Label,
  [bool]$RequireBootstrapPolicy = $true
) {
  $candidate = Read-JsonObject $Path $Label
  Assert-ExactProperties $candidate @(
    "schemaVersion", "releaseId", "productVersion", "channel", "artifact", "engine",
    "qualification", "updatePolicy", "licenses"
  ) $Label
  if (-not [StringComparer]::Ordinal.Equals([string]$candidate.schemaVersion, "hpi-release-candidate.v1") -or
      -not ($candidate.releaseId -is [string]) -or
      $candidate.releaseId.Length -gt 128 -or
      $candidate.releaseId -cnotmatch "^release_[A-Za-z0-9][A-Za-z0-9.-]*$" -or
      -not ($candidate.productVersion -is [string]) -or
      $candidate.productVersion -cnotmatch "^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$" -or
      (-not [StringComparer]::Ordinal.Equals([string]$candidate.channel, "PREVIEW") -and
       -not [StringComparer]::Ordinal.Equals([string]$candidate.channel, "STABLE"))) {
    throw "$Label has an invalid release identity."
  }
  if ($RequireBootstrapPolicy -and
      -not [StringComparer]::Ordinal.Equals([string]$candidate.channel, "PREVIEW")) {
    throw "$Label is outside this installer's release channel."
  }

  Assert-ExactProperties $candidate.artifact @("reference", "fingerprint", "byteLength") "$Label artifact"
  Assert-PortableReference $candidate.artifact.reference "$Label artifact reference"
  Assert-Fingerprint $candidate.artifact.fingerprint "$Label artifact fingerprint"
  Assert-JsonInteger $candidate.artifact.byteLength "$Label artifact byte length" 1
  if ($RequireBootstrapPolicy -and
      -not [StringComparer]::Ordinal.Equals([string]$candidate.artifact.reference, "update.bundle.tgz")) {
    throw "$Label artifact reference is incompatible."
  }

  Assert-ExactProperties $candidate.engine @("releaseId", "fingerprint", "piVersion") "$Label Engine"
  Assert-Fingerprint $candidate.engine.fingerprint "$Label Engine fingerprint"
  Assert-ExactVersion $candidate.engine.piVersion "$Label Engine Pi version"
  if (-not ($candidate.engine.releaseId -is [string]) -or
      $candidate.engine.releaseId.Length -gt 128 -or
      $candidate.engine.releaseId -cnotmatch "^engine-release_[A-Za-z0-9][A-Za-z0-9.-]*$") {
    throw "$Label has an invalid Engine Release identity."
  }
  if ($RequireBootstrapPolicy -and
      (-not [StringComparer]::Ordinal.Equals([string]$candidate.engine.releaseId, "engine-release_pi-0.84.1") -or
       -not [StringComparer]::Ordinal.Equals([string]$candidate.engine.piVersion, "0.84.1") -or
      -not [StringComparer]::Ordinal.Equals(
        [string]$candidate.engine.fingerprint,
        "sha256:a41dddea11dee5fce40f7f100d99f76fcac88281efc8f067c0f6b57b86fdb27e"
      ))) {
    throw "$Label does not bind the fixed Pi 0.84.1 Engine Release."
  }

  Assert-ExactProperties $candidate.updatePolicy @("piSelfUpdate", "unsigned") "$Label update policy"
  if ((-not [StringComparer]::Ordinal.Equals([string]$candidate.updatePolicy.piSelfUpdate, "DISABLED") -and
       -not [StringComparer]::Ordinal.Equals([string]$candidate.updatePolicy.piSelfUpdate, "ENABLED")) -or
      -not ($candidate.updatePolicy.unsigned -is [bool])) {
    throw "$Label update policy is incompatible."
  }
  if ($RequireBootstrapPolicy -and
      (-not [StringComparer]::Ordinal.Equals([string]$candidate.updatePolicy.piSelfUpdate, "DISABLED") -or
       -not $candidate.updatePolicy.unsigned)) {
    throw "$Label is outside this installer's update policy."
  }

  Assert-ExactProperties $candidate.qualification @(
    "status", "verifierFingerprint", "checks", "qualifiedAt"
  ) "$Label qualification"
  Assert-Fingerprint $candidate.qualification.verifierFingerprint "$Label qualification verifier"
  Assert-Timestamp $candidate.qualification.qualifiedAt "$Label qualification timestamp"
  if ($RequireBootstrapPolicy -and -not [StringComparer]::Ordinal.Equals(
      [string]$candidate.qualification.verifierFingerprint,
      "sha256:91015d5db9376b5e86a25538034c76609dcfddee1d7975faf64cca2bcbffe0c6"
    )) {
    throw "$Label qualification policy is incompatible."
  }
  $outcomeOrder = New-Object "System.Collections.Generic.Dictionary[string,int]" ([StringComparer]::Ordinal)
  $outcomeOrder.Add("PASS", 0)
  $outcomeOrder.Add("NOT_PROVEN", 1)
  $outcomeOrder.Add("BLOCKED", 2)
  $outcomeOrder.Add("FAIL", 3)
  if (-not $outcomeOrder.ContainsKey([string]$candidate.qualification.status)) {
    throw "$Label qualification status is invalid."
  }
  Assert-JsonArray $candidate.qualification.checks "$Label qualification checks"
  $checks = @($candidate.qualification.checks)
  if ($checks.Count -lt 1 -or $checks.Count -gt 64) {
    throw "$Label qualification checks have invalid bounds."
  }
  $checkNames = New-Object "System.Collections.Generic.HashSet[string]" ([StringComparer]::Ordinal)
  $aggregateOutcome = "PASS"
  foreach ($check in $checks) {
    $expectedCheckProperties = @("name", "outcome", "evidenceIds")
    if ($null -ne $check.PSObject.Properties["reason"]) {
      $expectedCheckProperties += "reason"
    }
    Assert-ExactProperties $check $expectedCheckProperties "$Label qualification check"
    if (-not ($check.name -is [string]) -or [string]::IsNullOrWhiteSpace($check.name) -or
        $check.name.Length -gt 4096 -or $check.name -ne $check.name.Trim() -or
        -not $checkNames.Add($check.name) -or
        -not $outcomeOrder.ContainsKey([string]$check.outcome)) {
      throw "$Label qualification check identity is invalid."
    }
    Assert-JsonArray $check.evidenceIds "$Label qualification Evidence identities"
    $evidenceIds = @($check.evidenceIds)
    foreach ($evidenceId in $evidenceIds) {
      if (-not ($evidenceId -is [string]) -or
          $evidenceId.Length -gt 128 -or
          $evidenceId -cnotmatch "^evidence_[A-Za-z0-9][A-Za-z0-9.-]*$") {
        throw "$Label qualification Evidence identity is invalid."
      }
    }
    if ([StringComparer]::Ordinal.Equals([string]$check.outcome, "PASS") -and $evidenceIds.Count -eq 0) {
      throw "$Label PASS qualification check lacks Evidence."
    }
    if ($null -ne $check.PSObject.Properties["reason"] -and
        (-not ($check.reason -is [string]) -or [string]::IsNullOrWhiteSpace($check.reason) -or
         $check.reason.Length -gt 4096 -or $check.reason -ne $check.reason.Trim())) {
      throw "$Label qualification reason is invalid."
    }
    if ($outcomeOrder[[string]$check.outcome] -gt $outcomeOrder[$aggregateOutcome]) {
      $aggregateOutcome = [string]$check.outcome
    }
  }
  if (-not [StringComparer]::Ordinal.Equals([string]$candidate.qualification.status, $aggregateOutcome)) {
    throw "$Label qualification status does not equal its check aggregate."
  }

  Assert-JsonArray $candidate.licenses "$Label license inventory"
  $licenses = @($candidate.licenses)
  if (($RequireBootstrapPolicy -and $licenses.Count -lt 2) -or $licenses.Count -gt 256) {
    throw "$Label license inventory has invalid bounds."
  }
  $hunterLicense = $false
  $piLicense = $false
  foreach ($license in $licenses) {
    Assert-ExactProperties $license @("name", "version", "license", "sourceReference") "$Label license"
    Assert-NonEmptyText $license.name "$Label license name"
    Assert-ExactVersion $license.version "$Label license version"
    Assert-NonEmptyText $license.license "$Label license identifier"
    Assert-PortableReference $license.sourceReference "$Label license source reference"
    if ($RequireBootstrapPolicy -and
        -not [StringComparer]::Ordinal.Equals([string]$license.sourceReference, "NOTICE.md")) {
      throw "$Label license source reference is incompatible."
    }
    if ([StringComparer]::Ordinal.Equals([string]$license.name, "Hunter Pi") -and
        [StringComparer]::Ordinal.Equals([string]$license.version, [string]$candidate.productVersion) -and
        [StringComparer]::Ordinal.Equals([string]$license.license, "MIT")) {
      $hunterLicense = $true
    }
    if ([StringComparer]::Ordinal.Equals([string]$license.name, "@earendil-works/pi-coding-agent") -and
        [StringComparer]::Ordinal.Equals([string]$license.version, "0.84.1")) {
      $piLicense = $true
    }
  }
  if ($RequireBootstrapPolicy -and (-not $hunterLicense -or -not $piLicense)) {
    throw "$Label license inventory does not bind Hunter Pi and Pi 0.84.1."
  }
  return $candidate
}

function Read-PortableActiveRelease([string]$Root) {
  $active = Read-JsonObject (Join-Path $Root ".hpi-update\active.json") "Portable active pointer"
  Assert-ExactProperties $active @(
    "schemaVersion", "releaseId", "artifactFingerprint", "productVersion", "activatedAt"
  ) "Portable active pointer"
  Assert-Fingerprint $active.artifactFingerprint "Portable active artifact"
  Assert-Timestamp $active.activatedAt "Portable activation timestamp"
  Assert-ExactVersion $active.productVersion "Portable active product version"
  if (-not [StringComparer]::Ordinal.Equals([string]$active.schemaVersion, "hpi-portable-active.v1") -or
      -not ($active.releaseId -is [string]) -or
      $active.releaseId.Length -gt 128 -or
      $active.releaseId -cnotmatch "^release_[A-Za-z0-9][A-Za-z0-9.-]*$") {
    throw "Portable active pointer has an invalid release identity."
  }

  $versionDirectory = Join-Path $Root ("versions\" + [string]$active.releaseId)
  Assert-PhysicalDirectoryIfPresent $versionDirectory "Active release version directory"
  if (-not (Test-Path -LiteralPath $versionDirectory -PathType Container)) {
    throw "Active release version directory is missing."
  }
  $candidate = Read-StrictReleaseCandidate (
    Join-Path $versionDirectory ".hpi-candidate.json"
  ) "Active release candidate" $false
  if (-not [StringComparer]::Ordinal.Equals([string]$active.releaseId, [string]$candidate.releaseId) -or
      -not [StringComparer]::Ordinal.Equals([string]$active.productVersion, [string]$candidate.productVersion) -or
      -not [StringComparer]::Ordinal.Equals(
        [string]$active.artifactFingerprint,
        [string]$candidate.artifact.fingerprint
      )) {
    throw "Portable active pointer does not bind its installed release candidate."
  }
  $artifactPath = Join-Path $versionDirectory ".hpi-artifact"
  if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
    throw "Active release artifact is missing."
  }
  $artifactItem = Get-Item -LiteralPath $artifactPath -Force
  if (($artifactItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $artifactItem.Length -ne [long]$candidate.artifact.byteLength -or
      -not [StringComparer]::Ordinal.Equals(
        ("sha256:" + (Get-Sha256Hex $artifactPath)),
        [string]$candidate.artifact.fingerprint
      )) {
    throw "Active release artifact bytes do not match its candidate."
  }
  return [ordered]@{
    ReleaseId = [string]$candidate.releaseId
    ProductVersion = [string]$candidate.productVersion
    EngineVersion = [string]$candidate.engine.piVersion
  }
}

function Read-PortableRelease([string]$Root, [bool]$RequireBootstrapActive = $true) {
  $manifestPath = Join-Path $Root "portable-manifest.json"
  $activePath = Join-Path $Root ".hpi-update\active.json"
  $candidatePath = Join-Path $Root "portable-release-candidate.json"
  foreach ($required in @(
    $manifestPath, $activePath, $candidatePath, (Join-Path $Root "hpi.cmd"),
    (Join-Path $Root "update.bundle.tgz")
  )) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Release payload is incomplete."
    }
    $requiredItem = Get-Item -LiteralPath $required -Force
    if (($requiredItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Release payload contains a redirected required file."
    }
  }

  $portable = Read-JsonObject $manifestPath "Portable manifest"
  Assert-ExactProperties $portable @(
    "schemaVersion", "product", "platform", "nodeVersion", "sourceCommit", "sourceState",
    "updateChannel", "installer", "signed", "releaseId", "productVersion", "engineVersion",
    "engineReleaseId", "engineReleaseFingerprint", "artifactFingerprint", "artifactByteLength",
    "versionDirectory", "cliPackageFingerprint", "productShellIntegrity",
    "coreExtensionIntegrity", "nodeRuntimeIntegrity"
  ) "Portable manifest"
  if (-not [StringComparer]::Ordinal.Equals([string]$portable.schemaVersion, "hpi-windows-portable.v3") -or
      -not [StringComparer]::Ordinal.Equals([string]$portable.product, "Hunter Pi") -or
      -not [StringComparer]::Ordinal.Equals([string]$portable.platform, "win32-x64") -or
      -not ($portable.nodeVersion -is [string]) -or
      $portable.nodeVersion -cnotmatch "^\d+\.\d+\.\d+$" -or
      -not ($portable.sourceCommit -is [string]) -or
      $portable.sourceCommit -cnotmatch "^[a-f0-9]{40}$" -or
      -not [StringComparer]::Ordinal.Equals([string]$portable.sourceState, "CLEAN") -or
      -not [StringComparer]::Ordinal.Equals([string]$portable.updateChannel, "developer-preview") -or
      -not [StringComparer]::Ordinal.Equals([string]$portable.installer, "PORTABLE_ZIP") -or
      -not ($portable.signed -is [bool]) -or $portable.signed) {
    throw "Portable manifest is incompatible."
  }
  $releaseId = [string]$portable.releaseId
  $productVersion = [string]$portable.productVersion
  if ($releaseId -cnotmatch "^release_[A-Za-z0-9][A-Za-z0-9.-]*$" -or
      $productVersion -cnotmatch "^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$" -or
      -not [StringComparer]::Ordinal.Equals([string]$portable.engineVersion, "0.84.1") -or
      -not [StringComparer]::Ordinal.Equals([string]$portable.engineReleaseId, "engine-release_pi-0.84.1") -or
      -not [StringComparer]::Ordinal.Equals(
        [string]$portable.engineReleaseFingerprint,
        "sha256:a41dddea11dee5fce40f7f100d99f76fcac88281efc8f067c0f6b57b86fdb27e"
      ) -or
      -not [StringComparer]::Ordinal.Equals([string]$portable.versionDirectory, "versions/$releaseId")) {
    throw "Portable manifest does not bind the fixed release identity."
  }
  foreach ($property in @(
    "engineReleaseFingerprint", "artifactFingerprint", "cliPackageFingerprint",
    "productShellIntegrity", "coreExtensionIntegrity", "nodeRuntimeIntegrity"
  )) {
    Assert-Fingerprint $portable.$property "Portable manifest $property"
  }
  Assert-JsonInteger $portable.artifactByteLength "Portable artifact byte length" 1

  $candidate = Read-StrictReleaseCandidate $candidatePath "Portable release candidate"
  if (-not [StringComparer]::Ordinal.Equals([string]$candidate.releaseId, $releaseId) -or
      -not [StringComparer]::Ordinal.Equals([string]$candidate.productVersion, $productVersion) -or
      -not [StringComparer]::Ordinal.Equals(
        [string]$candidate.artifact.fingerprint,
        [string]$portable.artifactFingerprint
      ) -or
      [long]$candidate.artifact.byteLength -ne [long]$portable.artifactByteLength -or
      -not [StringComparer]::Ordinal.Equals([string]$candidate.engine.releaseId, [string]$portable.engineReleaseId) -or
      -not [StringComparer]::Ordinal.Equals([string]$candidate.engine.fingerprint, [string]$portable.engineReleaseFingerprint) -or
      -not [StringComparer]::Ordinal.Equals([string]$candidate.engine.piVersion, [string]$portable.engineVersion)) {
    throw "Portable manifest and release candidate identities disagree."
  }

  $versionDirectory = Join-Path $Root ("versions\" + $releaseId)
  Assert-PhysicalDirectoryIfPresent $versionDirectory "Release version directory"
  if (-not (Test-Path -LiteralPath $versionDirectory -PathType Container)) {
    throw "Release version directory is missing."
  }
  $installedCandidate = Read-StrictReleaseCandidate (
    Join-Path $versionDirectory ".hpi-candidate.json"
  ) "Installed release candidate"
  if ((ConvertTo-CanonicalJson $installedCandidate) -ne (ConvertTo-CanonicalJson $candidate)) {
    throw "Installed and root release candidates disagree."
  }
  foreach ($artifactPath in @(
    (Join-Path $Root "update.bundle.tgz"),
    (Join-Path $versionDirectory ".hpi-artifact")
  )) {
    if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
      throw "Release artifact is missing."
    }
    $artifactItem = Get-Item -LiteralPath $artifactPath -Force
    if (($artifactItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $artifactItem.Length -ne [long]$candidate.artifact.byteLength -or
        -not [StringComparer]::Ordinal.Equals(
          ("sha256:" + (Get-Sha256Hex $artifactPath)),
          [string]$candidate.artifact.fingerprint
        )) {
      throw "Release artifact bytes do not match the candidate."
    }
  }

  $activeRelease = Read-PortableActiveRelease $Root
  if ($RequireBootstrapActive -and
      (-not [StringComparer]::Ordinal.Equals([string]$activeRelease.ReleaseId, $releaseId) -or
       -not [StringComparer]::Ordinal.Equals([string]$activeRelease.ProductVersion, $productVersion) -or
       -not [StringComparer]::Ordinal.Equals([string]$activeRelease.EngineVersion, [string]$portable.engineVersion))) {
    throw "Portable active pointer does not bind the bootstrap release."
  }

  return [ordered]@{
    ReleaseId = $releaseId
    ProductVersion = $productVersion
    EngineVersion = [string]$portable.engineVersion
    SourceCommit = [string]$portable.sourceCommit
    ProductShellIntegrity = [string]$portable.productShellIntegrity
    CoreExtensionIntegrity = [string]$portable.coreExtensionIntegrity
    Signed = $false
  }
}

function Assert-ExistingInstallerSchema([string]$Root) {
  $manifest = Read-JsonObject (Join-Path $Root "portable-manifest.json") "Existing portable manifest"
  $schemaProperty = @($manifest.PSObject.Properties | Where-Object {
    [StringComparer]::Ordinal.Equals($_.Name, "schemaVersion")
  })
  if ($schemaProperty.Count -ne 1 -or
      -not [StringComparer]::Ordinal.Equals(
        [string]$schemaProperty[0].Value,
        "hpi-windows-portable.v3"
      )) {
    throw "Another Hunter Pi release is active; use hpi update apply instead of overwriting it."
  }
}

function Copy-ReleaseTree([string]$SourceRoot, [string]$DestinationRoot) {
  New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
  foreach ($entry in Get-ChildItem -LiteralPath $SourceRoot -Force) {
    Copy-Item -LiteralPath $entry.FullName -Destination $DestinationRoot -Recurse -Force
  }
}

function Get-StableShimContent() {
  return "@echo off`r`ncall `"%~dp0..\hpi.cmd`" %*`r`nexit /b %errorlevel%`r`n"
}

function Assert-StableBinPhysical([string]$Root, [bool]$RequireShim) {
  Assert-PhysicalDirectoryIfPresent $Root "Installation root"
  $rootFull = (Get-FullPath $Root).TrimEnd("\")
  $bin = Get-FullPath (Join-Path $rootFull "bin")
  if (-not $bin.StartsWith($rootFull + "\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Stable command directory escaped the installation root."
  }
  if (Test-Path -LiteralPath $bin) {
    $binItem = Get-Item -LiteralPath $bin -Force
    if (-not $binItem.PSIsContainer -or
        (($binItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw "Stable command directory must be one physical directory."
    }
  } elseif ($RequireShim) {
    throw "Stable command directory is missing."
  }
  $shim = Join-Path $bin "hpi.cmd"
  if (Test-Path -LiteralPath $shim) {
    $shimItem = Get-Item -LiteralPath $shim -Force
    if ($shimItem.PSIsContainer -or
        (($shimItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw "Stable hpi command must be one physical file."
    }
    if ($RequireShim -and [IO.File]::ReadAllText($shim) -ne (Get-StableShimContent)) {
      throw "Stable hpi command has drifted."
    }
  } elseif ($RequireShim) {
    throw "Stable hpi command is missing."
  }
  return $bin
}

function Write-StableShim([string]$Root) {
  $bin = Assert-StableBinPhysical $Root $false
  if (-not (Test-Path -LiteralPath $bin)) {
    New-Item -ItemType Directory -Path $bin | Out-Null
  }
  $bin = Assert-StableBinPhysical $Root $false
  $shim = Join-Path $bin "hpi.cmd"
  if (Test-Path -LiteralPath $shim) {
    throw "Stable hpi command already exists before initial publication."
  }
  [IO.File]::WriteAllText(
    $shim,
    (Get-StableShimContent),
    (New-Object System.Text.UTF8Encoding($false))
  )
  return Assert-StableBinPhysical $Root $true
}

function Get-NormalizedPathEntry([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return "" }
  return (Get-FullPath $Path.Trim().Trim('"')).TrimEnd("\")
}

function Test-HpiCommandOwnedByStableBin([object]$Command, [string]$StableBin) {
  $pathProperty = $Command.PSObject.Properties["Path"]
  $sourcePath = if ($null -ne $pathProperty -and
      -not [string]::IsNullOrWhiteSpace([string]$pathProperty.Value)) {
    [string]$pathProperty.Value
  } else {
    [string]$Command.Source
  }
  if ([string]::IsNullOrWhiteSpace($sourcePath) -or
      -not [IO.Path]::IsPathRooted($sourcePath)) {
    return $false
  }
  try {
    $commandDirectory = Get-NormalizedPathEntry (Split-Path -Parent (Get-FullPath $sourcePath))
    $stableDirectory = Get-NormalizedPathEntry $StableBin
    return [StringComparer]::OrdinalIgnoreCase.Equals($commandDirectory, $stableDirectory)
  }
  catch {
    return $false
  }
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
    Set-HunterPiUserPath $newPath
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

function Set-HunterPiUserPath([AllowNull()][string]$Value) {
  if ($env:HUNTER_PI_INSTALL_TEST_FAIL_USER_PATH_WRITE -eq "1") {
    throw "Injected user PATH write failure."
  }
  [Environment]::SetEnvironmentVariable("Path", $Value, "User")
}

function Test-NewTerminalUserPath([string]$StableBin) {
  $comparison = [StringComparer]::OrdinalIgnoreCase
  $stable = Get-NormalizedPathEntry $StableBin
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = @($userPath.Split([IO.Path]::PathSeparator) | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_)
  })
  if ($entries.Count -eq 0 -or
      -not $comparison.Equals((Get-NormalizedPathEntry $entries[0]), $stable) -or
      @($entries | Where-Object {
        $comparison.Equals((Get-NormalizedPathEntry $_), $stable)
      }).Count -ne 1) {
    return $false
  }
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $originalProcessPath = $env:Path
  try {
    $env:Path = @($userPath, $machinePath) -join [IO.Path]::PathSeparator
    $wherePath = Join-Path $env:SystemRoot "System32\where.exe"
    $resolved = @(& $wherePath hpi 2>$null)
    if ($LASTEXITCODE -ne 0 -or $resolved.Count -eq 0) { return $false }
    return $comparison.Equals(
      (Get-FullPath ([string]$resolved[0]).Trim()),
      (Get-FullPath (Join-Path $StableBin "hpi.cmd"))
    )
  }
  finally {
    $env:Path = $originalProcessPath
  }
}

function Test-StableCommand([string]$InstallPath, [object]$ExpectedRelease) {
  $shim = Join-Path $InstallPath "bin\hpi.cmd"
  if (-not (Test-Path -LiteralPath $shim -PathType Leaf)) { return $false }
  $output = @(& $shim version --json 2>$null)
  if ($LASTEXITCODE -ne 0 -or $output.Count -eq 0) { return $false }
  try {
    $version = $output[-1] | ConvertFrom-Json
    return $version.product -eq "Hunter Pi" -and
      $version.productVersion -eq $ExpectedRelease.ProductVersion -and
      $version.engine.packageName -eq "@earendil-works/pi-coding-agent" -and
      $version.engine.version -eq $ExpectedRelease.EngineVersion -and
      $version.sourceCommit -eq $ExpectedRelease.SourceCommit -and
      $version.sourceState -eq "CLEAN" -and
      $version.productShellIntegrity -eq $ExpectedRelease.ProductShellIntegrity -and
      $version.coreExtensionIntegrity -eq $ExpectedRelease.CoreExtensionIntegrity -and
      $version.updateChannel -eq "developer-preview"
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
  $sourceInventoryFingerprint = Assert-ReleaseFiles $LocalSource
  $release = Read-PortableRelease $LocalSource
  if ($resolvedSource -eq "Remote" -and $ReleaseTag -ne ("v" + $release.ProductVersion)) {
    throw "Downloaded release does not match ReleaseTag."
  }

  $status = "INSTALLED"
  $newInstallPublished = $false
  if (Test-Path -LiteralPath $InstallRoot) {
    Assert-PhysicalDirectoryIfPresent $InstallRoot "Existing installation"
    Assert-ExistingInstallerSchema $InstallRoot
    $installedBootstrap = Read-PortableRelease $InstallRoot $false
    $installedRelease = Read-PortableActiveRelease $InstallRoot
    if (-not [StringComparer]::Ordinal.Equals([string]$installedRelease.ReleaseId, [string]$release.ReleaseId) -or
        -not [StringComparer]::Ordinal.Equals([string]$installedRelease.ProductVersion, [string]$release.ProductVersion) -or
        -not [StringComparer]::Ordinal.Equals([string]$installedRelease.EngineVersion, [string]$release.EngineVersion) -or
        -not [StringComparer]::Ordinal.Equals([string]$installedBootstrap.SourceCommit, [string]$release.SourceCommit)) {
      throw "A different Hunter Pi release is active; use hpi update apply instead of overwriting it."
    }
    Assert-InstalledPayloadMatches $LocalSource $InstallRoot
    $stableBin = Assert-StableBinPhysical $InstallRoot $true
    if (-not (Test-StableCommand $InstallRoot $release)) {
      throw "Installed hpi command failed its version probe."
    }
    $status = "ALREADY_INSTALLED"
  } else {
    $parent = Split-Path -Parent $InstallRoot
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Assert-PhysicalDirectoryIfPresent $parent "Install parent"
    $stage = Join-Path $parent (".HunterPi-install-" + [guid]::NewGuid().ToString("N"))
    try {
      Copy-ReleaseTree $LocalSource $stage
      $stageInventoryFingerprint = Assert-ReleaseFiles $stage
      if ($stageInventoryFingerprint -ne $sourceInventoryFingerprint) {
        throw "Staged release manifest changed after source verification."
      }
      $stageRelease = Read-PortableRelease $stage
      if ($stageRelease.ReleaseId -ne $release.ReleaseId -or
          $stageRelease.SourceCommit -ne $release.SourceCommit) {
        throw "Staged release identity changed after source verification."
      }
      $stableBin = Write-StableShim $stage
      if (-not (Test-StableCommand $stage $release)) {
        throw "Staged hpi command failed its version probe."
      }
      Move-Item -LiteralPath $stage -Destination $InstallRoot
      $newInstallPublished = $true
      $stableBin = Assert-StableBinPhysical $InstallRoot $true
    }
    finally {
      if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force
      }
    }
  }

  $conflicts = @(Get-Command hpi -All -ErrorAction SilentlyContinue | Where-Object {
    -not (Test-HpiCommandOwnedByStableBin $_ $stableBin)
  })
  $originalProcessPath = $env:Path
  $originalUserPath = if ($PathMode -eq "User") {
    [Environment]::GetEnvironmentVariable("Path", "User")
  } else { $null }
  try {
    $pathChanged = if ($PathMode -eq "None") { $false } else { Update-Path $stableBin $PathMode }
    if ($PathMode -eq "User" -and -not (Test-NewTerminalUserPath $stableBin)) {
      throw "The persisted user PATH does not resolve the installed hpi command in a new terminal."
    }
  }
  catch {
    $pathFailure = $_
    $env:Path = $originalProcessPath
    if ($PathMode -eq "User") {
      try {
        Set-HunterPiUserPath $originalUserPath
      }
      catch {
        # Preserve the original PATH failure while continuing required installation rollback.
      }
    }
    if ($newInstallPublished -and (Test-Path -LiteralPath $InstallRoot)) {
      try {
        Assert-PhysicalDirectoryIfPresent $InstallRoot "Failed installation root"
        Remove-Item -LiteralPath $InstallRoot -Recurse -Force
        $newInstallPublished = $false
      }
      catch {
        throw "PATH update failed and the new installation could not be rolled back."
      }
    }
    throw $pathFailure
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
