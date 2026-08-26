[CmdletBinding()]
param(
    [string]$ApiUrl,
    [switch]$Tunnel
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-UsableLanIPv4 {
    param(
        [Parameter(Mandatory)]
        [string]$Address
    )

    $parsedAddress = $null

    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsedAddress)) {
        return $false
    }

    if ($parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        return $false
    }

    $octets = $parsedAddress.GetAddressBytes()

    return $octets[0] -ne 0 -and
        $octets[0] -ne 127 -and
        $octets[0] -lt 224 -and
        -not ($octets[0] -eq 169 -and $octets[1] -eq 254)
}

function Get-PreferredLanIPv4 {
    $virtualAdapterPattern = '(?i)(docker|wsl|vethernet|hyper-v|virtual|vmware|virtualbox|loopback|tunnel|tap|vpn|tailscale|zerotier)'
    $preferredAdapterPattern = '(?i)(wi-?fi|wireless|wlan|ethernet)'
    $candidates = @()

    try {
        $configurations = Get-NetIPConfiguration -ErrorAction Stop
    }
    catch {
        throw "Unable to inspect Windows network adapters: $($_.Exception.Message)"
    }

    foreach ($configuration in $configurations) {
        $adapterText = "$($configuration.InterfaceAlias) $($configuration.InterfaceDescription)"

        if ($adapterText -match $virtualAdapterPattern) {
            continue
        }

        if ($configuration.NetAdapter -and $configuration.NetAdapter.Status -ne "Up") {
            continue
        }

        foreach ($addressEntry in @($configuration.IPv4Address)) {
            $address = [string]$addressEntry.IPAddress

            if (-not (Test-UsableLanIPv4 -Address $address)) {
                continue
            }

            $score = 0

            if ($configuration.IPv4DefaultGateway) {
                $score += 100
            }

            if ($adapterText -match $preferredAdapterPattern) {
                $score += 50
            }

            if ($configuration.NetAdapter -and $configuration.NetAdapter.HardwareInterface) {
                $score += 25
            }

            $metric = [int]::MaxValue

            if (
                $configuration.NetIPv4Interface -and
                $null -ne $configuration.NetIPv4Interface.InterfaceMetric
            ) {
                $metric = [int]$configuration.NetIPv4Interface.InterfaceMetric
            }

            $candidates += [PSCustomObject]@{
                Address = $address
                Score   = $score
                Metric  = $metric
            }
        }
    }

    $selected = $candidates |
        Sort-Object `
            -Property `
                @{ Expression = "Score"; Descending = $true },
                @{ Expression = "Metric"; Ascending = $true } |
        Select-Object -First 1

    if (-not $selected) {
        throw "No suitable LAN IPv4 address was found. Connect this PC to Wi-Fi or Ethernet, or pass -ApiUrl with a reachable public URL."
    }

    return $selected.Address
}

# Resolve API URL
if ($PSBoundParameters.ContainsKey("ApiUrl")) {
    $selectedApiUrl = $ApiUrl.Trim().TrimEnd("/")

    if ([string]::IsNullOrWhiteSpace($selectedApiUrl)) {
        throw "-ApiUrl cannot be empty."
    }
}
else {
    $lanAddress = Get-PreferredLanIPv4
    $selectedApiUrl = "http://${lanAddress}:8000"
}

# Validate API URL
$parsedApiUrl = $null

if (
    -not [System.Uri]::TryCreate(
        $selectedApiUrl,
        [System.UriKind]::Absolute,
        [ref]$parsedApiUrl
    ) -or
    $parsedApiUrl.Scheme -notin @("http", "https")
) {
    throw "Invalid API URL '$selectedApiUrl'. Supply an absolute HTTP or HTTPS URL."
}

# Check Docker
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker was not found. Install or start Docker Desktop and ensure 'docker' is available in PATH."
}

# Mobile project paths
$mobileDirectory = Join-Path $PSScriptRoot "mobile"
$mobilePackage = Join-Path $mobileDirectory "package.json"

if (-not (Test-Path -LiteralPath $mobilePackage -PathType Leaf)) {
    throw "Mobile package file was not found at '$mobilePackage'."
}

# Check Node.js
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw "Node.js was not found. Install Node.js and ensure 'node' is available in PATH."
}

# Check npm
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw "npm was not found. Install Node.js and ensure 'npm' is available in PATH."
}

# Check npx
$npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue

if (-not $npxCommand) {
    throw "npx was not found. Install Node.js and ensure 'npx' is available in PATH."
}

# Save original shell state
$originalLocation = Get-Location
$hadOriginalApiUrl = Test-Path Env:EXPO_PUBLIC_API_BASE_URL
$originalApiUrl = $env:EXPO_PUBLIC_API_BASE_URL

$dockerStarted = $false

try {
    # Set API URL for Expo
    $env:EXPO_PUBLIC_API_BASE_URL = $selectedApiUrl

    Write-Host ""
    Write-Host "========================================"
    Write-Host "          Fridge9000 Launcher"
    Write-Host "========================================"
    Write-Host ""
    Write-Host "Using Expo API URL: $env:EXPO_PUBLIC_API_BASE_URL"
    Write-Host ""

    # Start backend + database
    Set-Location $PSScriptRoot

    Write-Host "Starting Fridge9000 database and backend..."

    & docker compose up --build --detach --wait

    if ($LASTEXITCODE -ne 0) {
        throw "docker compose exited with code $LASTEXITCODE."
    }

    $dockerStarted = $true

    Write-Host ""
    Write-Host "Backend and database are running."
    Write-Host ""
    Write-Host "Press Ctrl+C to stop Fridge9000."
    Write-Host ""

    # Start Expo
    Set-Location $mobileDirectory

    if ($Tunnel) {
        Write-Host "Starting Expo in tunnel mode..."
        Write-Host ""

        & $npxCommand.Name expo start --tunnel
    }
    else {
        Write-Host "Starting Expo in LAN mode..."
        Write-Host ""

        & $npxCommand.Name expo start
    }

    if ($LASTEXITCODE -ne 0) {
        throw "Expo exited with code $LASTEXITCODE."
    }
}
finally {
    Write-Host ""
    Write-Host "========================================"
    Write-Host "       Shutting down Fridge9000"
    Write-Host "========================================"
    Write-Host ""

    # Shut down Docker only if it successfully started
    if ($dockerStarted) {
        try {
            Set-Location $PSScriptRoot

            Write-Host "Stopping backend and database..."

            & docker compose down

            if ($LASTEXITCODE -ne 0) {
                Write-Warning "Docker Compose shutdown returned exit code $LASTEXITCODE."
            }
            else {
                Write-Host "Backend and database stopped."
            }
        }
        catch {
            Write-Warning "Failed to shut down Docker Compose cleanly: $($_.Exception.Message)"
        }
    }

    # Restore original working directory
    Set-Location $originalLocation

    # Restore original environment variable
    if ($hadOriginalApiUrl) {
        $env:EXPO_PUBLIC_API_BASE_URL = $originalApiUrl
    }
    else {
        Remove-Item Env:EXPO_PUBLIC_API_BASE_URL -ErrorAction SilentlyContinue
    }

    Write-Host ""
    Write-Host "Fridge9000 stopped."
}