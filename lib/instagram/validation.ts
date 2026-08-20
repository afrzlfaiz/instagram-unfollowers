import type { InstagramUser } from "./types";

export const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
export const USER_ID_RE = /^[0-9]+$/;
export const MAX_SESSION_ID_LENGTH = 512;
export const MAX_PROXY_COUNT = 200;
export const MAX_CURSOR_LENGTH = 256;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
export const ALLOWED_IMAGE_HOSTS = ["cdninstagram.com", "fbcdn.net"] as const;

export function normalizeUsername(username: string): string {
  let value = (username || "").trim();
  if (value.startsWith("@")) value = value.slice(1);
  if (!USERNAME_RE.test(value)) {
    throw new Error(
      "Username harus 1-30 karakter dan hanya boleh berisi huruf, angka, titik, atau underscore.",
    );
  }
  return value.toLowerCase();
}

export function validateUserId(userId: string | number): string {
  const value = String(userId).trim();
  if (!USER_ID_RE.test(value)) throw new Error("user ID harus berupa angka");
  return value;
}

export function buildCookies(sessionid: string): Record<string, string> {
  const cleanSession = (sessionid || "").trim();
  let decodedSession = cleanSession;
  try {
    decodedSession = decodeURIComponent(cleanSession);
  } catch {
    throw new Error("Session ID tidak valid. Salin nilai cookie sessionid lengkap dari Instagram.");
  }
  const userId = decodedSession.split(":", 1)[0];
  const invalid = [...cleanSession].some(
    (char) => char.charCodeAt(0) < 32 || /\s/.test(char) || char === ";" || char === ",",
  );
  if (
    !cleanSession ||
    cleanSession.length > MAX_SESSION_ID_LENGTH ||
    invalid ||
    !USER_ID_RE.test(userId)
  ) {
    throw new Error("Session ID tidak valid. Salin nilai cookie sessionid lengkap dari Instagram.");
  }
  return { sessionid: cleanSession, ds_user_id: userId };
}

export function userKey(user: InstagramUser): string | null {
  if (!user || typeof user !== "object") return null;
  const value = user.pk ?? user.id;
  return value == null ? null : String(value);
}

export function isAllowedImageUrl(raw: string): URL {
  if (!raw) throw new Error("query url wajib");
  if (raw.length > 4096) throw new Error("URL gambar terlalu panjang");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("URL tidak valid");
  }
  const hostname = parsed.hostname.toLowerCase();
  const allowedHost = ALLOWED_IMAGE_HOSTS.some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  );
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    !allowedHost
  ) {
    throw new Error("URL gambar tidak diizinkan");
  }
  return parsed;
}
