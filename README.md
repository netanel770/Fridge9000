<p align="center">
  <img src="assets/fridge9000-banner.png" alt="Fridge 9000" width="100%">
</p>

# Fridge 9000

Fridge 9000 is a smart refrigerator platform that combines **computer vision, inventory management, OCR, freshness analysis, multi-user households, and human-in-the-loop machine learning**.

The system can scan refrigerator contents, detect products, review and correct predictions, manage inventory and expiration dates, process receipts, analyze food freshness, and use reviewed corrections to train improved object-detection candidates.

Beyond inference, Fridge 9000 manages the ML lifecycle around those models: **reviewed training data, versioned datasets, candidate training, evaluation, class-aware promotion policy, automatic rejection, provenance, quarantine, promotion, and rollback**.

The application is mobile-first using Expo and React Native, with shared support for Android, iOS, and Expo Web.

---

## Highlights

- YOLO product detection with labels, confidence scores, and bounding boxes
- Inventory batches, quantities, expiration dates, and open-product state
- Receipt OCR for images and PDFs
- Separate freshness-classification pipeline
- SAM2 segmentation
- Authenticated users and multi-user households
- Owner, Manager, and Member household roles
- Teach Fridge human-in-the-loop correction workflow
- Moderated annotation contributions
- Annotation provenance and lifecycle tracking
- Versioned datasets, training runs, and model artifacts
- Local and Kaggle model training
- Candidate-vs-active model evaluation
- Shared-class and added-class performance analysis
- Class-aware backend promotion policy
- Automatic rejection of candidates that fail valid quality checks
- Explicit model promotion, manual rejection, and rollback
- Shared mobile/web frontend
- Automated backend, ML, and frontend testing

---

# How It Works

A refrigerator scan follows this basic flow:

```text
Camera / Image
      ↓
YOLO Detection
      ↓
Human Review
      ↓
Inventory Update
```

Users can:

```text
Confirm detections
Relabel products
Adjust bounding boxes
Remove false positives
Add missed products
```

Corrections are stored separately from the original detector output and can later enter the Teach Fridge training workflow.

---

# Core Application

## Inventory

Inventory is represented using **product batches**.

A product can therefore have multiple units with different:

- expiration dates
- quantities
- open/closed states
- inventory histories

The UI derives aggregate product quantities from the underlying batches instead of maintaining a separate competing source of truth.

---

## Users and Households

Fridge 9000 supports authenticated users organized into households.

Household roles are:

- **Owner**
- **Manager**
- **Member**

Users can create or join households, switch between them, and manage membership according to their permissions.

Household-specific data such as scans, inventory, annotations, and freshness results remains scoped to the selected household.

System-admin permissions are kept separate for operations such as:

- annotation moderation
- model training
- model promotion and rejection
- quarantine
- rollback

Authentication uses JWT access and refresh sessions. Google sign-in is also supported when configured.

---

## Receipt OCR

Fridge 9000 can process receipt images and PDFs using Tesseract OCR.

Extracted products can be reviewed before inventory updates are applied.

---

## Freshness Analysis

Product detection and freshness classification are separate responsibilities:

```text
YOLO
→ What product is this?

Freshness Classifier
→ What condition is it in?
```

This allows both models to evolve independently.

---

## SAM2 Segmentation

YOLO detections can be passed to SAM2 to produce representative product masks.

```text
YOLO
→ locate and classify product

SAM2
→ refine product shape
```

---

# Teach Fridge

Teach Fridge turns human corrections into reviewed ML training data.

Supported annotation actions include:

```text
CONFIRM
RELABEL
ADJUST_BOX
ADD
REMOVE
```

The complete learning flow is:

```text
User Correction
      ↓
Pending Submission
      ↓
Moderation
      ↓
Approved Contribution
      ↓
Training Selection
      ↓
Versioned Dataset
      ↓
Candidate Training
      ↓
Model Evaluation
      ↓
Promotion Policy
      ↓
Promotion / Automatic Rejection / Manual Resolution
```

A relabel and bounding-box adjustment on the same detected object can be presented as one logical contribution while the underlying annotation actions remain separately preserved for provenance and training.

---

# Contributions and Moderation

The Contributions area contains:

```text
Contributions

▸ Contribution History

▸ Review Queue
```

## Contribution History

Contribution History provides:

- search and filtering
- sorting and grouping
- contribution status
- training lifecycle status
- image inspection
- model provenance
- historical training usage

Historical model usage remains preserved even when a model is later rejected or archived.

## Review Queue

Authorized system administrators can review pending submissions and:

```text
Approve
Reject
```

After moderation, the interface reloads authoritative backend state so resolved submissions do not remain displayed as pending.

---

# Annotation Lifecycle

Approved contributions move through four training states:

```text
eligible
experimental
trusted
quarantined
```

### Eligible

Approved and available for future candidate training.

### Experimental

Currently associated with an unresolved candidate.

### Trusted

Part of the **currently active model's recorded training provenance**.

### Quarantined

Excluded from normal training selection, commonly after the candidate that used the contribution is rejected.

---

## Current State vs Historical Usage

Fridge 9000 distinguishes between:

```text
Current lifecycle provenance
```

and:

```text
Historical training usage
```

For example:

```text
Model 7 used Annotation A
Model 7 promoted

Model 8 later used Annotation A
Model 8 rejected

Model 7 active
```

The current presentation remains:

```text
Annotation A
TRUSTED
Used in Model 7
```

Model 8's usage remains in historical records because it genuinely used the annotation, but it does not incorrectly become the reason the contribution is currently trusted.

---

# Candidate Training

Training and deployment are deliberately separate.

```text
Train ≠ Deploy
Evaluate ≠ Deploy
Pass policy ≠ Deploy

Only Promote or Rollback changes production.
```

Candidate training combines:

```text
Pretrained YOLO Foundation
        +
Permanent Base Dataset
        +
Reviewed Fridge Data
        ↓
Versioned Dataset
        ↓
Candidate Model
```

The permanent base dataset preserves the detector's established training foundation, while trusted and selected reviewed Fridge data allow the detector to learn from application feedback.

Training data is versioned so a model can be traced back to the exact dataset and reviewed contributions used to create it.

The current production detector remains active throughout candidate training and evaluation.

---

# Model Evaluation

After training, a candidate is compared with the current active model.

Fridge 9000 records metrics including:

- precision
- recall
- mAP50
- mAP50-95
- per-class metrics
- shared-class performance
- added-class performance
- class preservation

Both models are evaluated on the **same evaluation split** so their results remain directly comparable.

Fridge 9000 separates **shared classes** from **newly added classes**.

This matters because strong performance on a newly learned product should not hide regressions on products already supported by production.

```text
                 Candidate
                    │
          ┌─────────┴─────────┐
          │                   │
   Existing Products     Added Products
          │                   │
          ▼                   ▼
 Compare with Active     Evaluate New-Class
 on Shared Classes          Quality
```

The resulting comparison is persisted and then evaluated by the backend promotion policy.

---

# Promotion Policy

Model comparison does **not** directly deploy a candidate.

The backend applies a **class-aware promotion policy** to the persisted comparison.

The policy differs depending on whether the candidate preserves the existing class set or introduces new products.

The backend is authoritative for the final decision.

---

## Same-Class Candidates

If the active and candidate models support the same product classes, the candidate must outperform the active model.

The primary comparison metric is:

```text
mAP50-95
```

If mAP50-95 is effectively tied, `mAP50` is used as the tie-breaker.

Conceptually:

```text
Candidate better
      ↓
Eligible for Promotion

Candidate does not outperform Active
      ↓
Automatically Rejected
```

This prevents a newly trained model from replacing production when it provides no measurable detection improvement.

---

## Candidates With New Product Classes

When a candidate introduces new products, existing-product performance and new-product performance are evaluated separately.

The default policy requires:

| Requirement | Default |
| --- | ---: |
| Maximum shared-class mAP50-95 regression | **2 percentage points** |
| Minimum aggregate mAP50-95 across added classes | **50%** |
| Minimum mAP50-95 for every added class | **30%** |
| Established active-model classes may be removed | **No** |

These thresholds are configurable through backend environment settings.

The candidate must therefore:

1. preserve every established active-model class
2. provide comparable metrics for the existing classes
3. keep shared-class mAP50-95 regression within the configured tolerance
4. meet the aggregate quality threshold for newly added classes
5. meet the minimum quality threshold for **every** newly added class

For example:

```text
Active supports:
Apple
Banana
Milk

Candidate supports:
Apple
Banana
Milk
Potato
```

Fridge 9000 checks:

```text
Apple / Banana / Milk
        ↓
Did existing performance remain acceptable?

Potato
        ↓
Did the new class meet the required quality?
```

A strong Potato score therefore cannot compensate for unacceptable regression on Apple, Banana, or Milk.

Likewise, if several products are added together, one excellent new class cannot hide another newly added class that falls below the per-class minimum.

---

# Automatic Model Rejection

A candidate that fails a **valid quality comparison** can be rejected automatically.

Automatic rejection is triggered by policy failures such as:

- same-class candidate failing to outperform the active model
- removal of established active-model classes
- excessive shared-class mAP50-95 regression
- insufficient aggregate quality across added classes
- one or more added classes falling below the required per-class quality

The flow is:

```text
Valid Comparison
      ↓
Promotion Policy
      ↓
Quality Requirement Failed
      ↓
Candidate Automatically Rejected
      ↓
Candidate-Specific Experimental Data Quarantined
```

The active production model is never replaced by the rejected candidate.

Automatic rejection therefore protects production without requiring an administrator to manually inspect every clearly failing candidate.

---

# Invalid Comparisons Are Not Automatic Rejections

Infrastructure or evaluation problems are not treated as proof that a model is poor.

Examples include:

- missing comparison data
- stale comparisons
- malformed metrics
- incomplete class coverage
- otherwise invalid comparison artifacts

In these situations:

```text
Candidate
      ↓
Remains Unresolved
```

The comparison can be retried.

This distinction is intentional:

```text
Valid comparison + quality failure
        ↓
Automatic rejection

Invalid / untrustworthy comparison
        ↓
No automatic rejection
```

A candidate is automatically rejected only when trustworthy evaluation evidence demonstrates that it failed the quality policy.

---

# Candidate Outcomes

After evaluation and promotion-policy processing, a candidate can reach one of three main states.

## Eligible for Promotion

```text
Candidate
      ↓
Passes Policy
      ↓
Eligible for Promotion
```

The active model remains unchanged.

Passing the policy only means the candidate **may** be promoted.

Deployment still requires an explicit promotion action.

---

## Automatically Rejected

```text
Candidate
      ↓
Valid Quality Failure
      ↓
Automatically Rejected
```

The active model remains unchanged.

Candidate-specific experimental contributions are quarantined.

---

## Unresolved

```text
Candidate
      ↓
Comparison Missing / Invalid
      ↓
Remains Unresolved
```

The comparison can be retried or the candidate can be resolved manually.

---

# Promotion, Manual Rejection, and Rollback

Deployment actions occur only after the candidate lifecycle has established the candidate's state.

## Promotion

An eligible candidate can be explicitly promoted:

```text
Candidate
      ↓
Active

Previous Active
      ↓
Archived
```

Promotion is the action that changes the production detector.

---

## Manual Rejection

An administrator can explicitly reject an unresolved or unwanted candidate instead of promoting it.

```text
Candidate
      ↓
Manual Rejection
      ↓
Rejected
```

Experimental training contributions associated with the candidate are quarantined as appropriate.

Manual rejection is separate from **automatic rejection caused by a valid policy failure**.

---

## Rollback

Rollback restores a previously active production model without retraining it.

```text
Current Model
      ↓
Rollback
      ↓
Previous Production Model
```

After promotion or rollback, annotation training states are reconciled against the newly active model's exact training provenance.

For example:

```text
Annotation A used only by Model 8
Model 8 active
A = trusted

Rollback to Model 7
Model 7 did not use A

A = eligible
```

Historical usage remains preserved.

Rollback and new training are blocked while unresolved candidate work or an active lifecycle operation would make model state ambiguous.

---

# Training Providers

Fridge 9000 supports both local and Kaggle training.

Local:

```env
TRAINING_PROVIDER=local
```

Kaggle:

```env
TRAINING_PROVIDER=kaggle
```

Both follow the same dataset, evaluation, and lifecycle concepts.

With Kaggle:

```text
Build Versioned Dataset
        ↓
Upload Training Inputs
        ↓
Train Candidate
        ↓
Evaluate Active + Candidate
on the same evaluation split
        ↓
Persist Comparison
        ↓
Backend Promotion Policy
        ↓
Eligible / Automatically Rejected / Unresolved
```

Kaggle performs training and evaluation, but it does not decide which model becomes production.

Deployment remains controlled by Fridge 9000.

---

# Mobile and Web

Fridge 9000 uses Expo and React Native.

Native platforms use native functionality for:

- camera capture
- gallery selection
- secure storage
- navigation
- file handling

Expo Web provides browser-compatible alternatives such as:

```text
Camera       → Webcam
Gallery      → File Upload
Native URI   → Blob / File
```

Domain logic remains shared across platforms.

---

# Architecture

```text
Fridge9000/
├── backend/
│   ├── api/
│   ├── core/
│   ├── db/
│   ├── services/
│   └── tests/
│
├── mobile/
│   ├── app/
│   ├── __tests__/
│   └── src/
│       ├── components/
│       ├── features/
│       └── services/
│
├── db/
├── kaggle_trainer/
├── scripts/
├── assets/
└── docker-compose.yml
```

The backend uses FastAPI routes backed by focused application and domain services.

Teach Fridge functionality is similarly separated in the frontend into components and hooks for corrections, contributions, moderation, training, AI progress, quarantine, and rollback.

---

# Tech Stack

| Area | Technology |
| --- | --- |
| Mobile / Web | Expo, React Native, React, Expo Router, TypeScript |
| Backend | FastAPI, Python |
| Database | PostgreSQL |
| Detection | Ultralytics YOLO |
| Segmentation | SAM2 |
| Freshness | PyTorch |
| OCR | Tesseract |
| Authentication | JWT, Argon2, Google OAuth |
| Training | Local / Kaggle |
| Testing | pytest, Jest, React Native Testing Library |
| Infrastructure | Docker Compose |

---

# Running Locally

## Requirements

- Docker Desktop
- Node.js and npm
- Expo-compatible device, emulator, or modern browser
- PowerShell on Windows for the provided launcher

## Setup

```bash
git clone https://github.com/netanel770/Fridge9000.git
cd Fridge9000

cd mobile
npm install
cd ..
```

Copy `.env.example` to `.env` where configuration is required.

Do not commit real credentials or production secrets.

## Start

```bat
run-fridge.bat
```

or:

```powershell
.\start-fridge.ps1
```

The launcher starts the PostgreSQL/FastAPI Docker environment and Expo frontend.

Tunnel mode:

```powershell
.\start-fridge.ps1 -Tunnel
```

Custom API URL:

```powershell
.\start-fridge.ps1 -ApiUrl https://your-api.example.com
```

---

# Testing

The latest validated suites contain:

```text
Backend             233 passed
Kaggle worker        23 passed
Frontend Jest        81 passed
--------------------------------
Total               337 tests
```

Additional validation:

```text
TypeScript           passed
Lint                 0 errors
Expo Doctor          18/18
Git diff check       passed
```

The current lint configuration also reports 7 pre-existing warnings.

Backend:

```bash
pytest
```

Kaggle worker:

```bash
pytest kaggle_trainer/test_train.py -v
```

Frontend:

```bash
cd mobile
npm run test:ci
npx tsc --noEmit
npm run lint
npx expo-doctor
```

Full Windows validation:

```bat
fridge-test.bat
```

Testing covers areas including:

- authentication and sessions
- household permissions and isolation
- inventory and batches
- scans and annotations
- moderation
- freshness
- receipts
- training datasets
- candidate lifecycle
- model comparison
- class-aware promotion policy
- automatic and manual rejection
- quarantine
- rollback
- annotation-state reconciliation
- contribution provenance
- frontend lifecycle presentation

---

# Development Data Backup

Development data can be exported and imported using:

```bat
export-fridge-data.bat
import-fridge-data.bat
```

These scripts are intended for moving local development data between environments.

---

# AI-Assisted Development

Generative AI tools such as **ChatGPT and Codex** were used as development aids during parts of the project.

They assisted with activities such as:

- discussing implementation approaches
- reviewing code
- debugging specific issues
- suggesting test cases
- helping with refactoring and documentation

They were used in the same role as other development tools: to support the engineering process rather than define the project.

The project's requirements, architecture, feature design, ML workflow, integration decisions, implementation choices, testing, and final review remained the responsibility of the development team.

Suggested or generated code was reviewed and validated before being incorporated into the project.

This development assistance is separate from the machine-learning functionality implemented by Fridge 9000 itself, including YOLO detection, SAM2 segmentation, freshness classification, and the Teach Fridge training workflow.

---

# Project Goal

Fridge 9000 is not intended to be only:

```text
Image
  ↓
Pretrained Model
  ↓
Prediction
```

The goal is to combine:

```text
Computer Vision
      +
Application State
      +
Users and Households
      +
Human Feedback
      +
Moderation
      +
Versioned Training Data
      +
Model Evaluation
      +
Deployment Governance
```

into one complete application.

Users can correct the AI, reviewed corrections can become training data, candidates can be trained without replacing production, models can be evaluated against explicit quality requirements, poor candidates can be rejected automatically, successful candidates can be explicitly promoted, and earlier production models can be restored through rollback.

The result is a refrigerator-management system whose ML component can improve over time while preserving **moderation, provenance, quality control, deployment safety, and rollback**.
