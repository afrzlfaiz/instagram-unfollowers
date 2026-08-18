import unittest
from unittest.mock import patch

import scrape_followers


class PaginationTests(unittest.TestCase):
    def test_fetch_iter_deduplicates_users(self):
        responses = iter(
            [
                {"users": [{"pk": "1"}, {"pk": "2"}], "next_max_id": "next"},
                {"users": [{"pk": "2"}, {"pk": "3"}], "next_max_id": None},
            ]
        )

        with patch.object(scrape_followers, "fetch", side_effect=lambda *_: next(responses)):
            pages = list(scrape_followers.fetch_iter({}, "123", "followers", sleep=0))

        self.assertEqual([len(page[1]) for page in pages], [2, 1])
        self.assertEqual([user["pk"] for user in pages[-1][2]], ["1", "2", "3"])

    def test_fetch_iter_stops_repeating_cursor(self):
        responses = iter(
            [
                {"users": [{"pk": "1"}], "next_max_id": "same"},
                {"users": [{"pk": "2"}], "next_max_id": "same"},
            ]
        )

        with patch.object(scrape_followers, "fetch", side_effect=lambda *_: next(responses)):
            with self.assertRaisesRegex(RuntimeError, "pagination Instagram berulang"):
                list(scrape_followers.fetch_iter({}, "123", "followers", sleep=0))

    def test_fetch_iter_validates_arguments(self):
        with self.assertRaises(ValueError):
            list(scrape_followers.fetch_iter({}, "not-an-id", "followers"))
        with self.assertRaises(ValueError):
            list(scrape_followers.fetch_iter({}, "123", "unknown"))
        with self.assertRaises(ValueError):
            list(scrape_followers.fetch_iter({}, "123", "followers", sleep=-1))


if __name__ == "__main__":
    unittest.main()
