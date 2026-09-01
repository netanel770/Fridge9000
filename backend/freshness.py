import re
from typing import Any, Dict, Mapping, Optional


FRESHNESS_CONDITIONS = ("Fresh", "Rotten")
SUPPORTED_FRESHNESS_CLASSES = (
    "Fresh Apples",
    "Rotten Apples",
    "Fresh Bananas",
    "Rotten Bananas",
    "Fresh Oranges",
    "Rotten Oranges",
)


def parse_freshness_class(label: str) -> Optional[Dict[str, Any]]:
    """Turn a classifier class such as 'Fresh Apples' into API-friendly data."""
    normalized = " ".join(str(label or "").split())
    match = re.fullmatch(r"(Fresh|Rotten)\s+(.+)", normalized, flags=re.IGNORECASE)
    if not match:
        return None

    condition = match.group(1).capitalize()
    item = match.group(2).strip()
    if not item:
        return None
    return {
        "predicted_class": normalized,
        "item": item,
        "condition": condition,
        "is_rotten": condition == "Rotten",
    }


def classification_probabilities(
    names: Mapping[int, str], probabilities: Any, limit: int = 3
) -> list[Dict[str, Any]]:
    """Return the strongest classifier alternatives without exposing tensors."""
    values = probabilities.tolist() if hasattr(probabilities, "tolist") else list(probabilities)
    ranked = sorted(enumerate(values), key=lambda pair: float(pair[1]), reverse=True)
    candidates = []
    for class_id, confidence in ranked[:limit]:
        label = str(names.get(class_id, class_id))
        parsed = parse_freshness_class(label)
        candidates.append({
            "class_id": class_id,
            "label": label,
            "confidence": float(confidence),
            "recognized": parsed is not None,
        })
    return candidates


def normalize_product_identity(label: str) -> str:
    parsed = parse_freshness_class(label)
    product = parsed["item"] if parsed else str(label or "")
    normalized = " ".join(re.findall(r"[a-z0-9]+", product.casefold()))
    if normalized.endswith("s") and len(normalized) > 3:
        normalized = normalized[:-1]
    return normalized


def is_supported_freshness_class(label: str) -> bool:
    parsed = parse_freshness_class(label)
    if not parsed:
        return False
    supported_signatures = {
        (
            parse_freshness_class(supported)["condition"].casefold(),
            normalize_product_identity(supported),
        )
        for supported in SUPPORTED_FRESHNESS_CLASSES
    }
    return (
        parsed["condition"].casefold(),
        normalize_product_identity(parsed["item"]),
    ) in supported_signatures


def supported_product_identities(names: Mapping[int, str]) -> set[str]:
    identities = set()
    for label in names.values():
        normalized_label = " ".join(str(label or "").split())
        if not is_supported_freshness_class(normalized_label):
            continue
        identity = normalize_product_identity(normalized_label)
        if identity:
            identities.add(identity)
    return identities
