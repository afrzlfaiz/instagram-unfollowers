import type { AnalysisResult, InstagramUser } from "./types";
import { userKey } from "./validation";

export function compareUserLists(
  followers: InstagramUser[],
  following: InstagramUser[],
): AnalysisResult {
  const validFollowers = followers.filter((user) => userKey(user) !== null);
  const validFollowing = following.filter((user) => userKey(user) !== null);
  const followerKeys = new Set(validFollowers.map((user) => userKey(user)));
  const followingKeys = new Set(validFollowing.map((user) => userKey(user)));

  return {
    unfollowers: validFollowing.filter((user) => !followerKeys.has(userKey(user))),
    fans: validFollowers.filter((user) => !followingKeys.has(userKey(user))),
    mutuals: validFollowing.filter((user) => followerKeys.has(userKey(user))),
    following: validFollowing,
    followers: validFollowers,
  };
}
