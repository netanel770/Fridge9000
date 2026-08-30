import unittest

import pytest

try:
    from backend.freshness import classification_probabilities, parse_freshness_class
except ImportError:
    from freshness import classification_probabilities, parse_freshness_class


pytestmark = pytest.mark.ml


class FreshnessClassificationHelpersTest(unittest.TestCase):
    def test_parses_fresh_and_rotten_classes(self):
        self.assertEqual(parse_freshness_class("Fresh Apples"), {
            "predicted_class": "Fresh Apples", "item": "Apples",
            "condition": "Fresh", "is_rotten": False,
        })
        self.assertTrue(parse_freshness_class("Rotten Banana")["is_rotten"])

    def test_rejects_unexpected_classes(self):
        self.assertIsNone(parse_freshness_class("Apples"))
        self.assertIsNone(parse_freshness_class("Overripe Apples"))

    def test_returns_ranked_serializable_candidates(self):
        candidates = classification_probabilities(
            {0: "Fresh Apples", 1: "Rotten Apples", 2: "mystery"},
            [0.2, 0.7, 0.1],
            limit=2,
        )
        self.assertEqual([item["class_id"] for item in candidates], [1, 0])
        self.assertTrue(all(item["recognized"] for item in candidates))


if __name__ == "__main__":
    unittest.main()
