# instagram-unfollow

Web app Next.js/TypeScript untuk mengambil followers dan following Instagram
melalui proxy server, lalu menampilkan unfollowers, fans, mutuals, followers,
dan following. Aplikasi hanya membaca data; tidak melakukan aksi follow/unfollow.

## Menjalankan lokal

```bash
npm install
npm run dev
# buka http://localhost:3000
```

Production check:

```bash
npm run build
npm start
```

## Fitur

- analisis progresif dengan progress bar dan counter per halaman;
- proxy server-side `/api/ig/*` untuk menghindari CORS/adblock;
- tab Unfollowers, Fans, Mutuals, Following, dan Followers;
- pencarian real-time, export CSV/JSON, copy username, link profil, avatar fallback;
- `sessionid` tidak disimpan server dan hanya disimpan di LocalStorage bila dipilih;
- fallback `POST /` tetap merender hasil server-side ketika JavaScript tidak digunakan.

## CLI

```bash
npm run fetch -- --user-id 30869018875 --sessionid 'xxx...'
npm run fetch -- --user-id 30869018875 --list following --max-pages 3
IG_SESSIONID='xxx...' npm run fetch -- --user-id 30869018875
```

Options:

- `--list followers|following` — daftar yang diambil, default `followers`;
- `--user-id <id>` — ID akun target, wajib;
- `--sessionid <value>` — cookie `sessionid`, atau gunakan `IG_SESSIONID`;
- `--login-id <id>` — `ds_user_id`, default sama dengan `user-id`;
- `--output <file>` — file JSON tujuan;
- `--sleep <seconds>` — jeda antar halaman, default `1`;
- `--max-pages N` — batas halaman untuk dry-run, default tanpa batas.

## Endpoint

- `GET /healthz` — health check Render;
- `GET /api/ig/users/web_profile_info?username=...`;
- `GET /api/ig/friendships/<id>/followers?...`;
- `GET /api/ig/friendships/<id>/following?...`;
- `GET /api/ig/img?url=...` — proxy gambar CDN allowlisted.

Endpoint Instagram membutuhkan header `x-sessionid`. Jangan membagikan nilai
cookie tersebut. Gunakan hanya pada instance lokal atau server yang Anda kendalikan.

## Pengujian

```bash
npm test
python3 -m unittest discover -p 'test_*.py'  # rollback compatibility check
```

## Deploy ke Render

`render.yaml` mendefinisikan Node Web Service:

- runtime: `node`;
- build: `npm ci && npm run build`;
- start: `npm start`;
- health check: `/healthz`.

Buat service baru untuk cutover, verifikasi endpoint dan satu analisis nyata,
lalu pindahkan domain/traffic. Service Python lama dan artifacts Python sengaja
dipertahankan sampai cutover selesai agar rollback tetap tersedia.
