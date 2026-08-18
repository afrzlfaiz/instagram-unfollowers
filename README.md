# instagram-unfollow

Skrip ambil semua followers/following via web API Instagram dengan auto-pagination,
plus web app untuk cek unfollowers.

## Web app (Flask)

```bash
python3 app.py    # Buka http://127.0.0.1:5000
```

Fitur Web UI:
- **Tampilan Modern**: Tema *Instagram Dark Glassmorphism*, responsif desktop & mobile.
- **Real-time Live Progress Bar**: Indikator persentase, live counter jumlah akun Following & Followers yang sedang diambil, dan log status per halaman/batch (per-page fetch — terlihat di Network tab browser).
- **API proxy `/api/ig/*`**: request ke Instagram lewat server, tidak kena CORS/adblock.
- **5 Kategori Tab Lengkap**:
  - 🚫 **Unfollowers** — Akun yang Anda follow tapi tidak follow-back.
  - 🌟 **Fans** — Akun yang mem-follow Anda tapi belum Anda follow-back.
  - 🤝 **Mutuals** — Akun yang saling follow.
  - 👥 **Following** — Semua akun yang Anda ikuti.
  - 💜 **Followers** — Semua pengikut Anda.
- **Overview Stat Cards**: Metrik ringkas jumlah akun di setiap kategori.
- **Pencarian Real-Time**: Cari akun berdasarkan username / nama lengkap secara instan.
- **Export Data**: Ekspor daftar user ke format **CSV** dan **JSON**.
- **Fitur Praktis**: Salin @username sekali klik, tombol buka profil Instagram, fallback avatar, toggle simpan `sessionid` di browser, dan modal tutorial cara mengambil cookie `sessionid`.

## CLI

## Temuan riset (diuji empiris 2026-08-18)

Endpoint GET `/api/v1/*` www.instagram.com **tidak memvalidasi `x-ig-www-claim`**.
Yang divalidasi:

| Syarat | Tanpa ini |
|---|---|
| cookie `sessionid` + `ds_user_id` (sessionid saja → 302 login loop) | 302 |
| `user-agent` browser asli | 400 `useragent mismatch` |
| `x-ig-app-id: 936619743392459` | 400 `useragent mismatch` |

Pagination: loop `next_max_id` sampai habis. `followers` di-cap ~24/halaman
walau `count` minta lebih; `following` menerima count besar (200).

## Jalankan

```bash
pip install -r requirements.txt
python3 scrape_followers.py --user-id 30869018875 --sessionid 'xxx...'          # followers
python3 scrape_followers.py --user-id 30869018875 --list following             # following
# atau via env:
IG_SESSIONID='xxx...' python3 scrape_followers.py --user-id 30869018875
```

## Opsi

- `--list followers|following` — daftar yang diambil (default: followers)
- `--login-id <id>` — `ds_user_id` bila akun login ≠ akun target (default: user-id)
- `--output <file>` — file JSON tujuan (default: `<list>_<uid>.json`)
- `--sleep <detik>` — jeda antar halaman (default 1.0)
- `--max-pages N` — batas halaman untuk dry-run

Output: JSON array user (pk, username, full_name, is_private, profile_pic_url, dll).

## Deploy ke Render.com

Opsi 1 — via `render.yaml` (ada di repo ini): dashboard.render.com → **New+** →
**Blueprint** → pilih repo `instagram-unfollowers`. Semua terkonfigurasi
otomatis.

Opsi 2 — manual: **New+** → **Web Service** → pilih repo:
- Environment: `Python 3`
- Build command: `pip install -r requirements.txt`
- Start command: `gunicorn app:app --bind 0.0.0.0:$PORT --timeout 60`
- Plan: `Free`

Catatan free tier: service tidur setelah 15 menit idle (request pertama
terlambat ~30–60 dtk cold start), dan IP egress adalah IP datacenter bersama —
Instagram bisa memberi 429 rate limit.
