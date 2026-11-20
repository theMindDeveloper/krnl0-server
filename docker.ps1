# KRNL0 server with Docker Desktop on Windows, in one command (F28).
#
#   irm https://github.com/theMindDeveloper/krnl0-server/releases/latest/download/docker.ps1 | iex
#
# What it does (read it first if you like):
#   1. checks Docker Desktop and Docker Compose
#   2. downloads compose.yml and env.example and checks them against SHA256SUMS
#   3. writes %USERPROFILE%\krnl0\compose.yml and .env (your address and time zone)
#   4. keeps your data: a server started with "docker run" moves over with its volume
#   5. starts KRNL0 and its updater (one-click updates from the KRNL0 app)
#   6. prints the address and the one-time setup code, and opens it
#
# Run it again any time: it updates the files and keeps your data and settings.
# Options (environment): KRNL0_DIR, KRNL0_HOSTS, TZ, KRNL0_PORT (8443),
# KRNL0_AUTO_UPDATE=on|off, KRNL0_YES=1 (no questions).

& {
# Native commands report through exit codes; in Windows PowerShell 5.1 'Stop' would
# turn Docker's normal stderr output into errors. Cmdlets that matter use -ErrorAction Stop.
$ErrorActionPreference = 'Continue'
$Repo = 'theMindDeveloper/krnl0-server'
$Base = "https://github.com/$Repo/releases/latest/download"
$Dir = if ($env:KRNL0_DIR) { $env:KRNL0_DIR } else { Join-Path $env:USERPROFILE 'krnl0' }
$Port = if ($env:KRNL0_PORT) { $env:KRNL0_PORT } else { '8443' }
$Quiet = $env:KRNL0_YES -eq '1'
$Utf8 = New-Object System.Text.UTF8Encoding $false   # .env and compose.yml without a BOM

function Stop-Install([string]$Message) { Write-Host "krnl0: $Message" -ForegroundColor Red; throw 'KRNL0 install stopped.' }
function Get-Yes([string]$Question, [bool]$Default) {
  if ($Quiet) { return $Default }
  $hint = if ($Default) { '[Y/n]' } else { '[y/N]' }
  $a = Read-Host "$Question $hint"
  if ($a -match '^[Yy]') { return $true }
  if ($a -match '^[Nn]') { return $false }
  return $Default
}
function Test-Docker { & docker @args *> $null; return ($LASTEXITCODE -eq 0) }
function Get-DockerJson { $t = (& docker @args 2>$null) | Out-String; if ($LASTEXITCODE -ne 0 -or -not $t.Trim()) { return $null }; return ($t | ConvertFrom-Json) }

# -- Checks ----------------------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Stop-Install 'Docker Desktop is needed: https://www.docker.com/products/docker-desktop/ - install it, start it, and run this again.'
}
if (-not (Test-Docker info)) { Stop-Install 'Docker Desktop is installed but not running. Start it (wait for "Engine running"), then run this again.' }
if (-not (Test-Docker compose version)) { Stop-Install 'Docker Compose v2 is needed. Update Docker Desktop and run this again.' }

# -- Download and check ----------------------------------------------------
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("krnl0-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Tmp -ErrorAction Stop | Out-Null
try {
  Write-Host 'Downloading the KRNL0 server files...'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  foreach ($f in 'SHA256SUMS', 'compose.yml', 'env.example') {
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/$f" -OutFile (Join-Path $Tmp $f) -ErrorAction Stop
  }
  $sums = Get-Content (Join-Path $Tmp 'SHA256SUMS')
  foreach ($f in 'compose.yml', 'env.example') {
    $line = $sums | Where-Object { $_ -match "^([0-9a-f]{64})[ *]+$([regex]::Escape($f))$" } | Select-Object -First 1
    $want = if ($line) { ($line -split '\s+')[0] } else { '' }
    $have = (Get-FileHash -Algorithm SHA256 (Join-Path $Tmp $f) -ErrorAction Stop).Hash.ToLowerInvariant()
    if (-not $want -or $want -ne $have) { Stop-Install "$f does not match SHA256SUMS: the download is damaged or was changed. Nothing was installed." }
  }

  # -- Your data: keep the volume a server already uses --------------------
  $Volume = 'krnl0-data'
  $OldHosts = ''
  $OldTz = ''
  if (Test-Docker container inspect krnl0) {
    # JSON, not Go templates with quotes: Windows PowerShell drops inner quotes on the way to docker.
    $labels = Get-DockerJson inspect --format '{{json .Config.Labels}}' krnl0
    $mounts = Get-DockerJson inspect --format '{{json .Mounts}}' krnl0
    $project = if ($labels) { [string]$labels.'com.docker.compose.project' } else { '' }
    $used = @($mounts | Where-Object { $_.Destination -eq '/data' } | Select-Object -First 1)
    if ($used.Count -gt 0 -and $used[0].Type -eq 'bind') {
      $src = [string]$used[0].Source
      Write-Host "Your server keeps its data in the folder $src, not in a Docker volume."
      Write-Host 'Copy it into the volume once (the old server stops first), then run this again:'
      Write-Host "  docker stop krnl0; docker run --rm -v `"${src}:/from:ro`" -v krnl0-data:/to alpine sh -c 'cp -a /from/. /to/ && chown -R 1000:1000 /to'"
      Stop-Install 'Stopped. Nothing was changed.'
    }
    if ($used.Count -gt 0 -and $used[0].Name) { $Volume = [string]$used[0].Name }
    # Keep what the old server was reached by: its port, address and time zone.
    $envs = @(Get-DockerJson inspect --format '{{json .Config.Env}}' krnl0)
    $ports = Get-DockerJson inspect --format '{{json .HostConfig.PortBindings}}' krnl0
    if (-not $env:KRNL0_PORT -and $ports -and $ports.'8443/tcp') { $p = [string]@($ports.'8443/tcp')[0].HostPort; if ($p) { $Port = $p } }
    $OldHosts = ($envs | Where-Object { $_ -like 'KRNL0_HOSTS=*' } | Select-Object -First 1)
    $OldTz = ($envs | Where-Object { $_ -like 'TZ=*' } | Select-Object -First 1)
    if ($OldHosts) { $OldHosts = $OldHosts.Substring('KRNL0_HOSTS='.Length) }
    if ($OldTz) { $OldTz = $OldTz.Substring('TZ='.Length) }
    if ($project -ne 'krnl0') {
      Write-Host ''
      Write-Host "A KRNL0 server is already running here (data in the volume $Volume)."
      if (-not (Get-Yes 'Move it to the new setup with one-click updates? Your data stays.' $true)) { Stop-Install 'Stopped. Nothing was changed.' }
      Test-Docker stop krnl0 | Out-Null
      if (-not (Test-Docker rm krnl0)) { Stop-Install 'The old container could not be removed. Remove it in Docker Desktop (the volume stays) and run this again.' }
      Write-Host "Stopped the old container; the volume $Volume is kept."
    }
  } else {
    $hasOld = Test-Docker volume inspect krnl0_krnl0-data
    $hasNew = Test-Docker volume inspect krnl0-data
    if ($hasOld -and -not $hasNew) { $Volume = 'krnl0_krnl0-data' }
  }

  # -- Address, time zone, night updates -----------------------------------
  $Hosts = if ($env:KRNL0_HOSTS) { $env:KRNL0_HOSTS } else { $OldHosts }
  if (-not $Hosts) {
    try {
      $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Sort-Object RouteMetric | Select-Object -First 1
      $Hosts = (Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction Stop | Select-Object -First 1).IPAddress
    } catch { $Hosts = '' }
  }
  $Zone = if ($env:TZ) { $env:TZ } else { $OldTz }
  if (-not $Zone) {
    $win = [System.TimeZoneInfo]::Local.Id
    $iana = $null
    $convert = [System.TimeZoneInfo].GetMethod('TryConvertWindowsIdToIanaId', [type[]]@([string], [string].MakeByRefType()))
    if ($convert) { $out = $null; if ([System.TimeZoneInfo]::TryConvertWindowsIdToIanaId($win, [ref]$out)) { $iana = $out } }
    if (-not $iana) {
      $map = @{
        'W. Europe Standard Time' = 'Europe/Berlin'; 'Central Europe Standard Time' = 'Europe/Prague'; 'Central European Standard Time' = 'Europe/Warsaw'
        'Romance Standard Time' = 'Europe/Paris'; 'GMT Standard Time' = 'Europe/London'; 'E. Europe Standard Time' = 'Europe/Chisinau'
        'FLE Standard Time' = 'Europe/Kiev'; 'GTB Standard Time' = 'Europe/Bucharest'; 'Turkey Standard Time' = 'Europe/Istanbul'
        'Russian Standard Time' = 'Europe/Moscow'; 'Arab Standard Time' = 'Asia/Riyadh'; 'Arabian Standard Time' = 'Asia/Dubai'
        'Egypt Standard Time' = 'Africa/Cairo'; 'Israel Standard Time' = 'Asia/Jerusalem'; 'Jordan Standard Time' = 'Asia/Amman'
        'Syria Standard Time' = 'Asia/Damascus'; 'Middle East Standard Time' = 'Asia/Beirut'; 'India Standard Time' = 'Asia/Kolkata'
        'China Standard Time' = 'Asia/Shanghai'; 'Tokyo Standard Time' = 'Asia/Tokyo'; 'Korea Standard Time' = 'Asia/Seoul'
        'Singapore Standard Time' = 'Asia/Singapore'; 'AUS Eastern Standard Time' = 'Australia/Sydney'; 'New Zealand Standard Time' = 'Pacific/Auckland'
        'Eastern Standard Time' = 'America/New_York'; 'Central Standard Time' = 'America/Chicago'; 'Mountain Standard Time' = 'America/Denver'
        'Pacific Standard Time' = 'America/Los_Angeles'; 'E. South America Standard Time' = 'America/Sao_Paulo'; 'UTC' = 'UTC'
      }
      $iana = $map[$win]
    }
    if (-not $iana -and -not $Quiet) { $iana = Read-Host "Your time zone (like Europe/Berlin) - Windows says '$win'" }
    $Zone = if ($iana) { $iana } else { 'UTC' }
  }
  $EnvFile = Join-Path $Dir '.env'
  $Auto = $env:KRNL0_AUTO_UPDATE
  if (-not $Auto -and (Test-Path $EnvFile)) {
    $line = Get-Content $EnvFile | Where-Object { $_ -match '^KRNL0_AUTO_UPDATE=' } | Select-Object -First 1
    if ($line) { $Auto = $line.Substring('KRNL0_AUTO_UPDATE='.Length) }
  }
  if (-not $Auto) { $Auto = if (Get-Yes 'Update the server by itself at night (04:00), signed releases only?' $false) { 'on' } else { 'off' } }

  # -- Write the files -----------------------------------------------------
  New-Item -ItemType Directory -Force -Path $Dir -ErrorAction Stop | Out-Null
  $Compose = Join-Path $Dir 'compose.yml'
  $newCompose = [System.IO.File]::ReadAllText((Join-Path $Tmp 'compose.yml'))
  if ((Test-Path $Compose) -and ([System.IO.File]::ReadAllText($Compose) -ne $newCompose)) {
    Copy-Item $Compose (Join-Path $Dir ("compose.yml.before-" + (Get-Date -Format 'yyyyMMdd-HHmmss')))
  }
  [System.IO.File]::WriteAllText($Compose, $newCompose, $Utf8)
  $lines = if (Test-Path $EnvFile) { @(Get-Content $EnvFile) } else { @([System.IO.File]::ReadAllLines((Join-Path $Tmp 'env.example'))) }
  $set = [ordered]@{ TZ = $Zone; KRNL0_AUTO_UPDATE = $Auto; KRNL0_VOLUME = $Volume; KRNL0_PUBLISH_PORT = $Port }
  if ($Hosts) { $set['KRNL0_HOSTS'] = $Hosts }
  foreach ($k in $set.Keys) {
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "^$k=") { $lines[$i] = "$k=$($set[$k])"; $found = $true } }
    if (-not $found) { $lines += "$k=$($set[$k])" }
  }
  [System.IO.File]::WriteAllText($EnvFile, (($lines -join "`n") + "`n"), $Utf8)

  # -- Start ---------------------------------------------------------------
  Write-Host 'Starting KRNL0 (the first time downloads about 100 MB)...'
  Push-Location $Dir
  try {
    & docker compose pull --quiet
    if ($LASTEXITCODE -ne 0) { Stop-Install 'Downloading the image did not work. Check the internet connection and run this again.' }
    & docker compose up -d --remove-orphans
    if ($LASTEXITCODE -ne 0) { Stop-Install "Starting did not work. See: docker compose logs (in $Dir)" }
    for ($i = 0; $i -lt 60; $i++) {
      $state = (& docker inspect -f '{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}{{ .State.Status }}{{ end }}' krnl0 2>$null) | Out-String
      if ($state.Trim() -eq 'healthy') { break }
      Start-Sleep -Seconds 2
    }
    $logs = (& docker compose logs krnl0 2>$null) | Out-String
    $code = ([regex]::Matches($logs, '[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{2}') | Select-Object -Last 1).Value
    $hasOwner = Test-Docker exec krnl0 test -f /data/auth/owner.json
  } finally { Pop-Location }

  $hostName = if ($Hosts) { $Hosts } else { 'localhost' }
  $addr = "https://${hostName}:$Port"
  Write-Host ''
  Write-Host 'KRNL0 server is running.' -ForegroundColor Green
  Write-Host "  Open        $addr"
  if ($code -and -not $hasOwner) {
    Write-Host "  Setup code  $code" -ForegroundColor Yellow
    Write-Host ''
    Write-Host "Open the address, continue past the browser's warning once (Advanced, then Continue),"
    Write-Host 'type the setup code and choose your password.'
  }
  Write-Host ''
  Write-Host "Files:    $Dir (compose.yml, .env)"
  Write-Host "Updates:  one click in the KRNL0 app (saved > Update server). At night: $Auto."
  Write-Host 'Status:   docker exec krnl0 krnl0 status'
  Write-Host 'Guide:    https://theminddev.com/krnl0/server.html'
  Write-Host 'Windows may ask once to let Docker accept connections: allow it on private networks so your phone can reach KRNL0.'
  if (-not $Quiet -and -not $hasOwner) { Start-Process $addr }
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
}
