<p align="center">
  <img src="assets/fridge9000-banner.png" alt="Fridge9000" width="100%">
</p>

# Fridge 9000

Fridge 9000 is a smart refrigerator management system combining **computer vision, inventory tracking, OCR, freshness analysis, and human-in-the-loop machine learning**.

The mobile app can scan refrigerator images, review AI detections, update inventory, track expiration dates, process receipts, analyze food freshness, and turn reviewed human corrections into versioned training data for improved object-detection models.

Fridge 9000 is designed around a complete model lifecycle rather than simply replacing a detector whenever training finishes. Candidate models are trained independently, compared against the detector currently serving the application, and must be explicitly promoted before they can become active.

---

## Features

### AI Product Detection

Fridge 9000 uses **Ultralytics YOLO** for refrigerator product detection.

Each scan stores:

* Product labels
* Confidence scores
* Bounding boxes
* Source images
* Scan history

Before inventory is updated, detections can be reviewed and corrected.

Supported corrections include:

* Confirming a correct detection
* Relabeling an incorrect product
* Adjusting a bounding box
* Removing a false positive
* Adding a missed product

Images with zero YOLO detections are still stored, allowing completely new products to be manually annotated.

---

### Inventory Management

Inventory supports:

* Automatic updates from refrigerator scans
* Manual additions and removals
* Per-product quantities
* Separate inventory batches
* Manual and estimated expiration dates
* Partially consumed products
* Inventory history
* Low-stock and missing-product alerts

Inventory batches are the authoritative representation of stored products.

The aggregate quantity shown by the application is derived from those batches rather than maintained as a separate source of truth.

```text
Inventory Batches
      ↓
Quantity Aggregation
      ↓
Inventory Summary
```

This allows multiple units of the same product to keep independent expiration dates and open-product state without drifting out of sync with the displayed quantity.

Schema initialization is idempotent. Legacy inventory is backfilled only when an item has no batch records, preventing application restarts from creating duplicate inventory.

---

### Receipt OCR

Receipts can be uploaded as images or PDFs.

The backend uses **Tesseract OCR** to extract product names, which can then be reviewed before inventory changes are applied.

---

### Freshness Analysis

Fridge 9000 contains a separate image-classification model for supported food freshness / rot detection.

Freshness classification is intentionally independent from YOLO product detection because the two models answer different questions:

```text
YOLO
→ What product is this?

Freshness Classifier
→ What condition is this product in?
```

Keeping the pipelines separate also prevents freshness classification from becoming coupled to the detector-training lifecycle.

---

### SAM2 Segmentation

YOLO detections can be passed to **SAM2** to generate representative product masks and outlines.

YOLO identifies the product region, while SAM2 refines it.

Candidate masks are evaluated instead of automatically accepting the first generated mask.

---

# Teach Fridge

Fridge 9000 includes a complete **human-in-the-loop training workflow**.

Users can correct detections from normal refrigerator scans or manually annotate uploaded images.

Supported annotation actions are:

```text
CONFIRM
RELABEL
ADJUST_BOX
ADD
REMOVE
```

The normal flow is:

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

Raw feedback is never automatically considered trusted training data. Corrections must pass through moderation before they can participate in training.

Training selection also shows the source image and reviewed bounding boxes so that submissions can be inspected before they are included in a candidate run.

---

# Annotation Lifecycle

Approved annotation submissions have an explicit training lifecycle:

```text
eligible
experimental
trusted
quarantined
```

### `eligible`

Approved data available for selection in a future candidate-training run.

Eligible submissions can also be manually moved to Quarantine if they should no longer appear in the normal training pool.

### `experimental`

Data currently used by an unresolved candidate.

Experimental data remains separate from the trusted baseline until the candidate is resolved.

### `trusted`

Data represented by the **currently active model's recorded training provenance**.

Trusted data is automatically included in future candidate datasets so that established product knowledge is preserved.

### `quarantined`

Data excluded from normal training selection.

Rejected candidate data is moved to Quarantine, and eligible submissions can also be moved there manually.

Quarantined submissions can later be returned to the training pool:

```text
quarantined
     ↓
Return to training
     ↓
eligible
```

If selected again:

```text
eligible
   ↓
candidate training
   ↓
experimental
   ↓
candidate promoted
   ↓
trusted
```

Quarantine also supports lightweight archiving.

Archiving does **not** create another ML lifecycle state:

```text
training_state = quarantined
```

The submission simply receives archive metadata and disappears from the default working Quarantine view.

Archived submissions:

* Remain quarantined
* Remain excluded from training
* Preserve their annotations and provenance
* Can be viewed with `Show archived`
* Can be unarchived later

This keeps the normal Quarantine queue actionable without permanently deleting historical annotation data.

---

# Active-Model Trust

Trust follows the model that is currently serving predictions.

Suppose:

```text
Initial Model
    ↓
Model 2
```

and Model 2 was trained using a new set of approved corrections.

After Model 2 is promoted:

```text
Model 2 ACTIVE
Model-2 training data TRUSTED
```

If Fridge 9000 later rolls back to Initial Model, corrections that are not represented by Initial Model are no longer treated as trusted:

```text
Initial Model ACTIVE
Model 2 ARCHIVED
Model-2-only corrections ELIGIBLE
```

The records are not deleted.

They become available for deliberate reuse in a future candidate.

If Model 2 is later reactivated, its recorded training provenance once again determines the trusted baseline.

The same reconciliation runs during backend startup, preventing archived-model provenance from being mistaken for active trusted data.

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

Training provenance records both baseline/trusted data and the experimental submissions introduced by a candidate run.

The same annotation can legitimately appear in multiple historical training runs.

Promotion, rejection, quarantine, rollback, archiving, and retraining do not erase that history.

This makes it possible to determine:

* Which model was trained
* Which dataset version was used
* Which starting detector weights were used
* Which active model it was evaluated against
* Which submissions were baseline data
* Which submissions were newly introduced
* Which annotations contributed to each model

---

# Candidate Training Strategy

Fridge 9000 separates two concepts that are often accidentally conflated:

```text
Training Foundation
≠
Current Active Model
```

Every candidate starts from the same configurable pretrained YOLO foundation.

By default:

```env
TRAINING_STARTING_WEIGHTS_PATH=/app/yolo11s.pt
TRAINING_STARTING_MODEL_VERSION=yolo11s-pretrained
```

The current active Fridge detector is **not** used as the candidate's starting weights.

Instead, candidate training uses:

```text
Fixed Pretrained YOLO Foundation
              +
      Permanent Base Dataset
              +
 Corrections Trusted by Active Model
              +
  Newly Selected Eligible Corrections
              ↓
        Candidate Model
```

This means accumulated knowledge lives explicitly in the training data and provenance rather than depending on a chain of fine-tuned model weights.

For example:

```text
Run 1
YOLO foundation
+
Base
+
A
→ Model 2
```

After promotion:

```text
Run 2
Same YOLO foundation
+
Base
+
Trusted A
+
New B
→ Model 3
```

Model 3 does not inherit Model 2's weights.

It learns the accumulated Fridge knowledge from the accumulated trusted dataset.

This has several useful properties:

* Local and remote training have identical semantics
* Training runs are easier to reproduce
* Rollback does not require a model ancestry tree
* Archived-model weights cannot silently influence a new branch
* Human-reviewed data remains the durable source of accumulated learning

---

# Class Preservation

Although training starts from generic pretrained YOLO weights, the **current active Fridge model** defines the capability baseline.

Every candidate training dataset must preserve all classes supported by the active detector:

```text
Active Classes ⊆ Candidate Classes
```

For a valid candidate:

```text
Active:
A B C

Candidate:
A B C D
```

therefore:

```text
Shared:
A B C

Added:
D

Removed:
none
```

If a candidate loses a class supported by the active model, it fails class preservation and cannot be promoted.

The pretrained YOLO foundation's original classes are not used as the Fridge class-preservation baseline.

---

# Model Lifecycle

Detector models are versioned rather than overwriting the currently active model artifact.

```text
Current Active Model
        │
        │ comparison baseline
        │
        ▼
Train Candidate
from fixed YOLO foundation
        ↓
Candidate Model
        ↓
Compare with Current Active
        ↓
Promotion Evaluation
      ↙     ↘
   Reject   Promote
     ↓         ↓
Quarantine   Previous Active
new data       Archived
```

The system stores:

* Dataset versions
* Training runs
* Starting-weight identity and SHA
* Model versions
* Model artifacts
* Metrics
* Class-aware comparisons
* Training provenance
* Promotion history
* Activation history
* Rollback history

Only one detector can be active at a time.

Only one unresolved candidate can exist at a time.

Candidate training never modifies the active detector or the configured foundation weights.

The current active model continues serving predictions while another model is trained and evaluated.

Promotion is always explicit.

---

# Model Comparison and Promotion

Every candidate is evaluated against the **current active detector**.

The active detector is the benchmark even though the candidate itself starts from the fixed pretrained YOLO foundation.

Comparison data includes:

* Precision
* Recall
* mAP50
* mAP50-95
* Class-set analysis
* Shared-class metrics
* Added-class metrics
* Per-added-class metrics

The mobile comparison view separates established and newly introduced product performance rather than relying only on one aggregate score.

```text
Shared Product Performance

Products Added by Candidate

Promotion Evaluation
```

Shared products are compared directly between models, while products unique to one model show their available per-product or aggregate metrics separately.

This matters because a candidate can improve overall metrics while making established products worse.

The backend remains authoritative for promotion eligibility.

The mobile application displays the result but does not independently reimplement the promotion policy.

---

## Same Product Classes

When active and candidate models support the same classes, the candidate must outperform the active model.

Primary metric:

```text
mAP50-95
```

`mAP50` is used as the comparison tie-breaker where applicable.

---

## Candidate Adds New Products

When a candidate introduces new classes, existing and newly added capabilities are evaluated separately.

The default promotion requirements are:

```text
No active class removed
        +
All active classes have comparable shared metrics
        +
Shared-class mAP50-95 regression ≤ 2 percentage points
        +
Added-class average mAP50-95 ≥ 50%
        +
Every added class mAP50-95 ≥ 30%
        ↓
Eligible for Promotion
```

Configuration:

```env
MAX_SHARED_MAP50_95_REGRESSION=0.02
MIN_ADDED_CLASS_MAP50_95=0.50
MIN_ADDED_CLASS_PER_CLASS_MAP50_95=0.30
```

Separating shared and newly added classes prevents strong performance on a new product from hiding a serious regression on products already supported by the active detector.

Passing the policy does **not** automatically activate the candidate.

Promotion remains an explicit user action.

---

# Candidate Rejection and Quarantine

When a candidate is rejected:

```text
Candidate
→ rejected
```

its experimental submissions become:

```text
experimental
→ quarantined
```

Those submissions are excluded from normal candidate selection.

From Quarantine, they can later be:

```text
Return to training
→ eligible
```

or:

```text
Archive
→ still quarantined, hidden from normal queue
```

Quarantine previews and training-selection previews use the same reviewed annotation visualization, including multiple bounding boxes and corrected-coordinate fallback.

---

# Model Rollback

All models that were previously active production models remain potential rollback targets, except the model that is currently active.

A rejected candidate or failed training run is not a rollback target merely because a model record exists.

Conceptually:

```text
Rollback target
=
previously active production model
+
registered artifact still available
```

Rollback means **reactivating an existing model**, not retraining it.

It reuses:

* Model version
* Model artifact
* Model path
* Original training run
* Training provenance

No new training job or duplicate model version is created.

Example:

```text
Initial Model ACTIVE
Model 2 ARCHIVED

      ↓ rollback

Initial Model ARCHIVED
Model 2 ACTIVE
```

Rollback also reconciles trusted annotation state to the restored model.

This allows rollback to discard later accumulated training data from the **active trusted baseline** without deleting its history.

For example:

```text
Model 2 trusted:
A B C D

Model 3 trusted:
A B C D E
```

Rollback to Model 2:

```text
A B C D → trusted
E       → eligible
```

A later candidate can deliberately include E again if desired.

---

# Historical Model Comparison

Rollback models can be inspected before reactivation.

Historical comparison is read-only and cache-based.

```text
Current Active
      vs
Previous Production Model
```

The UI shows:

```text
Shared Product Performance
Products only in Current Active
Products only in Previous Model
```

Historical comparisons use already persisted model-comparison data.

Opening a rollback comparison does **not**:

* Launch YOLO evaluation
* Start a training/lifecycle job
* Call Kaggle
* Create a new comparison row
* Reapply candidate promotion eligibility

If no persisted comparison exists for the exact model pair, the comparison is shown as unavailable.

Rollback eligibility and candidate promotion eligibility are deliberately separate concepts.

A model that previously served in production remains a valid rollback target even if an equivalent new candidate would fail today's promotion thresholds.

---

# AI Progress

The **Teach Fridge → AI Progress** view exposes the model lifecycle to the mobile application.

It shows:

* Current active model
* Candidate and candidate state
* Candidate comparison
* Promotion/rejection controls
* Previously active rollback targets
* Cached historical comparisons
* Training History
* Active Model Products
* Quarantine

Candidate states distinguish situations such as:

```text
No candidate
Needs comparison
Comparison stale
Comparison invalid
Not eligible
Eligible for promotion
```

Training History contains actual candidate-training runs rather than model-activation events.

Active Model Products comes from persisted model metadata rather than the current refrigerator inventory.

For readability, models use presentation names such as:

```text
Initial Model
Model 2
Model 3
...
```

Internal model versions remain unchanged and continue to be used by backend actions.

---

# Local and Remote Training

Fridge 9000 supports two training providers:

```env
TRAINING_PROVIDER=local
```

and:

```env
TRAINING_PROVIDER=kaggle
```

Both use the same training semantics.

```text
Configured YOLO Foundation
          +
Combined Dataset
          ↓
Candidate Training
```

The current active model is supplied separately for:

* Class-preservation checks
* Comparison
* Provenance

It is not used as the candidate's starting weights.

---

## Local Training

Local training uses:

```env
TRAINING_STARTING_WEIGHTS_PATH
TRAINING_STARTING_MODEL_VERSION
LOCAL_BASE_DATASET_PATH
```

The local provider:

1. Exports trusted + selected correction data.
2. Combines it with the permanent base dataset.
3. Loads the configured pretrained YOLO foundation.
4. Loads the active detector separately as the capability baseline.
5. Verifies that the dataset preserves every active class.
6. Trains the isolated candidate.
7. Verifies that the candidate preserves every active class.
8. Registers the candidate and training provenance.
9. Compares it against the active detector.

---

## Kaggle Training

Kaggle uses the same foundation and dataset semantics but executes the training workload remotely on a GPU.

Conceptually:

```text
Backend
   │
   ├── Combined Dataset
   ├── Fixed Starting Model
   ├── Current Active Model
   └── Training Job Metadata
             ↓
           Kaggle
             ↓
      Returned Artifacts
             ↓
      Backend Validation
             ↓
     Candidate Registration
```

Kaggle is a compute provider, not the authority over Fridge model state.

The backend validates returned:

* Dataset identity
* Model identity
* Starting-model identity
* Class mappings
* Class preservation
* Metrics
* Class-aware comparison data
* Artifact hashes

before accepting the result.

A Kaggle run can complete successfully while its resulting candidate is still rejected by Fridge 9000.

PostgreSQL and the backend model registry remain the source of truth.

---

# Architecture

Fridge 9000 is organized around domain boundaries rather than a single backend or mobile application module.

At a high level:

```text
                 React Native / Expo
                         │
                         ▼
                 Feature / API Layer
                         │
                         ▼
                    FastAPI API
                         │
                         ▼
                  Domain Services
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
      Local CPU/GPU or Kaggle
```

## Backend Organization

FastAPI routing is separated from application behavior.

Modules under `backend/api/` define HTTP routes and delegate work to the corresponding domain service instead of containing the full implementation.

```text
HTTP Request
     ↓
backend/api/*
     ↓
backend/services/*
     ↓
Database / ML / Filesystem
```

The service layer is divided by responsibility:

* `annotations.py` manages reviewed human corrections and annotation workflow.
* `detection.py` owns detector loading and inference-related behavior.
* `events.py` handles event and alert operations.
* `freshness_analysis.py` owns freshness-classification requests.
* `inventory.py` manages inventory batches, quantities, expiry state, and inventory updates.
* `media_images.py` contains shared image/media helpers.
* `model_lifecycle.py` manages candidate training state, comparison, promotion, rejection, rollback, and model registry operations.
* `outlines.py` manages representative images and SAM2 outline preparation.
* `receipts.py` handles receipt ingestion and OCR-related processing.
* `scans.py` manages refrigerator scans, scan review, stored detections, and scan images.

`backend/services/runtime.py` remains only as a small compatibility facade for startup dependencies. It no longer acts as the central implementation module for unrelated application behavior.

Database responsibilities are also separated under `backend/db/`.

```text
backend/db/
├── connection.py
├── lifecycle_state.py
└── schema.py
```

`connection.py` owns database connection creation, `schema.py` owns idempotent runtime schema initialization and migration compatibility, and `lifecycle_state.py` contains annotation-state reconciliation associated with the active model lifecycle.

This keeps HTTP routing, application behavior, and database initialization from accumulating in one shared module.

## Mobile Organization

The mobile application uses Expo Router for route-level screens, while reusable feature behavior lives under `mobile/src/`.

Route files under `mobile/app/` primarily compose screens and connect feature modules rather than implementing every network request, modal, state transition, and presentation concern directly.

The largest workflow, **Teach Fridge**, is divided into a dedicated feature package:

```text
mobile/src/features/teach-fridge/
├── components/
│   ├── contributions/
│   ├── modals/
│   ├── progress/
│   └── suggestions/
├── hooks/
├── annotationUtils.ts
├── contributionUtils.ts
├── modelUtils.ts
├── styles.ts
└── types.ts
```

The route-level `teach-fridge.tsx` screen coordinates these pieces while specialized hooks own workflow state such as:

* AI progress
* Annotation editing
* Contributions
* Model lifecycle actions
* Moderation
* Quarantine
* Rollback comparison
* Suggestions
* Training selection

Presentation is similarly broken into focused components for suggestions, contributions, lifecycle progress, training data, quarantine, rollback, and model comparison.

This prevents the Teach Fridge workflow from depending on one multi-thousand-line screen component and allows individual parts of the lifecycle to evolve independently.

## Mobile API Layer

Mobile networking is also divided by backend domain.

```text
mobile/src/services/api/
├── client.ts
├── annotations.ts
├── events.ts
├── freshness.ts
├── inventory.ts
├── models.ts
├── outlines.ts
├── receipts.ts
├── scans.ts
└── index.ts
```

`client.ts` contains shared request construction, JSON response handling, and normalized API errors.

Domain modules contain the endpoint-specific calls.

The previous `mobile/src/services/api.ts` path remains as a lightweight compatibility export rather than a single file containing the complete mobile API implementation.

This gives both sides of the application similar boundaries:

```text
Mobile Feature
      ↓
Domain API Client
      ↓
FastAPI Domain Router
      ↓
Backend Domain Service
      ↓
Database / ML Service
```

PostgreSQL stores persistent application state and model-lifecycle metadata.

Generated artifacts such as uploads, dataset exports, comparison artifacts, and candidate models are stored outside Git.

---

# Technology Stack

## Backend

* Python
* FastAPI
* PostgreSQL
* psycopg2
* OpenCV
* Ultralytics YOLO
* PyTorch
* SAM2
* Tesseract OCR
* Pillow
* NumPy

## Mobile

* React Native
* Expo
* Expo Router
* TypeScript

## Infrastructure and Testing

* Docker
* Docker Compose
* PostgreSQL 16
* pytest
* TypeScript compiler
* ESLint
* Expo Doctor
* Kaggle GPU training

---

# Project Structure

```text
Fridge9000/
├── backend/
│   ├── api/                         # Thin FastAPI domain routers
│   │   ├── annotations.py
│   │   ├── events.py
│   │   ├── inventory.py
│   │   ├── models.py
│   │   ├── outlines.py
│   │   ├── receipts.py
│   │   ├── scans.py
│   │   └── system.py
│   │
│   ├── core/
│   │   └── config.py                # Backend configuration
│   │
│   ├── db/
│   │   ├── connection.py            # PostgreSQL connections
│   │   ├── lifecycle_state.py       # Annotation trust-state reconciliation
│   │   └── schema.py                # Runtime schema initialization
│   │
│   ├── services/                    # Domain application behavior
│   │   ├── annotations.py
│   │   ├── detection.py
│   │   ├── events.py
│   │   ├── freshness_analysis.py
│   │   ├── inventory.py
│   │   ├── media_images.py
│   │   ├── model_lifecycle.py
│   │   ├── outlines.py
│   │   ├── receipts.py
│   │   ├── runtime.py               # Startup compatibility facade
│   │   └── scans.py
│   │
│   ├── tests/
│   │   ├── api/
│   │   ├── integration/
│   │   ├── unit/
│   │   ├── e2e/
│   │   └── ml/
│   │
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
│   ├── app/                          # Expo Router screens
│   │   └── teach-fridge.tsx         # Teach Fridge orchestration screen
│   │
│   ├── assets/
│   │
│   └── src/
│       ├── components/               # Shared application components
│       │
│       ├── features/
│       │   └── teach-fridge/
│       │       ├── components/
│       │       │   ├── contributions/
│       │       │   ├── modals/
│       │       │   ├── progress/
│       │       │   └── suggestions/
│       │       ├── hooks/
│       │       ├── annotationUtils.ts
│       │       ├── contributionUtils.ts
│       │       ├── modelUtils.ts
│       │       ├── styles.ts
│       │       └── types.ts
│       │
│       ├── services/
│       │   ├── api/
│       │   │   ├── client.ts
│       │   │   ├── annotations.ts
│       │   │   ├── events.ts
│       │   │   ├── freshness.ts
│       │   │   ├── inventory.ts
│       │   │   ├── models.ts
│       │   │   ├── outlines.ts
│       │   │   ├── receipts.ts
│       │   │   ├── scans.ts
│       │   │   └── index.ts
│       │   └── config.ts
│       │
│       ├── theme/
│       ├── types/
│       └── utils/
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

The structure intentionally keeps route definitions, domain behavior, persistence setup, mobile networking, and complex UI workflows separate.

The goal is not to create layers merely for their own sake, but to keep high-complexity areas such as inventory, annotation moderation, and the model lifecycle independently navigable and testable.

---

# Running Fridge 9000

## Requirements

Install:

* Docker Desktop
* Git
* Node.js / npm
* Expo Go on the mobile device

Clone:

```bash
git clone https://github.com/netanel770/Fridge9000.git
cd Fridge9000
```

Install mobile dependencies:

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

A custom API URL or Expo tunnel can also be supplied through `start-fridge.ps1`.

---

## Stopping Fridge 9000

Press:

```text
Ctrl+C
```

in the launcher window.

The launcher stops Expo and Docker Compose while preserving the PostgreSQL volume.

Do not run:

```bash
docker compose down -v
```

unless you intentionally want to delete the development database.

---

# Persistent Development Data

Git contains application source code but intentionally does **not** contain all runtime state.

Persistent Fridge data includes:

* PostgreSQL database
* Uploaded scan images
* Candidate model artifacts
* Dataset exports
* Model-comparison artifacts
* Base training dataset
* Remote-training job state
* Local `.env`

Important runtime directories include:

```text
backend/uploads/
backend/candidate_models/
backend/dataset_exports/
backend/model_comparisons/
backend/base_dataset/
backend/remote_training_jobs/
```

The model registry and model artifacts should be treated as one persistent system.

PostgreSQL stores model versions and their artifact paths while trained `.pt` files live on disk.

Restoring only PostgreSQL without restoring those files can leave model records pointing to missing artifacts.

For this reason Fridge includes a backup / machine-transfer workflow that captures both.

---

# Backup and Machine Transfer

Fridge 9000 includes:

```text
export-fridge-data.bat
import-fridge-data.bat
scripts/fridge-data.ps1
```

These scripts allow a development installation to move between computers while preserving both application state and generated ML artifacts.

---

## Export

From the repository root:

```cmd
export-fridge-data.bat
```

The export captures:

* PostgreSQL database
* `.env` when present
* Uploads
* Candidate model artifacts
* Dataset exports
* Model comparisons
* Base dataset
* Remote training state when present
* Backup manifest
* Source Git branch and commit

The backend is stopped while runtime files are copied to avoid creating an inconsistent snapshot.

---

## Import

Clone the repository first, then run:

```cmd
import-fridge-data.bat "C:\path\to\fridge9000-backup.zip"
```

Import requires explicit confirmation because it replaces the destination development database and managed runtime directories.

The importer restores the database and matching artifacts as one coherent snapshot.

If destination data should be preserved, export it before importing another backup.

---

# Configuration

Start with:

```cmd
copy .env.example .env
```

## Common Training Configuration

```env
TRAINING_PROVIDER=local

TRAINING_STARTING_WEIGHTS_PATH=/app/yolo11s.pt
TRAINING_STARTING_MODEL_VERSION=yolo11s-pretrained

LOCAL_BASE_DATASET_PATH=/app/base_dataset

MAX_SHARED_MAP50_95_REGRESSION=0.02
MIN_ADDED_CLASS_MAP50_95=0.50
MIN_ADDED_CLASS_PER_CLASS_MAP50_95=0.30
```

`TRAINING_STARTING_*` applies to **both local and Kaggle training**.

Legacy `KAGGLE_STARTING_*` variables are still accepted as compatibility fallbacks when the generic settings are not provided.

---

## Kaggle Configuration

```env
TRAINING_PROVIDER=kaggle

KAGGLE_USERNAME=your_kaggle_username
KAGGLE_API_TOKEN=your_kaggle_api_token

KAGGLE_DATASET_SLUG_PREFIX=fridge9000-training-data
KAGGLE_KERNEL_SLUG=your_kaggle_username/fridge9000-remote-yolo-trainer
KAGGLE_MACHINE_SHAPE=NvidiaTeslaT4

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
Train Candidate
```

The system:

1. Presents eligible submissions with their reviewed annotations and bounding boxes.
2. Allows unwanted eligible data to be moved to Quarantine.
3. Selects approved eligible submissions for the new run.
4. Automatically includes trusted baseline corrections.
5. Exports a versioned correction dataset.
6. Combines corrections with the permanent base dataset.
7. Loads the fixed pretrained YOLO training foundation.
8. Loads the current active model separately as the capability/comparison baseline.
9. Verifies that every active class is preserved.
10. Starts local or remote training.
11. Produces an isolated candidate model.
12. Verifies candidate class preservation.
13. Registers its training provenance.
14. Evaluates it against the current active detector.
15. Stores overall, shared-class, and added-class comparison data.
16. Applies the backend promotion policy.
17. Waits for explicit promotion or rejection.

The active detector remains unchanged throughout the entire process.

Backend lifecycle activity can be viewed with:

```bash
docker compose logs -f backend
```

---

# Testing

Fridge 9000 uses a separate PostgreSQL test environment so automated tests do not modify normal development data.

The test suite follows the same domain-oriented structure used by the backend.

Focused API tests cover areas including annotations, freshness analysis, model lifecycle, product outlines, receipts, scans, and system health.

Integration tests cover persistence-heavy behavior including inventory and schema initialization, while smaller unit tests cover isolated utilities and image-processing behavior.

Lifecycle and integration tests exercise operations including:

* Fresh schema initialization
* Candidate registration
* Provider parity
* Class preservation
* Promotion
* Rejection
* Quarantine
* Archive / unarchive
* Returning quarantined data to training
* Rollback
* Repeated model reactivation
* Annotation trust reconciliation
* Cached rollback comparison
* Training provenance
* Inventory batch migration

The refactored backend service boundaries preserve the existing HTTP API while allowing these domains to be exercised without depending on one central runtime implementation.

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

Start the isolated test database:

```bash
docker compose -f docker-compose.test.yml -p fridge9000-test up -d --wait
```

Run:

```bash
pytest
```

Stop afterward:

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

* `.env` and real API credentials must never be committed.
* Runtime uploads and generated training artifacts are intentionally ignored by Git.
* FastAPI modules under `backend/api/` should remain focused on HTTP routing; domain behavior belongs under `backend/services/`.
* Database connection, schema initialization, and active-model annotation reconciliation are separated under `backend/db/`.
* `backend/services/runtime.py` is retained only as a small startup compatibility facade rather than a general-purpose service module.
* Mobile API calls are grouped by backend domain under `mobile/src/services/api/` and share common request/error handling through `client.ts`.
* Complex mobile workflows should keep route-level screens focused on composition and move reusable state and behavior into feature hooks/components.
* Teach Fridge is organized as a dedicated feature package rather than a single monolithic screen implementation.
* Inventory batches are the authoritative inventory representation.
* Only one detector can be active at a time.
* Only one unresolved candidate can exist at a time.
* Every candidate starts from the configured fixed pretrained YOLO foundation.
* The active Fridge model is the class-preservation and comparison baseline, not the training starting weights.
* Candidate datasets contain the permanent base dataset, trusted active-model corrections, and explicitly selected eligible corrections.
* All active-model classes must be preserved by a candidate.
* Candidate training never silently changes the active detector.
* Promotion is explicit and backend-authoritative.
* Rejected experimental data is quarantined.
* Quarantined data can be returned to the eligible training pool.
* Quarantine archiving controls workflow visibility without deleting provenance or creating another training state.
* Annotation trust follows the model currently serving predictions.
* Historical provenance is never rewritten merely because the active model changes.
* All previously active production models can remain rollback targets while their artifacts are available.
* Candidate promotion rules do not retroactively determine rollback eligibility.
* Rollback comparisons are read-only and use persisted historical comparison data.
* Rollback reactivates existing model versions without retraining.
* Local and Kaggle providers use the same starting-model and cumulative-data semantics.
* Kaggle provides remote compute while the Fridge backend remains the lifecycle authority.
* Freshness classification remains separate from the detector lifecycle.
* Development and test PostgreSQL environments are separated.
* Database backups and trained-model artifacts must be transferred together.

---

# Project Goal

Fridge 9000 is designed to go substantially beyond calling a pretrained object detector.

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
Annotation Lifecycle Management
+
Training Provenance
+
Versioned Datasets
+
Fixed-Foundation Candidate Training
+
Cumulative Trusted Training Data
+
Local / Remote Training Providers
+
Class-Preservation Validation
+
Class-Aware Evaluation
+
Explicit Model Promotion
+
Candidate Quarantine
+
Historical Model Comparison
+
Model Rollback / Reactivation
+
Persistent Runtime State
+
Portable Backup / Restore
```

into one end-to-end smart refrigerator system.

The important part is not only that Fridge 9000 can make predictions.

It can collect and moderate corrections, preserve where those corrections came from, build cumulative datasets, train isolated candidates from a reproducible pretrained foundation, compare them against the current production detector, prevent class loss, evaluate established and newly added products separately, quarantine rejected experimental data, restore previous production models without retraining, reconcile trusted data after rollback, and preserve the complete application and ML lifecycle across machines.
