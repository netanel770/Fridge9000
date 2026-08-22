# Fridge 9000

Fridge 9000 is a smart refrigerator management system that uses **computer vision, OCR, inventory tracking, and expiration management** to help users understand what is inside their fridge and reduce food waste.

The system can detect products from images, track inventory changes, process shopping receipts, estimate expiration dates, generate alerts, and provide a mobile interface for managing fridge contents.

## Features

- **AI-powered product detection**
  - Detects food and beverage products from refrigerator images using YOLO.
  - Stores detection confidence and bounding boxes.
  - Allows users to review and correct detections before updating inventory.

- **Smart inventory management**
  - Add and remove products using images.
  - Manually adjust inventory.
  - Track quantities across separate inventory batches.
  - Track partially consumed/open products.

- **Expiration tracking**
  - Store manually entered expiration dates.
  - Estimate expiration dates when no date is available.
  - Track expiration separately for different batches of the same product.
  - Automatically identify expired and soon-to-expire products.

- **Smart alerts**
  - Low-stock alerts.
  - Missing-product alerts.
  - Expiring-soon alerts.
  - Expired-product alerts.

- **Receipt OCR**
  - Upload grocery receipts as PDF or image files.
  - Extract purchased products using Tesseract OCR.
  - Review extracted products before adding them to inventory.

- **Product segmentation with SAM2**
  - Uses SAM2 to isolate detected products from refrigerator images.
  - Generates representative product outlines for the mobile interface.

- **Event history**
  - Records inventory additions and removals.
  - Stores detection confidence and associated scans.
  - Provides a history of inventory activity.

- **Mobile application**
  - Built with React Native and Expo.
  - View inventory, alerts, events, expired products, and scan results.
  - Add or remove products manually or using images.
  - Upload receipts directly from a phone.

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
          ┌──────────────────┼──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
     Computer Vision        OCR             Inventory
          │                  │               Management
       YOLO + SAM2       Tesseract              │
          │                  │                  │
          └──────────────────┼──────────────────┘
                             │
                             ▼
                        PostgreSQL
```

## Technology Stack

### Backend

- Python
- FastAPI
- PostgreSQL
- psycopg2
- OpenCV
- Ultralytics YOLO
- SAM2
- Tesseract OCR
- NumPy
- PDF2Image

### Mobile

- React Native
- Expo
- TypeScript
- Expo Router

### Infrastructure

- Docker
- Docker Compose
- PostgreSQL container

## Repository Structure

```text
Fridge9000/
│
├── backend/
│   ├── main.py
│   ├── train.py
│   ├── prepare_data.py
│   ├── requirements.txt
│   ├── rules.json
│   ├── best.pt
│   └── sam2_t.pt
│
├── db/
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

The YOLO model detects products and returns:

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

### 2. Inventory Tracking

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

### 3. Expiration Management

When an expiration date is known, it is stored directly.

When one is not provided, Fridge 9000 estimates a date according to the product category.

The system automatically identifies products that are:

- Expired
- Expiring soon
- Low in stock
- Missing

### 4. Receipt Processing

Users can upload grocery receipts as:

- PDF
- JPG
- JPEG
- PNG

Tesseract OCR extracts the text and attempts to identify purchased products.

The detected products can then be reviewed before being added to inventory.

### 5. SAM2 Product Segmentation

Fridge 9000 uses SAM2 to generate isolated product representations from detected objects.

The pipeline is approximately:

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
Product Mask
     │
     ▼
Representative Product Outline
```

## Running the Project

### Requirements

Install:

- Docker Desktop
- Git
- Node.js
- Expo Go on your mobile device

Clone the repository:

```bash
git clone https://github.com/netanel770/Fridge9000.git
cd Fridge9000
```

## Start the Backend and Database

From the project root:

```bash
docker compose up --build
```

Wait until the containers finish starting.

The backend and PostgreSQL database will then be available through Docker.

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

The mobile application needs to know the IP address of the computer running the backend.

Update:

```text
mobile/src/services/config.ts
```

and configure the backend URL using your computer's local network IP.

Example:

```text
http://192.168.1.100:<backend-port>
```

Make sure the phone and computer are connected to the same network.

Start Expo:

```bash
npx expo start
```

Open **Expo Go** on your phone and connect to the displayed development server.

## Main Application Screens

The mobile application includes screens for:

- Home dashboard
- Inventory
- Image-based inventory updates
- Manual inventory management
- Detection review
- Receipt upload
- Alerts
- Expired products
- Event history
- Open-product quantity adjustment

## Machine Learning

### YOLO

Fridge 9000 uses a custom-trained YOLO model for product detection.

The model identifies supported refrigerator products and produces:

- Class label
- Confidence score
- Bounding box

User corrections can also be stored through the detection review system.

### SAM2

SAM2 is used after product detection to generate more accurate product segmentation masks.

This allows the application to create cleaner visual representations of detected products rather than relying only on rectangular YOLO bounding boxes.

### OCR

Tesseract OCR is used to process grocery receipts.

The OCR pipeline performs text extraction and filters receipt metadata such as:

- Totals
- Payment information
- Store details
- Prices
- Barcodes

before identifying candidate product names.

## Database

Fridge 9000 stores information including:

- Products
- Inventory
- Inventory batches
- Scans
- Object detections
- Detection reviews
- Inventory events
- Expiration information
- Representative product images

This allows the system to maintain both the current fridge state and a historical record of changes.

## Current Limitations

Fridge 9000 is an academic prototype and currently has several limitations:

- Product detection is limited by the classes represented in the training dataset.
- Products hidden behind other objects may not be detected.
- Receipt OCR accuracy depends heavily on receipt layout and image quality.
- Estimated expiration dates are currently rule-based.
- Some inventory operations still require user confirmation to avoid false updates.
- The development mobile application requires the phone and backend machine to be accessible over the same network.

## Project Goal

The goal of Fridge 9000 is to demonstrate how multiple technologies can work together to create an intelligent household inventory system.

Rather than relying on manual inventory tracking alone, the system combines:

```text
Computer Vision
       +
OCR
       +
Inventory History
       +
Expiration Tracking
       +
Mobile Interaction
       =
Smart Fridge Management
```

The objective is to create a system capable of understanding **what is currently inside a refrigerator**, while helping users manage inventory, track expiration dates, and reduce unnecessary food waste.

## Authors

Fridge 9000 was developed as a final academic project.

## License

This repository is currently intended for academic and educational use.
