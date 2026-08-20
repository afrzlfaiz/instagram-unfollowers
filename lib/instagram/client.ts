import type { InstagramListResponse, InstagramUser, ListName } from "./types";
import { validateUserId } from "./validation";

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
export const IG_APP_ID = "936619743392459";
export const COUNT: Record<ListName, number> = { followers: 50, following: 200 };

export class InstagramHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseBody: string,
  ) {
    super(`Instagram returned HTTP ${status}`);
    this.name = "InstagramHttpError";
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type SleepLike = (ms: number) => Promise<void>;

export interface FetchOptions {
  retries?: number;
  fetchImpl?: FetchLike;
  sleep?: SleepLike;
  timeoutMs?: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Respons Instagram bukan JSON yang valid");
  }
}

export async function fetchInstagramJson(
  cookies: Record<string, string>,
  url: string,
  options: FetchOptions = {},
): Promise<unknown> {
  const retries = options.retries ?? 3;
  if (retries < 1) throw new Error("retries harus minimal 1");
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? wait;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const headers = {
    "user-agent": UA,
    accept: "*/*",
    cookie: cookieHeader(cookies),
    "x-ig-app-id": IG_APP_ID,
    "x-requested-with": "XMLHttpRequest",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = new InstagramHttpError(response.status, body.slice(0, 200));
        if ([429, 500, 502, 503].includes(response.status) && attempt < retries - 1) {
          await sleep(2_000 * (attempt + 1));
          continue;
        }
        throw error;
      }
      return await readJson(response);
    } catch (error) {
      const retryableHttp =
        error instanceof InstagramHttpError && [429, 500, 502, 503].includes(error.status);
      if (retryableHttp && attempt < retries - 1) continue;
      if (error instanceof InstagramHttpError || attempt >= retries - 1) throw error;
      await sleep(2_000 * (attempt + 1));
    }
  }
  throw new Error("Instagram tidak dapat dihubungi");
}

export async function fetchInstagramProfileJson(
  cookies: Record<string, string>,
  url: string,
  options: FetchOptions = {},
): Promise<unknown> {
  try {
    return await fetchInstagramJson(cookies, url, options);
  } catch (error) {
    if (!(error instanceof InstagramHttpError) || error.status !== 400 || !Object.keys(cookies).length) {
      throw error;
    }

    try {
      return await fetchInstagramJson({}, url, options);
    } catch {
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueUsers(rawUsers: unknown[]): InstagramUser[] {
  const seen = new Set<string>();
  const users: InstagramUser[] = [];
  for (const value of rawUsers) {
    if (!isRecord(value)) continue;
    const key = value.pk ?? value.id;
    if (key == null) continue;
    const id = String(key);
    if (seen.has(id)) continue;
    seen.add(id);
    users.push(value as InstagramUser);
  }
  return users;
}

export interface FetchPage {
  page: number;
  chunk: InstagramUser[];
  users: InstagramUser[];
}

export interface PaginationOptions extends FetchOptions {
  sleepSeconds?: number;
  maxPages?: number;
  verbose?: boolean;
}

export async function* fetchIter(
  cookies: Record<string, string>,
  userId: string,
  which: ListName,
  options: PaginationOptions = {},
): AsyncGenerator<FetchPage> {
  validateUserId(userId);
  const sleepSeconds = options.sleepSeconds ?? 1;
  const maxPages = options.maxPages ?? 0;
  if (sleepSeconds < 0) throw new Error("sleep tidak boleh negatif");
  if (maxPages < 0) throw new Error("max_pages tidak boleh negatif");

  const users: InstagramUser[] = [];
  const seenUserIds = new Set<string>();
  const seenCursors = new Set<string>();
  let maxId: string | null = null;
  let page = 0;

  while (true) {
    page += 1;
    const params = new URLSearchParams({ count: String(COUNT[which]) });
    if (which === "followers") params.set("search_surface", "follow_list_page");
    if (maxId) params.set("max_id", maxId);
    const url =
      `https://www.instagram.com/api/v1/friendships/${validateUserId(userId)}/${which}/?` +
      params.toString();

    let data: unknown;
    try {
      data = await fetchInstagramJson(cookies, url, options);
    } catch (error) {
      if (error instanceof InstagramHttpError) {
        throw new Error(`halaman ${page}: HTTP ${error.status} — ${error.responseBody}`);
      }
      throw error;
    }
    if (!isRecord(data)) throw new Error(`halaman ${page}: respons Instagram bukan JSON object`);

    const rawUsers = Array.isArray(data.users) ? data.users : [];
    const chunk = uniqueUsers(rawUsers);
    const newChunk = chunk.filter((user) => {
      const key = user.pk ?? user.id;
      if (key == null) return false;
      const id = String(key);
      if (seenUserIds.has(id)) return false;
      seenUserIds.add(id);
      return true;
    });
    users.push(...newChunk);
    yield { page, chunk: newChunk, users: [...users] };

    const next = data.next_max_id;
    if (!next || (maxPages > 0 && page >= maxPages)) break;
    maxId = String(next);
    if (seenCursors.has(maxId)) throw new Error(`halaman ${page}: pagination Instagram berulang`);
    seenCursors.add(maxId);
    await (options.sleep ?? wait)(sleepSeconds * 1_000);
  }
}

export async function fetchAll(
  cookies: Record<string, string>,
  userId: string,
  which: ListName,
  options: PaginationOptions = {},
): Promise<InstagramUser[]> {
  let users: InstagramUser[] = [];
  for await (const page of fetchIter(cookies, userId, which, options)) {
    users = page.users;
    if (options.verbose !== false) {
      console.log(`halaman ${page.page}: +${page.chunk.length} (total ${users.length})`);
    }
  }
  return users;
}
