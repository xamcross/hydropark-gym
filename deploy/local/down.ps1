<#
.SYNOPSIS
  Stop the local Hydropark stack.

.PARAMETER Volumes
  Also remove volumes (`docker compose down -v`) - THIS DESTROYS the local
  Mongo data. Off by default.
#>
[CmdletBinding()]
param(
  [switch]$Volumes
)

$ErrorActionPreference = "Stop"
$deployDir = Split-Path -Parent $PSScriptRoot

Push-Location $deployDir
try {
  if ($Volumes) {
    Write-Warning "Removing volumes too (-Volumes) - this destroys the local Mongo data."
    docker compose down -v
  } else {
    docker compose down
  }
  if ($LASTEXITCODE -ne 0) {
    Write-Error "docker compose down failed."
    exit 1
  }
  Write-Host "Stack stopped." -ForegroundColor Green
  exit 0
} finally {
  Pop-Location
}
