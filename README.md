<p align="center">
  <img src="assets/fridge9000-banner.png" alt="Fridge9000" width="100%">
</p>

# Fridge 9000

Fridge 9000 is a smart refrigerator management system combining **computer vision, inventory tracking, OCR, freshness analysis, and human-in-the-loop machine learning**.

The mobile app can scan refrigerator images, review AI detections, update inventory, track expiration dates, process receipts, analyze food freshness, and turn reviewed human corrections into improved object-detection models.

The system is designed so that AI predictions are useful immediately while human corrections can improve future models without silently replacing the detector currently serving the application.

---

## Features

### AI Product Detection

Fridge 9000 uses **YOLO** for refrigerator product detection.

Each scan stores:

- Product labels
- Confidence scores
- Bounding boxes
- Scan history

Before inventory is updated, detections can be reviewed and corrected.

Supported corrections include:

- Confirming a correct detection
- Relabeling an incorrect product
- Adjusting a bounding box
- Removing a false positive
- Adding a missed product

Images with zero YOLO detections are still stored, allowing completely new products to be manually annotated.

---

### Inventory Management

Inventory supports:

- Automatic updates from refrigerator scans
- Manual additions and removals
- Per-product quantities
- Separate inventory batches
- Manual and estimated expiration dates
- Partially consumed products
- Inventory history
- Low-stock and missing-product alerts

Inventory batches are the authoritative representation of stored products.

The aggregate quantity shown by the application is derived from those batches rather than maintained as an independent source of truth.

```text
Inventory Batches
      ↓
Quantity Aggregation
      ↓
Inventory Summary
```

This allows multiple units of the same product to keep independent expiration dates and open-product state without drifting out of sync with the displayed quantity.

Schema initialization is also idempotent. Legacy inventory is backfilled only when an item has no batch records at all, preventing application restarts from creating duplicate inventory.

---

### Receipt OCR

Receipts can be uploaded as images or PDFs.

The backend uses **Tesseract OCR** to extract product names, which can then be reviewed before inventory changes are applied.

---

### Freshness Analysis

Fridge 9000 contains a separate image-classification model for supported food freshness / rot detection.

Freshness classification is intentionally independent from YOLO product detection because the two models answer fundamentally different questions:

```text
YOLO
→ What product is this?

Freshness Classifier
→ What condition is this product in?
```

Keeping these pipelines separate also prevents freshness training from becoming coupled to the detector model lifecycle.

---

### SAM2 Segmentation

YOLO detections can be passed to **SAM2** to generate representative product masks and outlines.

YOLO identifies the object, while SAM2 refines the detected product region.

Candidate masks are evaluated instead of automatically accepting the first generated mask.

---

# Teach Fridge

Fridge 9000 includes a complete **human-in-the-loop training workflow**.

Users can correct normal AI scans or manually annotate uploaded images.

Supported annotation actions are:

```text
CONFIRM
RELABEL
ADJUST_BOX
ADD
REMOVE
```

The normal workflow is:

```text
Scan / Manual Image
        ↓
Human Correction
        ↓
Moderation
        ↓
Approved Annotation
        ↓
Training Selection
        ↓
Versioned Dataset
        ↓
Candidate Training
        ↓
Model Comparison
        ↓
Promotion or Rejection
```

Raw user feedback is never automatically treated as trusted training data. Corrections must first pass through moderation before they can participate in training.

---

# Annotation Lifecycle

Approved annotations have an explicit training lifecycle:

```text
eligible
experimental
trusted
quarantined
```

### `eligible`

Approved data that can be selected for a new candidate.

### `experimental`

Data currently associated with an unresolved candidate.

### `trusted`

Data represented by the **currently active model's training lineage**.

### `quarantined`

Experimental data belonging to a rejected candidate and excluded from normal training selection.

Trust follows the model that is currently active rather than permanently attaching itself to an annotation after its first training run.

For example:

```text
Lemon Model ACTIVE
Lemon Annotations TRUSTED
```

If the application rolls back to an older model that does not contain those Lemon annotations:

```text
Initial Model ACTIVE
Lemon Model ARCHIVED
Lemon Annotations ELIGIBLE
```

Those annotations become available for future candidate training again.

If the existing Lemon model is later reactivated:

```text
Lemon Model ACTIVE
Lemon Annotations TRUSTED
```

The same reconciliation also runs during application startup, so restarting the backend does not incorrectly treat archived-model provenance as active trusted data.

---

# Training Data Provenance

Every training run records which submissions and annotations were used.

The system maintains a traceable relationship between:

```text
Human Feedback
      ↓
Approved Annotation
      ↓
Dataset Version
      ↓
Training Run
      ↓
Model Version
```

Manual annotations remain distinguishable from corrected YOLO predictions, and training provenance is preserved across promotion, rejection, and rollback.

This makes it possible to determine not only which model is active, but also which human contributions were involved in producing it.

---

# Model Lifecycle

Detector models are versioned instead of simply overwriting `best.pt`.

```text
Active Model
     ↓
Train Candidate
     ↓
Candidate Model
     ↓
Compare
     ↓
Promotion Policy
   ↙       ↘
Reject    Promote
             ↓
       Previous Active
          Archived
```

The system stores:

- Dataset versions
- Training runs
- Model versions
- Model artifacts
- Metrics
- Model comparisons
- Training provenance
- Promotion history
- Rollback history

Only one detector can be active at a time, and only one unresolved candidate is allowed at a time.

Candidate training never modifies the active detector. The existing model continues serving predictions while another model is trained and evaluated.

Promotion is always an explicit action.

---

# Model Rollback

Previously active models remain available as archived model versions.

From **Teach Fridge → AI Progress**, `Rollback model` appears when archived models are available.

The user can open Training History and explicitly choose which model to restore.

Rollback is implemented as **model reactivation**, not retraining.

It reuses the existing:

- Model version
- Model artifact
- Model path
- Training run
- Training provenance

No new training job or duplicate model version is created.

For example:

```text
Initial ACTIVE
Lemon ARCHIVED

      ↓ Rollback to Lemon

Initial ARCHIVED
Lemon ACTIVE
```

The same models can later be switched again:

```text
Initial
   ↕
Lemon
```

This allows a previously deployed detector to be restored immediately without paying the cost or introducing the uncertainty of training it again.

Changing the active model also reconciles annotation lifecycle state so that `trusted` data continues to reflect the model actually serving predictions.

---

# Incremental Training

Training only on newly collected corrections could teach the detector a new product while causing it to forget products it already recognizes.

Fridge 9000 therefore combines existing training knowledge with newly approved corrections.

```text
Permanent Base Dataset
          +
Trusted Baseline Data
          +
Selected New Corrections
          ↓
Combined Dataset
          ↓
Candidate Training
```

A candidate must also preserve the product classes already supported by the active detector.

This allows the model to learn new products without sacrificing existing capabilities.

---

# Model Comparison and Promotion

Candidates are evaluated against the active detector using the same evaluation configuration.

Comparison data includes:

- Precision
- Recall
- mAP50
- mAP50-95
- Per-class metrics
- Shared-class metrics
- Added-class metrics

The backend applies the promotion policy:

```text
class-aware-promotion-v1
```

## Same Product Classes

When both models support the same classes, the candidate must outperform the active model.

The primary metric is:

```text
mAP50-95
```

`mAP50` is used as a tie-breaker when appropriate.

---

## Candidate Adds New Classes

When a candidate introduces new products, performance on existing products is evaluated separately from performance on the new classes.

```text
No existing class removed
        +
Existing-class regression ≤ 2 percentage points mAP50-95
        +
New-class average mAP50-95 ≥ 50%
        +
Every new class mAP50-95 ≥ 30%
        ↓
Eligible for Promotion
```

Default thresholds:

```env
MAX_SHARED_MAP50_95_REGRESSION=0.02
MIN_ADDED_CLASS_MAP50_95=0.50
MIN_ADDED_CLASS_PER_CLASS_MAP50_95=0.30
```

Separating shared and newly added classes prevents strong results on a new product from hiding a serious regression on products already supported by the active detector.

The backend owns the promotion decision. Passing the policy does **not** automatically activate the model.

---

# Local and Remote Training

Fridge 9000 supports:

```env
TRAINING_PROVIDER=local
```

and:

```env
TRAINING_PROVIDER=kaggle
```

Both providers use the same model lifecycle.

Kaggle is treated purely as a remote GPU compute provider rather than as the authority over Fridge model state.

```text
Kaggle Training
      ↓
Returned Artifacts
      ↓
Backend Validation
      ↓
Candidate Registration
      ↓
Comparison
      ↓
Promotion Policy
```

The backend validates returned artifacts, model identity, class mappings, metrics, class preservation, and comparison results before accepting a candidate.

A remote training job may therefore complete successfully while its resulting model is still rejected by Fridge 9000.

The backend and PostgreSQL model registry remain the source of truth.

---

# Architecture

```text
                 React Native / Expo
                         │
                         ▼
                    FastAPI API
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
        PostgreSQL               ML Services
             │                       │
     Inventory / Scans       YOLO / SAM2 / OCR
     Annotations / Models      Freshness Model
             │
             ▼
       Training Lifecycle
             │
             ▼
      Local or Remote GPU
```

The backend exposes separate API modules for:

- Scans
- Inventory
- Annotations
- Models
- Receipts
- Product outlines
- Events
- System operations

PostgreSQL stores persistent application state and model-lifecycle metadata.

Generated artifacts such as uploads, datasets, model comparisons, and candidate models are stored outside Git.

---

# Technology Stack

## Backend

- Python
- FastAPI
- PostgreSQL
- psycopg2
- OpenCV
- Ultralytics YOLO
- PyTorch
- SAM2
- Tesseract OCR
- Pillow
- NumPy

## Mobile

- React Native
- Expo
- Expo Router
- TypeScript

## Infrastructure and Testing

- Docker
- Docker Compose
- PostgreSQL 16
- pytest
- TypeScript compiler
- ESLint
- Expo Doctor
- Kaggle GPU training

---

# Project Structure

```text
Fridge9000/
├── backend/
│   ├── api/
│   ├── core/
│   ├── db/
│   ├── services/
│   ├── tests/
│   ├── class_aware_metrics.py
│   ├── compare_yolo_models.py
│   ├── export_yolo_dataset.py
│   ├── model_promotion_policy.py
│   ├── train_yolo_candidate.py
│   ├── training_providers.py
│   └── main.py
│
├── db/
│   └── init.sql
│
├── kaggle_trainer/
│   ├── train.py
│   ├── test_train.py
│   └── README.md
│
├── mobile/
│   ├── app/
│   ├── assets/
│   └── src/
│
├── scripts/
│   └── fridge-data.ps1
│
├── assets/
├── docker-compose.yml
├── docker-compose.test.yml
├── run-fridge.bat
├── start-fridge.ps1
├── fridge-test.bat
├── export-fridge-data.bat
├── import-fridge-data.bat
└── README.md
```

---

# Running Fridge 9000

## Requirements

Install:

- Docker Desktop
- Git
- Node.js / npm
- Expo Go on the mobile device

Clone the repository:

```bash
git clone https://github.com/netanel770/Fridge9000.git
cd Fridge9000
```

Install mobile dependencies once:

```bash
cd mobile
npm install
cd ..
```

Create the local environment file:

```cmd
copy .env.example .env
```

`.env` must never be committed.

---

## Windows Quick Start

Make sure Docker Desktop is running.

From the repository root:

```cmd
run-fridge.bat
```

`run-fridge.bat` launches `start-fridge.ps1`.

The launcher:

1. Detects a usable physical LAN IPv4 address.
2. Sets the Expo API URL.
3. Builds and starts PostgreSQL and FastAPI through Docker Compose.
4. Waits for Docker services to become ready.
5. Starts Expo.
6. Displays the Expo QR code.

The mobile device and development computer must be able to reach each other on the same local network.

The backend is normally available at:

```text
http://<LAN-IP>:8000
```

A custom API URL or Expo tunnel mode can also be supplied through `start-fridge.ps1`.

---

## Stopping Fridge 9000

Press:

```text
Ctrl+C
```

in the launcher window.

The launcher shuts down Expo and Docker Compose.

The PostgreSQL Docker volume is preserved.

Do not run:

```bash
docker compose down -v
```

unless you intentionally want to delete the development database.

---

# Persistent Development Data

Git contains the application source code, but it intentionally does **not** contain all runtime state.

Persistent Fridge data includes:

- PostgreSQL database
- Uploaded scan images
- Candidate model artifacts
- Dataset exports
- Model-comparison artifacts
- Base training dataset
- Remote-training job state
- Local `.env`

Important runtime directories include:

```text
backend/uploads/
backend/candidate_models/
backend/dataset_exports/
backend/model_comparisons/
backend/base_dataset/
backend/remote_training_jobs/
```

These directories are intentionally ignored by Git.

The model registry and model artifacts should be treated as a single persistent system.

PostgreSQL stores information about model versions and their artifact paths, while the actual trained `.pt` files live in directories such as:

```text
backend/candidate_models/
```

Restoring only PostgreSQL without restoring those files could leave the model registry pointing to artifacts that no longer exist.

For that reason, Fridge includes a backup and machine-transfer workflow that captures both.

---

# Backup and Machine Transfer

Fridge 9000 includes:

```text
export-fridge-data.bat
import-fridge-data.bat
scripts/fridge-data.ps1
```

These scripts allow a development installation to be moved between computers while preserving the database and generated runtime artifacts.

---

## Export Fridge Data

From the repository root, run:

```cmd
export-fridge-data.bat
```

The BAT file invokes:

```text
scripts/fridge-data.ps1 -Mode Export
```

The export process:

1. Records the current Git branch and commit.
2. Stops the Fridge backend so runtime files do not change during the snapshot.
3. Keeps or starts PostgreSQL.
4. Creates a PostgreSQL custom-format dump using `pg_dump`.
5. Copies runtime directories.
6. Copies the local `.env` if present.
7. Creates a backup manifest.
8. Compresses everything into one timestamped ZIP.

Example:

```text
fridge9000-backup-2026-08-28_01-45-00.zip
```

The backup contains approximately:

```text
fridge9000.dump
.env
manifest.json

backend/
├── uploads/
├── candidate_models/
├── dataset_exports/
├── model_comparisons/
├── base_dataset/
└── remote_training_jobs/   if present
```

The PostgreSQL dump preserves application state such as:

- Inventory
- Inventory batches
- Scans
- Annotation submissions
- Annotation lifecycle states
- Training runs
- Dataset and model provenance
- Model versions
- Model comparisons
- Active / archived model registry
- Activation history

The accompanying runtime folders preserve the physical files referenced by that database state, including trained model weights.

The backend is intentionally left stopped after export.

---

## Import Fridge Data

Import can be used either to restore a backup or transfer an existing Fridge installation to another development machine.

First clone the repository:

```bash
git clone https://github.com/netanel770/Fridge9000.git
cd Fridge9000
```

Check out the appropriate branch or revision if necessary.

Install mobile dependencies:

```bash
cd mobile
npm install
cd ..
```

Then drag the backup ZIP onto:

```text
import-fridge-data.bat
```

or run:

```cmd
import-fridge-data.bat "C:\path\to\fridge9000-backup.zip"
```

Import requires explicit confirmation because it replaces the destination machine's existing Fridge development database and matching runtime directories.

The importer:

1. Extracts the backup.
2. Reads its source manifest.
3. Stops the backend.
4. Starts PostgreSQL.
5. Restores the database using `pg_restore`.
6. Restores runtime directories.
7. Restores `.env` when included.
8. Rebuilds and starts Fridge 9000.
9. Performs a basic database verification.

The restored installation includes:

```text
Inventory
Scans
Annotations
Annotation Lifecycle State
Training Runs
Model Versions
Model Comparisons
Activation History
Active / Archived Models
Trained Model Files
Uploads
Datasets
Comparison Artifacts
```

If the destination computer already contains Fridge data that should be preserved, export it before importing another backup.

---

# Configuration

The main runtime and training configuration lives in `.env`.

Start from:

```cmd
copy .env.example .env
```

Example local configuration:

```env
TRAINING_PROVIDER=local
LOCAL_BASE_DATASET_PATH=/app/base_dataset

MAX_SHARED_MAP50_95_REGRESSION=0.02
MIN_ADDED_CLASS_MAP50_95=0.50
MIN_ADDED_CLASS_PER_CLASS_MAP50_95=0.30
```

For Kaggle:

```env
TRAINING_PROVIDER=kaggle

KAGGLE_USERNAME=your_kaggle_username
KAGGLE_API_TOKEN=your_kaggle_api_token

KAGGLE_DATASET_SLUG_PREFIX=fridge9000-training-data
KAGGLE_KERNEL_SLUG=your_kaggle_username/fridge9000-remote-yolo-trainer
KAGGLE_MACHINE_SHAPE=NvidiaTeslaT4

KAGGLE_STARTING_WEIGHTS_PATH=/app/yolo11s.pt
KAGGLE_STARTING_MODEL_VERSION=yolo11s-pretrained

KAGGLE_CLI_PATH=kaggle
KAGGLE_POLL_INTERVAL_SECONDS=30
KAGGLE_TIMEOUT_SECONDS=14400
KAGGLE_COMMAND_TIMEOUT_SECONDS=300
```

Never commit real credentials.

---

# Candidate Training

From the mobile application:

```text
Teach Fridge
      ↓
AI Progress
      ↓
Train a candidate
```

The system:

1. Selects approved eligible annotations.
2. Exports a versioned correction dataset.
3. Combines baseline/trusted data with selected corrections.
4. Starts local or remote training.
5. Produces a candidate model.
6. Evaluates the candidate.
7. Registers it in the model lifecycle.
8. Compares it against the active detector.
9. Applies the promotion policy.

The active detector remains unchanged throughout candidate training.

Backend lifecycle activity can be viewed with:

```bash
docker compose logs -f backend
```

---

# Testing

Fridge 9000 uses a separate PostgreSQL test environment so automated tests do not modify normal development data.

This separation is especially important because lifecycle and inventory tests deliberately exercise operations such as:

- Schema initialization
- Candidate registration
- Promotion
- Rejection
- Quarantine
- Rollback
- Repeated model reactivation
- Annotation trust reconciliation
- Inventory batch migration

Those operations run against isolated test state rather than a developer's real inventory, annotations, or trained models.

---

## Full Windows Validation

From the repository root:

```cmd
fridge-test.bat
```

The validation runner performs:

```text
1. Start isolated PostgreSQL test environment
2. Run backend pytest suite
3. Run training-provider tests
4. Run Kaggle worker tests
5. Stop isolated PostgreSQL test environment
6. Run TypeScript checks
7. Run mobile ESLint
8. Run Expo Doctor
9. Run git diff --check
```

---

## Backend Tests

Start the isolated database:

```bash
docker compose -f docker-compose.test.yml -p fridge9000-test up -d --wait
```

Run:

```bash
pytest
```

Stop it afterward:

```bash
docker compose -f docker-compose.test.yml -p fridge9000-test down
```

---

## Mobile Validation

From `mobile/`:

```bash
npx tsc --noEmit
npm run lint
npx expo-doctor
```

---

# Development Notes

- `.env` and real API credentials must never be committed.
- Runtime uploads and generated training artifacts are intentionally ignored by Git.
- Inventory batches are the authoritative inventory representation.
- Only one detector can be active at a time.
- Only one unresolved candidate can exist at a time.
- Candidate training never silently changes the active detector.
- Promotion is explicit.
- Rejected experimental data is quarantined.
- Annotation trust follows the currently active model's lineage.
- Archived model provenance alone does not make annotations trusted.
- Rollback reactivates existing archived models without retraining.
- Previously active models remain reusable as long as their registered artifacts remain available.
- Local and Kaggle training use the same lifecycle.
- Kaggle provides compute while the Fridge backend remains the source of truth.
- Freshness classification remains separate from the YOLO detector lifecycle.
- Development and test PostgreSQL environments are separated.
- Database backups and trained model artifacts must be transferred together.

---

# Project Goal

Fridge 9000 is designed to go beyond simply calling a pretrained object detector.

The project combines:

```text
Computer Vision
+
Inventory Management
+
Human Feedback
+
Moderated Training Data
+
Training Provenance
+
Versioned Datasets
+
Incremental Model Training
+
Remote GPU Compute
+
Class-Aware Evaluation
+
Safe Model Promotion
+
Model Rollback / Reactivation
+
Persistent Runtime State
+
Portable Backup / Restore
```

into one end-to-end smart refrigerator system.

The important part is not only that the application can make predictions.

Fridge 9000 can collect corrections, preserve where those corrections came from, train candidate models without disturbing the active detector, evaluate candidates before deployment, reject unsafe changes, reactivate previous models without retraining, and preserve the application and ML lifecycle when moving between development machines.
