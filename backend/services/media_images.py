from io import BytesIO

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError


def normalize_uploaded_image(contents: bytes, content_type: str):
    formats = {
        "image/jpeg": ("JPEG", "jpg"),
        "image/png": ("PNG", "png"),
        "image/webp": ("WEBP", "webp"),
    }
    image_format = formats.get(content_type)
    if not image_format:
        raise HTTPException(status_code=415, detail="Upload a JPEG, PNG, or WebP image")
    try:
        with Image.open(BytesIO(contents)) as source:
            normalized = ImageOps.exif_transpose(source)
            normalized.load()
            if image_format[0] == "JPEG":
                normalized = normalized.convert("RGB")
            elif normalized.mode not in ("RGB", "RGBA"):
                normalized = normalized.convert("RGBA" if "transparency" in source.info else "RGB")
            output = BytesIO()
            save_options = {"quality": 95} if image_format[0] in ("JPEG", "WEBP") else {}
            normalized.save(output, format=image_format[0], **save_options)
            width, height = normalized.size
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Uploaded image could not be decoded") from exc
    if width <= 0 or height <= 0:
        raise HTTPException(status_code=400, detail="Uploaded image has invalid dimensions")
    return output.getvalue(), image_format[1], width, height
