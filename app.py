"""Flask web: cek followers / following / unfollowers akun Instagram.

Hanya butuh sessionid (ds_user_id diambil dari prefix sessionid itu sendiri).
Fetch followers + following via scrape_followers.fetch_iter / fetch_all, lalu unfollowers =
following yang tidak di-follow-back (diff by pk).

    python3 app.py   # http://127.0.0.1:5000
"""

import json
from urllib.error import HTTPError
from urllib.parse import unquote, urlencode

from flask import Flask, Response, render_template, request, stream_with_context

from scrape_followers import fetch, fetch_all, fetch_iter

app = Flask(__name__)


def resolve_user_info(cookies: dict, username: str) -> tuple[str, dict]:
    """Cari User ID dan metadata profil pengguna target di Instagram."""
    url = "https://www.instagram.com/api/v1/users/web_profile_info/?" + urlencode({"username": username})
    try:
        data = fetch(cookies, url)
    except HTTPError as exc:
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


@app.route("/api/scan", methods=["POST", "GET"])
def api_scan():
    """Endpoint Server-Sent Events (SSE) untuk live streaming progress pengambilan data."""
    if request.method == "POST":
        sessionid = request.form.get("sessionid", "").strip()
        username = request.form.get("username", "").strip().lstrip("@")
    else:
        sessionid = request.args.get("sessionid", "").strip()
        username = request.args.get("username", "").strip().lstrip("@")

    def generate():
        if not sessionid or not username:
            yield f"data: {json.dumps({'type': 'error', 'message': 'Session ID dan Username wajib diisi!'})}\n\n"
            return

        try:
            cookies = build_cookies(sessionid)
            yield f"data: {json.dumps({'type': 'status', 'step': 'resolve', 'message': f'Mencari data akun @{username} di Instagram...' })}\n\n"

            uid, target_profile = resolve_user_info(cookies, username)
            total_following = target_profile.get("following_count", 0)
            total_followers = target_profile.get("follower_count", 0)

            yield f"data: {json.dumps({'type': 'profile_found', 'target_profile': target_profile, 'total_following': total_following, 'total_followers': total_followers, 'message': f'Akun @{username} ditemukan! Memulai pengambilan data...'})}\n\n"

            # 1. Fetch Following
            yield f"data: {json.dumps({'type': 'progress', 'phase': 'following', 'page': 1, 'current_following': 0, 'current_followers': 0, 'total_following': total_following, 'total_followers': total_followers, 'message': f'Mengambil daftar Following (Target: {total_following} akun)...'})}\n\n"

            following = []
            for page, chunk, users_so_far in fetch_iter(cookies, uid, "following", sleep=0.3):
                following = users_so_far
                yield f"data: {json.dumps({'type': 'progress', 'phase': 'following', 'page': page, 'chunk_size': len(chunk), 'current_following': len(following), 'current_followers': 0, 'total_following': total_following, 'total_followers': total_followers, 'message': f'Following: Halaman {page} (+{len(chunk)} user, total {len(following)})'})}\n\n"

            # 2. Fetch Followers
            yield f"data: {json.dumps({'type': 'progress', 'phase': 'followers', 'page': 1, 'current_following': len(following), 'current_followers': 0, 'total_following': total_following, 'total_followers': total_followers, 'message': f'Mengambil daftar Followers (Target: {total_followers} akun)...'})}\n\n"

            followers = []
            for page, chunk, users_so_far in fetch_iter(cookies, uid, "followers", sleep=0.3):
                followers = users_so_far
                yield f"data: {json.dumps({'type': 'progress', 'phase': 'followers', 'page': page, 'chunk_size': len(chunk), 'current_following': len(following), 'current_followers': len(followers), 'total_following': total_following, 'total_followers': total_followers, 'message': f'Followers: Halaman {page} (+{len(chunk)} user, total {len(followers)})'})}\n\n"

            # 3. Calculate metrics
            yield f"data: {json.dumps({'type': 'status', 'step': 'calculating', 'message': 'Menghitung perbandingan Unfollowers, Fans, dan Mutuals...'})}\n\n"

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

            yield f"data: {json.dumps({'type': 'complete', 'result': result, 'target_profile': target_profile, 'message': f'Selesai! Ditemukan {len(unfollowers)} unfollowers, {len(fans)} fans, {len(mutuals)} mutuals.'})}\n\n"

        except RuntimeError as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': f'Terjadi kesalahan: {exc}'})}\n\n"

    return Response(stream_with_context(generate()), mimetype="text/event-stream")


if __name__ == "__main__":
    app.run(debug=False, port=5000)
