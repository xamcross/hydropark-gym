<#
.SYNOPSIS
  Nuke the local stack (containers + volumes) and bring it back up from scratch.

.DESCRIPTION
  Equivalent to `down.ps1 -Volumes` followed by `up.ps1`. Destroys all local
  Mongo data - use when the replica set gets into a bad state (see
  deploy/README.md Troubleshooting) or you just want a clean slate.
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot

Write-Warning "This destroys all local Mongo data (volumes) and rebuilds the stack from scratch."

& (Join-Path $scriptDir "down.ps1") -Volumes
if ($LASTEXITCODE -ne 0) {
  exit 1
}

if ($SkipBuild) {
  & (Join-Path $scriptDir "up.ps1") -SkipBuild
} else {
  & (Join-Path $scriptDir "up.ps1")
}
exit $LASTEXITCODE
