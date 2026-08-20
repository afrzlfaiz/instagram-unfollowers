import type { NextApiRequest, NextApiResponse } from "next";
import {
  fetchInstagramJson,
  InstagramHttpError,
} from "../../../lib/instagram/client";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_CURSOR_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_PROXY_COUNT,
  buildCookies,
  isAllowedImageUrl,
  normalizeUsername,
  validateUserId,
} from "../../../lib/instagram/validation";

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};

function valueOf(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Terjadi kesalahan";
}

function jsonError(res: NextApiResponse, status: number, message: string) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json({ message });
}

function getCookies(req: NextApiRequest, res: NextApiResponse) {
  const sessionid = valueOf(req.headers["x-sessionid"]);
  if (!sessionid) {
    jsonError(res, 400, "header x-sessionid wajib");
    return null;
  }
  try {
    return buildCookies(sessionid);
  } catch (error) {
    jsonError(res, 400, errorMessage(error));
    return null;
  }
}

async function proxyInstagramJson(
  req: NextApiRequest,
  res: NextApiResponse,
  url: string,
) {
  const cookies = getCookies(req, res);
  if (!cookies) return;
  try {
    const data = await fetchInstagramJson(cookies, url);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(data);
  } catch (error) {
    if (error instanceof InstagramHttpError) {
      return jsonErrorWithStatus(res, 502, `HTTP ${error.status}`, error.status);
    }
    return jsonError(res, 502, "Instagram tidak dapat dihubungi. Coba lagi.");
  }
}

function jsonErrorWithStatus(
  res: NextApiResponse,
  status: number,
  message: string,
  httpStatus: number,
) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json({ message, httpStatus });
}

async function handleProfile(req: NextApiRequest, res: NextApiResponse) {
  let username: string;
  try {
    username = normalizeUsername(valueOf(req.query.username));
  } catch (error) {
    return jsonError(res, 400, errorMessage(error));
  }
  const url =
    "https://www.instagram.com/api/v1/users/web_profile_info/?" +
    new URLSearchParams({ username }).toString();
  return proxyInstagramJson(req, res, url);
}

async function handleFriendship(
  req: NextApiRequest,
  res: NextApiResponse,
  uid: string,
  which: "followers" | "following",
) {
  try {
    uid = validateUserId(uid);
  } catch (error) {
    return jsonError(res, 400, errorMessage(error));
  }
  const countRaw = valueOf(req.query.count) || "50";
  const count = Number(countRaw);
  if (!Number.isInteger(count) || count < 1 || count > MAX_PROXY_COUNT) {
    return jsonError(res, 400, `count harus antara 1 dan ${MAX_PROXY_COUNT}`);
  }
  const maxId = valueOf(req.query.max_id).trim();
  if (maxId.length > MAX_CURSOR_LENGTH) {
    return jsonError(res, 400, "max_id terlalu panjang");
  }
  const params = new URLSearchParams({ count: String(count) });
  if (which === "followers") params.set("search_surface", "follow_list_page");
  if (maxId) params.set("max_id", maxId);
  const url =
    `https://www.instagram.com/api/v1/friendships/${uid}/${which}/?` +
    params.toString();
  return proxyInstagramJson(req, res, url);
}

async function fetchImageWithSafeRedirects(rawUrl: string): Promise<Response> {
  let current = isAllowedImageUrl(rawUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(current, {
      headers: { "user-agent": "Mozilla/5.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || redirects === 3) throw new Error("Redirect gambar tidak valid");
    current = isAllowedImageUrl(new URL(location, current).toString());
  }
  throw new Error("Redirect gambar terlalu banyak");
}

async function readImageBody(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("IMAGE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function handleImage(req: NextApiRequest, res: NextApiResponse) {
  const rawUrl = valueOf(req.query.url).trim();
  try {
    const response = await fetchImageWithSafeRedirects(rawUrl);
    if (!response.ok) return jsonError(res, 502, `HTTP ${response.status}`);
    const contentType = (response.headers.get("content-type") || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      return jsonError(res, 415, "Respons bukan gambar yang didukung");
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_IMAGE_BYTES) {
      return jsonError(res, 413, "Ukuran gambar terlalu besar");
    }
    const data = await readImageBody(response);
    if (data.length > MAX_IMAGE_BYTES) {
      return jsonError(res, 413, "Ukuran gambar terlalu besar");
    }
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(200).send(data);
  } catch (error) {
    if (error instanceof Error && error.message === "IMAGE_TOO_LARGE") {
      return jsonError(res, 413, "Ukuran gambar terlalu besar");
    }
    if (error instanceof Error && [
      "query url wajib",
      "URL gambar terlalu panjang",
      "URL tidak valid",
      "URL gambar tidak diizinkan",
    ].includes(error.message)) {
      return jsonError(res, 400, error.message);
    }
    return jsonError(res, 502, "Gambar Instagram tidak dapat dihubungi. Coba lagi.");
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return jsonError(res, 405, "method tidak diizinkan");
  }
  const path = Array.isArray(req.query.path) ? req.query.path : [valueOf(req.query.path)];
  if (path.length === 1 && path[0] === "img") return handleImage(req, res);
  if (path.length === 2 && path[0] === "users" && path[1] === "web_profile_info") {
    return handleProfile(req, res);
  }
  if (path.length === 3 && path[0] === "friendships") {
    const which = path[2];
    if (which === "followers" || which === "following") {
      return handleFriendship(req, res, path[1], which);
    }
  }
  return jsonError(res, 400, "path tidak diizinkan");
}
