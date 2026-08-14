import re
from typing import Any, Dict, Mapping, Optional


FRESHNESS_CONDITIONS = ("Fresh", "Rotten")


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
