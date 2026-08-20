export type InstagramScalar = string | number;

export interface InstagramUser {
  pk?: InstagramScalar;
  id?: InstagramScalar;
  username?: string;
  full_name?: string;
  profile_pic_url?: string;
  is_private?: boolean;
  is_verified?: boolean;
  edge_followed_by?: { count?: number };
  edge_follow?: { count?: number };
  [key: string]: unknown;
}

export interface InstagramProfileResponse {
  data?: { user?: InstagramUser };
  [key: string]: unknown;
}

export interface InstagramListResponse {
  users?: unknown;
  next_max_id?: InstagramScalar | null;
  [key: string]: unknown;
}

export interface TargetProfile {
  id: string;
  username: string;
  full_name: string;
  profile_pic_url: string;
  is_private: boolean;
  is_verified: boolean;
  follower_count: number;
  following_count: number;
}

export type RelationshipCategory =
  | "unfollowers"
  | "fans"
  | "mutuals"
  | "following"
  | "followers";

export interface AnalysisResult {
  unfollowers: InstagramUser[];
  fans: InstagramUser[];
  mutuals: InstagramUser[];
  following: InstagramUser[];
  followers: InstagramUser[];
}

export type ListName = "followers" | "following";

export interface ProgressState {
  phase: string;
  percent: number;
  following: string | number;
  followers: string | number;
  targetFollowing: string | number;
  targetFollowers: string | number;
  page: string;
  log: string;
}
