import { fetchAll, fetchInstagramJson, InstagramHttpError } from "./client";
import { compareUserLists } from "./relationships";
import { buildCookies, normalizeUsername } from "./validation";
import type {
  AnalysisResult,
  InstagramProfileResponse,
  InstagramUser,
  TargetProfile,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asUser(value: unknown): InstagramUser | null {
  return isRecord(value) ? (value as InstagramUser) : null;
}

export async function resolveUserInfo(
  cookies: Record<string, string>,
  rawUsername: string,
): Promise<[string, TargetProfile]> {
  const username = normalizeUsername(rawUsername);
  const url =
    "https://www.instagram.com/api/v1/users/web_profile_info/?" +
    new URLSearchParams({ username }).toString();
  let data: unknown;
  try {
    data = await fetchInstagramJson(cookies, url);
  } catch (error) {
    if (error instanceof InstagramHttpError && error.status === 429) {
      throw new Error("Instagram memblokir sementara (HTTP 429/rate limit) — tunggu beberapa menit lalu coba lagi.");
    }
    if (error instanceof InstagramHttpError) {
      throw new Error(
        `Resolusi username '${username}' gagal (HTTP ${error.status}) — periksa kembali sessionid atau status login akun Anda`,
      );
    }
    throw error;
  }
  const response = data as InstagramProfileResponse;
  const user = asUser(response?.data?.user);
  if (!user?.id) throw new Error(`Akun Instagram @${username} tidak ditemukan`);

  const edgeFollowers = isRecord(user.edge_followed_by) ? user.edge_followed_by.count : 0;
  const edgeFollowing = isRecord(user.edge_follow) ? user.edge_follow.count : 0;
  const followerCount = Number(edgeFollowers || user.follower_count || 0);
  const followingCount = Number(edgeFollowing || user.following_count || 0);
  return [String(user.id), {
    id: String(user.id),
    username: String(user.username || username),
    full_name: String(user.full_name || ""),
    profile_pic_url: String(user.profile_pic_url || ""),
    is_private: Boolean(user.is_private),
    is_verified: Boolean(user.is_verified),
    follower_count: Number.isFinite(followerCount) ? followerCount : 0,
    following_count: Number.isFinite(followingCount) ? followingCount : 0,
  }];
}

export async function analyzeAccount(
  sessionid: string,
  username: string,
): Promise<{ result: AnalysisResult; targetProfile: TargetProfile }> {
  const cookies = buildCookies(sessionid);
  const [userId, targetProfile] = await resolveUserInfo(cookies, username);
  const followers = await fetchAll(cookies, userId, "followers", {
    sleepSeconds: 0.5,
    verbose: false,
  });
  const following = await fetchAll(cookies, userId, "following", {
    sleepSeconds: 0.5,
    verbose: false,
  });
  return { result: compareUserLists(followers, following), targetProfile };
}
