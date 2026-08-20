import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import apiHandler from "../pages/api/ig/[...path]";
import healthHandler from "../pages/api/healthz";
import { getServerSideProps } from "../pages/index";
import { fetchInstagramJson, fetchIter, InstagramHttpError } from "../lib/instagram/client";
import { compareUserLists } from "../lib/instagram/relationships";
import {
  buildCookies,
  isAllowedImageUrl,
  normalizeUsername,
  validateUserId,
} from "../lib/instagram/validation";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
      return this;
    },
    send(value: unknown) {
      this.body = value;
      return this;
    },
    setHeader(name: string, value: string | number | string[]) {
      this.headers[name] = String(value);
      return this;
    },
  };
}

test("buildCookies extracts encoded user ID", () => {
  assert.deepEqual(buildCookies("12345%3Asecret%3Aextra"), {
    sessionid: "12345%3Asecret%3Aextra",
    ds_user_id: "12345",
  });
});

test("validators reject malformed values", () => {
  assert.equal(normalizeUsername(" @Example.User "), "example.user");
  assert.equal(validateUserId("123"), "123");
  assert.throws(() => buildCookies("not-a-session"));
  assert.throws(() => buildCookies("123:secret;evil=true"));
  assert.throws(() => normalizeUsername("bad username"));
  assert.throws(() => validateUserId("not-an-id"));
});

test("relationship comparison preserves categories and order", () => {
  const result = compareUserLists(
    [{ pk: "1", username: "one" }, { pk: "2", username: "two" }],
    [{ pk: "2", username: "two" }, { pk: "3", username: "three" }],
  );
  assert.deepEqual(result.unfollowers.map((user) => user.username), ["three"]);
  assert.deepEqual(result.fans.map((user) => user.username), ["one"]);
  assert.deepEqual(result.mutuals.map((user) => user.username), ["two"]);
});

test("Instagram client retries transient HTTP errors", async () => {
  let calls = 0;
  const data = await fetchInstagramJson({}, "https://example.test", {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? response(503, { error: "busy" }) : response(200, { ok: true });
    },
    sleep: async () => undefined,
  });
  assert.deepEqual(data, { ok: true });
  assert.equal(calls, 2);
});

test("Instagram client exposes final HTTP errors", async () => {
  await assert.rejects(
    () => fetchInstagramJson({}, "https://example.test", {
      retries: 1,
      fetchImpl: async () => response(400, { error: "bad" }),
    }),
    (error: unknown) => error instanceof InstagramHttpError && error.status === 400,
  );
});

test("pagination deduplicates users and stops at the end", async () => {
  const pages = [
    { users: [{ pk: "1" }, { pk: "2" }], next_max_id: "next" },
    { users: [{ pk: "2" }, { pk: "3" }], next_max_id: null },
  ];
  const yielded = [] as Array<{ chunk: unknown[]; users: unknown[] }>;
  let index = 0;
  for await (const page of fetchIter({}, "123", "followers", {
    fetchImpl: async () => response(200, pages[index++]),
    sleep: async () => undefined,
  })) yielded.push(page);
  assert.deepEqual(yielded.map((page) => page.chunk.length), [2, 1]);
  assert.deepEqual(yielded.at(-1)?.users.map((user) => (user as { pk: string }).pk), ["1", "2", "3"]);
});

test("pagination rejects repeating cursors and invalid options", async () => {
  const pages = [
    { users: [{ pk: "1" }], next_max_id: "same" },
    { users: [{ pk: "2" }], next_max_id: "same" },
  ];
  let index = 0;
  await assert.rejects(
    async () => {
      for await (const _page of fetchIter({}, "123", "followers", {
        fetchImpl: async () => response(200, pages[index++]),
        sleep: async () => undefined,
      })) {
        // consume the generator
      }
    },
    /pagination Instagram berulang/,
  );
  await assert.rejects(() => fetchIter({}, "not-an-id", "followers").next(), /user ID/);
  await assert.rejects(() => fetchIter({}, "123", "followers", { sleepSeconds: -1 }).next(), /sleep/);
});

test("image URL validation rejects SSRF targets", () => {
  assert.equal(isAllowedImageUrl("https://scontent.cdninstagram.com/avatar.jpg").hostname, "scontent.cdninstagram.com");
  assert.throws(() => isAllowedImageUrl("http://cdninstagram.com/avatar.jpg"));
  assert.throws(() => isAllowedImageUrl("https://evil.example/avatar.jpg"));
  assert.throws(() => isAllowedImageUrl("https://cdninstagram.com:444/avatar.jpg"));
});

test("health route preserves its response contract", async () => {
  const health = fakeResponse();
  healthHandler({ method: "GET" } as never, health as never);
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.body, { status: "ok" });
});

test("proxy route preserves validation contracts", async () => {
  const invalidSession = fakeResponse();
  await apiHandler({ method: "GET", query: { path: ["friendships", "123", "followers"], count: "50" }, headers: { "x-sessionid": "invalid" } } as never, invalidSession as never);
  assert.equal(invalidSession.statusCode, 400);

  const invalidCount = fakeResponse();
  await apiHandler({ method: "GET", query: { path: ["friendships", "123", "followers"], count: "201" }, headers: { "x-sessionid": "123:secret" } } as never, invalidCount as never);
  assert.equal(invalidCount.statusCode, 400);

  const invalidUsername = fakeResponse();
  await apiHandler({ method: "GET", query: { path: ["users", "web_profile_info"], username: "bad username" }, headers: {} } as never, invalidUsername as never);
  assert.equal(invalidUsername.statusCode, 400);

  const invalidImage = fakeResponse();
  await apiHandler({ method: "GET", query: { path: ["img"], url: "https://evil.example/avatar.jpg" }, headers: {} } as never, invalidImage as never);
  assert.equal(invalidImage.statusCode, 400);
});

test("server-side POST fallback returns no session ID in props", async () => {
  const request = Readable.from(["sessionid=123%3Asecret&username=bad%20username"]) as never;
  Object.assign(request, { method: "POST" });
  const result = await getServerSideProps({ req: request, res: fakeResponse() } as never);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /123%3Asecret/);
  assert.doesNotMatch(serialized, /123:secret/);
  assert.match(serialized, /Username harus/);
});

test("server-side POST fallback renders mocked result without credential", async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    call += 1;
    if (call === 1) {
      return response(200, { data: { user: { id: "9", username: "target", full_name: "Target", follower_count: 1, following_count: 1 } } });
    }
    if (call === 2) return response(200, { users: [{ pk: "1", username: "fan" }], next_max_id: null });
    return response(200, { users: [{ pk: "2", username: "other" }], next_max_id: null });
  }) as typeof fetch;
  try {
    const request = Readable.from(["sessionid=123%3Asecret&username=target"]) as never;
    Object.assign(request, { method: "POST" });
    const result = await getServerSideProps({ req: request, res: fakeResponse() } as never);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /123%3Asecret/);
    assert.match(serialized, /target/);
    assert.equal(call, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
