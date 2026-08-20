import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fetchAll } from "../lib/instagram/client";
import type { ListName } from "../lib/instagram/types";
import { buildCookies, validateUserId } from "../lib/instagram/validation";

function usage(): string {
  return `
Usage:
  npm run fetch -- --user-id <id> [options]

Options:
  --list followers|following   daftar yang diambil (default: followers)
  --user-id <id>               ID akun yang daftarnya diambil
  --sessionid <value>          cookie sessionid (atau IG_SESSIONID)
  --login-id <id>              ds_user_id (default: user-id)
  --output <file>              file JSON tujuan
  --sleep <seconds>            jeda antar halaman (default: 1)
  --max-pages <number>         batas halaman untuk tes (0 = tanpa batas)
  --help                       tampilkan bantuan
`;
}

function numberOption(value: string | undefined, name: string, fallback: number): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} harus berupa angka`);
  return parsed;
}

async function main() {
  const { values } = parseArgs({
    options: {
      list: { type: "string", default: "followers" },
      "user-id": { type: "string" },
      sessionid: { type: "string", default: process.env.IG_SESSIONID || "" },
      "login-id": { type: "string" },
      output: { type: "string" },
      sleep: { type: "string", default: "1" },
      "max-pages": { type: "string", default: "0" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(usage());
    return;
  }
  if (!values["user-id"]) throw new Error("--user-id wajib");
  if (!values.sessionid) throw new Error("sessionid wajib — pakai --sessionid atau env IG_SESSIONID");
  if (values.list !== "followers" && values.list !== "following") {
    throw new Error("jenis daftar harus followers atau following");
  }

  const userId = validateUserId(values["user-id"]);
  const sleepSeconds = numberOption(values.sleep, "sleep", 1);
  const maxPages = numberOption(values["max-pages"], "max-pages", 0);
  if (sleepSeconds < 0) throw new Error("sleep tidak boleh negatif");
  if (maxPages < 0 || !Number.isInteger(maxPages)) throw new Error("max-pages harus bilangan bulat tidak negatif");

  const cookies = buildCookies(values.sessionid);
  cookies.ds_user_id = values["login-id"] ? validateUserId(values["login-id"]) : userId;
  const which = values.list as ListName;
  const users = await fetchAll(cookies, userId, which, {
    sleepSeconds,
    maxPages,
    verbose: true,
  });
  const output = values.output || `${which}_${userId}.json`;
  await writeFile(output, JSON.stringify(users, null, 1), "utf8");
  console.log(`selesai: ${users.length} user -> ${output}`);
}

main().catch((error: unknown) => {
  console.error(`gagal: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
