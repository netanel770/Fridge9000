<p align="center">
  <img src="assets/fridge9000-banner.png" alt="Fridge9000" width="100%">
</p>

# Fridge 9000

Fridge 9000 is a smart refrigerator management system combining **computer vision, inventory tracking, OCR, freshness analysis, and human-in-the-loop machine learning**.

The mobile app can scan refrigerator images, review AI detections, update inventory, track expiration dates, process receipts, analyze food freshness, and turn reviewed human corrections into improved object-detection models.

The project is built around one central idea:

> AI predictions should be useful immediately, while human corrections can safely improve future models without silently replacing the model currently serving the application.

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

#### Important design choice: batches are authoritative

Inventory is represented by individual `inventory_batches`.

The aggregate inventory quantity is derived from those batches rather than maintained as an independent source of truth.

```text
Inventory Batches
      ↓
Quantity Aggregation
      ↓
Inventory Summary
```

This keeps expiry information, open-product state, and quantities consistent.

Schema initialization is idempotent and only performs legacy backfill when an inventory item has no batch records at all.

---

### Receipt OCR

Receipts can be uploaded as images or PDFs.

The backend uses **Tesseract OCR** to extract product names, which can then be reviewed before inventory changes are applied.

---

### Freshness Analysis

Fridge 9000 contains a separate image-classification model for supported food freshness / rot detection.

#### Important design choice: freshness is a separate ML task

Freshness classification is deliberately independent from YOLO product detection.

```text
YOLO
→ What product is this?

Freshness Classifier
→ What condition is this product in?
```

Keeping these pipelines separate prevents unrelated training lifecycles from becoming coupled.

---

### SAM2 Segmentation

YOLO detections can be passed to **SAM2** to generate representative product masks and outlines.

YOLO identifies the object, while SAM2 refines the detected product region.

Candidate masks are evaluated instead of automatically trusting the first generated mask.

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

Raw user feedback is never automatically treated as trusted training data.

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

#### Important design choice: trust follows the active model

An annotation is not permanently trusted merely because it was used by a model at some point.

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

The annotations can then be selected again for another candidate.

If the Lemon model is later reactivated:

```text
Lemon Model ACTIVE
Lemon Annotations TRUSTED
```

Startup reconciliation uses the same lifecycle semantics, so restarting the backend does not incorrectly make archived-only annotations trusted again.

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

Manual annotations remain distinguishable from corrected YOLO predictions.

Training provenance is preserved across promotion, rejection, and rollback.

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

Only one detector can be active at a time.

Only one unresolved candidate can exist at a time.

#### Important design choice: candidate training never replaces production

Training a candidate does not modify the active detector.

The current model continues serving predictions while another model is trained and evaluated.

Promotion is always explicit.

---

# Model Rollback

Previously active models remain available as archived model versions.

From **Teach Fridge → AI Progress**, `Rollback model` appears when an archived model is available.

The user can open Training History and explicitly choose which archived model to restore.

#### Important design choice: rollback means reactivation, not retraining

Rollback reuses the existing:

- Model version
- Model artifact
- Model path
- Training run
- Training provenance

No new training job or duplicate model is created.

For example:

```text
Initial ACTIVE
Lemon ARCHIVED

      ↓ Rollback to Lemon

Initial ARCHIVED
Lemon ACTIVE
```

The same model can later be switched back again:

```text
Initial
   ↕
Lemon
```

Previously active models can therefore be reused without repeating expensive training.

Rollback also reconciles annotation lifecycle state to match the newly active model.

---

# Incremental Training

Training only on new corrections could teach the detector a new product while causing it to forget existing products.

Fridge 9000 therefore combines permanent/base training data with reviewed corrections.

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

A candidate must preserve the product classes already supported by the active model.

This allows the system to learn new products without casually forgetting that milk exists, a surprisingly important property for a refrigerator.

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

The backend applies:

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

When the candidate introduces new products:

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

This prevents strong performance on newly added products from hiding a serious regression on products already supported by the active detector.

The backend owns the final promotion decision.

Passing the policy does **not** automatically activate the model.

Promotion remains an explicit action.

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

Local and remote training use the same model lifecycle.

#### Important design choice: remote compute is not trusted

Kaggle is treated as a GPU compute provider, not as the source of truth for the model registry.

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

A remotely completed job can therefore still be rejected.

The Fridge backend and PostgreSQL model registry remain authoritative.

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

The backend exposes separate API modules for areas including:

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

Create your local environment file:

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

#### Important design choice: database and model artifacts must move together

The database stores model registry information and model paths.

The actual trained `.pt` files live in runtime storage such as:

```text
backend/candidate_models/
```

Restoring only PostgreSQL without restoring the corresponding model artifacts can leave the registry pointing to files that do not exist.

Fridge therefore includes a portable backup and restore workflow.

---

# Backup and Machine Transfer

Fridge 9000 includes:

```text
export-fridge-data.bat
import-fridge-data.bat
scripts/fridge-data.ps1
```

These scripts allow a development installation to be transferred between computers while preserving both database state and generated artifacts.

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
2. Stops the Fridge backend so runtime files are not changing during the snapshot.
3. Keeps / starts PostgreSQL.
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

The PostgreSQL dump preserves application state including:

- Inventory
- Inventory batches
- Scans
- Annotation submissions
- Annotation lifecycle states
- Training runs
- Dataset/model provenance
- Model versions
- Model comparisons
- Active / archived model registry
- Activation history

The runtime folders preserve the actual files referenced by that database state, including trained candidate-model weights.

The backend is intentionally left stopped after export.

---

## Import Fridge Data

Import is intended for restoring a backup or transferring an existing Fridge installation to another machine.

First clone the repository on the destination computer:

```bash
git clone https://github.com/netanel770/Fridge9000.git
cd Fridge9000
```

Check out the appropriate branch/version if required.

Install the mobile dependencies:

```bash
cd mobile
npm install
cd ..
```

Then either drag the backup ZIP onto:

```text
import-fridge-data.bat
```

or run:

```cmd
import-fridge-data.bat "C:\path\to\fridge9000-backup.zip"
```

The import script requires explicit confirmation before replacing the destination machine's development state.

The importer:

1. Extracts the backup.
2. Reads the source manifest.
3. Stops the backend.
4. Starts PostgreSQL.
5. Restores the PostgreSQL dump using `pg_restore`.
6. Restores runtime directories.
7. Restores `.env` when included.
8. Rebuilds and starts Fridge 9000.
9. Performs a basic database verification.

The restored installation includes:

```text
Inventory
Scans
Annotations
Annotation lifecycle state
Training runs
Model versions
Model comparisons
Activation history
Active / archived models
Trained model files
Uploads
Datasets
Comparison artifacts
```

### Important import warning

Import replaces the destination development database and matching runtime directories.

It is therefore intentionally protected by explicit confirmation.

A backup should be created first if the destination machine already contains Fridge data that must be preserved.

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

The active model remains unchanged throughout candidate training.

Backend lifecycle activity can be viewed with:

```bash
docker compose logs -f backend
```

---

# Testing

Fridge 9000 uses a separate PostgreSQL test environment so automated tests do not mutate normal development data.

#### Important design choice: tests do not use development PostgreSQL

Model-lifecycle and inventory tests deliberately exercise operations such as:

- Schema initialization
- Candidate registration
- Promotion
- Rejection
- Quarantine
- Rollback
- Repeated model reactivation
- Annotation trust reconciliation
- Inventory batch migration

These operations therefore run against isolated test state rather than the developer's real inventory, annotations, or trained models.

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
- Previously active models remain reusable as long as their registered artifacts remain valid.
- Local and Kaggle training use the same lifecycle.
- Kaggle provides compute; the Fridge backend remains the source of truth.
- Freshness classification remains separate from YOLO model lifecycle.
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

Fridge 9000 can collect corrections, preserve where those corrections came from, train candidate models without disturbing production, evaluate candidates before deployment, reject unsafe changes, reactivate previous models without retraining, and preserve the entire application and ML lifecycle when moving between development machines.
