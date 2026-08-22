# Fridge9000 Kaggle YOLO trainer

This private Kaggle worker fine-tunes a YOLO **object detector** from the supplied active Fridge9000 detector. It never overwrites the active input. Backend/Kaggle API integration is intentionally not part of this package yet.

## Input dataset

Attach one private Kaggle dataset containing exactly one copy of each filename (subdirectories are allowed):

```text
dataset.zip
active_model.pt
starting_model.pt
job.json
```

`dataset.zip` contains the approved Fridge9000 corrections. The kernel also attaches the immutable Kaggle base dataset containing `data/images`, `data/labels`, and `data/classes.txt`. `starting_model.pt` is the pretrained YOLO detector used to train a fresh candidate; `active_model.pt` is evaluation-only. `job.json` follows [example_job.json](example_job.json).

The worker combines base and approved corrections, deduplicates identical image content, remaps classes, and creates deterministic 70/15/15 train/validation/test splits using the source-image SHA-256. The candidate is trained from `starting_model.pt`; both candidate and active are evaluated on the exact same fixed test split.

## Kaggle setup

1. Replace `YOUR_KAGGLE_USERNAME` in `kernel-metadata.json`.
2. Create/attach the private input dataset through Kaggle or add its dataset slug to `dataset_sources`.
3. Keep GPU enabled. Internet is enabled so the pinned Ultralytics dependency can be installed if the Kaggle image does not already provide it; no token belongs in this repository.
4. Run `train.py`. Inputs are discovered recursively under `/kaggle/input`; working files and outputs are written under `/kaggle/working`.

For a lightweight local check that does not import Ultralytics or train:

```powershell
python kaggle_trainer/train.py --input-root <mock-input> --working-root <temp-output> --validate-only
```

## Outputs

- `candidate_best.pt` and, when available, `candidate_last.pt`
- `comparison.json` with real active/candidate metrics and deltas
- `training_metrics.json` with environment, parameters, timing, and candidate metrics
- `run_manifest.json` with input hashes and audit metadata
- `failure.json` on failure
- `validation_report.json` in validation-only mode
- `yolo_runs/` containing useful native Ultralytics artifacts

Promotion is never performed by the worker. The Fridge9000 backend orchestration handles packaging, launch, monitoring, artifact verification, and transactional candidate registration.

## Backend orchestration

The backend now supports `TRAINING_PROVIDER=local|kaggle`. Kaggle mode creates a private, uniquely named dataset and kernel for every training run, preventing an older Kaggle dataset/kernel version from being consumed accidentally. Authentication uses only `KAGGLE_USERNAME` and `KAGGLE_KEY` environment variables. The API token is never placed in command arguments, staging files, logs, or database records.

The configured `KAGGLE_KERNEL_SLUG` is a base slug such as `owner/fridge9000-remote-yolo-trainer`; the backend appends the unique run ID. The backend submits with `kaggle kernels push`, polls that unique slug, downloads its outputs, validates all run/model/dataset identities and metrics, and transactionally registers the candidate. Promotion remains a separate existing action.
