<#
.SYNOPSIS
  Create Hydropark's least-privilege custom roles and database users on MongoDB Atlas.

.DESCRIPTION
  Atlas manages database users and custom roles through its control plane. It
  refuses `db.createRole` / `db.createUser` over the wire even for `atlasAdmin`
  (CMD_NOT_ALLOWED), so deploy/fly/atlas-roles.js - which is the executable
  specification of the split, and what we run against a self-managed mongod to
  verify it with privcheck.js - cannot provision Atlas. This script does the same
  thing through the Atlas Administration API.

  It creates four identities:

    hp_api_user       read/write on everything EXCEPT settled_orders, grants,
                      licenses, license_audit, and the wallet, which it may only
                      read. Deletes only the auth sub-collections and
                      idempotency_keys - never `users`, which the GDPR job
                      anonymizes in place.

    hp_worker_user    the ONLY identity that may write settled_orders + grants.
                      A fully compromised api tier therefore cannot forge a
                      settlement. Also owns the wallet debit.

    hp_issuer_user    read-only on the settlement log it independently re-verifies
                      before signing (§6.2). Writes only licenses + license_audit.

    hp_migrator_user  the ONLY identity that may create or drop an index. Never
                      goes near a Fly app: bootstrap-secrets.ps1 refuses it.

  Verify afterwards with privcheck.js, from each user's own credentials.

.PARAMETER PublicKey
  Atlas API public key. Atlas UI -> Organization -> Access Manager -> API Keys.
  The key needs "Project Owner" on the target project, and your current IP must be
  in the key's API access list.

.PARAMETER PrivateKey
  Atlas API private key (shown once, at creation).

.PARAMETER ProjectId
  Atlas project (group) id. Discovered automatically if the key can list projects.

.PARAMETER ClusterHost
  The cluster host from your SRV string, e.g. hydroparkgym.nymlwxi.mongodb.net.
  Used only to print ready-to-paste connection strings.

.PARAMETER OutFile
  Where to write the four connection strings. Defaults to deploy/.env.atlas,
  which is gitignored. Passwords are generated here and printed nowhere else.

.EXAMPLE
  ./atlas-provision.ps1 -PublicKey abcdefgh -PrivateKey 1234-... -ClusterHost hydroparkgym.nymlwxi.mongodb.net
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $PublicKey,
  [Parameter(Mandatory = $true)][string] $PrivateKey,
  [string] $ProjectId,
  [Parameter(Mandatory = $true)][string] $ClusterHost,
  [string] $DbName = "hydropark",
  [string] $OutFile = "$PSScriptRoot/../.env.atlas"
)

$ErrorActionPreference = "Stop"
$BaseUri = "https://cloud.mongodb.com"
$ApiVersionHeader = "application/vnd.atlas.2023-01-01+json"

# --- Atlas requires HTTP Digest auth. Invoke-RestMethod's -Credential does not
# --- reliably negotiate it on Windows PowerShell 5.1, so drive HttpClient directly.
Add-Type -AssemblyName System.Net.Http
$cache = New-Object System.Net.CredentialCache
$cache.Add([Uri]$BaseUri, "Digest", (New-Object System.Net.NetworkCredential($PublicKey, $PrivateKey)))
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.Credentials = $cache
$http = New-Object System.Net.Http.HttpClient($handler)
$http.Timeout = [TimeSpan]::FromSeconds(60)

function Invoke-Atlas {
  param([string]$Method, [string]$Path, $Body)
  $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::$Method, "$BaseUri$Path")
  $req.Headers.Accept.ParseAdd($ApiVersionHeader)
  if ($null -ne $Body) {
    $json = $Body | ConvertTo-Json -Depth 12 -Compress
    $req.Content = New-Object System.Net.Http.StringContent($json, [Text.Encoding]::UTF8, "application/json")
    $req.Content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($ApiVersionHeader)
  }
  $res = $http.SendAsync($req).GetAwaiter().GetResult()
  $text = $res.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  if (-not $res.IsSuccessStatusCode) {
    throw "Atlas API $Method $Path -> $([int]$res.StatusCode): $text"
  }
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  return $text | ConvertFrom-Json
}

# --- Collections. Mirrors atlas-roles.js exactly. -----------------------------
$AUTH       = @("users","oauth_identities","refresh_tokens","email_verification_tokens","password_reset_tokens","step_up_challenges")
$CATALOG    = @("skills","skill_versions","bundles","bundle_members","regional_prices")
$ORDERS     = @("orders","webhook_events","idempotency_keys")
$SETTLEMENT = @("settled_orders","grants")
$LICENSING  = @("licenses","license_audit")
$DEVICES    = @("devices","device_slot_counters")
$WALLET     = @("wallet_accounts","wallet_transactions")
$SYSTEM     = @("schema_migrations","schema_migrations_lock")
$ALL        = $AUTH + $CATALOG + $ORDERS + $SETTLEMENT + $LICENSING + $DEVICES + $WALLET

# api deletes only these; never `users` (anonymized in place, not dropped).
$API_DELETABLE = ($AUTH | Where-Object { $_ -ne "users" }) + @("idempotency_keys")
# api reads but never writes these.
$API_READ_ONLY = $SETTLEMENT + $LICENSING + $WALLET

# Atlas names privilege actions in CAPS.
$RW      = @("FIND","INSERT","UPDATE")
$RWDEL   = $RW + @("REMOVE")
$RO      = @("FIND")
$MIGRATE = @("FIND","INSERT","UPDATE","REMOVE","CREATE_INDEX","DROP_INDEX","LIST_INDEXES","CREATE_COLLECTION","COLL_STATS")

# Atlas wants role definitions grouped BY ACTION, each listing its resources -
# the inverse of mongosh's grouped-by-resource shape. Build that inversion here.
function New-Role {
  param([string]$RoleName, [hashtable]$CollectionsByAction)
  $byAction = @{}
  foreach ($collections in $CollectionsByAction.Keys) {
    foreach ($action in $CollectionsByAction[$collections]) {
      if (-not $byAction.ContainsKey($action)) { $byAction[$action] = New-Object System.Collections.Generic.List[string] }
      foreach ($c in ($collections -split ',')) { $byAction[$action].Add($c) }
    }
  }
  $actions = @()
  foreach ($a in ($byAction.Keys | Sort-Object)) {
    $actions += @{
      action    = $a
      resources = @($byAction[$a] | Sort-Object -Unique | ForEach-Object { @{ db = $DbName; collection = $_ } })
    }
  }
  return @{ roleName = $RoleName; actions = $actions; inheritedRoles = @() }
}

function New-Grant([string[]]$collections, [string[]]$actions) { return @{ ($collections -join ",") = $actions } }

function Merge([hashtable[]]$maps) {
  $out = @{}
  foreach ($m in $maps) { foreach ($k in $m.Keys) { $out[$k] = $m[$k] } }
  return $out
}

$apiRwCollections = $ALL | Where-Object { $API_READ_ONLY -notcontains $_ -and $API_DELETABLE -notcontains $_ }

$roles = @(
  (New-Role "hp_api" (Merge @(
      (New-Grant $apiRwCollections $RW),
      (New-Grant $API_DELETABLE   $RWDEL),
      (New-Grant $API_READ_ONLY   $RO)))),
  (New-Role "hp_worker" (Merge @(
      (New-Grant ($SETTLEMENT + $WALLET + $ORDERS) $RW),
      (New-Grant $CATALOG $RO)))),
  (New-Role "hp_issuer" (Merge @(
      (New-Grant ($SETTLEMENT + $DEVICES) $RO),
      (New-Grant $LICENSING $RW)))),
  (New-Role "hp_migrator" (New-Grant ($ALL + $SYSTEM) $MIGRATE))
)

# --- Discover the project if not supplied. ------------------------------------
if ([string]::IsNullOrWhiteSpace($ProjectId)) {
  $groups = Invoke-Atlas GET "/api/atlas/v2/groups"
  if ($groups.results.Count -eq 0) { throw "The API key can see no projects. Grant it Project Owner on the target project." }
  if ($groups.results.Count -gt 1) {
    Write-Host "Multiple projects visible; pass -ProjectId explicitly:" -ForegroundColor Yellow
    $groups.results | ForEach-Object { Write-Host "  $($_.id)  $($_.name)" }
    throw "ambiguous project"
  }
  $ProjectId = $groups.results[0].id
  Write-Host "Project: $($groups.results[0].name) ($ProjectId)"
}

# --- Roles: delete then create, so re-running converges. ----------------------
foreach ($role in $roles) {
  try { Invoke-Atlas DELETE "/api/atlas/v2/groups/$ProjectId/customDBRoles/roles/$($role.roleName)" $null | Out-Null } catch { }
  Invoke-Atlas POST "/api/atlas/v2/groups/$ProjectId/customDBRoles/roles" $role | Out-Null
  Write-Host "  role  $($role.roleName)  ($($role.actions.Count) distinct actions)" -ForegroundColor Green
}

# --- Users. Passwords are generated here and written only to $OutFile. --------
function New-Password {
  $bytes = New-Object byte[] 30
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  # Keep it URI-safe: no reserved characters to percent-encode in a connection string.
  return ([Convert]::ToBase64String($bytes) -replace '[+/=]', '').Substring(0, 32)
}

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# Generated by atlas-provision.ps1. Secrets. Never commit. Never set MONGODB_URI_MIGRATOR on a Fly app.")

$userMap = @{ "hp_api_user" = "hp_api"; "hp_worker_user" = "hp_worker"; "hp_issuer_user" = "hp_issuer"; "hp_migrator_user" = "hp_migrator" }
$envMap  = @{ "hp_api_user" = "MONGODB_URI_API"; "hp_worker_user" = "MONGODB_URI_WORKER"; "hp_issuer_user" = "MONGODB_URI_ISSUER"; "hp_migrator_user" = "MONGODB_URI_MIGRATOR" }

foreach ($user in @("hp_api_user","hp_worker_user","hp_issuer_user","hp_migrator_user")) {
  $pw = New-Password
  try { Invoke-Atlas DELETE "/api/atlas/v2/groups/$ProjectId/databaseUsers/admin/$user" $null | Out-Null } catch { }
  $body = @{
    databaseName = "admin"
    username     = $user
    password     = $pw
    roles        = @(@{ databaseName = $DbName; roleName = $userMap[$user] })
    scopes       = @()
  }
  Invoke-Atlas POST "/api/atlas/v2/groups/$ProjectId/databaseUsers" $body | Out-Null
  $uri = "mongodb+srv://$($user):$pw@$ClusterHost/$DbName" + "?retryWrites=true&w=majority"
  $lines.Add("$($envMap[$user])=$uri")
  Write-Host "  user  $user  (role: $($userMap[$user]))" -ForegroundColor Green
}

[IO.File]::WriteAllLines($OutFile, $lines, (New-Object Text.UTF8Encoding $false))

Write-Host ""
Write-Host "Wrote four connection strings to $OutFile (gitignored)." -ForegroundColor Cyan
Write-Host "Atlas needs a moment to apply new users; then verify the split actually holds:"
Write-Host "  mongosh '<hp_api_user uri>'    --eval `"var ROLE='hp_api'`"    --file privcheck.js"
Write-Host "  mongosh '<hp_worker_user uri>' --eval `"var ROLE='hp_worker'`" --file privcheck.js"
Write-Host "  mongosh '<hp_issuer_user uri>' --eval `"var ROLE='hp_issuer'`" --file privcheck.js"
Write-Host ""
Write-Host "Every line must read PASS. Then delete the temporary atlasAdmin user." -ForegroundColor Yellow
