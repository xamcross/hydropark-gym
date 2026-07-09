<#
.SYNOPSIS
  Smoke-test the local stack: GET /actuator/health and GET /v1/catalog must
  both return 200, health must report UP, and the catalog must be non-empty.

.PARAMETER BaseUrl
  Defaults to http://localhost:8080 (api's published port).
#>
[CmdletBinding()]
param(
  [string]$BaseUrl = "http://localhost:8080"
)

$ErrorActionPreference = "Continue"
$failed = $false

Write-Host "==> GET $BaseUrl/actuator/health" -ForegroundColor Cyan
try {
  $health = Invoke-RestMethod -Uri "$BaseUrl/actuator/health" -Method Get -TimeoutSec 5
  if ($health.status -ne "UP") {
    Write-Host "    FAIL - status is '$($health.status)', expected UP" -ForegroundColor Red
    $failed = $true
  } else {
    Write-Host "    OK - status=UP" -ForegroundColor Green
  }
} catch {
  Write-Host "    FAIL - request failed: $($_.Exception.Message)" -ForegroundColor Red
  $failed = $true
}

Write-Host "==> GET $BaseUrl/v1/catalog" -ForegroundColor Cyan
try {
  $resp = Invoke-WebRequest -Uri "$BaseUrl/v1/catalog" -Method Get -TimeoutSec 5 -UseBasicParsing
  if ($resp.StatusCode -ne 200) {
    Write-Host "    FAIL - HTTP $($resp.StatusCode), expected 200" -ForegroundColor Red
    $failed = $true
  } else {
    $catalog = $resp.Content | ConvertFrom-Json
    # Response shape: accept either a bare JSON array or an { items: [...] }
    # / CursorPage-style envelope (io.hydropark.common.CursorPage) - the
    # catalog package's exact wire shape isn't this script's concern.
    $items = $catalog
    if ($null -ne $catalog.items) {
      $items = $catalog.items
    }
    $count = @($items).Count
    if ($null -eq $items -or $count -eq 0) {
      Write-Host "    FAIL - HTTP 200 but no catalog items in the response" -ForegroundColor Red
      $failed = $true
    } else {
      Write-Host "    OK - $count item(s)" -ForegroundColor Green
    }
  }
} catch {
  Write-Host "    FAIL - request failed: $($_.Exception.Message)" -ForegroundColor Red
  $failed = $true
}

Write-Host ""
if ($failed) {
  Write-Host "SMOKE TEST FAILED" -ForegroundColor Red
  exit 1
} else {
  Write-Host "SMOKE TEST PASSED" -ForegroundColor Green
  exit 0
}
