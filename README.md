# Fridge 9000

Fridge 9000 is a smart refrigerator management system that uses **computer vision, OCR, inventory tracking, expiration management, and a human-in-the-loop model lifecycle** to help users understand what is inside their fridge and reduce food waste.

The system can detect products from images, track inventory changes, process shopping receipts, estimate expiration dates, generate alerts, collect reviewed detections as training data, train candidate detector models, compare them against the active model, and promote or roll back model versions.

## Features

* **AI-powered product detection**

  * Detects food and beverage products from refrigerator images using YOLO.
  * Stores detection confidence and bounding boxes.
  * Allows users to review and correct detections before updating inventory.

* **Human-in-the-loop model improvement**

  * Stores confirmed, relabeled, adjusted, added, and removed detections as structured annotations.
  * Tracks which annotation submissions and individual annotations were used in each training run.
  * Exports reviewed annotations into versioned YOLO datasets.
  * Trains candidate detector models from the current active model.
  * Compares candidate and active models on a traceable validation split.
  * Supports explicit model promotion and rollback while preserving activation history.

* **Smart inventory management**

  * Add and remove products using images.
  * Manually adjust inventory.
  * Track quantities across separate inventory batches.
  * Track partially consumed/open products.

* **Expiration tracking**

  * Store manually entered expiration dates.
  * Estimate expiration dates when no date is available.
  * Track expiration separately for different batches of the same product.
  * Automatically identify expired and soon-to-expire products.

* **Smart alerts**

  * Low-stock alerts.
  * Missing-product alerts.
  * Expiring-soon alerts.
  * Expired-product alerts.

* **Receipt OCR**

  * Upload grocery receipts as PDF or image files.
  * Extract purchased products using Tesseract OCR.
  * Review extracted products before adding them to inventory.

* **Product segmentation with SAM2**

  * Uses SAM2 to isolate detected products from refrigerator images.
  * Cleans and scores segmentation masks before accepting them.
  * Generates representative product outlines for the mobile interface.

* **Freshness classification**

  * Uses a separate image-classification model for supported freshness or rot checks.
  * Keeps freshness inference separate from the YOLO detector lifecycle.

* **Event history**

  * Records inventory additions and removals.
  * Stores detection confidence and associated scans.
  * Provides a history of inventory activity.

* **Mobile application**

  * Built with React Native and Expo.
  * View inventory, alerts, events, expired products, and scan results.
  * Add or remove products manually or using images.
  * Upload receipts directly from a phone.
  * Review detections and submit corrections that can later improve the detector.

## System Architecture

```text
                               Fridge 9000
                                    │
                   ┌────────────────┴────────────────┐
                   │                                 │
              Mobile Client                      Web Client
            React Native / Expo                    Frontend
                   │                                 │
                   └───────────────┬─────────────────┘
                                   │
                                   ▼
                             FastAPI Backend
                                   │
          ┌────────────────────────┼────────────────────────┐
          │                        │                        │
          ▼                        ▼                        ▼
   Computer Vision                OCR                   Inventory
    YOLO + SAM2               Tesseract                Management
          │                                                  │
          │                        ┌───────────────────────────┘
          │                        │
          ▼                        ▼
   Detection Review          PostgreSQL
          │                        ▲
          ▼                        │
 Human Annotations ────────────────┘
          │
          ▼
 Versioned Dataset Export
          │
          ▼
 Candidate Model Training
          │
          ▼
 Active vs Candidate Evaluation
          │
          ▼
   Promotion / Rollback
          │
          └──────────────► Active YOLO Model
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
* PDF2Image

### Mobile

* React Native
* Expo
* TypeScript
* Expo Router

### Infrastructure

* Docker
* Docker Compose
* PostgreSQL container

## Repository Structure

```text
Fridge9000/
│
├── backend/
│   ├── api/                  # FastAPI route definitions
│   ├── core/                 # Application configuration
│   ├── db/                   # Database connection helpers
│   ├── services/             # Runtime application and ML services
│   ├── main.py               # FastAPI entry point
│   ├── train.py              # Detector training workflow
│   ├── prepare_data.py       # Dataset preparation
│   ├── export_yolo_dataset.py
│   ├── compare_yolo_models.py
│   ├── requirements.txt
│   ├── rules.json
│   ├── best.pt
│   └── sam2_t.pt
│
├── db/
│   └── init.sql
│
├── frontend/
│
├── mobile/
│   ├── app/
│   ├── assets/
│   ├── src/
│   ├── package.json
│   └── app.json
│
├── docker-compose.yml
└── README.md
```

## How It Works

### 1. Product Detection

A refrigerator image is uploaded to the backend.

The active YOLO model detects products and returns information such as:

```json
{
  "label": "Milk",
  "confidence": 0.91,
  "x1": 120,
  "y1": 84,
  "x2": 315,
  "y2": 470
}
```

The user can review the detected products before confirming the inventory update.

### 2. Detection Review and Annotation

Detection review serves two purposes:

1. It prevents incorrect detections from being applied blindly to inventory.
2. It creates structured human feedback that can later be used to improve the detector.

Corrections can be stored as annotation actions such as:

```text
CONFIRM
RELABEL
ADJUST_BOX
ADD
REMOVE
```

The database keeps the original prediction alongside the corrected label and bounding box.

Each set of corrections belongs to an annotation submission tied to the original scan.

### 3. Inventory Tracking

Confirmed detections are converted into inventory changes.

Each product can have multiple inventory batches, allowing Fridge 9000 to track different expiration dates for multiple units of the same product.

For example:

```text
Milk

Batch 1
Quantity: 1
Expires: 2026-08-17

Batch 2
Quantity: 2
Expires: 2026-08-22
```

### 4. Expiration Management

When an expiration date is known, it is stored directly.

When one is not provided, Fridge 9000 estimates a date according to the product category.

The system automatically identifies products that are:

* Expired
* Expiring soon
* Low in stock
* Missing

### 5. Receipt Processing

Users can upload grocery receipts as:

* PDF
* JPG
* JPEG
* PNG

Tesseract OCR extracts the text and attempts to identify purchased products.

The extracted products can then be reviewed before being added to inventory.

### 6. SAM2 Product Segmentation

Fridge 9000 uses SAM2 to generate isolated product representations from detected objects.

```text
Fridge Image
     │
     ▼
YOLO Detection
     │
     ▼
Bounding Box
     │
     ▼
SAM2 Segmentation
     │
     ▼
Mask Cleaning and Quality Scoring
     │
     ▼
Representative Product Outline
```

The segmentation pipeline evaluates masks rather than accepting every SAM2 result directly.

It uses:

* Multiple expanded bounding-box prompts
* Connected-component filtering
* Minimum-area rejection
* Component purity
* Prompt coverage
* Contour solidity
* Boundary-touch penalties
* Composite quality scoring

The best reliable mask is selected and used to create a representative product outline.

# Model Lifecycle Architecture

One of the major components of Fridge 9000 is its model-management workflow.

Instead of treating the detector as a static `.pt` file, reviewed detections can become traceable training data used to create and evaluate new model versions.

## Lifecycle Overview

```text
Production Scan
      │
      ▼
Active YOLO Model
      │
      ▼
Predicted Detections
      │
      ▼
Human Review / Correction
      │
      ▼
Annotation Submission
      │
      ▼
Approved Training Data
      │
      ▼
Versioned YOLO Dataset
      │
      ▼
Training Run
      │
      ▼
Candidate Model
      │
      ▼
Reproducible Validation Comparison
      │
      ├──── Candidate does not qualify ────► Reject / Keep Active Model
      │
      └──── Candidate qualifies ───────────► Promote Candidate
                                                │
                                                ▼
                                         New Active Model
                                                │
                                                ▼
                                          Rollback Available
```

## Annotation Provenance

Human feedback is stored in two levels.

### Annotation submissions

An annotation submission represents a reviewed scan.

Each submission records:

* The source scan
* Review status
* Image dimensions
* Creation time
* Review time

Possible statuses include:

```text
pending
approved
rejected
used
```

### Individual annotations

Each correction inside a submission is stored separately.

Annotations preserve information such as:

* Original label
* Final label
* Original confidence
* Original bounding box
* Corrected bounding box
* Annotation action
* Source detection

This allows the project to distinguish between:

```text
What the model predicted
```

and:

```text
What the human reviewer accepted or corrected
```

## Dataset Versioning

Approved annotation data can be exported into YOLO-compatible training datasets.

Training runs reference a specific dataset version instead of an arbitrary mutable directory.

The model-comparison system also records hashes for:

* Dataset contents
* Validation split

This helps ensure that model comparisons are tied to the exact data used during evaluation.

## Training Runs

Each candidate-model training process receives a persistent training-run record.

A training run can store:

* Training run ID
* Dataset version
* Starting weights path
* Starting model version
* Starting weights SHA-256
* Training parameters
* Start timestamp
* End timestamp
* Training status
* Candidate model path
* Precision
* Recall
* mAP@50
* mAP@50:95
* Error information if training fails

Possible run statuses include:

```text
running
completed
failed
interrupted
```

The database also records which annotation submissions and individual annotations were actually consumed by each training run.

This provides training-data provenance instead of leaving model history buried in filenames and terminal logs, where software history traditionally goes to die.

## Model Registry

Detector versions are stored in a model registry.

Each model can have one of the following states:

```text
candidate
active
rejected
archived
```

A model-version record can contain:

* Version identifier
* Model path
* Model SHA-256
* Dataset version
* Source training run
* Precision
* Recall
* mAP@50
* mAP@50:95

The database enforces that only one detector can have `active` status at a time.

The backend can therefore determine which detector is currently considered the production model without simply assuming that whichever file is named `best.pt` deserves the throne.

## Candidate vs Active Model Comparison

A newly trained model is not automatically promoted.

It can first be evaluated against the currently active detector.

A comparison records:

* Dataset version
* Dataset-content SHA-256
* Validation-split SHA-256
* Active model ID
* Candidate model ID
* Evaluation parameters
* Active-model metrics
* Candidate-model metrics
* Metric differences
* Comparison rule
* Whether the candidate outperformed the active model

Typical metrics include:

* Precision
* Recall
* mAP@50
* mAP@50:95

This provides a reproducible decision record for model promotion.

## Model Promotion

If a candidate satisfies the comparison criteria, it can be promoted to become the active detector.

The previous active model is retained in the registry rather than being overwritten or forgotten.

The promotion is recorded in the model activation history.

## Model Rollback

Because previous model versions remain registered, the system can roll back to an earlier detector.

Rollback records:

* The current model
* The model being restored
* The action type
* Timestamp

Activation actions are recorded as:

```text
PROMOTE
ROLLBACK
```

This creates a traceable model history rather than a mysterious pile of files named:

```text
best.pt
best2.pt
best_final.pt
best_final_real.pt
```

## Full Model Provenance Chain

The system is designed to preserve the following chain:

```text
Production Image
       │
       ▼
YOLO Prediction
       │
       ▼
Human Correction
       │
       ▼
Annotation
       │
       ▼
Dataset Version
       │
       ▼
Training Run
       │
       ▼
Candidate Model
       │
       ▼
Candidate vs Active Comparison
       │
       ▼
Promotion
       │
       ▼
Active Production Model
```

This makes it possible to trace how a production detector was created and why it became active.

## Why the Model Lifecycle Matters

The model lifecycle is designed to avoid common problems in smaller machine-learning projects:

* Losing track of which dataset trained a model
* Reusing annotations without knowing where they were used
* Automatically replacing a production model after training
* Having multiple models ambiguously treated as active
* Comparing models on different validation data
* Being unable to explain why a model was promoted
* Losing the previous model after deployment
* Being unable to roll back a bad model

Fridge 9000 therefore treats model improvement as a versioned workflow rather than a one-time training script.

## Running the Project

### Requirements

Install:

* Docker Desktop
* Git
* Node.js
* Expo Go on your mobile device

Clone the repository:

```bash
git clone https://github.com/netanel770/Fridge9000.git
cd Fridge9000
```

## Start the Project

From the project root:

```powershell
.\start-fridge.ps1
```

The PowerShell launcher detects an active LAN IPv4 address and sets `EXPO_PUBLIC_API_BASE_URL` automatically. PostgreSQL and FastAPI run in Docker, then Expo runs directly on Windows so its tunnel status, interactive CLI, and QR code display normally.

To use a Cloudflare Tunnel, ngrok, or another public backend URL instead of LAN detection:

```powershell
.\start-fridge.ps1 -ApiUrl "https://example.com"
```

You can also copy the optional root environment example and start the Docker backend and database separately:

```powershell
Copy-Item .env.example .env
docker compose up --build
```

LAN URLs require the phone and PC to be on a mutually reachable local network. A tunnel URL can work when the devices are on different networks.

To stop the application:

```bash
docker compose down
```

## Running the Mobile Application

Navigate to the mobile directory:

```bash
cd mobile
```

Install dependencies:

```bash
npm install
```

The mobile application reads the backend address from `EXPO_PUBLIC_API_BASE_URL`. Set that environment variable before starting Expo directly; do not edit the source configuration for each network.

Start Expo in tunnel mode:

```bash
npx expo start --tunnel
```

Open **Expo Go** on the phone and connect to the displayed development server.

## Main Application Screens

The mobile application includes screens for:

* Home dashboard
* Inventory
* Image-based inventory updates
* Manual inventory management
* Detection review
* Receipt upload
* Alerts
* Expired products
* Event history
* Open-product quantity adjustment
* Freshness / rot detection

## Machine Learning

### YOLO Detector

Fridge 9000 uses a custom-trained YOLO model for refrigerator product detection.

The detector produces:

* Class label
* Confidence score
* Bounding box

The production detector is represented by the active model in the model registry.

Human corrections can feed the annotation and retraining lifecycle described above.

### SAM2

SAM2 is used after YOLO detection to generate more accurate product segmentation masks.

This allows Fridge 9000 to create cleaner visual representations of detected products rather than relying only on rectangular bounding boxes.

### Freshness Classifier

Fridge 9000 also contains a separate classifier for supported freshness and rot checks.

This model is separate from the object detector.

The two models answer different questions:

```text
YOLO:
What product is present, and where is it?

Freshness classifier:
What freshness state does this supplied product image represent?
```

### OCR

Tesseract OCR is used to process grocery receipts.

The OCR pipeline performs text extraction and filters receipt metadata such as:

* Totals
* Payment information
* Store information
* Prices
* Barcodes

before identifying candidate product names.

## Database

Fridge 9000 stores information including:

* Products
* Inventory
* Inventory batches
* Scans
* Object detections
* Detection reviews
* Inventory events
* Expiration information
* Representative product images
* Annotation submissions
* Human annotations
* Training runs
* Training-data usage provenance
* Model versions
* Active/candidate model comparisons
* Model activation history

This allows the system to maintain both the current refrigerator state and a historical record of how the detector evolves.

## Current Limitations

Fridge 9000 is an academic prototype and currently has several limitations:

* Product detection is limited by the classes represented in the training dataset.
* Products hidden behind other objects may not be detected.
* Receipt OCR accuracy depends heavily on receipt layout and image quality.
* Estimated expiration dates are currently rule-based.
* Some inventory operations still require user confirmation to avoid false updates.
* Model promotion is metric-driven but is not intended to be a complete production MLOps platform.
* Large ML model weights increase repository and deployment size.
* The development mobile application requires the phone and backend machine to be mutually reachable when using a local backend address.

## Project Goal

The goal of Fridge 9000 is to demonstrate how multiple technologies can work together to create an intelligent household inventory system that can also improve its detector from reviewed real-world usage.

Rather than relying on manual inventory tracking or a static one-time-trained model alone, Fridge 9000 combines:

```text
Computer Vision
       +
Human Review
       +
Versioned Model Improvement
       +
OCR
       +
Inventory History
       +
Expiration Tracking
       +
Mobile Interaction
       =
Adaptive Smart Fridge Management
```

The objective is to create a system capable of understanding **what is currently inside a refrigerator**, helping users manage inventory and expiration, while preserving a traceable process for improving the detector as reviewed data accumulates.

## Authors

Fridge 9000 was developed as a final academic project.

## License

This repository is currently intended for academic and educational use.
