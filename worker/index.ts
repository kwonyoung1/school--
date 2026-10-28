import type {
  D1Database,
  Fetcher,
  ExportedHandler,
} from "@cloudflare/workers-types";
import { OfficeStore, OfficeError, tables } from "../shared/office-store.ts";
import {
  schemas,
  generatePlan,
  generatePurpose,
  type Kind,
} from "../shared/office.ts";
import { z } from "zod";
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_PASSWORD?: string;
  ADMIN_USERNAME?: string;
  LOCAL_DEV?: string;
}
const encoder = new TextEncoder();
const hex = (data: ArrayBuffer) =>
  Array.from(new Uint8Array(data), (x) => x.toString(16).padStart(2, "0")).join(
    "",
  );
const token = () => hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
const hash = async (s: string) =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(s)));
export async function passwordHash(password: string, salt = token()) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return `${salt}:${hex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: encoder.encode(salt), iterations: 100000, hash: "SHA-256" }, key, 256))}`;
}
async function passwordMatches(password: string, stored: string) {
  const [salt, expected] = stored.split(":");
  const actual = (await passwordHash(password, salt)).split(":")[1];
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < actual.length; i++)
    diff |= actual.charCodeAt(i) ^ (expected.charCodeAt(i) || 0);
  return diff === 0;
}
const response = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
async function body(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > 10 * 1024 * 1024)
    throw new OfficeError(413, "요청은 10MB 이하여야 합니다");
  const reader = request.body?.getReader();
  if (!reader) return {};
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 10 * 1024 * 1024) {
      await reader.cancel();
      throw new OfficeError(413, "요청은 10MB 이하여야 합니다");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(all));
  } catch {
    throw new OfficeError(400, "올바른 JSON 자료를 전송하세요");
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith("/api/")) {
      const res = await env.ASSETS.fetch(request as any);
      return new Response(res.body as any, {
        status: res.status,
        headers: {
          ...Object.fromEntries(res.headers as any),
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "same-origin",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
        },
      });
    }
    try {
      const db = env.DB;
      const store = new OfficeStore({
        all: async (sql, args = []) => {
          const r = await db
            .prepare(sql)
            .bind(...args)
            .all();
          return r.results;
        },
        batch: async (statements) => {
          await db.batch(
            statements.map((s) => db.prepare(s.sql).bind(...(s.args || []))),
          );
        },
      });
      if (path === "/api/health") {
        await db.prepare("SELECT count(*) AS n FROM office_admin").first();
        return response({ status: "ok", storage: "d1" });
      }
      if (request.method === "POST" && path === "/api/login") {
        if (
          request.headers.get("Origin") &&
          request.headers.get("Origin") !== url.origin
        )
          return response(
            { error: "다른 사이트의 로그인 요청은 허용하지 않습니다" },
            403,
          );
        const input = z
          .object({
            username: z.string().min(1).max(100),
            password: z.string().min(1).max(200),
          })
          .parse(await body(request));
        // A global account bucket plus a client bucket prevents username/IP rotation bypassing lockout.
        const keys = [
          "account",
          await hash(request.headers.get("CF-Connecting-IP") || "local"),
        ];
        for (const key of keys) {
          const attempt = await db
            .prepare("SELECT * FROM office_login_attempts WHERE key=?")
            .bind(key)
            .first<any>();
          if (attempt && attempt.until_at > Date.now() && attempt.count >= 5)
            return response(
              { error: "로그인 시도가 많습니다. 15분 후 다시 시도하세요" },
              429,
            );
        }
        let admin = await db
          .prepare("SELECT * FROM office_admin WHERE id=1")
          .first<any>();
        if (!admin) {
          if (
            !env.ADMIN_PASSWORD ||
            env.ADMIN_PASSWORD.length < 12 ||
            env.ADMIN_PASSWORD.length > 200
          )
            return response(
              {
                error:
                  "Cloudflare 런타임 Secret에 ADMIN_PASSWORD를 12~200자로 설정하세요",
              },
              503,
            );
          const stored = await passwordHash(env.ADMIN_PASSWORD);
          await db
            .prepare("INSERT OR IGNORE INTO office_admin VALUES(1,?,?)")
            .bind(env.ADMIN_USERNAME || "admin", stored)
            .run();
          admin = await db
            .prepare("SELECT * FROM office_admin WHERE id=1")
            .first<any>();
        }
        const matches = await passwordMatches(
          input.password,
          admin.password_hash,
        );
        if (!matches || input.username !== admin.username) {
          await db.batch(
            keys.map((key) =>
              db
                .prepare(
                  "INSERT INTO office_login_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN until_at>? THEN count+1 ELSE 1 END,until_at=excluded.until_at",
                )
                .bind(key, Date.now() + 900000, Date.now()),
            ),
          );
          return response(
            { error: "아이디 또는 비밀번호가 올바르지 않습니다" },
            401,
          );
        }
        const sid = token(),
          csrf = token();
        await db.batch([
          db.prepare("DELETE FROM office_login_attempts"),
          db
            .prepare("DELETE FROM office_sessions WHERE expires<=?")
            .bind(Date.now()),
          db
            .prepare("INSERT INTO office_sessions VALUES(?,?,?)")
            .bind(await hash(sid), csrf, Date.now() + 8 * 3600000),
        ]);
        return response(
          {
            user: {
              id: "admin",
              username: admin.username,
              name: "관리자",
              role: "admin",
            },
            csrf,
          },
          200,
          {
            "Set-Cookie": `office_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${env.LOCAL_DEV === "true" ? "" : "; Secure"}`,
          },
        );
      }
      const sid = request.headers
        .get("cookie")
        ?.split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("office_sid="))
        ?.slice(11);
      const session = sid
        ? await db
            .prepare(
              "SELECT * FROM office_sessions WHERE token=? AND expires>?",
            )
            .bind(await hash(sid), Date.now())
            .first<any>()
        : null;
      if (!session) return response({ error: "로그인이 필요합니다" }, 401);
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        if (request.headers.get("X-CSRF-Token") !== session.csrf)
          return response(
            { error: "요청 검증에 실패했습니다. 다시 로그인하세요" },
            403,
          );
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin)
          return response(
            { error: "다른 사이트의 요청은 허용하지 않습니다" },
            403,
          );
      }
      if (path === "/api/me") {
        const admin = await db
          .prepare("SELECT username FROM office_admin WHERE id=1")
          .first<any>();
        return response({
          user: {
            id: "admin",
            username: admin.username,
            name: "관리자",
            role: "admin",
          },
          csrf: session.csrf,
        });
      }
      if (path === "/api/logout" && request.method === "POST") {
        await db
          .prepare("DELETE FROM office_sessions WHERE token=?")
          .bind(await hash(sid!))
          .run();
        return response({ ok: true }, 200, {
          "Set-Cookie": `office_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${env.LOCAL_DEV === "true" ? "" : "; Secure"}`,
        });
      }
      if (path === "/api/password" && request.method === "POST") {
        const input = z
          .object({
            current: z.string().max(200),
            next: z.string().min(12).max(200),
          })
          .parse(await body(request));
        const admin = await db
          .prepare("SELECT * FROM office_admin WHERE id=1")
          .first<any>();
        if (!(await passwordMatches(input.current, admin.password_hash)))
          throw new OfficeError(400, "현재 비밀번호가 일치하지 않습니다");
        await db.batch([
          db
            .prepare("UPDATE office_admin SET password_hash=? WHERE id=1")
            .bind(await passwordHash(input.next)),
          db.prepare("DELETE FROM office_sessions"),
        ]);
        return response({ ok: true });
      }
      if (path === "/api/office/activities" && request.method === "GET")
        return response(
          await store.logs(url.searchParams.get("date") || undefined),
        );
      if (path === "/api/office/backup" && request.method === "GET")
        return response(await store.backup());
      if (path === "/api/office/restore" && request.method === "POST")
        return response(await store.restore(await body(request), "admin"));
      if (path === "/api/office/snapshots" && request.method === "GET")
        return response(
          (
            await db
              .prepare(
                "SELECT id,created_at FROM office_snapshots ORDER BY created_at DESC",
              )
              .all()
          ).results,
        );
      if (
        path.startsWith("/api/office/snapshots/") &&
        request.method === "GET"
      ) {
        const row = await db
          .prepare("SELECT data FROM office_snapshots WHERE id=?")
          .bind(path.split("/").pop())
          .first<any>();
        if (!row) throw new OfficeError(404, "백업을 찾을 수 없습니다");
        return response(JSON.parse(row.data));
      }
      if (path === "/api/office/generate" && request.method === "POST") {
        const input = await body(request);
        if (input.type === "purpose") {
          const name = String(input.name || "").slice(0, 200);
          const old = (await store.list("templates")).find(
            (x) => x.type === "purpose" && x.title === name,
          );
          return response({
            content: old?.content || generatePurpose(name, input.location),
          });
        }
        return response({
          content: generatePlan(schemas.facilities.parse(input)),
        });
      }
      const match = path.match(
        /^\/api\/office\/([a-z]+)(?:\/([a-zA-Z0-9-]+))?$/,
      );
      if (match && Object.hasOwn(tables, match[1])) {
        const kind = match[1] as Kind,
          id = match[2];
        if (request.method === "GET")
          return response(
            id ? await store.get(kind, id) : await store.list(kind),
          );
        if (request.method === "POST" && !id)
          return response(
            await store.put(kind, await body(request), "admin"),
            201,
          );
        if (["PUT", "DELETE"].includes(request.method) && id)
          return response(
            await store.put(
              kind,
              await body(request),
              "admin",
              id,
              request.method === "DELETE",
            ),
          );
      }
      return response({ error: "API를 찾을 수 없습니다" }, 404);
    } catch (e) {
      if (e instanceof OfficeError)
        return response({ error: e.message }, e.status);
      if (e instanceof z.ZodError)
        return response(
          { error: e.issues.map((x) => x.message).join(" · ") },
          400,
        );
      console.error(
        "Worker request failed",
        e instanceof Error ? e.message : "unknown",
      );
      return response(
        {
          error:
            "요청 처리 중 오류가 발생했습니다. DB 바인딩·마이그레이션·무료 사용량을 확인하세요",
        },
        500,
      );
    }
  },
};
