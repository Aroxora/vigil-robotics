<#
.SYNOPSIS
Installs or configures Ghidra for Vigil headless analysis on Windows.

.DESCRIPTION
The script prefers an existing local Ghidra install such as C:\ghidra_12.1_PUBLIC.
If none is found, it downloads a public Ghidra release zip from the NSA GitHub
release feed, expands it under the current user's profile, and writes
~\.vigil\ghidra.json for Vigil's Node and MCP integrations.
#>
[CmdletBinding()]
param(
  [string]$Version = $(if ($env:VIGIL_GHIDRA_VERSION) { $env:VIGIL_GHIDRA_VERSION } else { '12.1' }),
  [string]$InstallRoot = $(if ($env:VIGIL_GHIDRA_INSTALL_ROOT) { $env:VIGIL_GHIDRA_INSTALL_ROOT } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Vigil\Tools' } else { Join-Path $HOME '.vigil\tools' }),
  [string]$ExistingInstall = $(if ($env:GHIDRA_INSTALL_DIR) { $env:GHIDRA_INSTALL_DIR } elseif ($env:GHIDRA_HOME) { $env:GHIDRA_HOME } else { '' }),
  [switch]$ConfigureOnly,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Test-GhidraInstall {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  return Test-Path -LiteralPath (Join-Path $Path 'support\analyzeHeadless.bat')
}

function Get-GhidraVersion {
  param([string]$Path)
  $bom = Join-Path $Path 'bom.json'
  if (Test-Path -LiteralPath $bom) {
    try {
      $json = Get-Content -Raw -LiteralPath $bom | ConvertFrom-Json
      $component = $json.components | Where-Object { $_.group -eq 'ghidra' -and $_.version } | Select-Object -First 1
      if ($component.version) { return $component.version }
    } catch {
      # Fall back to directory name below.
    }
  }
  if ((Split-Path -Leaf $Path) -match 'ghidra[_-]([0-9.]+)[_-]PUBLIC') { return $Matches[1] }
  return $null
}

function Write-VigilGhidraConfig {
  param(
    [string]$InstallDir,
    [string]$Source
  )
  $vigilHome = if ($env:VIGIL_HOME) { $env:VIGIL_HOME } else { Join-Path $HOME '.vigil' }
  New-Item -ItemType Directory -Force -Path $vigilHome | Out-Null
  $configPath = Join-Path $vigilHome 'ghidra.json'
  $config = [ordered]@{
    installDir = $InstallDir
    analyzeHeadless = Join-Path $InstallDir 'support\analyzeHeadless.bat'
    version = Get-GhidraVersion -Path $InstallDir
    source = $Source
    configuredAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  $config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $configPath -Encoding UTF8
  return $configPath
}

function Find-ExistingGhidra {
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($ExistingInstall) { $candidates.Add($ExistingInstall) }
  if ($env:VIGIL_GHIDRA_HOME) { $candidates.Add($env:VIGIL_GHIDRA_HOME) }
  $candidates.Add("C:\ghidra_${Version}_PUBLIC")
  $candidates.Add('C:\ghidra_12.1_PUBLIC')
  $candidates.Add('C:\ghidra')
  if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA "Vigil\Tools\ghidra_${Version}_PUBLIC")) }
  if ($env:USERPROFILE) { $candidates.Add((Join-Path $env:USERPROFILE "ghidra_${Version}_PUBLIC")) }

  try {
    Get-ChildItem -LiteralPath 'C:\' -Directory -Filter 'ghidra_*_PUBLIC' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      ForEach-Object { $candidates.Add($_.FullName) }
  } catch {
    # Ignore root enumeration failures.
  }

  foreach ($candidate in $candidates) {
    if (Test-GhidraInstall -Path $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  return $null
}

function Get-GhidraReleaseAsset {
  param([string]$RequestedVersion)
  $headers = @{ 'User-Agent' = 'vigil-ghidra-installer' }
  $releases = Invoke-RestMethod -Headers $headers -Uri 'https://api.github.com/repos/NationalSecurityAgency/ghidra/releases?per_page=100'
  foreach ($release in $releases) {
    $releaseText = "$($release.tag_name) $($release.name)"
    if ($RequestedVersion -ne 'latest' -and $releaseText -notmatch [regex]::Escape($RequestedVersion)) {
      continue
    }
    $asset = $release.assets |
      Where-Object { $_.name -match '^ghidra_.*_PUBLIC.*\.zip$' } |
      Select-Object -First 1
    if ($asset) { return $asset }
  }
  if ($RequestedVersion -ne 'latest') {
    throw "Could not find a Ghidra $RequestedVersion public zip asset in the GitHub release feed."
  }
  throw 'Could not find a Ghidra public zip asset in the GitHub release feed.'
}

$existing = Find-ExistingGhidra
if ($existing -and -not $Force) {
  $configPath = Write-VigilGhidraConfig -InstallDir $existing -Source 'existing-install'
  Write-Host "Configured Ghidra for Vigil: $existing"
  Write-Host "Config: $configPath"
  exit 0
}

if ($ConfigureOnly) {
  throw 'No existing Ghidra install was found, and -ConfigureOnly was set.'
}

if ($PSVersionTable.PSEdition -eq 'Desktop') {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
$asset = Get-GhidraReleaseAsset -RequestedVersion $Version
$zipPath = Join-Path ([IO.Path]::GetTempPath()) $asset.name

Write-Host "Downloading $($asset.name)"
Invoke-WebRequest -Headers @{ 'User-Agent' = 'vigil-ghidra-installer' } -Uri $asset.browser_download_url -OutFile $zipPath

Write-Host "Extracting to $InstallRoot"
Expand-Archive -LiteralPath $zipPath -DestinationPath $InstallRoot -Force

$installDir = Get-ChildItem -LiteralPath $InstallRoot -Directory -Filter 'ghidra_*_PUBLIC' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 -ExpandProperty FullName

if (-not (Test-GhidraInstall -Path $installDir)) {
  throw "Downloaded Ghidra, but analyzeHeadless.bat was not found under $InstallRoot."
}

$configPath = Write-VigilGhidraConfig -InstallDir $installDir -Source $asset.browser_download_url
Write-Host "Installed Ghidra for Vigil: $installDir"
Write-Host "Config: $configPath"
