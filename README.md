<p align="center">
  <img src="assets/fridge9000-banner.png" alt="Fridge9000" width="100%">
</p>

# Fridge 9000

Fridge 9000 is a smart refrigerator management system that combines **computer vision, inventory tracking, OCR, freshness analysis, and human-in-the-loop machine learning**.

The mobile app can scan refrigerator images, review AI detections, update inventory, track expiration dates, process receipts, analyze freshness, and collect human corrections that can later be used to train improved detector models.

---

## Features

### AI Product Detection

Fridge 9000 uses **YOLO** to detect supported products from refrigerator images.

It stores:

- Product labels
- Confidence scores
- Bounding boxes
- Scan history

Users can review detections before inventory changes are applied.

Incorrect predictions can be corrected by:

- Changing the product label
- Adjusting the bounding box
- Removing false-positive detections
- Adding products the detector missed
- Confirming correct detections

A scan is still stored even when YOLO detects nothing, allowing users to manually annotate completely new or previously unsupported products.

---

### Inventory Management

The application supports:

- Adding products from refrigerator scans
- Manual inventory updates
- Product quantities
- Separate inventory batches
- Expiration dates
- Estimated expiration dates
- Partially consumed products
- Inventory event history
- Low-stock and missing-product alerts

---

### Receipt OCR

Shopping receipts can be uploaded as images or PDFs.

The backend uses **Tesseract OCR** to extract products from receipts.

Detected products can be reviewed before being added to inventory.

---

### Freshness Detection

Fridge 9000 includes a separate image-classification model for supported freshness or rot detection.

Freshness classification is intentionally separate from the YOLO product-detection lifecycle because freshness and product identification are different machine-learning tasks.

---

### SAM2 Segmentation

YOLO detections can be passed to **SAM2** to generate representative product segmentation masks and outlines.

YOLO handles product detection while SAM2 is used downstream to refine the detected product region.

The segmentation pipeline evaluates candidate masks instead of blindly accepting the first generated result.

---

# Teach AI

Fridge 9000 includes a full **human-in-the-loop learning workflow**.

Users can correct normal AI scans or upload images and annotate products manually.

Supported annotation actions:

```text
CONFIRM
RELABEL
ADJUST_BOX
ADD
REMOVE
```

Users can:

1. Run a normal refrigerator scan.
2. Review the AI predictions.
3. Correct labels, boxes, false positives, or missed products.
4. Submit corrections for moderation.
5. Approve useful contributions as training data.
6. Train a candidate model.
7. Compare the candidate against the active model.
8. Promote it only if the promotion policy passes.
9. Roll back to a previous model if necessary.

---

# Training Data Provenance

Fridge 9000 does not train directly on raw user feedback.

Every correction keeps information about where it came from and what the user changed.

For example:

```text
YOLO Detection
     ↓
RELABEL / ADJUST_BOX / CONFIRM / REMOVE
```

or:

```text
Manual Image
     ↓
ADD
```

Manual annotations are stored as genuine manual additions rather than fake YOLO predictions.

Corrections must also pass moderation before they become eligible for training.

```text
User Feedback
      ↓
Pending Annotation
      ↓
Moderation
      ↓
Approved Annotation
      ↓
Versioned Dataset
```

This creates a traceable path from a user contribution all the way to a trained model:

```text
User Feedback
      ↓
Approved Annotation
      ↓
Dataset Version
      ↓
Training Run
      ↓
Candidate Model
```

The system also records which annotations were consumed by training.

---

# Model Lifecycle

Detector improvement is handled as a versioned lifecycle instead of simply replacing `best.pt`.

```text
Scan / Manual Image
        ↓
Human Corrections
        ↓
Moderation
        ↓
Approved Training Data
        ↓
Versioned YOLO Dataset
        ↓
Candidate Training
        ↓
Active vs Candidate Comparison
        ↓
Promotion Policy
        ↓
Promotion or Rejection
        ↓
Rollback Available
```

The system tracks:

- Annotation submissions
- Dataset versions
- Training runs
- Model versions
- Training parameters
- Training metrics
- Model comparisons
- Contributions used for training
- Promotion history
- Rollback history

Only one detector is active at a time.

Training a candidate does **not** replace the active detector.

The current model continues serving predictions while the candidate is trained and evaluated.

Promotion is always explicit.

---

# Incremental Training Without Forgetting Existing Products

New corrections are not trained in isolation.

Training only on newly collected examples could improve a new product while causing the model to forget products it already knows.

Fridge 9000 therefore separates the correction dataset from the permanent base dataset for traceability, then combines them during candidate training.

```text
Permanent Base Dataset
          +
Approved Corrections
          ↓
Combined Training Dataset
          ↓
Candidate Training
```

This allows new user corrections to improve the detector while preserving the original training knowledge.

Before a remotely trained candidate is registered, the system also verifies that it still contains every class supported by the active model.

A candidate that loses an existing product class is rejected.

---

# Model Comparison

The active and candidate models are evaluated using the same evaluation data and configuration.

The comparison records metrics including:

- Precision
- Recall
- mAP50
- mAP50-95
- Per-class metrics
- Shared-class metrics
- Added-class metrics

For normal candidates with the same set of classes, overall model performance can be compared directly.

When a candidate introduces new classes, Fridge 9000 instead separates:

```text
Existing products shared by both models
```

from:

```text
New products introduced by the candidate
```

This prevents strong performance on new products from hiding a serious regression on existing ones.

---

# Model Promotion Policy

Fridge 9000 uses the backend promotion policy:

```text
class-aware-promotion-v1
```

A candidate must pass this policy before it can replace the active detector.

There are two promotion modes.

---

## Same Product Classes

If the active and candidate models support the same product classes, the candidate must outperform the active model.

The primary metric is:

```text
mAP50-95
```

The candidate passes when:

```text
candidate mAP50-95 > active mAP50-95
```

If their mAP50-95 values are effectively equal, `mAP50` is used as the tie-breaker:

```text
candidate mAP50 > active mAP50
```

Otherwise, promotion is blocked.

---

## Candidate Adds New Product Classes

A candidate that introduces new product classes must pass **all** of the following checks.

### 1. Existing classes must be preserved

The candidate cannot remove a product class supported by the active model.

```text
Removed existing class
→ Promotion blocked
```

Every existing class must also have valid comparison metrics.

---

### 2. Existing-product regression is limited

The candidate may lose at most:

```env
MAX_SHARED_MAP50_95_REGRESSION=0.02
```

That means a maximum regression of **2 percentage points of mAP50-95** on products already supported by the active model.

Example:

```text
Active shared mAP50-95:     89%
Candidate shared mAP50-95:  88%
Difference:                 -1%

PASS
```

But:

```text
Active shared mAP50-95:     89%
Candidate shared mAP50-95:  79%
Difference:                -10%

BLOCKED
```

---

### 3. New classes must perform well overall

The average mAP50-95 across newly added classes must reach:

```env
MIN_ADDED_CLASS_MAP50_95=0.50
```

Equivalent to:

```text
50% average mAP50-95
```

---

### 4. Every new class must meet a minimum

Each new class must individually reach:

```env
MIN_ADDED_CLASS_PER_CLASS_MAP50_95=0.30
```

Equivalent to:

```text
30% mAP50-95 per class
```

This prevents a strong average from hiding a poorly performing new product.

For example:

```text
Lemon       65%
Milk        58%
Yogurt      12%
```

Promotion would still be blocked because `Yogurt` is below the minimum.

---

## Additional Promotion Safety

Promotion is also blocked when:

- No comparison exists
- The comparison is stale
- The candidate was compared against a model that is no longer active
- An existing class disappeared
- Shared-class metrics are missing
- Added-class metrics are incomplete
- Comparison metrics are malformed or non-finite

The backend makes the final promotion decision.

The mobile application displays that decision and only enables promotion when the backend reports that the candidate is eligible.

### Default Promotion Thresholds

```env
MAX_SHARED_MAP50_95_REGRESSION=0.02
MIN_ADDED_CLASS_MAP50_95=0.50
MIN_ADDED_CLASS_PER_CLASS_MAP50_95=0.30
```

In short:

```text
Same classes
    ↓
Candidate must outperform active model
```

or:

```text
New classes added
    ↓
No existing classes removed
    +
Existing products lose ≤ 2% mAP50-95
    +
New classes average ≥ 50% mAP50-95
    +
Every new class ≥ 30% mAP50-95
    ↓
Eligible for promotion
```

Even after passing the policy, the candidate does **not** automatically become active.

Promotion remains an explicit action.

---

# Remote Training Validation

Kaggle is used as a **GPU compute provider**, not as a trusted source of truth.

A completed Kaggle notebook does not automatically create a valid candidate.

When remote training finishes, the backend validates:

- Training-run identity
- Candidate artifacts
- Model metadata
- Class mappings
- Class preservation
- Comparison metrics
- Numeric metric validity
- Class-aware comparison results

The backend also recomputes the canonical class-aware comparison before registering the candidate.

```text
Kaggle Training
      ↓
Remote Artifacts
      ↓
Backend Validation
      ↓
Candidate Registration
      ↓
Promotion Policy
```

A remote run can therefore finish successfully while the resulting candidate is still rejected or blocked from promotion.

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
- NumPy
- Pillow

## Mobile

- React Native
- Expo
- TypeScript
- Expo Router

## Infrastructure

- Docker
- Docker Compose
- PostgreSQL 16
- pytest
- Kaggle GPU training

---

# Project Structure

```text
Fridge9000/
├── backend/
│   ├── api/                  FastAPI routes
│   ├── core/                 Application configuration
│   ├── db/                   Database helpers
│   ├── services/             Application and ML services
│   ├── tests/                Backend test suite
│   ├── class_aware_metrics.py
│   ├── model_promotion_policy.py
│   ├── export_yolo_dataset.py
│   ├── train_yolo_candidate.py
│   ├── compare_yolo_models.py
│   └── main.py
│
├── db/
│   └── init.sql
│
├── kaggle_trainer/
│   ├── train.py
│   └── kernel-metadata.json
│
├── mobile/
│   ├── app/
│   ├── assets/
│   └── src/
│
├── assets/
├── docker-compose.yml
├── docker-compose.test.yml
├── fridge-test.bat
├── run-fridge.bat
└── README.md
```

---

# Running Fridge 9000

## Requirements

Install:

- Docker Desktop
- Git
- Node.js and npm
- Expo Go on the mobile device

Clone the repository:

```bash
git clone https://github.com/netanel770/Fridge9000.git
cd Fridge9000
```

Install the mobile dependencies once:

```bash
cd mobile
npm install
cd ..
```

---

## Quick Start on Windows

Make sure **Docker Desktop is running**.

From the repository root, run:

```cmd
run-fridge.bat
```

The launcher automatically:

1. Detects a usable LAN IPv4 address.
2. Configures the mobile API URL.
3. Builds and starts PostgreSQL and FastAPI with Docker Compose.
4. Waits for the backend to become healthy.
5. Starts Expo.
6. Displays the Expo QR code.

Scan the QR code with **Expo Go**.

The phone and development PC must be able to reach each other on the same local network.

The backend is normally available at:

```text
http://<your-LAN-IP>:8000
```

---

## Stopping the Project

Press:

```text
Ctrl+C
```

in the launcher window.

The launcher shuts down Expo and the Docker services.

Development PostgreSQL data is preserved.

Do not run:

```bash
docker compose down -v
```

unless you intentionally want to delete the development database.

---

# Kaggle GPU Training Setup

Kaggle training is optional.

Fridge 9000 supports:

```env
TRAINING_PROVIDER=local
```

or:

```env
TRAINING_PROVIDER=kaggle
```

Kaggle is recommended when GPU training is required.

---

## 1. Create a Kaggle Account

Create or sign in to a Kaggle account.

Make sure the account can use GPU notebooks.

Kaggle may require phone verification before GPU accelerators become available.

---

## 2. Create a Kaggle API Token

Open your Kaggle account settings and go to the API section.

Generate an API token and copy it.

Never commit the token to Git.

---

## 3. Create the Permanent Base Dataset

Remote training combines:

```text
Permanent Base Dataset
          +
New Approved Corrections
```

Create a Kaggle dataset named:

```text
<your-kaggle-username>/fridge9000-training-data
```

The dataset must contain one YOLO base dataset with:

```text
base_dataset/
├── classes.txt
├── images/
│   ├── image001.jpg
│   ├── image002.jpg
│   └── ...
└── labels/
    ├── image001.txt
    ├── image002.txt
    └── ...
```

`classes.txt` contains one class name per line.

Each label file uses normal YOLO detection format:

```text
class_id center_x center_y width height
```

Example:

```text
0 0.512 0.423 0.245 0.531
```

Coordinates must be normalized between `0` and `1`.

Every image should have a matching label file.

---

## 4. Create `.env`

The repository contains:

```text
.env.example
```

Create a local `.env`:

```cmd
copy .env.example .env
```

`.env` is ignored by Git.

---

## 5. Configure Kaggle

Edit `.env`:

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

The configured starting weights must be pretrained YOLO weights rather than the current Fridge 9000 production model.

---

## 6. Optional Training Settings

Training settings can also be configured:

```env
MODEL_TRAIN_EPOCHS=30
MODEL_TRAIN_IMGSZ=640
MODEL_TRAIN_BATCH=8

MODEL_COMPARE_IMGSZ=640
MODEL_COMPARE_BATCH=8
```

---

## 7. Start Fridge 9000

After configuring `.env`, run:

```cmd
run-fridge.bat
```

---

## 8. Verify Kaggle Access

Check that the Kaggle CLI works inside the backend container:

```bash
docker compose exec backend kaggle --version
```

Verify that Kaggle is the selected provider:

```bash
docker compose exec backend printenv TRAINING_PROVIDER
```

Expected:

```text
kaggle
```

---

## 9. Train a Candidate

In the mobile application:

```text
Teach AI
→ Contributions
→ Approve useful corrections
→ AI Progress
→ Train Candidate
```

Fridge 9000 automatically:

1. Exports approved annotations.
2. Creates a versioned correction dataset.
3. Creates a private per-run Kaggle dataset.
4. Creates a private Kaggle training notebook.
5. Requests the configured GPU.
6. Combines the base dataset with approved corrections.
7. Trains the candidate.
8. Evaluates the active and candidate models.
9. Downloads the Kaggle artifacts.
10. Validates the remote results.
11. Registers the candidate if validation succeeds.

The active detector remains unchanged throughout this process.

---

## Watching Training Progress

Backend lifecycle logs:

```bash
docker compose logs -f backend
```

Typical phases include:

```text
preparing
uploading
waiting_for_dataset
queued
running
downloading
registering
completed
```

For epoch-by-epoch YOLO output, open the generated Kaggle notebook and view its output or logs.

---

# Testing

Fridge 9000 uses a separate PostgreSQL test database so automated tests do not modify normal development data.

## Full Windows Validation

From the repository root:

```cmd
fridge-test.bat
```

The validation runner executes:

1. Isolated PostgreSQL test database
2. Backend pytest suite
3. Training-provider tests
4. Kaggle worker tests
5. TypeScript checks
6. Mobile lint
7. Expo Doctor
8. Git whitespace validation

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

Stop the test database:

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

- `.env` must never be committed.
- Kaggle API tokens must never be committed.
- Runtime uploads should not be committed.
- Generated datasets should not be committed.
- Candidate model artifacts should not be committed.
- Model-comparison output should not be committed.
- The active detector remains unchanged while a candidate is training.
- Promotion is always explicit.
- Model rollback remains available after promotion.
- Freshness classification is separate from the YOLO detector lifecycle.
- Local and Kaggle training use the same candidate-model lifecycle.
- Expo runs on the Windows host while PostgreSQL and FastAPI run through Docker Compose.

---

# Goal

Fridge 9000 is designed to go beyond simple object detection.

The project combines:

```text
Computer Vision
+ Inventory Management
+ Human Feedback
+ Moderated Training Data
+ Versioned Datasets
+ Incremental Model Training
+ Remote GPU Training
+ Class-Aware Evaluation
+ Safe Model Promotion
+ Rollback
```

into one complete smart-fridge system.
