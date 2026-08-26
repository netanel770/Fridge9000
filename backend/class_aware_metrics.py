"""Strict semantic class analysis for detector comparison artifacts."""

from __future__ import annotations

import math
import numbers
from typing import Any


METRIC_KEYS = ("precision", "recall", "map50", "map50_95")


def finite_metric(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, numbers.Real):
        raise ValueError(f"{field} must be a numeric metric")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{field} must be finite")
    return number


def normalized_class_names(raw: Any, field: str) -> list[str]:
    if isinstance(raw, dict):
        try:
            indexed = {int(key): value for key, value in raw.items()}
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{field} class IDs must be integers") from exc
        if set(indexed) != set(range(len(indexed))):
            raise ValueError(f"{field} class IDs must be contiguous from zero")
        values = [indexed[index] for index in range(len(indexed))]
    elif isinstance(raw, (list, tuple)):
        values = list(raw)
    else:
        raise ValueError(f"{field} classes must be an indexed mapping or list")

    names: list[str] = []
    identities: set[str] = set()
    for value in values:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{field} contains an empty or non-string class name")
        name = value.strip()
        identity = name.casefold()
        if identity in identities:
            raise ValueError(f"{field} contains duplicate normalized class name {name!r}")
        identities.add(identity)
        names.append(name)
    if not names:
        raise ValueError(f"{field} contains no classes")
    return names


def class_set_analysis(active_classes: Any, candidate_classes: Any) -> dict[str, list[str]]:
    active = normalized_class_names(active_classes, "active model")
    candidate = normalized_class_names(candidate_classes, "candidate model")
    active_by_identity = {name.casefold(): name for name in active}
    candidate_by_identity = {name.casefold(): name for name in candidate}
    return {
        "active_classes": active,
        "candidate_classes": candidate,
        "shared_classes": [name for name in active if name.casefold() in candidate_by_identity],
        "added_classes": [name for name in candidate if name.casefold() not in active_by_identity],
        "removed_classes": [name for name in active if name.casefold() not in candidate_by_identity],
    }


def missing_required_classes(required_classes: Any, available_classes: Any) -> list[str]:
    """Return required semantic classes absent from an available class mapping."""
    required = normalized_class_names(required_classes, "required")
    available = normalized_class_names(available_classes, "available")
    available_identities = {name.casefold() for name in available}
    return [name for name in required if name.casefold() not in available_identities]


def require_class_preservation(
    required_classes: Any, available_classes: Any, context: str
) -> None:
    missing = missing_required_classes(required_classes, available_classes)
    if missing:
        raise ValueError(
            f"{context} is missing active detector classes: {', '.join(missing)}"
        )


def validated_per_class(raw: Any, classes: list[str], field: str) -> dict[str, dict[str, Any]]:
    if not isinstance(raw, list):
        raise ValueError(f"{field}.per_class must be a list")
    allowed = {name.casefold(): name for name in classes}
    rows: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"{field}.per_class[{index}] must be an object")
        name = item.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"{field}.per_class[{index}] has an invalid class name")
        display_name = name.strip()
        identity = display_name.casefold()
        if identity not in allowed:
            raise ValueError(f"{field}.per_class references undeclared class {display_name!r}")
        if identity in rows:
            raise ValueError(f"{field}.per_class duplicates class {display_name!r}")
        metrics = {
            key: finite_metric(item.get(key), f"{field}.per_class[{display_name!r}].{key}")
            for key in METRIC_KEYS
        }
        rows[identity] = {"name": allowed[identity], **metrics}
    return rows


def _aggregate(rows: dict[str, dict[str, Any]], names: list[str]) -> dict[str, float]:
    return {
        key: sum(rows[name.casefold()][key] for name in names) / len(names)
        for key in METRIC_KEYS
    }


def _differences(candidate: dict[str, float], active: dict[str, float]) -> dict[str, float]:
    return {key: candidate[key] - active[key] for key in METRIC_KEYS}


def _candidate_is_better(delta: dict[str, float], tolerance: float = 1e-12) -> bool:
    return delta["map50_95"] > tolerance or (
        abs(delta["map50_95"]) <= tolerance and delta["map50"] > tolerance
    )


def build_class_aware_comparison(
    active_evaluation: dict[str, Any], candidate_evaluation: dict[str, Any]
) -> dict[str, Any]:
    analysis = class_set_analysis(
        active_evaluation.get("classes"), candidate_evaluation.get("classes")
    )
    active_rows = validated_per_class(
        active_evaluation.get("per_class"), analysis["active_classes"], "active evaluation"
    )
    candidate_rows = validated_per_class(
        candidate_evaluation.get("per_class"),
        analysis["candidate_classes"],
        "candidate evaluation",
    )

    comparable_shared = [
        name
        for name in analysis["shared_classes"]
        if name.casefold() in active_rows and name.casefold() in candidate_rows
    ]
    unavailable_shared = [
        name for name in analysis["shared_classes"] if name not in comparable_shared
    ]
    if comparable_shared:
        active_shared = _aggregate(active_rows, comparable_shared)
        candidate_shared = _aggregate(candidate_rows, comparable_shared)
        shared = {
            "available": True,
            "classes": comparable_shared,
            "class_count": len(comparable_shared),
            "class_names": comparable_shared,
            "unavailable_classes": unavailable_shared,
            "active_metrics": active_shared,
            "candidate_metrics": candidate_shared,
            "metric_differences": _differences(candidate_shared, active_shared),
            "candidate_outperforms_active": _candidate_is_better(
                _differences(candidate_shared, active_shared)
            ),
            "note": (
                "Macro-average of per-class metrics for the same semantic classes "
                "from each model's evaluation on the identical validation split."
            ),
        }
    else:
        shared = {
            "available": False,
            "classes": [],
            "class_count": 0,
            "class_names": [],
            "unavailable_classes": analysis["shared_classes"],
            "note": "No shared class had metrics in both model evaluations.",
        }

    measured_added = [
        name for name in analysis["added_classes"] if name.casefold() in candidate_rows
    ]
    unavailable_added = [
        name for name in analysis["added_classes"] if name not in measured_added
    ]
    if measured_added:
        per_class = {
            name: {key: candidate_rows[name.casefold()][key] for key in METRIC_KEYS}
            for name in measured_added
        }
        added = {
            "available": True,
            "classes": measured_added,
            "unavailable_classes": unavailable_added,
            "aggregate": _aggregate(candidate_rows, measured_added),
            "per_class": per_class,
            "note": "Macro-average of candidate per-class metrics for newly added classes.",
        }
    else:
        added = {
            "available": False,
            "classes": [],
            "unavailable_classes": analysis["added_classes"],
            "per_class": {},
            "note": "No added class had metrics in the candidate evaluation.",
        }

    return {
        "class_comparison": analysis,
        "shared_class_comparison": shared,
        "added_class_metrics": added,
    }
