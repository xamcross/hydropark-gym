<#
.SYNOPSIS
  Tail logs from the local stack.

.PARAMETER Service
  Limit to one service (mongo, mongo-init, migrate, api, issuer, worker,
  mongo-express). Omit for all services.

.PARAMETER Tail
  Number of historical lines to show before following. Default 200.

.PARAMETER NoFollow
  Print the last N lines and exit instead of following.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Service = "",
  [int]$Tail = 200,
  [switch]$NoFollow
)

$ErrorActionPreference = "Stop"
$deployDir = Split-Path -Parent $PSScriptRoot

Push-Location $deployDir
try {
  $composeArgs = @("logs", "--tail=$Tail")
  if (-not $NoFollow) {
    $composeArgs += "-f"
  }
  if ($Service) {
    $composeArgs += $Service
  }
  & docker compose @composeArgs
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
