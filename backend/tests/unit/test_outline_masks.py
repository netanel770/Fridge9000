import importlib

import numpy as np
import pytest


pytestmark = pytest.mark.unit


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


def test_small_centered_foreground_beats_its_inverse_background_mask():
    outlines = _outlines_module()
    foreground = np.zeros((200, 200), dtype=np.float32)
    yy, xx = np.ogrid[:200, :200]
    foreground[(xx - 100) ** 2 + (yy - 100) ** 2 <= 15 ** 2] = 1.0
    inverse = 1.0 - foreground

    cleaned_foreground, foreground_quality, _ = outlines.clean_and_score_mask(
        foreground, [6, 6, 194, 194], 0.9
    )
    cleaned_inverse, inverse_quality, _ = outlines.clean_and_score_mask(
        inverse, [6, 6, 194, 194], 0.9
    )

    assert cleaned_foreground is not None
    assert foreground_quality > inverse_quality
    assert cleaned_inverse is None


def test_nearly_full_background_with_central_hole_is_rejected():
    outlines = _outlines_module()
    background = np.zeros((160, 180), dtype=np.float32)
    background[5:155, 5:175] = 1.0
    background[60:100, 70:110] = 0.0

    cleaned, quality, touches_prompt = outlines.clean_and_score_mask(
        background, [5, 5, 175, 155], 1.0
    )

    assert cleaned is None
    assert quality == 0.0
    assert touches_prompt is True


def test_large_bottle_shaped_foreground_is_still_accepted():
    outlines = _outlines_module()
    bottle = np.zeros((220, 160), dtype=np.float32)
    bottle[15:55, 65:95] = 1.0
    bottle[50:210, 35:125] = 1.0

    cleaned, quality, _ = outlines.clean_and_score_mask(
        bottle, [5, 5, 155, 210], 0.95
    )

    assert cleaned is not None
    assert int(cleaned.sum()) == int(bottle.sum())
    assert quality >= 0.58


def test_valid_foreground_touching_one_prompt_boundary_is_not_rejected():
    outlines = _outlines_module()
    foreground = np.zeros((140, 180), dtype=np.float32)
    foreground[5:90, 55:125] = 1.0

    cleaned, quality, touches_prompt = outlines.clean_and_score_mask(
        foreground, [5, 5, 175, 135], 0.85
    )

    assert cleaned is not None
    assert quality > 0.35
    assert touches_prompt is True
