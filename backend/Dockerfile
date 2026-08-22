FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-heb \
    poppler-utils

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
# Inference runs locally on CPU; remote retraining gets its CUDA runtime from Kaggle.
# Installing PyTorch first from the CPU wheel index prevents Ultralytics from
# pulling several gigabytes of NVIDIA CUDA libraries into the backend image.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch torchvision
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .
COPY kaggle_trainer/train.py /kaggle_trainer/train.py
COPY kaggle_trainer/kernel-metadata.json /kaggle_trainer/kernel-metadata.json

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
