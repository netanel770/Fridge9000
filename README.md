<p align="center">
  <img src="assets/fridge9000-banner.png" alt="Fridge9000" width="100%">
</p>

# Fridge 9000

Fridge 9000 is a smart refrigerator management system that combines **computer vision, inventory tracking, OCR, freshness analysis, and a human-in-the-loop ML pipeline** to help users understand what is in their fridge and reduce food waste.

The system can detect products from refrigerator images, review and correct AI predictions, track inventory and expiration dates, process shopping receipts, classify product freshness, and turn approved human annotations into traceable training data for future detector versions.

## Features

### AI Product Detection

* Detects food and beverage products using **YOLO**.
* Stores detection labels, confidence scores, and bounding boxes.
* Lets users review detections before applying inventory changes.
* Supports correcting labels, adjusting boxes, removing false positives, and adding missed products.

### Human-in-the-Loop Learning

Fridge 9000 includes a complete annotation and model-improvement workflow.

Supported annotation actions:

```text
CONFIRM
RELABEL
ADJUST_BOX
ADD
REMOVE
```

Users can teach the detector in two ways:

1. **AI-assisted annotation**

   * Run a normal YOLO scan.
   * Review the detected products.
   * Confirm or correct the model's predictions.

2. **Manual annotation**

   * Upload an image without running YOLO.
   * Draw bounding boxes and assign product labels manually.
   * Submit annotations through the same moderation and training pipeline.

Manual annotations do not create fake detector predictions. They are stored as `ADD` annotations with no source detection, preserving accurate provenance.

Approved annotations can later be exported into versioned YOLO datasets and used to train candidate detector models.

### Model Lifecycle

Detector improvement is treated as a versioned workflow rather than simply overwriting `best.pt`.

```text
Image
  ↓
YOLO Detection / Manual Annotation
  ↓
Human Annotation
  ↓
Moderation
  ↓
Approved Training Data
  ↓
Versioned Dataset
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

* Annotation submissions and individual corrections
* Dataset versions
* Training runs
* Starting model and weights
* Training parameters and metrics
* Which annotations were consumed by training
* Candidate and active model versions
* Model comparisons
* Promotion and rollback history

Only one detector can be active at a time.

### Inventory Management

* Add or remove products using refrigerator scans.
* Add products manually.
* Track quantities using separate inventory batches.
* Track multiple expiration dates for the same product.
* Track partially consumed/open products.
* Preserve inventory event history.

### Expiration and Alerts

Fridge 9000 tracks known or estimated expiration dates and can identify:

* Expired products
* Products expiring soon
* Low-stock products
* Missing products

### Receipt OCR

Shopping receipts can be uploaded as images or PDFs.

The backend uses **Tesseract OCR** to extract purchased products, which can then be reviewed before being added to inventory.

### SAM2 Product Segmentation

YOLO detections can be passed to **SAM2** to generate representative product outlines.

The segmentation pipeline evaluates candidate masks using filtering and quality checks rather than blindly accepting the first SAM result.

### Freshness Classification

A separate image-classification model can evaluate supported products for freshness or rot.

Freshness classification is intentionally separate from the YOLO detector lifecycle.

### Mobile Application

The mobile application is built with **React Native, Expo, TypeScript, and Expo Router**.

It provides interfaces for:

* Inventory
* Product scans
* Detection review
* Manual annotation
* AI contributions and moderation
* Model progress
* Alerts and expiration
* Receipts
* Freshness detection
* Inventory history

---

## Architecture

```text
                         Fridge 9000
                              │
                              ▼
                    React Native / Expo
                              │
                              ▼
                       FastAPI Backend
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
    YOLO + SAM2          Tesseract OCR       Inventory
          │                                       │
          ▼                                       ▼
   Detection Review                         PostgreSQL
          │                                       ▲
          ▼                                       │
 Human / Manual Annotations ──────────────────────┘
          │
          ▼
     Moderation
          │
          ▼
 Versioned Dataset
          │
          ▼
 Candidate Training
          │
          ▼
 Model Comparison
          │
          ▼
 Promotion / Rollback
```

## Technology Stack

### Backend

* Python
* FastAPI
* PostgreSQL
* psycopg2
* OpenCV
* Ultralytics YOLO
* SAM2
* Tesseract OCR
* NumPy

### Mobile

* React Native
* Expo
* TypeScript
* Expo Router

### Infrastructure and Testing

* Docker
* Docker Compose
* PostgreSQL 16
* pytest
* FastAPI TestClient

---

## Repository Structure

```text
Fridge9000/
├── backend/
│   ├── api/                  # FastAPI route definitions
│   ├── core/                 # Application configuration
│   ├── db/                   # Database helpers
│   ├── services/             # Application and ML services
│   ├── tests/                # Backend test suite
│   ├── main.py               # FastAPI entry point
│   ├── train_yolo_candidate.py # Local candidate training
│   ├── export_yolo_dataset.py
│   └── compare_yolo_models.py
│
├── db/
│   └── init.sql              # PostgreSQL schema
│
├── mobile/
│   ├── app/                  # Expo Router screens
│   ├── assets/
│   ├── src/
│   └── package.json
│
├── kaggle_trainer/           # Remote training support
├── docker-compose.yml        # Development DB + backend
├── docker-compose.test.yml   # Isolated PostgreSQL test DB
├── run-fridge.bat            # One-click Windows launcher
├── start-fridge.ps1          # PowerShell launcher and lifecycle management
├── pytest.ini
└── README.md
```

---

# Running Fridge 9000

## Requirements

Install:

* Docker Desktop
* Git
* Node.js and npm
* Expo Go on the mobile device used for development

Python is also required when running the backend test suite directly from the host.

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

## Quick Start on Windows

Make sure **Docker Desktop is running**.

Then double-click:

```text
run-fridge.bat
```

Alternatively, from Command Prompt:

```cmd
run-fridge
```

The launcher automatically:

1. Detects a suitable LAN IPv4 address.
2. Sets `EXPO_PUBLIC_API_BASE_URL`.
3. Builds and starts PostgreSQL and FastAPI with Docker Compose.
4. Waits for the backend services to become healthy.
5. Starts Expo directly from `mobile/`.
6. Displays the Expo QR code for connecting the mobile application.

The normal development architecture is:

```text
PostgreSQL  ─┐
             ├── Docker Compose
FastAPI      ─┘

Expo / Metro ─── Windows host
```

Expo intentionally runs outside Docker so its interactive CLI, LAN discovery, and QR code work normally.

Once Expo starts, scan the displayed QR code using **Expo Go**.

The phone and development PC must be able to reach each other on the same local network.

The backend is automatically exposed at:

```text
http://<your-LAN-IP>:8000
```

## Stopping Fridge 9000

Press:

```text
Ctrl + C
```

in the launcher terminal.

The launcher automatically:

1. Stops Expo.
2. Shuts down the FastAPI and PostgreSQL Docker containers.
3. Restores the previous `EXPO_PUBLIC_API_BASE_URL` environment state.
4. Restores the original terminal working directory.

The PostgreSQL development data is preserved between runs because the Docker volume is not deleted.

Do **not** use:

```bash
docker compose down -v
```

unless you intentionally want to delete the development database volume.

## Advanced Launcher Usage

The underlying PowerShell launcher can also be run directly from the project root:

```powershell
.\start-fridge.ps1
```

### Custom Backend URL

A specific backend URL can be supplied with:

```powershell
.\start-fridge.ps1 -ApiUrl "https://example.com"
```

### Expo Tunnel Mode

Expo tunnel mode is also available:

```powershell
.\start-fridge.ps1 -Tunnel
```

`-Tunnel` tunnels the Expo development server. It does not automatically expose the FastAPI backend, so the configured API URL must still be reachable from the phone.

---

# Testing

The backend test suite uses a **separate PostgreSQL 16 database** so tests cannot accidentally modify the development database.

The isolated test database:

* Uses database `fridge9000_test`
* Runs on host port `5433`
* Uses temporary storage instead of the development database volume
* Is rejected by the fixtures if configured to use the normal development database

Install test dependencies:

```bash
python -m pip install -r backend/requirements-test.txt
```

Start the isolated test database:

```bash
docker compose -f docker-compose.test.yml -p fridge9000-test up -d --wait
```

Run the full backend suite:

```bash
pytest
```

Run API tests:

```bash
pytest -m api
```

Run integration tests:

```bash
pytest -m integration
```

Run the normal suite while excluding ML and end-to-end tests:

```bash
pytest -m "not ml and not e2e"
```

The current automated tests cover important workflows including:

* Database and health checks
* Inventory and inventory batches
* Scan persistence and review
* Inventory consistency and transaction rollback
* Annotation creation and validation
* Moderation and annotation provenance
* Manual annotation without YOLO inference
* Invalid and cross-scan/cross-image operations

Manual-annotation tests can also be run directly:

```bash
pytest backend/tests/api/test_manual_annotations.py -v
```

Stop the isolated test database when finished:

```bash
docker compose -f docker-compose.test.yml -p fridge9000-test down
```

## Mobile Validation

From `mobile/`:

```bash
npm run lint
npx expo-doctor
```

---

## Development Notes

Runtime-generated uploads, model outputs, datasets, test caches, and local environment files should not be committed.

The root `.env` file is optional and ignored by Git. See `.env.example` for configurable values used by model training and other development workflows.

The mobile application receives its backend URL through:

```text
EXPO_PUBLIC_API_BASE_URL
```

Do not hardcode local IP addresses in the mobile source code.
