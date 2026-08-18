"""Flask web: cek followers / following / unfollowers akun Instagram.

Hanya butuh sessionid (ds_user_id diambil dari prefix sessionid itu sendiri).
Fetch followers + following via scrape_followers.fetch_all, lalu unfollowers =
following yang tidak di-follow-back (diff by pk). Deploy target: Render.com.

    python3 app.py   # http://127.0.0.1:5000
"""

import json
import re
import traceback
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlencode, urlsplit
from urllib.request import Request as UrlRequest

from flask import Flask, Response, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

from scrape_followers import fetch, fetch_all, make_openers

app = Flask(__name__)


@app.errorhandler(Exception)
def on_unhandled(exc):
    """Semua error tak terduga: print ke log (terlihat di dashboard Render)
    dan balas JSON berisi pesannya, bukan halaman 500 kosong."""
    if isinstance(exc, HTTPException):
        return exc
    traceback.print_exc()
    return jsonify({"message": str(exc)}), 500


def resolve_user_info(cookies: dict, username: str) -> tuple[str, dict]:
    """Cari User ID dan metadata profil pengguna target di Instagram."""
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
    user = (data.get("data") or {}).get("user")
    if not user or not user.get("id"):
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
    clean_session = sessionid.strip()
    user_id = unquote(clean_session).split(":")[0]
    return {"sessionid": clean_session, "ds_user_id": user_id}


@app.route("/", methods=["GET", "POST"])
def index():
    sessionid = request.form.get("sessionid", "").strip()
    username = request.form.get("username", "").strip().lstrip("@")
    error = None
    result = None
    target_profile = None

    if request.method == "POST":
        if not sessionid or not username:
            error = "Session ID dan Username target wajib diisi!"
        else:
            try:
                cookies = build_cookies(sessionid)
                uid, target_profile = resolve_user_info(cookies, username)
                
                followers = fetch_all(cookies, uid, "followers", sleep=0.5, verbose=False)
                following = fetch_all(cookies, uid, "following", sleep=0.5, verbose=False)
                
                followed_pks = {str(u.get("pk") or u.get("id")) for u in followers}
                following_pks = {str(u.get("pk") or u.get("id")) for u in following}
                
                unfollowers = [u for u in following if str(u.get("pk") or u.get("id")) not in followed_pks]
                fans = [u for u in followers if str(u.get("pk") or u.get("id")) not in following_pks]
                mutuals = [u for u in following if str(u.get("pk") or u.get("id")) in followed_pks]
                
                result = {
                    "unfollowers": unfollowers,
                    "fans": fans,
                    "mutuals": mutuals,
                    "following": following,
                    "followers": followers,
                }
            except RuntimeError as exc:
                error = str(exc)
            except Exception as exc:
                error = f"Terjadi kesalahan: {exc}"

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
    cookies = build_cookies(sessionid)

    if api_path == "users/web_profile_info":
        username = request.args.get("username", "").strip()
        if not username:
            return jsonify({"message": "query username wajib"}), 400
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
        params = {"count": count}
        if which == "followers":
            params["search_surface"] = "follow_list_page"
        max_id = request.args.get("max_id", "").strip()
        if max_id:
            params["max_id"] = max_id
        url = f"https://www.instagram.com/api/v1/friendships/{uid}/{which}/?" + urlencode(params)

    try:
        data = fetch(cookies, url)
    except HTTPError as exc:
        return jsonify({"message": f"HTTP {exc.code}", "httpStatus": exc.code}), 502
    except Exception as exc:
        return jsonify({"message": str(exc)}), 502
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
    try:
        parts = urlsplit(raw)
    except ValueError:
        return jsonify({"message": "URL tidak valid"}), 400
    host = (parts.hostname or "").lower()
    if (
        parts.scheme != "https"
        or not any(host == h or host.endswith("." + h) for h in ALLOWED_IMG_HOSTS)
    ):
        return jsonify({"message": "URL gambar tidak diizinkan"}), 400

    try:
        with make_openers()[0].open(UrlRequest(raw, headers={"user-agent": "Mozilla/5.0"}), timeout=30) as resp:
            data = resp.read()
            ctype = resp.headers.get("Content-Type", "image/jpeg")
            return Response(data, mimetype=ctype, headers={"Cache-Control": "public, max-age=86400"})
    except (HTTPError, URLError, OSError) as exc:
        return jsonify({"message": str(exc)}), 502


if __name__ == "__main__":
    app.run(debug=False, port=5000)
