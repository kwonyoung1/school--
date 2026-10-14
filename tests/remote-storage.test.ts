import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import type { Proposal } from "../server/domain.ts";

test("libSQL 어댑터: 임시 서버 디스크 교체 후 계정·품의·첨부·백업 보존", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "school-libsql-"));
  const password = randomBytes(24).toString("hex");
  const port = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess;
  let runtime = join(directory, "runtime-1"),
    cookie = "",
    csrf = "",
    logs = "";
  async function start() {
    server = spawn(
      process.execPath,
      ["--experimental-strip-types", "server/index.ts"],
      {
        env: {
          ...process.env,
          NODE_ENV: "test",
          PORT: String(port),
          DATA_DIR: runtime,
          ADMIN_PASSWORD: password,
          SECURE_COOKIE: "true",
          LIBSQL_TEST_URL: pathToFileURL(join(directory, "durable.sqlite"))
            .href,
        },
        stdio: "pipe",
      },
    );
    server.stdout!.on("data", (c) => (logs += c));
    server.stderr!.on("data", (c) => (logs += c));
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(logs);
      try {
        const r = await fetch(base + "/api/health");
        if (r.status === 200) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(logs);
  }
  async function stop() {
    if (server && server.exitCode === null) {
      const exit = once(server, "exit");
      server.kill();
      await exit;
    }
  }
  const request = (path: string, method = "GET", data?: unknown) =>
    fetch(base + "/api" + path, {
      method,
      headers: {
        cookie,
        "X-CSRF-Token": csrf,
        ...(data && !(data instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body:
        data instanceof FormData
          ? data
          : data === undefined
            ? undefined
            : JSON.stringify(data),
    });
  async function login() {
    const r = await request("/login", "POST", { username: "admin", password });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("set-cookie")!, /Secure/);
    cookie = r.headers.get("set-cookie")!.split(";")[0];
    csrf = (await r.json()).csrf;
  }
  let attachment = "",
    mixed: Proposal;
  const bytes = Buffer.alloc(768 * 1024, 65);
  bytes.write("%PDF-1.4\n");
  try {
    await start();
    await login();
    await t.test(
      "실제 libSQL 드라이버로 품의·청크 첨부 저장 및 백업",
      async () => {
        assert.equal((await request("/seed", "POST", {})).status, 200);
        mixed = (
          (await (await request("/proposals")).json()) as Proposal[]
        ).find((p) => p.payments.length === 3)!;
        const f = new FormData();
        f.append("paymentId", mixed.payments[0].id);
        f.append("file", new Blob([bytes]), "chunk-test.pdf");
        const r = await request(
          "/proposals/" + mixed.id + "/attachments",
          "POST",
          f,
        );
        assert.equal(r.status, 201);
        attachment = (await r.json()).id;
        assert.deepEqual(
          Buffer.from(
            await (await request("/attachments/" + attachment)).arrayBuffer(),
          ),
          bytes,
        );
        const backup = await (await request("/backup")).json();
        assert.equal(backup.attachments.length, 1);
        assert.deepEqual(
          Buffer.from(backup.attachments[0].content, "base64"),
          bytes,
        );
        assert.equal((await request("/restore", "POST", backup)).status, 200);
      },
    );
    await t.test("동시 신규 품의 관리번호 중복 방지", async () => {
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          request("/proposals", "POST", { ...mixed, title: "동시 등록 " + i }),
        ),
      );
      for (const r of responses) assert.equal(r.status, 201);
      const values = await Promise.all(responses.map((r) => r.json()));
      assert.equal(new Set(values.map((x) => x.management)).size, 6);
    });
    await t.test(
      "웹 서버 임시 디스크를 삭제하고 재시작해도 자료 보존",
      async () => {
        await stop();
        rmSync(runtime, { recursive: true, force: true });
        runtime = join(directory, "runtime-2");
        await start();
        await login();
        assert.equal((await (await request("/proposals")).json()).length, 8);
        assert.deepEqual(
          Buffer.from(
            await (await request("/attachments/" + attachment)).arrayBuffer(),
          ),
          bytes,
        );
        assert.deepEqual(readdirSync(runtime), []);
        const snapshots = await (await request("/recovery-backups")).json();
        assert.ok(snapshots.length >= 2);
        const recovery = await (
          await request(
            "/recovery-backups/" +
              snapshots.find(
                (x: { id: string }) => x.id.includes("-") && x.id.length > 10,
              ).id,
          )
        ).json();
        assert.equal(recovery.attachments.length, 1);
        assert.deepEqual(
          Buffer.from(recovery.attachments[0].content, "base64"),
          bytes,
        );
      },
    );
  } finally {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
