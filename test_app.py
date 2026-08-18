import unittest

from app import app, build_cookies, compare_user_lists, normalize_username


class AppHelpersTests(unittest.TestCase):
    def test_build_cookies_extracts_encoded_user_id(self):
        self.assertEqual(
            build_cookies("12345%3Asecret%3Aextra"),
            {"sessionid": "12345%3Asecret%3Aextra", "ds_user_id": "12345"},
        )

    def test_build_cookies_rejects_malformed_session(self):
        with self.assertRaises(ValueError):
            build_cookies("not-a-session")
        with self.assertRaises(ValueError):
            build_cookies("123:secret;evil=true")

    def test_normalize_username(self):
        self.assertEqual(normalize_username(" @Example.User "), "example.user")
        with self.assertRaises(ValueError):
            normalize_username("bad username")

    def test_compare_user_lists(self):
        followers = [{"pk": "1", "username": "one"}, {"pk": "2", "username": "two"}]
        following = [{"pk": "2", "username": "two"}, {"pk": "3", "username": "three"}]

        result = compare_user_lists(followers, following)

        self.assertEqual([user["username"] for user in result["unfollowers"]], ["three"])
        self.assertEqual([user["username"] for user in result["fans"]], ["one"])
        self.assertEqual([user["username"] for user in result["mutuals"]], ["two"])


class AppRouteTests(unittest.TestCase):
    def setUp(self):
        app.config.update(TESTING=True)
        self.client = app.test_client()

    def test_healthcheck(self):
        response = self.client.get("/healthz")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {"status": "ok"})

    def test_html_response_is_not_cached(self):
        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")

    def test_proxy_rejects_invalid_session_and_count(self):
        invalid_session = self.client.get(
            "/api/ig/friendships/123/followers?count=50",
            headers={"x-sessionid": "invalid"},
        )
        invalid_count = self.client.get(
            "/api/ig/friendships/123/followers?count=201",
            headers={"x-sessionid": "123:secret"},
        )

        self.assertEqual(invalid_session.status_code, 400)
        self.assertEqual(invalid_count.status_code, 400)

    def test_proxy_rejects_invalid_username(self):
        response = self.client.get(
            "/api/ig/users/web_profile_info?username=bad%20name",
            headers={"x-sessionid": "123:secret"},
        )

        self.assertEqual(response.status_code, 400)

    def test_image_proxy_rejects_non_allowlisted_url(self):
        response = self.client.get(
            "/api/ig/img?url=https%3A%2F%2Fevil.example%2Favatar.jpg"
        )

        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
