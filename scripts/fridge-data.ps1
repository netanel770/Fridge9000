[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet("Export", "Import")]
    [string]$Mode,

    # Required for Import.
    [string]$Archive,

    # Export destination. Defaults to the parent of the repo.
    [string]$OutputDirectory,

    # Import overwrites the target development DB/data.
    [switch]$ConfirmImport
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDirectory "..")).Path

$DbContainer = "fridge9000-db"
$DbUser = "fridge"
$DbName = "fridge9000"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message"
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)]
        [scriptblock]$Command,

        [Parameter(Mandatory)]
        [string]$Description
    )

    & $Command

    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

function Assert-Repo {
    $composePath = Join-Path $RepoRoot "docker-compose.yml"

    if (-not (Test-Path $composePath)) {
        throw "docker-compose.yml was not found at $RepoRoot. Run this script from the Fridge9000 repository."
    }
}

function Assert-Docker {
    Invoke-Checked {
        docker version *> $null
    } "Docker check"
}

function Ensure-Directory {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Copy-DirectoryIfExists {
    param(
        [string]$Source,
        [string]$Destination
    )

    if (-not (Test-Path $Source)) {
        Write-Host "Skipping missing path: $Source"
        return
    }

    Ensure-Directory (Split-Path -Parent $Destination)

    Copy-Item `
        -Path $Source `
        -Destination $Destination `
        -Recurse `
        -Force
}

function Export-FridgeData {
    Assert-Repo
    Assert-Docker

    Push-Location $RepoRoot

    try {
        Write-Step "Checking current Git state"

        $branch = (git branch --show-current).Trim()
        $commit = (git rev-parse HEAD).Trim()

        Write-Host "Branch: $branch"
        Write-Host "Commit: $commit"

        if (-not $OutputDirectory) {
            $destinationRoot = Split-Path -Parent $RepoRoot
        }
        else {
            $destinationRoot = $OutputDirectory
        }

        Ensure-Directory $destinationRoot

        $timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
        $backupName = "fridge9000-backup-$timestamp"

        $workingDirectory = Join-Path $destinationRoot $backupName
        $archivePath = Join-Path $destinationRoot "$backupName.zip"

        if (Test-Path $workingDirectory) {
            Remove-Item $workingDirectory -Recurse -Force
        }

        if (Test-Path $archivePath) {
            Remove-Item $archivePath -Force
        }

        Ensure-Directory $workingDirectory
        Ensure-Directory (Join-Path $workingDirectory "backend")

        Write-Step "Stopping Fridge backend"

        Invoke-Checked {
            docker compose stop backend
        } "Stopping backend"

        Write-Step "Starting PostgreSQL if necessary"

        Invoke-Checked {
            docker compose up -d db
        } "Starting PostgreSQL"

        Write-Step "Waiting for PostgreSQL"

        $healthy = $false

        for ($attempt = 1; $attempt -le 30; $attempt++) {
            docker exec $DbContainer `
                pg_isready `
                -U $DbUser `
                -d $DbName *> $null

            if ($LASTEXITCODE -eq 0) {
                $healthy = $true
                break
            }

            Start-Sleep -Seconds 2
        }

        if (-not $healthy) {
            throw "PostgreSQL did not become ready."
        }

        Write-Step "Creating PostgreSQL dump"

        $containerDump = "/tmp/fridge9000-backup.dump"
        $localDump = Join-Path $workingDirectory "fridge9000.dump"

        Invoke-Checked {
            docker exec $DbContainer `
                pg_dump `
                -U $DbUser `
                -d $DbName `
                -Fc `
                -f $containerDump
        } "PostgreSQL backup"

        Invoke-Checked {
            docker cp "${DbContainer}:$containerDump" $localDump
        } "Copying PostgreSQL backup"

        docker exec $DbContainer rm -f $containerDump *> $null

        Write-Step "Copying Fridge runtime data"

        $runtimeDirectories = @(
            "uploads",
            "candidate_models",
            "dataset_exports",
            "model_comparisons",
            "base_dataset",
            "remote_training_jobs"
        )

        foreach ($directory in $runtimeDirectories) {
            $source = Join-Path $RepoRoot "backend\$directory"
            $destination = Join-Path $workingDirectory "backend\$directory"

            Copy-DirectoryIfExists $source $destination
        }

        $envFile = Join-Path $RepoRoot ".env"

        if (Test-Path $envFile) {
            Copy-Item `
                $envFile `
                (Join-Path $workingDirectory ".env") `
                -Force
        }
        else {
            Write-Host "No .env file found. Skipping it."
        }

        Write-Step "Writing backup manifest"

        $manifest = [ordered]@{
            format_version = 1
            created_at = (Get-Date).ToString("o")
            branch = $branch
            commit = $commit
            database = $DbName
            database_container = $DbContainer
            computer = $env:COMPUTERNAME
            included_runtime_directories = $runtimeDirectories
        }

        $manifest |
            ConvertTo-Json -Depth 5 |
            Set-Content `
                -Path (Join-Path $workingDirectory "manifest.json") `
                -Encoding UTF8

        Write-Step "Creating archive"

        Compress-Archive `
            -Path (Join-Path $workingDirectory "*") `
            -DestinationPath $archivePath `
            -CompressionLevel Optimal

        if (-not (Test-Path $archivePath)) {
            throw "Backup archive was not created."
        }

        $sizeMb = [math]::Round(
            (Get-Item $archivePath).Length / 1MB,
            2
        )

        Remove-Item $workingDirectory -Recurse -Force

        Write-Step "Backup completed"

        Write-Host "Archive: $archivePath"
        Write-Host "Size:    $sizeMb MB"
        Write-Host ""
        Write-Host "Copy this ZIP to the laptop."
        Write-Host ""
        Write-Host "Your backend was intentionally left stopped."
    }
    finally {
        Pop-Location
    }
}

function Import-FridgeData {
    Assert-Repo
    Assert-Docker

    if (-not $Archive) {
        throw "Import requires -Archive <path-to-backup.zip>."
    }

    if (-not $ConfirmImport) {
        throw @"
Import replaces the target Fridge9000 development database and runtime data.

Run again with:

-ConfirmImport

after confirming this is the correct laptop/repository.
"@
    }

    $resolvedArchive = (Resolve-Path $Archive).Path

    Push-Location $RepoRoot

    $tempDirectory = Join-Path `
        ([System.IO.Path]::GetTempPath()) `
        ("fridge9000-import-" + [guid]::NewGuid().ToString("N"))

    try {
        Write-Step "Extracting backup"

        Ensure-Directory $tempDirectory

        Expand-Archive `
            -Path $resolvedArchive `
            -DestinationPath $tempDirectory `
            -Force

        $dumpPath = Join-Path $tempDirectory "fridge9000.dump"

        if (-not (Test-Path $dumpPath)) {
            throw "fridge9000.dump was not found in the backup."
        }

        $manifestPath = Join-Path $tempDirectory "manifest.json"

        if (Test-Path $manifestPath) {
            $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

            Write-Host "Backup created: $($manifest.created_at)"
            Write-Host "Source branch:  $($manifest.branch)"
            Write-Host "Source commit:  $($manifest.commit)"
        }

        Write-Step "Stopping Fridge services"

        docker compose stop backend *> $null

        Write-Step "Starting target PostgreSQL"

        Invoke-Checked {
            docker compose up -d db
        } "Starting PostgreSQL"

        $healthy = $false

        for ($attempt = 1; $attempt -le 30; $attempt++) {
            docker exec $DbContainer `
                pg_isready `
                -U $DbUser `
                -d $DbName *> $null

            if ($LASTEXITCODE -eq 0) {
                $healthy = $true
                break
            }

            Start-Sleep -Seconds 2
        }

        if (-not $healthy) {
            throw "PostgreSQL did not become ready."
        }

        Write-Step "Restoring PostgreSQL database"

        $containerDump = "/tmp/fridge9000-restore.dump"

        Invoke-Checked {
            docker cp $dumpPath "${DbContainer}:$containerDump"
        } "Copying database dump into PostgreSQL container"

        Invoke-Checked {
            docker exec $DbContainer `
                pg_restore `
                -U $DbUser `
                -d $DbName `
                --clean `
                --if-exists `
                --no-owner `
                $containerDump
        } "Restoring PostgreSQL database"

        docker exec $DbContainer rm -f $containerDump *> $null

        Write-Step "Restoring runtime files"

        $runtimeDirectories = @(
            "uploads",
            "candidate_models",
            "dataset_exports",
            "model_comparisons",
            "base_dataset",
            "remote_training_jobs"
        )

        foreach ($directory in $runtimeDirectories) {
            $source = Join-Path $tempDirectory "backend\$directory"

            if (-not (Test-Path $source)) {
                continue
            }

            $destination = Join-Path $RepoRoot "backend\$directory"

            if (Test-Path $destination) {
                Remove-Item $destination -Recurse -Force
            }

            Copy-Item `
                $source `
                $destination `
                -Recurse `
                -Force
        }

        $backupEnv = Join-Path $tempDirectory ".env"

        if (Test-Path $backupEnv) {
            Copy-Item `
                $backupEnv `
                (Join-Path $RepoRoot ".env") `
                -Force
        }

        Write-Step "Starting Fridge9000"

        Invoke-Checked {
            docker compose up -d --build
        } "Starting Fridge9000"

        Write-Step "Checking database"

        Invoke-Checked {
            docker exec $DbContainer `
                psql `
                -U $DbUser `
                -d $DbName `
                -c "SELECT COUNT(*) AS model_versions FROM model_versions;"
        } "Database verification"

        Write-Step "Import completed"

        Write-Host ""
        Write-Host "Fridge9000 data has been restored."
        Write-Host ""
        Write-Host "Verify:"
        Write-Host "  - Inventory"
        Write-Host "  - Teach Fridge annotations"
        Write-Host "  - AI Progress"
        Write-Host "  - active/archived models"
        Write-Host "  - trained Lemon model"
    }
    finally {
        if (Test-Path $tempDirectory) {
            Remove-Item $tempDirectory -Recurse -Force
        }

        Pop-Location
    }
}

switch ($Mode) {
    "Export" {
        Export-FridgeData
    }

    "Import" {
        Import-FridgeData
    }
}