import { DatabaseSync } from "node:sqlite";
import {
  createClient,
  type Client,
  type Transaction,
  type InValue,
} from "@libsql/client";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
export const dataDir = resolve(process.env.DATA_DIR || "data");
export const remoteStorage = !!process.env.TURSO_DATABASE_URL;
if (process.env.REQUIRE_REMOTE_DB === "true" && !remoteStorage)
  throw new Error(
    "무료 호스팅은 TURSO_DATABASE_URL이 필요합니다. 임시 디스크에 자료를 저장하지 않습니다.",
  );
if (remoteStorage && !process.env.TURSO_AUTH_TOKEN)
  throw new Error("TURSO_AUTH_TOKEN을 서버 보안 환경 변수에 설정하세요");
if (
  remoteStorage &&
  !/^(libsql|https):\/\//.test(process.env.TURSO_DATABASE_URL!)
)
  throw new Error(
    "원격 DB는 TLS를 사용하는 libsql:// 또는 https:// 주소가 필요합니다",
  );
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
let client: Client | undefined;
let local: DatabaseSync | undefined;
// LIBSQL_TEST_URL is intentionally unavailable in hosted production.
const testUrl =
  process.env.NODE_ENV === "test" ? process.env.LIBSQL_TEST_URL : undefined;
export const databaseAttachments = remoteStorage || !!testUrl;
if (remoteStorage || testUrl)
  client = createClient({
    url: testUrl || process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
else {
  local = new DatabaseSync(join(dataDir, "school.sqlite"));
  local.exec(
    "PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;",
  );
  mkdirSync(join(dataDir, "uploads"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dataDir, "backups"), { recursive: true, mode: 0o700 });
}
const scope = new AsyncLocalStorage<{ transaction?: Transaction }>();
let tail: Promise<void> = Promise.resolve();
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const before = tail;
  let release!: () => void;
  tail = new Promise<void>((r) => (release = r));
  await before;
  try {
    return await fn();
  } finally {
    release();
  }
}
async function execute(sql: string, args: InValue[] = []) {
  const run = async () => {
    if (client)
      return await (scope.getStore()?.transaction || client).execute({
        sql,
        args,
      });
    const statement = local!.prepare(sql);
    if (statement.columns().length)
      return { rows: statement.all(...(args as never[])) };
    return { ...statement.run(...(args as never[])), rows: [] };
  };
  return scope.getStore() ? run() : exclusive(run);
}
export const db = {
  prepare(sql: string) {
    return {
      async get(...args: InValue[]): Promise<any> {
        return (await execute(sql, args)).rows[0];
      },
      async all(...args: InValue[]): Promise<any[]> {
        return (await execute(sql, args)).rows;
      },
      async run(...args: InValue[]) {
        return execute(sql, args);
      },
    };
  },
  async exec(sql: string) {
    const run = async () => {
      if (client) {
        const transaction = scope.getStore()?.transaction;
        if (transaction) {
          for (const statement of sql
            .split(";")
            .map((s) => s.trim())
            .filter(Boolean))
            await transaction.execute(statement);
        } else await client.executeMultiple(sql);
      } else local!.exec(sql);
    };
    return scope.getStore() ? run() : exclusive(run);
  },
  close() {
    client?.close();
    local?.close();
  },
};
export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  if (scope.getStore()) return fn();
  return exclusive(async () => {
    if (client) {
      const tx = await client.transaction("write");
      try {
        const value = await scope.run({ transaction: tx }, fn);
        await tx.commit();
        return value;
      } catch (e) {
        await tx.rollback();
        throw e;
      } finally {
        tx.close();
      }
    }
    local!.exec("BEGIN IMMEDIATE");
    try {
      const value = await scope.run({}, fn);
      local!.exec("COMMIT");
      return value;
    } catch (e) {
      local!.exec("ROLLBACK");
      throw e;
    }
  });
}
export async function readAttachment(path: string): Promise<Buffer> {
  if (!databaseAttachments) return readFileSync(join(dataDir, "uploads", path));
  const rows = await db
    .prepare("SELECT content FROM attachment_chunks WHERE path=? ORDER BY part")
    .all(path);
  if (!rows.length) throw new Error("첨부파일 내용을 찾을 수 없습니다");
  return Buffer.concat(rows.map((r) => Buffer.from(r.content)));
}
export async function writeAttachment(path: string, buffer: Buffer) {
  if (!databaseAttachments) {
    writeFileSync(join(dataDir, "uploads", path), buffer, {
      mode: 0o600,
      flag: "wx",
    });
    return;
  }
  await transaction(async () => {
    for (
      let offset = 0, part = 0;
      offset < buffer.length;
      offset += 256 * 1024, part++
    )
      await db
        .prepare(
          "INSERT INTO attachment_chunks(path,part,content) VALUES(?,?,?)",
        )
        .run(path, part, buffer.subarray(offset, offset + 256 * 1024));
  });
}
export async function removeAttachment(path: string) {
  if (!databaseAttachments) {
    rmSync(join(dataDir, "uploads", path), { force: true });
    return;
  }
  // Recovery snapshots retain content even after the live attachment is removed.
  // Unreferenced chunks are collected when snapshots rotate.
  const live = await db
    .prepare("SELECT id FROM attachments WHERE path=?")
    .get(path);
  if (live) return;
  const snapshots = await db
    .prepare("SELECT data FROM recovery_snapshots")
    .all();
  if (
    snapshots.some((s) =>
      JSON.parse(s.data).attachments.some(
        (a: { path: string }) => a.path === path,
      ),
    )
  )
    return;
  await db.prepare("DELETE FROM attachment_chunks WHERE path=?").run(path);
}
