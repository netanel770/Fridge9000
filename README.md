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

Uploaded images are normalized before detection so the stored image, detector input, and annotation coordinates use the same orientation.

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

Freshness classification is intentionally separate from the YOLO product-detection lifecycle.

---

### SAM2 Segmentation

YOLO detections can be passed to **SAM2** to generate representative product segmentation masks and outlines.

The system evaluates candidate masks instead of blindly accepting the first segmentation result.

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
8. Promote it only if the backend promotion policy passes.
9. Roll back to a previous model if necessary.

Manual annotations do not create fake YOLO predictions.

They enter the same moderation and training pipeline while preserving their original source.

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

The active model is **never replaced automatically**.

---

## Class-Aware Model Promotion

Candidate models are evaluated using class-aware metrics.

A candidate cannot silently remove products already supported by the active model.

For candidates that introduce new product classes, the promotion policy checks:

- Performance on existing shared classes
- Average performance of new classes
- Performance of each individual new class

Current default policy:

```env
MAX_SHARED_MAP50_95_REGRESSION=0.02
MIN_ADDED_CLASS_MAP50_95=0.50
MIN_ADDED_CLASS_PER_CLASS_MAP50_95=0.30
```

This means a new model must improve the system without seriously damaging performance on existing products.

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
├── start-fridge.ps1
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

From the repository root run:

```powershell
.\start-fridge.ps1
```

The launcher automatically:

1. Detects a usable LAN IPv4 address.
2. Sets the mobile API URL.
3. Builds and starts PostgreSQL and FastAPI.
4. Waits for the backend to become healthy.
5. Starts Expo from the `mobile` directory.
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

in the launcher terminal.

The launcher shuts down Expo and the Docker services.

Development PostgreSQL data is preserved.

Do not run:

```bash
docker compose down -v
```

unless you intentionally want to delete the development database.

---

# Kaggle GPU Training

Kaggle training is optional.

Fridge 9000 supports both:

```env
TRAINING_PROVIDER=local
```

and:

```env
TRAINING_PROVIDER=kaggle
```

Kaggle is recommended when GPU training is required.

---

## 1. Create a Kaggle Account

Create or sign in to a Kaggle account.

Make sure the account is allowed to use GPU notebooks.

Depending on the account, Kaggle may require phone verification before GPU accelerators become available.

---

## 2. Create a Kaggle API Token

Open your Kaggle account settings.

Go to:

```text
Settings
→ API
→ Generate/Create API Token
```

Copy the generated token.

Never commit this token to Git.

---

## 3. Create the Permanent Base Dataset

Remote training combines:

```text
Permanent base dataset
        +
New approved Fridge 9000 corrections
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

`classes.txt` contains one product name per line:

```text
Osem Tomato Ketchup
Tirosh Wine
Tnuva 3% Milk
Tnuva Cottage Cheese
Yoplait Strawberry Yogurt
```

Each label file uses standard YOLO detection format:

```text
class_id center_x center_y width height
```

Example:

```text
0 0.512 0.423 0.245 0.531
```

Coordinates must be normalized between `0` and `1`.

Every image should have a matching `.txt` label file.

---

## 4. Create `.env`

The repository contains:

```text
.env.example
```

Create your local `.env`:

### Command Prompt

```cmd
copy .env.example .env
```

### PowerShell

```powershell
Copy-Item .env.example .env
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

The default project configuration uses:

```text
NvidiaTeslaT4
```

for remote training.

The configured starting weights must be **pretrained YOLO weights**, not the current Fridge 9000 production model.

---

## 6. Optional Training Settings

Training settings can also be configured through environment variables:

```env
MODEL_TRAIN_EPOCHS=30
MODEL_TRAIN_IMGSZ=640
MODEL_TRAIN_BATCH=8

MODEL_COMPARE_IMGSZ=640
MODEL_COMPARE_BATCH=8
```

The default training length is:

```text
30 epochs
```

---

## 7. Rebuild the Backend

After changing `.env`, rebuild the backend:

```bash
docker compose up -d --build
```

Or restart the normal launcher:

```powershell
.\start-fridge.ps1
```

---

## 8. Verify Kaggle Access

Check that the Kaggle CLI works inside the backend container:

```bash
docker compose exec backend kaggle --version
```

You can also verify the configured environment:

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

Fridge 9000 then automatically:

1. Exports approved annotations.
2. Creates a versioned correction dataset.
3. Creates a private per-run Kaggle dataset.
4. Creates a private Kaggle training notebook.
5. Requests the configured GPU.
6. Combines the base dataset with the corrections.
7. Trains the candidate model.
8. Evaluates the active and candidate models.
9. Downloads the Kaggle artifacts.
10. Validates them locally.
11. Registers the candidate.

The active model continues serving predictions during this entire process.

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

The Kaggle notebook page can be used to see YOLO's epoch-by-epoch training output.

---

## Kaggle Training Safety

Remote artifacts are not blindly trusted.

Before candidate registration, the backend validates:

- Training-run identity
- Candidate model metadata
- Class mappings
- Class preservation
- Comparison metrics
- Numeric metric validity
- Candidate artifacts

The backend recomputes class-aware comparison data before storing it.

A completed Kaggle training job still does **not** automatically activate the candidate.

Promotion remains a separate explicit action.

---

# Testing

Fridge 9000 uses a separate PostgreSQL test database.

The test database does not use the normal development database volume.

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
- Freshness classification is separate from the YOLO detector lifecycle.
- Expo runs on the Windows host while PostgreSQL and FastAPI run through Docker Compose.

---

# Goal

Fridge 9000 is designed to go beyond simple object detection.

The project combines:

```text
Computer Vision
+ Inventory Management
+ Human Feedback
+ Versioned Training Data
+ Remote GPU Training
+ Model Evaluation
+ Safe Promotion
+ Rollback
```

into one complete smart-fridge system.
