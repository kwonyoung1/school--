import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
for (const backend of ["sqlite", "libsql"])
  test(`${backend}: 비밀번호 변경·재시작·일회성 복구 시 업무와 다른 계정 보존`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "school-password-"));
    const initial = randomBytes(24).toString("hex"),
      changed = randomBytes(24).toString("hex") + "!가상",
      afterRecovery = randomBytes(24).toString("hex");
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => resolve(port));
      });
    });
    const base = `http://127.0.0.1:${port}/api`;
    let server: ChildProcess;
    let cookie = "",
      csrf = "",
      logs = "";
    async function start(reset?: string) {
      server = spawn(
        process.execPath,
        ["--experimental-strip-types", "server/index.ts"],
        {
          env: {
            ...process.env,
            NODE_ENV: "test",
            PORT: String(port),
            DATA_DIR: dir,
            ADMIN_PASSWORD: initial,
            ADMIN_PASSWORD_RESET_ID: reset || "",
            ...(backend === "libsql"
              ? {
                  LIBSQL_TEST_URL: pathToFileURL(
                    join(dir, "remote-test.sqlite"),
                  ).href,
                }
              : {}),
          },
          stdio: "pipe",
        },
      );
      server.stdout!.on("data", (c) => (logs += c));
      server.stderr!.on("data", (c) => (logs += c));
      for (let i = 0; i < 100; i++) {
        if (server.exitCode !== null) throw new Error(logs);
        try {
          if ((await fetch(base + "/health")).ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("시작 실패 " + logs);
    }
    async function stop() {
      if (server && server.exitCode === null) {
        const done = once(server, "exit");
        server.kill();
        await done;
      }
    }
    const call = (path: string, body?: unknown) =>
      fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie,
          "X-CSRF-Token": csrf,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    async function login(password: string, username = "admin") {
      const response = await call("/login", { username, password });
      if (response.ok) {
        const result = await response.json();
        cookie = response.headers.get("set-cookie")!.split(";")[0];
        csrf = result.csrf;
      }
      return response;
    }
    try {
      await start();
      assert.equal((await login(initial)).status, 200);
      assert.equal((await call("/seed", {})).status, 200);
      const viewerPassword = randomBytes(24).toString("hex");
      assert.equal(
        (
          await call("/users", {
            username: "viewer",
            name: "조회자",
            role: "viewer",
            password: viewerPassword,
          })
        ).status,
        201,
      );
      assert.equal(
        (await call("/password", { current: initial, next: changed })).status,
        200,
      );
      assert.equal((await call("/me")).status, 401);
      assert.equal((await login(initial)).status, 401);
      assert.equal((await login(changed)).status, 200);
      await stop();
      await start();
      assert.equal((await login(changed)).status, 200);
      const beforeCookie = cookie;
      for (let i = 0; i < 5; i++)
        assert.equal((await login("wrong")).status, 401);
      assert.equal((await login(changed)).status, 429);
      await stop();
      await start("test-recovery-1");
      const expired = await fetch(base + "/me", {
        headers: { cookie: beforeCookie },
      });
      assert.equal(expired.status, 401);
      assert.equal((await login(initial)).status, 200);
      assert.equal((await (await call("/proposals")).json()).length, 2);
      assert.equal(
        (await call("/password", { current: initial, next: afterRecovery }))
          .status,
        200,
      );
      await stop();
      await start("test-recovery-1");
      assert.equal((await login(initial)).status, 401);
      assert.equal((await login(afterRecovery)).status, 200);
      const audit = (await (await call("/audit")).json()) as {
        action: string;
      }[];
      assert.equal(
        audit.filter((a) => a.action === "관리자 비밀번호 복구").length,
        1,
      );
      assert.equal((await login(viewerPassword, "viewer")).status, 200);
      assert.equal((await (await call("/proposals")).json()).length, 2);
      assert.ok(
        !logs.includes(initial) &&
          !logs.includes(changed) &&
          !logs.includes(afterRecovery),
      );
    } finally {
      await stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
