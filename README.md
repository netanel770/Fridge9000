<p align="center">
  <img src="assets/fridge9000-banner.png" alt="Fridge 9000" width="100%">
</p>

# Fridge 9000

Fridge 9000 is a smart refrigerator platform that combines **computer vision, inventory management, OCR, freshness analysis, multi-user households, and human-in-the-loop machine learning**.

The app can scan a refrigerator, detect products, review and correct AI predictions, maintain inventory and expiration dates, process receipts, analyze food freshness, and use approved corrections to train and evaluate improved object-detection models.

Fridge 9000 is **mobile-first** with Android/iOS as the primary experience, while Expo Web provides the same core actions through browser-friendly equivalents such as webcam capture and file upload.

## Highlights

* **YOLO product detection** with labels, confidence scores and bounding boxes
* **Inventory tracking** with quantities, batches, expiration dates and open-product state
* **Receipt OCR** for images and PDFs
* **Freshness classification** using a dedicated image-classification pipeline
* **SAM2 segmentation** for representative product masks and outlines
* **Users and households** with role-based access and household isolation
* **Teach Fridge**, a moderated human-in-the-loop annotation and retraining workflow
* **Versioned model lifecycle** with training, comparison, promotion, rejection and rollback
* **Local or Kaggle training** with shared training and provenance semantics
* **Mobile and web support** while preserving native app behavior
* **Automated validation** across backend, ML, API, end-to-end, mobile and web-facing application logic

---

## How It Works

A normal refrigerator scan follows this flow:

```text
Camera / Image
      ↓
YOLO Detection
      ↓
Human Review
      ↓
Inventory Update
```

Users can confirm detections, relabel products, adjust bounding boxes, remove false positives, or add products that the detector missed.

Inventory is stored using product batches rather than maintaining a second aggregate quantity as a separate source of truth. This allows multiple units of the same product to keep their own expiration dates and open/closed state while the UI derives the total quantity from the underlying batches.

---

## Users and Households

Fridge 9000 supports authenticated users organized into households.

Household roles include:

* **Owner**
* **Manager**
* **Member**

Users can create or join households, switch between households, and manage membership according to their role.

Household-scoped data such as scans, inventory, annotations and freshness results stays isolated to the selected household.

System-admin functionality is kept separate from normal household permissions for operations such as annotation moderation and model governance.

Authentication uses JWT access and refresh sessions with platform-aware storage. Google sign-in is also supported when OAuth client IDs are configured.

---

## Teach Fridge

Teach Fridge turns normal user feedback into reviewed training data instead of automatically trusting every correction.

Supported annotation actions are:

```text
CONFIRM
RELABEL
ADJUST_BOX
ADD
REMOVE
```

The workflow is:

```text
Scan / Manual Image
        ↓
Human Correction
        ↓
Moderation
        ↓
Approved Submission
        ↓
Training Selection
        ↓
Versioned Dataset
        ↓
Candidate Training
        ↓
Model Comparison
        ↓
Promote or Reject
```

A label correction and bounding-box correction for the same detected object are treated as **one logical correction** in the UI.

The raw `RELABEL` and `ADJUST_BOX` actions remain separate for provenance and training, while Fridge 9000 reconstructs the effective final label and final bounding box when displaying the corrected object.

Contribution history includes:

* Correction status
* Submitter identity
* Product information
* Training usage
* Moderation state

Contributions that have already been used for training remain available as read-only history, but are hidden from the normal contribution view unless the **Used** filter is selected.

Admin contribution views also support grouping and sorting by submitting user.

---

## Annotation Lifecycle

Approved annotation submissions move through an explicit training lifecycle:

```text
eligible
experimental
trusted
quarantined
```

### Eligible

Approved data available for future candidate training.

### Experimental

Data currently used by an unresolved candidate model.

### Trusted

Data represented by the currently active model's recorded training provenance.

### Quarantined

Data excluded from normal training selection.

Rejected candidate data is moved to Quarantine automatically. Eligible data can also be moved there manually.

Quarantined submissions can later be restored to the training pool.

Quarantine also supports lightweight archiving. Archived items remain quarantined and preserve their annotations and provenance, but disappear from the default active Quarantine workload.

---

## Model Lifecycle

Fridge 9000 does not replace the active detector as soon as training finishes.

Each candidate is trained and evaluated independently before it can serve predictions.

```text
Fixed YOLO Foundation
        +
Permanent Base Dataset
        +
Trusted Corrections
        +
New Approved Corrections
        ↓
Candidate Model
        ↓
Compare with Active Model
        ↓
Promotion Evaluation
      ↙                 ↘
   Reject              Promote
     ↓                    ↓
Quarantine          Previous Active
new data               Archived
```

The active detector continues serving predictions while another model is trained and evaluated.

The system records:

* Dataset versions
* Training runs
* Starting weights
* Model versions
* Model artifacts
* Evaluation metrics
* Class-aware comparisons
* Training provenance
* Promotion history
* Activation history
* Rollback history

Promotion is always explicit.

A candidate must preserve the product classes already supported by the active model and satisfy the configured comparison policy before it becomes eligible for promotion.

---

## Training Strategy

Fridge 9000 separates the model used as the **training foundation** from the model currently serving predictions.

Candidates begin from a configurable pretrained YOLO model rather than inheriting the currently active Fridge model's weights.

Conceptually:

```text
Pretrained YOLO Foundation
          +
Permanent Base Dataset
          +
Trusted Fridge Corrections
          +
New Approved Corrections
          ↓
Candidate Model
```

Accumulated Fridge knowledge therefore lives explicitly in reviewed training data and provenance rather than depending entirely on a chain of fine-tuned weights.

This also keeps local and remote training behavior consistent.

---

## Model Comparison and Promotion

Candidates are compared against the current active detector.

Evaluation includes:

* Precision
* Recall
* mAP50
* mAP50-95
* Shared-class performance
* Added-class performance
* Per-class metrics
* Class preservation

The comparison separates established products from newly introduced products so strong performance on a new class cannot hide a serious regression on existing classes.

The backend remains authoritative for promotion eligibility.

Passing the comparison policy does **not** automatically activate a candidate. Promotion remains an explicit action.

---

## Rejection, Quarantine and Rollback

If a candidate is rejected, the new experimental data used by that candidate is moved to Quarantine.

It can later be:

```text
Return to training
→ eligible
```

or archived while remaining quarantined.

Previously active production models can also be restored through **rollback**.

Rollback reactivates an existing model and its recorded provenance rather than retraining it.

This lets Fridge 9000 return to an earlier production model while preserving later annotation and training history.

---

## Freshness Analysis

Fridge 9000 uses a separate image-classification pipeline for supported food freshness and rot detection.

```text
YOLO
→ What product is this?

Freshness Classifier
→ What condition is this product in?
```

Keeping the two responsibilities separate allows the detector and freshness model to evolve independently.

---

## Receipt OCR

Receipt images and PDFs can be processed with **Tesseract OCR**.

Extracted products can be reviewed before inventory changes are applied.

---

## SAM2 Segmentation

YOLO detections can be passed to **SAM2** to generate representative product masks and outlines.

YOLO identifies the product region, while SAM2 refines its shape.

---

## Mobile and Web

Fridge 9000 is designed as an app first.

On Android/iOS, the project keeps native Expo/React Native behavior for:

* Camera capture
* Gallery selection
* Secure storage
* Navigation
* Native file handling

Expo Web provides equivalent capabilities using browser-specific implementations where necessary:

```text
Native Camera        → Browser Webcam
Native Gallery       → File Upload
Native URI Upload    → Blob / File Upload
SecureStore          → Web-Compatible Session Storage
Native Confirmation  → Browser-Compatible Confirmation
```

Browser webcam access is requested only after user interaction.

If camera permission is unavailable or denied, image-based features still offer file upload so the workflow remains usable.

The platform-specific parts are kept behind shared abstractions so scanning, freshness analysis, annotations and other domain logic remain shared.

---

## Architecture

```text
Fridge9000/
├── backend/
│   ├── api/          # FastAPI routes
│   ├── core/         # Configuration, auth and security
│   ├── db/           # Database access
│   ├── services/     # Domain/application services
│   └── tests/
│       ├── unit/
│       ├── integration/
│       ├── api/
│       ├── ml/
│       ├── e2e/
│       └── fixtures/
│
├── mobile/
│   ├── app/          # Expo Router screens
│   └── src/
│       ├── components/
│       ├── features/
│       └── services/
│
├── db/               # PostgreSQL initialization
├── kaggle_trainer/   # Remote YOLO training worker
├── scripts/          # Development/data utilities
└── docker-compose.yml
```

The backend is organized around thin API routes and domain services rather than one large runtime module.

The mobile code follows the same direction, with feature-specific components, hooks and API modules.

---

## Tech Stack

| Area             | Technology                                            |
| ---------------- | ----------------------------------------------------- |
| Mobile / Web     | Expo, React Native, React, Expo Router, TypeScript    |
| Backend          | FastAPI, Python                                       |
| Database         | PostgreSQL                                            |
| Object Detection | Ultralytics YOLO                                      |
| Segmentation     | SAM2                                                  |
| Freshness        | PyTorch                                               |
| OCR              | Tesseract                                             |
| Authentication   | JWT, Argon2, Google OAuth                             |
| Training         | Local or Kaggle                                       |
| Testing          | pytest, Jest, jest-expo, React Native Testing Library |
| Infrastructure   | Docker Compose                                        |

---

## AI-Assisted Development

Generative AI tools, including **ChatGPT and Codex**, were used during the development of Fridge 9000 as engineering assistants.

They were used for tasks such as:

* Code review and identifying potential issues
* Exploring implementation and refactoring approaches
* Generating and expanding automated tests
* Debugging assistance
* Reviewing architecture and project structure
* Improving technical documentation

AI-generated suggestions were not treated as authoritative or integrated automatically. Changes were reviewed, adapted where necessary, and validated against the project's requirements and automated test suite before being accepted.

The project's architecture, feature requirements, system behavior, machine-learning lifecycle, integration decisions and final implementation remained under the responsibility of the development team.

Development-time generative AI is separate from the AI/ML systems implemented by Fridge 9000 itself, including **YOLO object detection, SAM2 segmentation, freshness classification, and the Teach Fridge human-in-the-loop training workflow**.

---

## Running Locally

### Requirements

* Docker Desktop
* Node.js and npm
* Expo-compatible Android/iOS device, emulator, or modern browser
* PowerShell on Windows for the provided launcher

### Setup

```bash
git clone https://github.com/netanel770/Fridge9000.git
cd Fridge9000

cd mobile
npm install
cd ..
```

Configuration can be copied from `.env.example` into `.env` when needed.

This includes settings for:

* JWT authentication
* Google OAuth
* Training provider
* Kaggle
* Promotion thresholds
* API configuration

Never commit real credentials or production secrets.

### Start Fridge 9000

On Windows:

```bat
run-fridge.bat
```

or:

```powershell
.\start-fridge.ps1
```

The launcher:

1. Detects a usable LAN address
2. Configures the Expo API URL
3. Builds and starts PostgreSQL and FastAPI with Docker Compose
4. Starts Expo

From Expo you can launch Android/iOS normally or press `w` to open the web client.

Tunnel mode:

```powershell
.\start-fridge.ps1 -Tunnel
```

Custom backend URL:

```powershell
.\start-fridge.ps1 -ApiUrl https://your-api.example.com
```

---

## Training Providers

Fridge 9000 supports:

```env
TRAINING_PROVIDER=local
```

and:

```env
TRAINING_PROVIDER=kaggle
```

Both follow the same dataset-building and model-lifecycle semantics.

See `.env.example` for the available training and Kaggle configuration.

---

## Testing

Fridge 9000 includes automated testing across the backend, machine-learning lifecycle, API workflows, Kaggle training worker, and shared mobile/web frontend.

The current validation suite contains **319 automated tests**:

* **229 backend tests**
* **23 Kaggle worker tests**
* **67 mobile/web frontend tests across 8 Jest suites**

### Backend Testing

The backend uses **pytest** with an isolated PostgreSQL test database.

Tests are organized by purpose:

```text
backend/tests/
├── unit/
├── integration/
├── api/
├── ml/
├── e2e/
└── fixtures/
```

Coverage includes:

* Authentication and JWT behavior
* Refresh-session security
* User and household permissions
* Cross-household data isolation
* Inventory and batch management
* Scanning and annotations
* Annotation moderation
* Receipt processing
* Freshness analysis
* Model training and lifecycle behavior
* Dataset and training-provider behavior
* Class-aware model comparison
* Model-promotion policy and edge cases
* End-to-end workflows across the HTTP API and PostgreSQL database

Expensive ML boundaries are replaced with deterministic test doubles where appropriate so the normal suite does not require full model training or external services.

Backend tests can be run with:

```bash
pytest
```

### Mobile and Web Frontend Testing

The Expo frontend uses **Jest**, **jest-expo**, and **React Native Testing Library**.

Because Fridge 9000 shares application logic across Android, iOS and Expo Web, the frontend suite validates behavior used across both the native and browser experiences.

The frontend tests cover:

* API request and error handling
* Access-token authentication
* Refresh-token recovery
* Automatic request retry after authentication refresh
* Concurrent `401` handling with single-flight token refresh
* Authentication session restoration
* Sign-in, registration, Google authentication and logout state
* Household loading, selection and switching
* `X-Fridge-ID` household propagation
* Authentication and household navigation gates
* Teach Fridge annotation and contribution logic
* Model lifecycle presentation logic
* Bounding-box and image-coordinate transformations
* Authenticated image loading
* Product-label behavior

Frontend tests can be run with:

```bash
cd mobile
npm test
```

For deterministic non-watch validation:

```bash
npm run test:ci
```

Additional frontend validation includes:

```bash
npx tsc --noEmit
npm run lint
npx expo-doctor
```

### Kaggle Worker Testing

The remote training worker has its own automated test suite:

```bash
pytest kaggle_trainer/test_train.py -v
```

The worker tests validate training behavior without requiring live Kaggle execution during normal project validation.

### Full Validation

A complete Windows validation runner is included:

```bat
fridge-test.bat
```

It performs the project's backend, ML, frontend and repository checks using an isolated test environment.

The validation pipeline includes:

1. Starting the isolated PostgreSQL test database
2. Running the complete backend pytest suite
3. Running the Kaggle worker tests
4. Running TypeScript validation
5. Running the frontend Jest suite
6. Running Expo lint
7. Running Expo Doctor
8. Running Git diff validation
9. Cleaning up the isolated test database

The current full validation passes with:

```text
Backend             229 passed
Kaggle worker        23 passed
Frontend Jest        67 passed
TypeScript           passed
Expo lint            passed
Expo Doctor          18/18
Git diff check       passed
Full validation      passed
```

The test database is removed after validation, including when the validation runner exits after a failed stage.

---

## Data Backup

Development data can be exported and imported using:

```bat
export-fridge-data.bat
import-fridge-data.bat
```

These scripts are useful for moving a local Fridge 9000 environment between development machines.

---

## Project Goal

Fridge 9000 is not intended to be only an object-detection demo.

The goal is to build a complete application where computer vision interacts with real application state, users can correct the AI, reviewed corrections can become training data, new models can be evaluated safely, and every model change remains traceable and reversible.

The result is a refrigerator-management system where the ML component can improve over time without giving up moderation, provenance or control.
