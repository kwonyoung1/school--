import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";

test("브라우저에서 로그인·혼합 품의 확인·등록·수정·달력·통계·설정", async () => {
  const dir = mkdtempSync(join(tmpdir(), "school-browser-")),
    password = randomBytes(24).toString("hex");
  const port = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(
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
      stdio: "pipe",
    },
  );
  let logs = "";
  server.stderr.on("data", (s) => (logs += s));
  server.stdout.on("data", (s) => (logs += s));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(logs);
      try {
        if ((await fetch(base + "/api/me")).status === 401) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const executablePath =
      process.env.CHROMIUM_EXECUTABLE ||
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1050 },
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    await page.getByLabel("아이디", { exact: true }).fill("admin");
    await page.getByLabel("비밀번호", { exact: true }).fill(password);
    await page.getByRole("button", { name: "로그인 →", exact: true }).click();
    await page
      .getByRole("heading", { name: "업무 대시보드", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "설정·사용자" }).click();
    await page.getByRole("button", { name: "가상 예시 2건 생성" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "가상 품의 2건" })
      .waitFor();
    await page.getByRole("button", { name: "업무 대시보드" }).click();
    await page
      .getByRole("button", { name: /정보관 실습실 기자재 구입/ })
      .first()
      .waitFor();
    await page.getByRole("button", { name: "지출업무 목록" }).click();
    await page
      .getByRole("button", { name: /정보관 실습실 기자재 구입/ })
      .click();
    await page.getByText("세부 결제 3건", { exact: true }).waitFor();
    assert.equal(await page.getByText("최종 완료", { exact: true }).count(), 1);
    await page
      .getByRole("button", { name: "＋ 품의 등록", exact: true })
      .click();
    await page
      .getByLabel("품의 제목 *", { exact: true })
      .fill("브라우저 등록 가상 품의");
    await page.getByLabel("신청 교직원 *", { exact: true }).fill("가상교사");
    await page.getByLabel("품의 총금액 (원) *", { exact: true }).fill("10000");
    await page.getByRole("button", { name: "결제 세부 1건" }).click();
    await page.getByLabel("업체명 *", { exact: true }).fill("가상 문구업체");
    await page.getByLabel("예정금액 (원)", { exact: true }).fill("10000");
    await page.getByLabel("배분금액", { exact: true }).fill("10000");
    await page.getByRole("button", { name: "품의 저장", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "품의를 저장" }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.getByRole("button", { name: /브라우저 등록 가상 품의/ }).click();
    const row = page.locator("tr").filter({
      has: page.getByRole("button", { name: /브라우저 등록 가상 품의/ }),
    });
    await row.getByRole("button", { name: "상세 ↗" }).click();
    await page
      .getByLabel("품의 비고", { exact: true })
      .fill("브라우저 수정 저장 검증");
    await page.getByRole("button", { name: "품의 저장", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.reload();
    await page
      .getByRole("heading", { name: "업무 대시보드", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "지출업무 목록" }).click();
    await page
      .getByRole("button", { name: /브라우저 등록 가상 품의/ })
      .waitFor();
    await page.getByLabel("품의 검색").fill("브라우저 등록");
    assert.equal(await page.locator("tbody > tr").count(), 1);
    await page
      .locator("tbody tr")
      .first()
      .getByRole("button", { name: "상세 ↗" })
      .click();
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "품의 삭제", exact: true }).click();
    assert.equal(await page.getByRole("dialog").count(), 1);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "품의 삭제", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(await page.locator("tbody tr").count(), 0);
    for (const name of [
      "업무 달력",
      "집행 통계",
      "완료 보관함",
      "설정·사용자",
      "업무 대시보드",
    ]) {
      await page.getByRole("button", { name, exact: false }).first().click();
      await page.getByRole("heading", { name, exact: true }).first().waitFor();
    }
    await page.screenshot({
      path: "/tmp/school-dashboard.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/school-mobile.png", fullPage: true });
    assert.equal(
      await page
        .locator("body")
        .evaluate((e) => e.scrollWidth <= window.innerWidth),
      true,
    );
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page
      .getByRole("button", { name: "시설 작업계획", exact: false })
      .first()
      .click();
    await page
      .getByRole("button", { name: "작업계획 작성", exact: true })
      .click();
    const officeDialog = page.getByRole("dialog");
    await officeDialog.getByLabel("업무명").fill("로컬 시설 조명 점검");
    await officeDialog
      .getByRole("button", { name: "자동 작성", exact: true })
      .click();
    await officeDialog
      .getByRole("button", { name: "저장", exact: true })
      .click();
    await officeDialog.waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: "로컬 시설 조명 점검", exact: true })
      .waitFor();
    const officeBackup = await page.request.get(base + "/api/office/backup");
    assert.equal(officeBackup.status(), 200);
    assert.equal((await officeBackup.json()).records.facilities.length, 1);
    const activities = await (
      await page.request.get(base + "/api/office/activities")
    ).json();
    assert.ok(
      activities.some(
        (x: any) =>
          x.entity_type === "legacy" && x.title === "브라우저 등록 가상 품의",
      ),
    );
    assert.ok(activities.some((x: any) => x.entity_type === "facilities"));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server.exitCode === null) {
      const exit = once(server, "exit");
      server.kill();
      await exit;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
