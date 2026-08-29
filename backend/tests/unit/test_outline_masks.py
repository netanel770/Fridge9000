import importlib

import numpy as np


def _outlines_module():
    return importlib.import_module("services.outlines")


def test_expanded_box_clamps_to_image_bounds():
    outlines = _outlines_module()
    assert outlines.expanded_box([20, 10, 40, 30], 100, 80, 0.5) == [10, 0, 50, 40]


def test_mask_cleanup_keeps_largest_component_and_returns_quality():
    outlines = _outlines_module()
    raw_mask = np.zeros((80, 100), dtype=np.float32)
    raw_mask[10:50, 20:60] = 1.0
    raw_mask[70:72, 90:92] = 1.0

    cleaned, quality, touches_prompt = outlines.clean_and_score_mask(
        raw_mask, [20, 10, 60, 50], 0.9
    )

    assert cleaned.shape == raw_mask.shape
    assert int(cleaned.sum()) == 1600
    assert 0.7 < quality < 1.0
    assert touches_prompt is True
