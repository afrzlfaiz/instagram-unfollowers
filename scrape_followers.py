"""Ambil SEMUA followers/following user via web API Instagram, auto-pagination.

Cookie sessionid+ds_user_id, user-agent browser, x-ig-app-id — tanpa claim.
Followers di-cap ~24/halaman walau count minta lebih (count=50); following
menerima count besar (count=200). Loop next_max_id sampai habis.

Target deploy: Render.com (atau mac/lokal) — satu rute koneksi langsung,
tanpa logika khusus platform.

Contoh:
    python3 scrape_followers.py --user-id 30869018875 --sessionid 'xxx...'
    python3 scrape_followers.py --user-id 30869018875 --list following
    IG_SESSIONID=xxx python3 scrape_followers.py --user-id 30869018875
    python3 scrape_followers.py --user-id 30869018875 --max-pages 3   # dry run
"""

import argparse
import json
import os
import re
import ssl
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import (
    HTTPSHandler,
    ProxyHandler,
    Request as UrlRequest,
    build_opener,
    getproxies,
)

import certifi

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
)
IG_APP_ID = "936619743392459"
# followers di-cap ~24/halaman; following menerima count besar
COUNT = {"followers": 50, "following": 200}
CTX = ssl.create_default_context(cafile=certifi.where())
USER_ID_RE = re.compile(r"^[0-9]+$")


def validate_user_id(user_id: str) -> str:
    """Validate the numeric Instagram user ID used in API URL paths."""
    value = str(user_id).strip()
    if not USER_ID_RE.fullmatch(value):
        raise ValueError("user ID harus berupa angka")
    return value


def make_openers():
    """Satu rute: koneksi langsung, hormati proxy env (HTTP(S)_PROXY)."""
    return [build_opener(ProxyHandler(getproxies()), HTTPSHandler(context=CTX))]


def _open_once(opener, url, headers, timeout=30):
    with opener.open(UrlRequest(url, headers=headers), timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch(cookies: dict, url: str, retries: int = 3) -> dict:
    """GET JSON dengan retry cepat untuk error transient (429, 5xx, reset).

    Jeda sengaja pendek (2s, 4s): request harus selesai jauh di bawah
    timeout gunicorn 30s di Render — error dilaporkan cepat, tidak hang."""
    if retries < 1:
        raise ValueError("retries harus minimal 1")

    headers = {
        "user-agent": UA,
        "accept": "*/*",
        "cookie": "; ".join(f"{k}={v}" for k, v in cookies.items() if v),
        "x-ig-app-id": IG_APP_ID,
        "x-requested-with": "XMLHttpRequest",
    }
    opener = make_openers()[0]
    for attempt in range(retries):
        try:
            return _open_once(opener, url, headers)
        except HTTPError as exc:
            if exc.code in (429, 500, 502, 503) and attempt < retries - 1:
                time.sleep(2 * (attempt + 1))  # 2s, 4s
                continue
            raise
        except OSError as exc:  # reset/timeout jaringan — transient
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            raise


def fetch_iter(cookies: dict, user_id: str, which: str, sleep: float = 1.0,
               max_pages: int = 0):
    """Generator yang yield (page, chunk, users_so_far) tiap halaman sampai habis."""
    if which not in COUNT:
        raise ValueError("jenis daftar harus followers atau following")
    user_id = validate_user_id(user_id)
    if sleep < 0:
        raise ValueError("sleep tidak boleh negatif")
    if max_pages < 0:
        raise ValueError("max_pages tidak boleh negatif")

    users = []
    seen_user_ids = set()
    seen_max_ids = set()
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

        if not isinstance(data, dict):
            raise RuntimeError(f"halaman {page}: respons Instagram bukan JSON object")

        raw_chunk = data.get("users") or []
        if not isinstance(raw_chunk, list):
            raise RuntimeError(f"halaman {page}: format daftar user tidak valid")

        chunk = []
        for user in raw_chunk:
            if not isinstance(user, dict):
                continue
            user_key = user.get("pk") or user.get("id")
            if user_key is None:
                continue
            user_key = str(user_key)
            if user_key in seen_user_ids:
                continue
            seen_user_ids.add(user_key)
            chunk.append(user)

        users.extend(chunk)
        yield page, chunk, users

        next_max_id = data.get("next_max_id")
        if not next_max_id or (max_pages and page >= max_pages):
            break
        next_max_id = str(next_max_id)
        if next_max_id in seen_max_ids:
            raise RuntimeError(f"halaman {page}: pagination Instagram berulang")
        seen_max_ids.add(next_max_id)
        max_id = next_max_id
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
    except (RuntimeError, ValueError) as exc:
        sys.exit(f"gagal: {exc}")

    out = args.output or f"{args.list}_{args.user_id}.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(users, f, ensure_ascii=False, indent=1)
    print(f"selesai: {len(users)} user -> {out}")


if __name__ == "__main__":
    main()
