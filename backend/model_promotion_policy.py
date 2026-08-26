"""Central class-aware promotion policy for persisted detector comparisons."""

from __future__ import annotations

from typing import Any

try:
    from class_aware_metrics import METRIC_KEYS, class_set_analysis, finite_metric
except ModuleNotFoundError:
    from backend.class_aware_metrics import METRIC_KEYS, class_set_analysis, finite_metric


POLICY_NAME = "class-aware-promotion-v1"


def _reason(code: str, message: str, **details: Any) -> dict[str, Any]:
    return {"code": code, "message": message, **details}


def _normalized_set(names: list[str]) -> set[str]:
    return {name.strip().casefold() for name in names}


def _class_list(value: Any, field: str) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(f"{field} must be a list")
    result: list[str] = []
    identities: set[str] = set()
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ValueError(f"{field} contains an invalid class name")
        name = item.strip()
        identity = name.casefold()
        if identity in identities:
            raise ValueError(f"{field} contains duplicate class {name!r}")
        identities.add(identity)
        result.append(name)
    return result


def _metrics(value: Any, field: str) -> dict[str, float]:
    if not isinstance(value, dict):
        raise ValueError(f"{field} must be an object")
    return {
        key: finite_metric(value.get(key), f"{field}.{key}") for key in METRIC_KEYS
    }


def _class_data(
    comparison: dict[str, Any],
) -> tuple[dict[str, list[str]], dict[str, Any], dict[str, Any]]:
    raw_classes = comparison.get("class_comparison")
    if not isinstance(raw_classes, dict):
        raise ValueError("class_comparison must be an object")
    active = _class_list(raw_classes.get("active_classes"), "active_classes")
    candidate = _class_list(raw_classes.get("candidate_classes"), "candidate_classes")
    expected = class_set_analysis(active, candidate)
    for key, expected_names in expected.items():
        actual_names = _class_list(raw_classes.get(key), key)
        if _normalized_set(actual_names) != _normalized_set(expected_names):
            raise ValueError(f"{key} disagrees with active and candidate class metadata")
    shared = comparison.get("shared_class_comparison")
    added = comparison.get("added_class_metrics")
    if not isinstance(shared, dict) or not isinstance(added, dict):
        raise ValueError("class-aware metric structures must be objects")
    return expected, shared, added


def evaluate_promotion(
    comparison: dict[str, Any] | None,
    *,
    current_active_id: int | None,
    candidate_id: int | None,
    max_shared_map50_95_regression: float,
    min_added_class_map50_95: float,
    min_added_class_per_class_map50_95: float,
) -> dict[str, Any]:
    """Return one auditable decision used by both the API and promotion transaction."""
    thresholds = {
        "max_shared_map50_95_regression": max_shared_map50_95_regression,
        "min_added_class_map50_95": min_added_class_map50_95,
        "min_added_class_per_class_map50_95": min_added_class_per_class_map50_95,
    }
    result: dict[str, Any] = {
        "policy": POLICY_NAME,
        "eligible": False,
        "mode": None,
        "thresholds": thresholds,
        "metrics": {},
        "reasons": [],
        "stale": False,
    }
    if comparison is None:
        result["reasons"] = [_reason("comparison_missing", "No comparison is available for this candidate.")]
        return result

    if (
        current_active_id is not None
        and comparison.get("active_model_id") != current_active_id
    ) or (
        candidate_id is not None
        and comparison.get("candidate_model_id") != candidate_id
    ):
        result["stale"] = True
        result["reasons"] = [
            _reason(
                "stale_comparison",
                "The candidate was not compared with the current active model.",
                compared_active_model_id=comparison.get("active_model_id"),
                current_active_model_id=current_active_id,
            )
        ]
        return result

    try:
        classes, shared, added = _class_data(comparison)
        has_added = bool(classes["added_classes"])
        has_removed = bool(classes["removed_classes"])
        same_classes = not has_added and not has_removed
        result["mode"] = "same_classes" if same_classes else "expanded_classes"

        if same_classes:
            active_metrics = _metrics(comparison.get("active_metrics"), "active_metrics")
            candidate_metrics = _metrics(comparison.get("candidate_metrics"), "candidate_metrics")
            outcome = comparison.get("candidate_outperforms_active")
            if not isinstance(outcome, bool):
                raise ValueError("candidate_outperforms_active must be boolean")
            result["metrics"] = {
                "active_map50_95": active_metrics["map50_95"],
                "candidate_map50_95": candidate_metrics["map50_95"],
                "active_map50": active_metrics["map50"],
                "candidate_map50": candidate_metrics["map50"],
            }
            if outcome:
                result["eligible"] = True
            else:
                result["reasons"] = [
                    _reason(
                        "candidate_lost",
                        "The same-class candidate did not outperform the active model.",
                    )
                ]
            return result

        reasons: list[dict[str, Any]] = []
        if has_removed:
            reasons.append(
                _reason(
                    "removed_classes",
                    "The candidate removes classes supported by the active model.",
                    classes=classes["removed_classes"],
                )
            )
        if not has_added:
            reasons.append(
                _reason(
                    "added_class_quality",
                    "The candidate does not add any measurable new classes.",
                )
            )

        shared_classes = _class_list(shared.get("classes"), "shared classes")
        unavailable_shared = _class_list(
            shared.get("unavailable_classes"), "unavailable shared classes"
        )
        if (
            shared.get("available") is not True
            or unavailable_shared
            or _normalized_set(shared_classes)
            != _normalized_set(classes["active_classes"])
        ):
            reasons.append(
                _reason(
                    "missing_shared_classes",
                    "Not every active class has comparable candidate metrics.",
                    missing_classes=sorted(
                        _normalized_set(classes["active_classes"])
                        - _normalized_set(shared_classes)
                    ),
                )
            )
        else:
            active_shared = _metrics(shared.get("active_metrics"), "shared active metrics")
            candidate_shared = _metrics(
                shared.get("candidate_metrics"), "shared candidate metrics"
            )
            differences = _metrics(
                shared.get("metric_differences"), "shared metric differences"
            )
            calculated_delta = candidate_shared["map50_95"] - active_shared["map50_95"]
            if abs(differences["map50_95"] - calculated_delta) > 1e-12:
                raise ValueError("shared mAP50-95 difference is inconsistent")
            result["metrics"].update(
                {
                    "shared_active_map50_95": active_shared["map50_95"],
                    "shared_candidate_map50_95": candidate_shared["map50_95"],
                    "shared_map50_95_difference": calculated_delta,
                }
            )
            if calculated_delta < -max_shared_map50_95_regression - 1e-12:
                reasons.append(
                    _reason(
                        "shared_class_regression",
                        "Existing-class performance regressed beyond the allowed tolerance.",
                        difference=calculated_delta,
                        maximum_regression=max_shared_map50_95_regression,
                    )
                )

        if has_added:
            added_classes = _class_list(added.get("classes"), "added metric classes")
            unavailable_added = _class_list(
                added.get("unavailable_classes"), "unavailable added classes"
            )
            per_class = added.get("per_class")
            if not isinstance(per_class, dict):
                raise ValueError("added per-class metrics must be an object")
            per_class_names = _class_list(list(per_class), "added per-class names")
            if (
                added.get("available") is not True
                or unavailable_added
                or _normalized_set(added_classes)
                != _normalized_set(classes["added_classes"])
                or _normalized_set(per_class_names)
                != _normalized_set(classes["added_classes"])
            ):
                raise ValueError("added-class metrics do not cover every added class")
            aggregate = _metrics(added.get("aggregate"), "added aggregate")
            per_class_map: dict[str, float] = {}
            normalized_rows = {
                name.strip().casefold(): value for name, value in per_class.items()
            }
            for name in classes["added_classes"]:
                row = _metrics(normalized_rows[name.casefold()], f"added class {name}")
                per_class_map[name] = row["map50_95"]
            calculated_aggregate = sum(per_class_map.values()) / len(per_class_map)
            if abs(aggregate["map50_95"] - calculated_aggregate) > 1e-12:
                raise ValueError(
                    "added aggregate mAP50-95 is inconsistent with per-class metrics"
                )
            result["metrics"].update(
                {
                    "added_map50_95": aggregate["map50_95"],
                    "added_per_class_map50_95": per_class_map,
                }
            )
            if aggregate["map50_95"] < min_added_class_map50_95 - 1e-12:
                reasons.append(
                    _reason(
                        "added_class_quality",
                        "Aggregate added-class performance is below the required minimum.",
                        value=aggregate["map50_95"],
                        minimum=min_added_class_map50_95,
                    )
                )
            below = {
                name: value
                for name, value in per_class_map.items()
                if value < min_added_class_per_class_map50_95 - 1e-12
            }
            if below:
                reasons.append(
                    _reason(
                        "added_class_below_minimum",
                        "One or more added classes are below the per-class quality minimum.",
                        classes=below,
                        minimum=min_added_class_per_class_map50_95,
                    )
                )
        result["reasons"] = reasons
        result["eligible"] = not reasons
        return result
    except (KeyError, TypeError, ValueError) as exc:
        result["eligible"] = False
        result["reasons"] = [
            _reason(
                "malformed_class_metrics",
                "The persisted class-aware comparison is incomplete or invalid.",
                detail=str(exc),
            )
        ]
        return result
