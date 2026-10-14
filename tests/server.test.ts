import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { defaultSettings, type Proposal } from "../server/domain.ts";

test("실제 서버: 인증·권한·저장·엑셀·첨부·백업·재시작", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "school-test-"));
  const password = randomBytes(24).toString("base64url");
  const port = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess;
  let logs = "";
  let cookie = "",
    csrf = "";
  async function start() {
    server = spawn(
      process.execPath,
      ["--experimental-strip-types", "server/index.ts"],
      {
        env: {
          ...process.env,
          PORT: String(port),
          DATA_DIR: dir,
          ADMIN_PASSWORD: password,
          NODE_ENV: "production",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout!.on("data", (c) => (logs += c));
    server.stderr!.on("data", (c) => (logs += c));
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(logs);
      try {
        const r = await fetch(base + "/api/me");
        if (r.status === 401) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("서버 시작 실패 " + logs);
  }
  async function stop() {
    if (server && server.exitCode === null) {
      const done = once(server, "exit");
      server.kill("SIGTERM");
      await done;
    }
  }
  const request = (
    path: string,
    method = "GET",
    data?: unknown,
    session = true,
  ) =>
    fetch(base + "/api" + path, {
      method,
      headers: {
        ...(session ? { cookie, "X-CSRF-Token": csrf } : {}),
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
  async function login(username = "admin", pw = password) {
    const r = await request(
      "/login",
      "POST",
      { username, password: pw },
      false,
    );
    assert.equal(r.status, 200);
    cookie = r.headers.get("set-cookie")!.split(";")[0];
    const b = await r.json();
    csrf = b.csrf;
    assert.equal(r.headers.get("set-cookie")!.includes("HttpOnly"), true);
  }
  try {
    await start();
    await t.test("미인증 차단 및 CSRF 검증", async () => {
      assert.equal(
        (await request("/proposals", "GET", undefined, false)).status,
        401,
      );
      assert.equal(
        (
          await request(
            "/login",
            "POST",
            { username: "admin", password: "wrong" },
            false,
          )
        ).status,
        401,
      );
      await login();
      const r = await fetch(base + "/api/seed", {
        method: "POST",
        headers: { cookie },
      });
      assert.equal(r.status, 403);
    });
    let mixed: Proposal;
    let backup: Record<string, unknown>;
    let attachmentId = "";
    await t.test(
      "가상 혼합 품의 생성·수정 및 동시 수정 충돌 방지",
      async () => {
        assert.equal((await request("/seed", "POST", {})).status, 200);
        const data = (await (await request("/proposals")).json()) as Proposal[];
        assert.equal(data.length, 2);
        mixed = data.find((p) => p.payments.length === 3)!;
        assert.equal(
          mixed.payments.filter((x) => x.stages.payment.done).length,
          2,
        );
        const updated = await request("/proposals/" + mixed.id, "PUT", {
          ...mixed,
          note: "수정 저장 테스트",
        });
        assert.equal(updated.status, 200);
        const newValue = await updated.json();
        assert.equal(newValue.version, 2);
        assert.equal(
          (await request("/proposals/" + mixed.id, "PUT", mixed)).status,
          409,
        );
        mixed = newValue;
        assert.equal(
          (await request("/proposals", "POST", { ...mixed, total: -1 })).status,
          400,
        );
      },
    );
    await t.test("실제 파일 업로드·다운로드 및 위장 파일 차단", async () => {
      const bad = new FormData();
      bad.append("paymentId", mixed.payments[0].id);
      bad.append(
        "file",
        new Blob(["<script>alert(1)</script>"], { type: "application/pdf" }),
        "bad.pdf",
      );
      assert.equal(
        (await request("/proposals/" + mixed.id + "/attachments", "POST", bad))
          .status,
        400,
      );
      const form = new FormData();
      form.append("paymentId", mixed.payments[0].id);
      form.append(
        "file",
        new Blob(
          [
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9i8AAAAASUVORK5CYII=",
              "base64",
            ),
          ],
          { type: "image/png" },
        ),
        "test.png",
      );
      const upload = await request(
        "/proposals/" + mixed.id + "/attachments",
        "POST",
        form,
      );
      assert.equal(upload.status, 201);
      attachmentId = (await upload.json()).id;
      const file = await request("/attachments/" + attachmentId);
      assert.equal(file.status, 200);
      assert.equal(file.headers.get("content-type"), "image/png");
      assert.ok((await file.arrayBuffer()).byteLength > 10);
      assert.equal(
        (await request("/attachments/" + attachmentId, "GET", undefined, false))
          .status,
        401,
      );
    });
    await t.test("첨부 연결이 있는 결제 항목 삭제 차단", async () => {
      const changed = { ...mixed, payments: mixed.payments.slice(1) };
      const response = await request("/proposals/" + mixed.id, "PUT", changed);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /첨부파일/);
      const rows = (await (await request("/proposals")).json()) as Proposal[];
      assert.equal(rows.find((p) => p.id === mixed.id)?.payments.length, 3);
    });
    await t.test("설정 저장 및 예시 중복 생성 차단", async () => {
      assert.equal(
        (
          await request("/settings", "PUT", {
            ...defaultSettings,
            commitDays: 7,
          })
        ).status,
        200,
      );
      assert.equal((await (await request("/settings")).json()).commitDays, 7);
      assert.equal((await request("/seed", "POST", {})).status, 409);
    });
    await t.test("엑셀 출력·일괄 등록 왕복", async () => {
      const exportResponse = await request("/export");
      assert.equal(exportResponse.status, 200);
      const bytes = await exportResponse.arrayBuffer();
      assert.ok(bytes.byteLength > 1000);
      const f = new FormData();
      f.append("file", new Blob([bytes]), "import.xlsx");
      const r = await request("/import", "POST", f);
      assert.equal(r.status, 200);
      assert.equal((await r.json()).count, 2);
      assert.equal((await (await request("/proposals")).json()).length, 4);
    });
    await t.test("조회자는 수정·사용자 관리·백업에 접근 불가", async () => {
      const pw = randomBytes(24).toString("hex");
      const r = await request("/users", "POST", {
        username: "viewer",
        name: "조회자",
        role: "viewer",
        password: pw,
      });
      assert.equal(r.status, 201);
      await login("viewer", pw);
      assert.equal((await request("/proposals")).status, 200);
      assert.equal(
        (await request("/proposals/" + mixed.id, "PUT", mixed)).status,
        403,
      );
      assert.equal((await request("/backup")).status, 403);
      assert.equal((await request("/users")).status, 403);
      assert.equal(
        (await request("/settings", "PUT", defaultSettings)).status,
        403,
      );
      await login();
    });
    await t.test("백업·첨부 복원 및 변경 이력", async () => {
      backup = await (await request("/backup")).json();
      assert.equal((backup.attachments as unknown[]).length, 1);
      assert.equal((await request("/restore", "POST", backup)).status, 200);
      assert.equal((await request("/attachments/" + attachmentId)).status, 200);
      const changes = (await (await request("/audit")).json()) as {
        action: string;
      }[];
      assert.ok(changes.some((x) => x.action === "품의 수정"));
      assert.ok(changes.some((x) => x.action === "백업 복원"));
      assert.ok(readdirSync(join(dir, "backups")).length >= 2);
    });
    await t.test("서버 재시작 후 SQLite 자료 보존 및 프런트 제공", async () => {
      await stop();
      await start();
      await login();
      const p = (await (await request("/proposals")).json()) as Proposal[];
      assert.equal(p.length, 4);
      assert.equal(p.find((p) => p.id === mixed.id)?.note, "수정 저장 테스트");
      const html = await fetch(base);
      assert.equal(html.status, 200);
      assert.ok((await html.text()).includes('<div id="root">'));
      assert.equal((await request("/does-not-exist")).status, 404);
    });
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
