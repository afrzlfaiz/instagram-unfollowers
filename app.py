"""Flask web: cek followers / following / unfollowers akun Instagram.

Hanya butuh sessionid (ds_user_id diambil dari prefix sessionid itu sendiri).
Fetch followers + following via scrape_followers.fetch_all, lalu unfollowers =
following yang tidak di-follow-back (diff by pk). Deploy target: Render.com.

    python3 app.py   # http://127.0.0.1:5000
"""

import os
import re
import traceback
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlencode, urlsplit
from urllib.request import Request as UrlRequest

from flask import Flask, Response, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

from scrape_followers import fetch, fetch_all, make_openers

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024
USERNAME_RE = re.compile(r"^[A-Za-z0-9._]{1,30}$")
USER_ID_RE = re.compile(r"^[0-9]+$")
MAX_SESSION_ID_LENGTH = 512
MAX_PROXY_COUNT = 200
MAX_CURSOR_LENGTH = 256
MAX_IMAGE_BYTES = 5 * 1024 * 1024
ALLOWED_IMAGE_TYPES = frozenset({
    "image/avif",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
})


@app.errorhandler(Exception)
def on_unhandled(exc):
    """Semua error tak terduga: print ke log (terlihat di dashboard Render)
    dan balas JSON generik, bukan halaman 500 kosong atau detail internal."""
    if isinstance(exc, HTTPException):
        return exc
    traceback.print_exc()
    return jsonify({"message": "Terjadi kesalahan internal. Coba lagi."}), 500


@app.after_request
def add_security_headers(response):
    """Prevent browser sniffing/caching of pages that may contain a session ID."""
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    if response.mimetype == "text/html":
        response.headers["Cache-Control"] = "no-store"
    return response


def normalize_username(username: str) -> str:
    """Normalize and validate an Instagram username before using it in a URL."""
    value = (username or "").strip()
    if value.startswith("@"):
        value = value[1:]
    if not USERNAME_RE.fullmatch(value):
        raise ValueError(
            "Username harus 1-30 karakter dan hanya boleh berisi huruf, angka, titik, atau underscore."
        )
    return value.lower()


def resolve_user_info(cookies: dict, username: str) -> tuple[str, dict]:
    """Cari User ID dan metadata profil pengguna target di Instagram."""
    username = normalize_username(username)
    url = "https://www.instagram.com/api/v1/users/web_profile_info/?" + urlencode({"username": username})
    try:
        data = fetch(cookies, url)
    except HTTPError as exc:
        if exc.code == 429:
            raise RuntimeError(
                "Instagram memblokir sementara (HTTP 429/rate limit) — tunggu beberapa menit lalu coba lagi."
            ) from exc
        raise RuntimeError(
            f"Resolusi username '{username}' gagal (HTTP {exc.code}) — periksa kembali sessionid atau status login akun Anda"
        ) from exc
    if not isinstance(data, dict):
        raise RuntimeError("Respons profil Instagram tidak valid")
    profile_data = data.get("data")
    user = profile_data.get("user") if isinstance(profile_data, dict) else None
    if not isinstance(user, dict) or not user.get("id"):
        raise RuntimeError(f"Akun Instagram @{username} tidak ditemukan")
    
    follower_count = (user.get("edge_followed_by") or {}).get("count") or user.get("follower_count") or 0
    following_count = (user.get("edge_follow") or {}).get("count") or user.get("following_count") or 0

    profile_info = {
        "id": user.get("id"),
        "username": user.get("username", username),
        "full_name": user.get("full_name", ""),
        "profile_pic_url": user.get("profile_pic_url", ""),
        "is_private": user.get("is_private", False),
        "is_verified": user.get("is_verified", False),
        "follower_count": follower_count,
        "following_count": following_count,
    }
    return user["id"], profile_info


def build_cookies(sessionid: str) -> dict:
    """Bangun cookie dictionary; ds_user_id diekstrak dari prefix sessionid."""
    clean_session = (sessionid or "").strip()
    decoded_session = unquote(clean_session)
    user_id = decoded_session.split(":", 1)[0]
    if (
        not clean_session
        or len(clean_session) > MAX_SESSION_ID_LENGTH
        or any(
            ord(char) < 32 or char.isspace() or char in ";,"
            for char in clean_session
        )
        or not USER_ID_RE.fullmatch(user_id)
    ):
        raise ValueError("Session ID tidak valid. Salin nilai cookie sessionid lengkap dari Instagram.")
    return {"sessionid": clean_session, "ds_user_id": user_id}


def user_key(user: dict) -> Optional[str]:
    """Return the stable ID used to compare follower and following lists."""
    if not isinstance(user, dict):
        return None
    value = user.get("pk") or user.get("id")
    return str(value) if value is not None else None


def compare_user_lists(followers: list, following: list) -> dict:
    """Build all relationship categories from two Instagram user lists."""
    followers = [user for user in followers if user_key(user) is not None]
    following = [user for user in following if user_key(user) is not None]
    follower_keys = {user_key(user) for user in followers}
    following_keys = {user_key(user) for user in following}
    return {
        "unfollowers": [user for user in following if user_key(user) not in follower_keys],
        "fans": [user for user in followers if user_key(user) not in following_keys],
        "mutuals": [user for user in following if user_key(user) in follower_keys],
        "following": following,
        "followers": followers,
    }


@app.get("/healthz")
def healthz():
    """Lightweight health check for Render and uptime monitors."""
    return jsonify({"status": "ok"})


@app.route("/", methods=["GET", "POST"])
def index():
    sessionid = request.form.get("sessionid", "").strip()
    raw_username = request.form.get("username", "")
    username = ""
    error = None
    result = None
    target_profile = None

    if raw_username.strip():
        try:
            username = normalize_username(raw_username)
        except ValueError as exc:
            error = str(exc)

    if request.method == "POST":
        if not sessionid:
            error = "Session ID dan Username target wajib diisi!"
        elif not username:
            error = error or "Session ID dan Username target wajib diisi!"
        else:
            try:
                cookies = build_cookies(sessionid)
                uid, target_profile = resolve_user_info(cookies, username)
                
                followers = fetch_all(cookies, uid, "followers", sleep=0.5, verbose=False)
                following = fetch_all(cookies, uid, "following", sleep=0.5, verbose=False)
                
                result = compare_user_lists(followers, following)
            except (RuntimeError, ValueError) as exc:
                error = str(exc)
            except Exception as exc:
                traceback.print_exc()
                error = "Terjadi kesalahan saat mengambil data. Coba lagi."

    return render_template(
        "index.html",
        sessionid=sessionid,
        username=username,
        error=error,
        result=result,
        target_profile=target_profile
    )


@app.route("/api/ig/<path:api_path>", methods=["GET"])
def ig_proxy(api_path):
    """Proxy passthrough ke IG — request per-halaman terlihat di Network tab.
    Sessionid dikirim browser sebagai header x-sessionid (same-origin, aman)."""
    sessionid = request.headers.get("x-sessionid", "").strip()
    if not sessionid:
        return jsonify({"message": "header x-sessionid wajib"}), 400
    try:
        cookies = build_cookies(sessionid)
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400

    if api_path == "users/web_profile_info":
        try:
            username = normalize_username(request.args.get("username", ""))
        except ValueError as exc:
            return jsonify({"message": str(exc)}), 400
        url = "https://www.instagram.com/api/v1/users/web_profile_info/?" + urlencode({"username": username})
    else:
        m = re.fullmatch(r"friendships/(\d+)/(followers|following)", api_path)
        if not m:
            return jsonify({"message": "path tidak diizinkan"}), 400
        uid, which = m.groups()
        try:
            count = int(request.args.get("count", "50"))
        except ValueError:
            return jsonify({"message": "count harus angka"}), 400
        if not 1 <= count <= MAX_PROXY_COUNT:
            return jsonify({"message": f"count harus antara 1 dan {MAX_PROXY_COUNT}"}), 400
        params = {"count": count}
        if which == "followers":
            params["search_surface"] = "follow_list_page"
        max_id = request.args.get("max_id", "").strip()
        if len(max_id) > MAX_CURSOR_LENGTH:
            return jsonify({"message": "max_id terlalu panjang"}), 400
        if max_id:
            params["max_id"] = max_id
        url = f"https://www.instagram.com/api/v1/friendships/{uid}/{which}/?" + urlencode(params)

    try:
        data = fetch(cookies, url)
    except HTTPError as exc:
        return jsonify({"message": f"HTTP {exc.code}", "httpStatus": exc.code}), 502
    except Exception:
        return jsonify({"message": "Instagram tidak dapat dihubungi. Coba lagi."}), 502
    return jsonify(data)


ALLOWED_IMG_HOSTS = ("cdninstagram.com", "fbcdn.net")


@app.route("/api/ig/img")
def ig_img():
    """Proxy gambar profil: CDN IG diblokir client-side (adblock/CORS) dari halaman
    asing. Ambil server-side (tanpa referer — CDN terbukti melayani 200) lalu
    kembalikan bytes; browser melihat request ke domain sendiri, tidak diblokir."""
    raw = request.args.get("url", "").strip()
    if not raw:
        return jsonify({"message": "query url wajib"}), 400
    if len(raw) > 4096:
        return jsonify({"message": "URL gambar terlalu panjang"}), 400
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError:
        return jsonify({"message": "URL tidak valid"}), 400
    host = (parts.hostname or "").lower()
    if (
        parts.scheme != "https"
        or parts.username
        or parts.password
        or port not in (None, 443)
        or not any(host == h or host.endswith("." + h) for h in ALLOWED_IMG_HOSTS)
    ):
        return jsonify({"message": "URL gambar tidak diizinkan"}), 400

    try:
        with make_openers()[0].open(UrlRequest(raw, headers={"user-agent": "Mozilla/5.0"}), timeout=30) as resp:
            ctype = (resp.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
            if ctype not in ALLOWED_IMAGE_TYPES:
                return jsonify({"message": "Respons bukan gambar yang didukung"}), 415
            content_length = resp.headers.get("Content-Length")
            if content_length:
                try:
                    if int(content_length) > MAX_IMAGE_BYTES:
                        return jsonify({"message": "Ukuran gambar terlalu besar"}), 413
                except ValueError:
                    pass
            data = resp.read(MAX_IMAGE_BYTES + 1)
            if len(data) > MAX_IMAGE_BYTES:
                return jsonify({"message": "Ukuran gambar terlalu besar"}), 413
            return Response(
                data,
                mimetype=ctype,
                headers={
                    "Cache-Control": "public, max-age=86400",
                    "X-Content-Type-Options": "nosniff",
                },
            )
    except (HTTPError, URLError, OSError) as exc:
        return jsonify({"message": str(exc)}), 502


if __name__ == "__main__":
    app.run(host="0.0.0.0", debug=False, port=int(os.getenv("PORT", "5000")))
