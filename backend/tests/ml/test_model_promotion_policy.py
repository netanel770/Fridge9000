import copy

import pytest

from backend.model_promotion_policy import evaluate_promotion


pytestmark = [pytest.mark.unit, pytest.mark.ml]

THRESHOLDS = {
    "max_shared_map50_95_regression": 0.02,
    "min_added_class_map50_95": 0.50,
    "min_added_class_per_class_map50_95": 0.30,
}


def metrics(map50_95: float) -> dict[str, float]:
    return {
        "precision": map50_95,
        "recall": map50_95,
        "map50": map50_95,
        "map50_95": map50_95,
    }


def same_class_comparison(candidate_wins: bool = True) -> dict:
    return {
        "active_model_id": 1,
        "candidate_model_id": 2,
        "active_metrics": metrics(0.70),
        "candidate_metrics": metrics(0.72 if candidate_wins else 0.69),
        "candidate_outperforms_active": candidate_wins,
        "class_comparison": {
            "active_classes": ["Apple", "Milk"],
            "candidate_classes": ["Apple", "Milk"],
            "shared_classes": ["Apple", "Milk"],
            "added_classes": [],
            "removed_classes": [],
        },
        "shared_class_comparison": {"available": True},
        "added_class_metrics": {"available": False, "classes": [], "unavailable_classes": [], "per_class": {}},
    }


def expanded_comparison(
    *,
    shared_candidate: float = 0.69,
    added_scores: tuple[float, ...] = (0.60,),
    active_classes: tuple[str, ...] = ("Apple", "Milk"),
    candidate_classes: tuple[str, ...] = ("Apple", "Milk", "Lemon"),
) -> dict:
    shared = [name for name in active_classes if name in candidate_classes]
    added = [name for name in candidate_classes if name not in active_classes]
    removed = [name for name in active_classes if name not in candidate_classes]
    per_class = {name: metrics(score) for name, score in zip(added, added_scores)}
    aggregate_score = sum(added_scores) / len(added_scores) if added_scores else 0.0
    return {
        "active_model_id": 1,
        "candidate_model_id": 2,
        "active_metrics": metrics(0.70),
        "candidate_metrics": metrics(0.71),
        "candidate_outperforms_active": True,
        "class_comparison": {
            "active_classes": list(active_classes),
            "candidate_classes": list(candidate_classes),
            "shared_classes": shared,
            "added_classes": added,
            "removed_classes": removed,
        },
        "shared_class_comparison": {
            "available": True,
            "classes": shared,
            "unavailable_classes": [],
            "active_metrics": metrics(0.70),
            "candidate_metrics": metrics(shared_candidate),
            "metric_differences": metrics(shared_candidate - 0.70),
        },
        "added_class_metrics": {
            "available": bool(added),
            "classes": added,
            "unavailable_classes": [],
            "aggregate": metrics(aggregate_score) if added else None,
            "per_class": per_class,
        },
    }


def evaluate(comparison: dict | None):
    return evaluate_promotion(
        comparison,
        current_active_id=1,
        candidate_id=2,
        **THRESHOLDS,
    )


def reason_codes(result: dict) -> set[str]:
    return {reason["code"] for reason in result["reasons"]}


def test_missing_and_stale_comparisons_fail_closed():
    missing = evaluate(None)
    assert missing["eligible"] is False
    assert reason_codes(missing) == {"comparison_missing"}

    stale_comparison = same_class_comparison()
    stale_comparison["active_model_id"] = 99
    stale = evaluate(stale_comparison)
    assert stale["eligible"] is False
    assert stale["stale"] is True
    assert reason_codes(stale) == {"stale_comparison"}


@pytest.mark.parametrize(
    ("candidate_wins", "eligible", "reason"),
    [(True, True, None), (False, False, "candidate_lost")],
)
def test_same_class_candidate_uses_persisted_outcome(candidate_wins, eligible, reason):
    result = evaluate(same_class_comparison(candidate_wins))
    assert result["mode"] == "same_classes"
    assert result["eligible"] is eligible
    assert reason_codes(result) == ({reason} if reason else set())


def test_expanded_class_set_can_pass_with_acceptable_shared_and_added_quality():
    result = evaluate(expanded_comparison(shared_candidate=0.68, added_scores=(0.60,)))
    assert result["mode"] == "expanded_classes"
    assert result["eligible"] is True
    assert result["metrics"]["shared_map50_95_difference"] == pytest.approx(-0.02)


def test_removed_classes_are_rejected():
    result = evaluate(expanded_comparison(
        active_classes=("Apple", "Milk"),
        candidate_classes=("Apple", "Lemon"),
        added_scores=(0.65,),
    ))
    assert result["eligible"] is False
    assert "removed_classes" in reason_codes(result)


@pytest.mark.parametrize(
    ("shared_candidate", "eligible"),
    [(0.679, False), (0.680, True), (0.695, True)],
)
def test_shared_class_regression_threshold_is_inclusive(shared_candidate, eligible):
    result = evaluate(expanded_comparison(shared_candidate=shared_candidate))
    assert result["eligible"] is eligible
    assert ("shared_class_regression" in reason_codes(result)) is (not eligible)


def test_insufficient_aggregate_added_class_quality_is_rejected():
    result = evaluate(expanded_comparison(
        candidate_classes=("Apple", "Milk", "Lemon", "Orange"),
        added_scores=(0.45, 0.49),
    ))
    assert result["eligible"] is False
    assert "added_class_quality" in reason_codes(result)


def test_insufficient_individual_added_class_quality_is_rejected():
    result = evaluate(expanded_comparison(
        candidate_classes=("Apple", "Milk", "Lemon", "Orange"),
        added_scores=(0.80, 0.20),
    ))
    assert result["eligible"] is False
    assert "added_class_below_minimum" in reason_codes(result)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda value: value["class_comparison"].update({"added_classes": []}),
        lambda value: value["shared_class_comparison"].update({"metric_differences": metrics(0.5)}),
        lambda value: value["added_class_metrics"].update({"per_class": {}}),
        lambda value: value["added_class_metrics"].update({"aggregate": metrics(float("nan"))}),
    ],
    ids=["inconsistent-class-set", "inconsistent-difference", "missing-per-class", "non-finite"],
)
def test_malformed_or_inconsistent_comparisons_fail_closed(mutate):
    comparison = copy.deepcopy(expanded_comparison())
    mutate(comparison)
    result = evaluate(comparison)
    assert result["eligible"] is False
    assert reason_codes(result) == {"malformed_class_metrics"}
