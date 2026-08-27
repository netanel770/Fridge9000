import subprocess
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[3]
SCRIPT_PATH = PROJECT_ROOT / "scripts" / "fridge-data.ps1"


def test_backup_manifest_tracks_managed_and_included_directories():
    script = SCRIPT_PATH.read_text(encoding="utf-8")

    assert "format_version = 2" in script
    assert "managed_runtime_directories = $ManagedRuntimeDirectories" in script
    assert "included_runtime_directories = $includedRuntimeDirectories" in script
    for directory in (
        "uploads",
        "candidate_models",
        "dataset_exports",
        "model_comparisons",
        "base_dataset",
        "remote_training_jobs",
    ):
        assert f'"{directory}"' in script


def test_runtime_restore_replaces_included_and_clears_omitted_directories(tmp_path):
    target_root = tmp_path / "target"
    backup_root = tmp_path / "backup"
    command = f"""
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        '{SCRIPT_PATH.as_posix()}', [ref]$tokens, [ref]$errors
    )
    if ($errors.Count -gt 0) {{ throw ($errors.Message -join '; ') }}
    $function = $ast.Find({{
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq 'Restore-RuntimeDirectories'
    }}, $true)
    if (-not $function) {{ throw 'Restore-RuntimeDirectories was not found.' }}
    Invoke-Expression $function.Extent.Text

    $target = '{target_root.as_posix()}'
    $backup = '{backup_root.as_posix()}'
    New-Item -ItemType Directory -Path "$target/backend/uploads" -Force | Out-Null
    New-Item -ItemType Directory -Path "$target/backend/candidate_models" -Force | Out-Null
    New-Item -ItemType Directory -Path "$backup/backend/uploads" -Force | Out-Null
    Set-Content -Path "$target/backend/uploads/stale.txt" -Value stale
    Set-Content -Path "$target/backend/candidate_models/old-model.pt" -Value stale
    Set-Content -Path "$backup/backend/uploads/current.txt" -Value current

    Restore-RuntimeDirectories `
        -TargetRoot $target `
        -BackupRoot $backup `
        -Directories @('uploads', 'candidate_models')

    if (Test-Path "$target/backend/uploads/stale.txt") {{
        throw 'A stale file survived in an included directory.'
    }}
    if (-not (Test-Path "$target/backend/uploads/current.txt")) {{
        throw 'The included directory was not restored.'
    }}
    if (Test-Path "$target/backend/candidate_models/old-model.pt") {{
        throw 'A stale file survived in an omitted directory.'
    }}
    if (Test-Path "$target/backend/candidate_models") {{
        throw 'The omitted target directory was not cleared.'
    }}
    """

    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", command],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr or result.stdout
