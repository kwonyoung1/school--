import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
const root = resolve("dist-cloud");
async function makeRuntime(password: string, persist?: string) {
  return new Miniflare({
    ...convertV4MiniflareOptions({
      modules: true,
      scriptPath: "worker-bundle/index.js",
      compatibilityDate: "2026-10-01",
      host: "127.0.0.1",
      port: 0,
      d1Databases: ["DB"],
      ...(persist ? { d1Persist: persist } : {}),
      bindings: { ADMIN_PASSWORD: password, LOCAL_DEV: "true" },
      serviceBindings: {
        ASSETS: async (req: any) => {
          const url = new URL(req.url);
          let path = resolve(root, "." + decodeURIComponent(url.pathname));
          if (!path.startsWith(root + "/") && path !== root)
            return new Response("", { status: 403 });
          if (!existsSync(path) || !extname(path))
            path = resolve(root, "index.html");
          const types: Record<string, string> = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript",
            ".css": "text/css",
            ".png": "image/png",
          };
          return new Response(readFileSync(path), {
            headers: {
              "Content-Type":
                types[extname(path)] || "application/octet-stream",
            },
          });
        },
      },
    }),
    resourcePersistencePath: persist,
  });
}
test("Workers/D1: 인증·CSRF·업무 CRUD·충돌·관계·백업복원·재시작·브라우저", async (t) => {
  const password = randomBytes(24).toString("base64url");
  const persist = mkdtempSync(join(tmpdir(), "office-d1-"));
  let mf = await makeRuntime(password, persist);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const db = await mf.getD1Database("DB");
    for (const sql of readFileSync("migrations/0001_office.sql", "utf8")
      .replace(/^--.*$/gm, "")
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
    let base = (await mf.ready).origin;
    let cookie = "",
      csrf = "";
    const call = async (
      path: string,
      method = "GET",
      value?: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(base + "/api" + path, {
        method,
        headers: {
          cookie,
          "X-CSRF-Token": csrf,
          "Content-Type": "application/json",
          ...headers,
        },
        body: value === undefined ? undefined : JSON.stringify(value),
      });
    await t.test(
      "공개 회원가입 없음·미인증 차단·DB 상태·로그인·CSRF",
      async () => {
        assert.equal((await call("/office/projects")).status, 401);
        assert.equal((await call("/register", "POST", {})).status, 401);
        assert.equal((await call("/health")).status, 200);
        const login = await call("/login", "POST", {
          username: "admin",
          password,
        });
        assert.equal(login.status, 200);
        cookie = login.headers.get("set-cookie")!.split(";")[0];
        assert.match(login.headers.get("set-cookie")!, /HttpOnly/);
        csrf = (await login.json()).csrf;
        assert.equal(
          (await call("/office/facilities", "POST", {}, { "X-CSRF-Token": "" }))
            .status,
          403,
        );
        assert.equal(
          (
            await call(
              "/office/facilities",
              "POST",
              {},
              { Origin: "https://attacker.example" },
            )
          ).status,
          403,
        );
        assert.equal(
          (await call("/office/facilities", "POST", { title: "" })).status,
          400,
        );
        assert.equal((await call("/office/__proto__")).status, 404);
      },
    );
    let saved: any;
    await t.test(
      "동일 업체 복수 지급·혼합결제·정산 독립·동시 수정·업체 관계",
      async () => {
        const p = (vendor: string, method: string, expectedAmount: number) => ({
          id: crypto.randomUUID(),
          vendor,
          method,
          expectedAmount,
        });
        const r = await call("/office/projects", "POST", {
          title: "기숙사 사무용품 구입",
          budgetType: "school",
          approvedAmount: 500000,
          approvalDate: "2026-10-27",
          payments: [
            p("쿠팡", "card", 200000),
            p("오피스디포", "transfer", 150000),
            p("쿠팡", "transfer", 150000),
          ],
        });
        assert.equal(r.status, 201, await r.clone().text());
        saved = await r.json();
        const old = structuredClone(saved);
        saved.payments[0].expenditureDate = "2026-10-27";
        saved.payments[0].expectedAmount = 210000;
        const updated = await call(
          "/office/projects/" + saved.id,
          "PUT",
          saved,
        );
        assert.equal(updated.status, 200, await updated.clone().text());
        saved = await updated.json();
        assert.equal(saved.payments[0].status, "지급 예정");
        assert.equal(saved.payments[0].actualAmount, null);
        assert.equal(
          (await call("/office/projects/" + saved.id, "PUT", old)).status,
          409,
        );
        assert.equal(
          (await db
            .prepare(
              "SELECT count(*) n FROM expense_payments p JOIN expense_vendors v ON v.id=p.vendor_id",
            )
            .first<any>())!.n,
          3,
        );
        assert.equal((await (await call("/office/vendors")).json()).length, 2);
      },
    );
    await t.test(
      "D1 활동 금액 변경 전후·백업 복원·삭제·불량 백업 차단",
      async () => {
        const logs = await (await call("/office/activities")).json();
        assert.ok(
          logs.some((x: any) => x.description.includes("200000 → 210000")),
        );
        const backup = await (await call("/office/backup")).json();
        assert.equal(
          (
            await call("/office/projects/" + saved.id, "DELETE", {
              version: saved.version,
            })
          ).status,
          200,
        );
        assert.equal((await (await call("/office/projects")).json()).length, 0);
        assert.equal(
          (await call("/office/restore", "POST", backup)).status,
          200,
        );
        assert.equal((await (await call("/office/projects")).json()).length, 1);
        assert.equal(
          (await (await call("/office/snapshots")).json()).length,
          1,
        );
        assert.equal(
          (await call("/office/restore", "POST", { format: "wrong" })).status,
          400,
        );
      },
    );
    await t.test(
      "D1 디스크 유지 및 Worker 프로세스 재시작 후 계정·세션·자료 보존",
      async () => {
        await mf.dispose();
        mf = await makeRuntime(randomBytes(24).toString("hex"), persist);
        base = (await mf.ready).origin;
        assert.equal((await call("/me")).status, 200);
        assert.equal((await (await call("/office/projects")).json()).length, 1);
      },
    );
    await t.test(
      "Chromium: 시설 자동 작성·초안·물품 용도·사업·보고서·엑셀·반응형",
      async () => {
        browser = await chromium.launch({
          executablePath: "/usr/bin/chromium",
          args: ["--no-sandbox"],
        });
        const page = await browser.newPage({
          viewport: { width: 1440, height: 1000 },
        });
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(base);
        await page.getByLabel("아이디", { exact: true }).fill("admin");
        await page.getByLabel("비밀번호", { exact: true }).fill(password);
        await page.getByRole("button", { name: "로그인", exact: true }).click();
        await page
          .getByRole("heading", { name: "통합 대시보드", exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "시설 작업계획", exact: true })
          .click();
        await page
          .getByRole("button", { name: "작업계획 작성", exact: true })
          .click();
        const dialog = page.getByRole("dialog");
        await dialog.getByLabel("업무명").fill("2학년 교무실 유리 교체");
        await dialog
          .getByRole("button", { name: "자동 작성", exact: true })
          .click();
        assert.equal(
          (await dialog.getByLabel("작업내용 (직접 수정)").inputValue()).split(
            "\n",
          ).length,
          3,
        );
        await dialog.getByRole("button", { name: "닫기", exact: true }).click();
        await page
          .getByRole("button", { name: "작업계획 작성", exact: true })
          .click();
        assert.equal(
          await dialog.getByLabel("업무명").inputValue(),
          "2학년 교무실 유리 교체",
        );
        await dialog.getByRole("button", { name: "저장", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        await page.reload();
        await page
          .getByRole("heading", { name: "통합 대시보드", exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "시설 작업계획", exact: true })
          .click();
        await page
          .getByRole("button", { name: "2학년 교무실 유리 교체", exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "시설관리물품 구입", exact: true })
          .click();
        await page
          .getByRole("button", { name: "구입 업무 등록", exact: true })
          .click();
        await dialog.getByLabel("업무명").fill("기숙사 청소용품 구입");
        await dialog.getByLabel("물품명", { exact: true }).fill("락스");
        await dialog.getByLabel("수량", { exact: true }).fill("2");
        await dialog.getByLabel("단가", { exact: true }).fill("3000");
        await dialog
          .getByRole("button", { name: "용도 자동 생성", exact: true })
          .click();
        assert.match(
          await dialog.getByLabel("구입 용도", { exact: true }).inputValue(),
          /청소/,
        );
        await dialog.getByRole("button", { name: "저장", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        await page
          .getByRole("button", { name: "지출사업 관리", exact: true })
          .click();
        await page
          .getByRole("button", { name: "신규 사업 등록", exact: true })
          .click();
        await dialog
          .getByLabel("사업명 *", { exact: true })
          .fill("브라우저 혼합 지급 사업");
        await dialog.getByLabel("품의 금액", { exact: true }).fill("500000");
        for (const [i, vendor, method, amount] of [
          [0, "쿠팡", "card", "230000"],
          [1, "오피스디포", "transfer", "150000"],
          [2, "쿠팡", "transfer", "150000"],
        ] as const) {
          await dialog
            .getByRole("button", { name: "+ 결제·지급 건 추가", exact: true })
            .click();
          const section = dialog.locator(".os-payment").nth(i);
          await section.getByLabel("업체명").fill(vendor);
          await section.getByLabel("결제 방식").selectOption(method);
          await section
            .getByLabel("지급 예정금액", { exact: true })
            .fill(amount);
        }
        await dialog.getByText("품의 금액 초과", { exact: false }).waitFor();
        await dialog
          .locator(".os-payment")
          .nth(0)
          .getByLabel("지급 예정금액", { exact: true })
          .fill("200000");
        await dialog
          .locator(".os-payment")
          .nth(0)
          .getByRole("button", { name: "지출결의 완료", exact: true })
          .click();
        assert.equal(
          await dialog
            .locator(".os-payment")
            .nth(0)
            .getByLabel("대금 지급 상태")
            .inputValue(),
          "지급 예정",
        );
        await dialog.getByRole("button", { name: "저장", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        await page
          .getByRole("button", { name: "업체별 지급관리", exact: true })
          .click();
        await page
          .getByRole("button", { name: "쿠팡", exact: true })
          .first()
          .waitFor();
        const downloadPromise = page.waitForEvent("download");
        await page
          .getByRole("button", { name: "Excel 다운로드", exact: true })
          .click();
        const file = await downloadPromise;
        assert.match(file.suggestedFilename(), /\.xlsx$/);
        const { default: ExcelJS } = await import("exceljs");
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile((await file.path())!);
        assert.equal(
          workbook.worksheets[0].getRow(1).getCell(1).text,
          "사업명",
        );
        assert.ok(workbook.worksheets[0].rowCount >= 7);
        await page
          .getByRole("button", { name: "오늘 한 일", exact: true })
          .click();
        await page
          .getByRole("heading", {
            name: "행정실 일일업무 처리현황",
            exact: true,
          })
          .waitFor();
        assert.match(
          await page.getByLabel("일일업무보고 내용").inputValue(),
          /유리 교체/,
        );
        await page
          .getByRole("button", { name: "보고서 저장", exact: true })
          .click();
        await page
          .getByRole("status")
          .filter({ hasText: "보고서를 저장했습니다" })
          .waitFor();
        const pdf = await page.pdf({
          format: "A4",
          path: "/tmp/school-office-report.pdf",
        });
        assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(
          await page
            .locator("body")
            .evaluate((x) => x.scrollWidth <= innerWidth),
        );
        await page.screenshot({
          path: "/tmp/school-office-mobile.png",
          fullPage: true,
        });
        assert.deepEqual(errors, []);
      },
    );
    await t.test("로그아웃과 세션 무효화", async () => {
      assert.equal((await call("/logout", "POST", {})).status, 200);
      assert.equal((await call("/office/projects")).status, 401);
    });
  } finally {
    await browser?.close();
    await mf.dispose();
    rmSync(persist, { recursive: true, force: true });
  }
});
