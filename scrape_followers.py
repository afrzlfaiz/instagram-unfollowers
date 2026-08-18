"""Ambil SEMUA followers/following user via web API Instagram, auto-pagination.

Cookie sessionid+ds_user_id, user-agent browser, x-ig-app-id — tanpa claim.
Followers di-cap ~24/halaman walau count minta lebih (count=50); following
menerima count besar (count=200). Loop next_max_id sampai habis.

Contoh:
    python3 scrape_followers.py --user-id 30869018875 --sessionid 'xxx...'
    python3 scrape_followers.py --user-id 30869018875 --list following
    IG_SESSIONID=xxx python3 scrape_followers.py --user-id 30869018875
    python3 scrape_followers.py --user-id 30869018875 --max-pages 3   # dry run
"""

import argparse
import json
import os
import ssl
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request as UrlRequest, urlopen

import certifi

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
)
IG_APP_ID = "936619743392459"
# followers di-cap ~24/halaman; following menerima count besar
COUNT = {"followers": 50, "following": 200}
CTX = ssl.create_default_context(cafile=certifi.where())


def fetch(cookies: dict, url: str, retries: int = 3) -> dict:
    """GET JSON dengan retry backoff untuk rate limit / error transient (429, 5xx)."""
    headers = {
        "user-agent": UA,
        "accept": "*/*",
        "cookie": "; ".join(f"{k}={v}" for k, v in cookies.items() if v),
        "x-ig-app-id": IG_APP_ID,
        "x-requested-with": "XMLHttpRequest",
    }
    last_exc = None
    for attempt in range(retries):
        try:
            with urlopen(UrlRequest(url, headers=headers), timeout=30, context=CTX) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except HTTPError as exc:
            last_exc = exc
            if exc.code not in (429, 500, 502, 503) or attempt == retries - 1:
                raise
            time.sleep(2 * (2 ** attempt))  # 2, 4, 8 dtk
    raise last_exc


def fetch_iter(cookies: dict, user_id: str, which: str, sleep: float = 1.0,
               max_pages: int = 0):
    """Generator yang yield (page, chunk, users_so_far) tiap halaman sampai habis."""
    users = []
    max_id = None
    page = 0
    while True:
        page += 1
        params = {"count": COUNT[which]}
        if which == "followers":
            params["search_surface"] = "follow_list_page"
        if max_id:
            params["max_id"] = max_id
        url = (
            f"https://www.instagram.com/api/v1/friendships/{user_id}/{which}/?"
            + urlencode(params)
        )
        try:
            data = fetch(cookies, url)
        except HTTPError as exc:
            raise RuntimeError(
                f"halaman {page}: HTTP {exc.code} — {exc.read().decode('utf-8', 'replace')[:200]}"
            ) from exc

        chunk = data.get("users") or []
        users.extend(chunk)
        yield page, chunk, users

        max_id = data.get("next_max_id")
        if not max_id or (max_pages and page >= max_pages):
            break
        time.sleep(sleep)


def fetch_all(cookies: dict, user_id: str, which: str, sleep: float = 1.0,
              max_pages: int = 0, verbose: bool = True) -> list:
    """Ambil semua user dari daftar followers/following, loop next_max_id sampai habis."""
    users = []
    for page, chunk, users_so_far in fetch_iter(cookies, user_id, which, sleep, max_pages):
        users = users_so_far
        if verbose:
            print(f"halaman {page}: +{len(chunk)} (total {len(users)})")
            sys.stdout.flush()
    return users


def main():
    ap = argparse.ArgumentParser(description="Ambil semua followers/following via web API Instagram")
    ap.add_argument("--list", choices=["followers", "following"], default="followers",
                    help="daftar yang diambil (default: followers)")
    ap.add_argument("--user-id", required=True, help="ID akun yang daftarnya diambil")
    ap.add_argument("--sessionid", default=os.getenv("IG_SESSIONID", ""), help="cookie sessionid")
    ap.add_argument("--login-id", default=None, help="ds_user_id (default: user-id)")
    ap.add_argument("--output", default=None, help="file JSON tujuan (default: <list>_<uid>.json)")
    ap.add_argument("--sleep", type=float, default=1.0, help="jeda antar halaman (detik)")
    ap.add_argument("--max-pages", type=int, default=0, help="batas halaman untuk tes (0 = tanpa batas)")
    args = ap.parse_args()

    if not args.sessionid:
        sys.exit("sessionid wajib — pakai --sessionid atau env IG_SESSIONID")
    cookies = {
        "sessionid": args.sessionid,
        "ds_user_id": args.login_id or args.user_id,
    }

    try:
        users = fetch_all(cookies, args.user_id, args.list, args.sleep, args.max_pages)
    except RuntimeError as exc:
        sys.exit(f"gagal: {exc}")

    out = args.output or f"{args.list}_{args.user_id}.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(users, f, ensure_ascii=False, indent=1)
    print(f"selesai: {len(users)} user -> {out}")


if __name__ == "__main__":
    main()
