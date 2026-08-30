import os
import uuid

import pytesseract
from fastapi import File, HTTPException, UploadFile
from pdf2image import convert_from_path

try:
    from ..core.config import UPLOAD_DIR
    from ..db.connection import get_conn
except ImportError:
    from core.config import UPLOAD_DIR
    from db.connection import get_conn


async def upload_receipt(
    file: UploadFile = File(...), household_id: int = 1, user_id: int | None = None
):
    try:
        import re

        ext = file.filename.split(".")[-1].lower()

        if ext not in ("pdf", "jpg", "jpeg", "png"):
            raise HTTPException(
                status_code=400,
                detail="Only PDF, JPG, JPEG or PNG files are supported"
            )

        filename = f"{uuid.uuid4()}.{ext}"
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        file_path = os.path.join(UPLOAD_DIR, filename)

        with open(file_path, "wb") as f:
            f.write(await file.read())

        if ext == "pdf":
            pages = convert_from_path(file_path, dpi=300)
        else:
            from PIL import Image
            pages = [Image.open(file_path)]

        full_text = ""

        for i, page in enumerate(pages):
            text = pytesseract.image_to_string(page, lang="eng")

            print(f"----- PAGE {i + 1} OCR -----")
            print(text)

            full_text += text + "\n"

        lines = [
            line.strip()
            for line in full_text.splitlines()
            if line.strip()
        ]

        noise_words = [
            "receipt", "invoice", "tax", "vat",
            "cash", "credit", "visa", "mastercard", "change",
            "store", "branch", "date", "time", "cashier",
            "card", "customer", "thank", "thanks",
            "phone", "address", "qty", "quantity", "price",
            "item", "code", "barcode", "description",
        ]

        stop_words = [
            "subtotal",
            "sub-total",
            "sub-totai",
            "total",
            "payment",
            "you saved",
            "saved today",
            "amount due",
            "balance",
            "debit",
            "credit",
            "change",
            "thank you",
            "thanks",
        ]

        detected_items = []
        pending_item = None
        pending_qty = 1

        for raw_line in lines:
            line = raw_line.strip()
            line = line.replace("SR", "")

            if len(line) < 2:
                continue

            lowered = line.lower()

            if any(word in lowered for word in stop_words):
                break

            if any(word in lowered for word in noise_words):
                continue

            has_letters = re.search(r"[A-Za-z]", line)

            # Price examples: 9.99, 9 ,99, $9.99, SR 77.80
            has_price = re.search(r"\$?\s*\d+\s*[.,]\s*\d{2}", line)

            # Quantity at beginning of line, e.g. "2 WH Asahi 1+1/2 SR 77.80"
            qty_match = re.match(r"^\s*(\d+)\s+", line)
            quantity = int(qty_match.group(1)) if qty_match else 1

            # If this is only a price line, attach it to pending item
            if has_price and not has_letters:
                if pending_item:
                    for _ in range(pending_qty):
                        detected_items.append(pending_item.title())

                    pending_item = None
                    pending_qty = 1

                continue

            if not has_letters:
                continue

            cleaned_line = line

            # Remove price
            cleaned_line = re.sub(r"\$?\s*\d+\s*[.,]\s*\d{2}", " ", cleaned_line)

            # Remove long codes/barcodes
            cleaned_line = re.sub(r"\b\d{5,}\b", " ", cleaned_line)

            # Remove parenthesis content
            cleaned_line = re.sub(r"\([^)]*\)", " ", cleaned_line)

            # Remove leading quantity only
            cleaned_line = re.sub(r"^\s*\d+\s+", " ", cleaned_line)

            # Remove standalone numbers, but after leading quantity was saved
            cleaned_line = re.sub(r"\b\d+\b", " ", cleaned_line)

            # Keep English letters and useful separators
            cleaned_line = re.sub(r"[^A-Za-z\s\-']", " ", cleaned_line)

            item_name = " ".join(cleaned_line.split()).strip()

            if len(item_name) < 2:
                continue

            if has_price:
                for _ in range(quantity):
                    detected_items.append(item_name.title())

                pending_item = None
                pending_qty = 1
            else:
                pending_item = item_name
                pending_qty = quantity

        if pending_item:
            for _ in range(pending_qty):
                detected_items.append(pending_item.title())

        if not detected_items:
            raise HTTPException(status_code=400, detail="No items found in receipt")

        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO scans(household_id, created_by_user_id, image_ref, source)
                    VALUES (%s, %s, %s, 'receipt')
                    RETURNING id;
                    """,
                    (household_id, user_id, file_path),
                )
                scan_id = cur.fetchone()[0]

                for item in detected_items:
                    cur.execute(
                        """
                        INSERT INTO scan_detections(scan_id, label, confidence)
                        VALUES (%s, %s, %s);
                        """,
                        (scan_id, item, 1.0),
                    )

                conn.commit()

        return {
            "ok": True,
            "scan_id": scan_id,
            "items_count": len(detected_items),
            "items": detected_items,
        }

    except HTTPException:
        raise

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
