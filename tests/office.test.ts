import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { OfficeStore } from "../shared/office-store.ts";
import {
  generatePlan,
  recommendTemplate,
  generatePurpose,
  cardAlert,
  totals,
  projectSchema,
  describeChanges,
  koreanDate,
  dailyReport,
  type OfficePayment,
} from "../shared/office.ts";
export const payment = (
  vendor = "쿠팡",
  method: "card" | "transfer" = "card",
  expectedAmount = 200000,
): OfficePayment => ({
  id: crypto.randomUUID(),
  vendor,
  method,
  expectedAmount,
  actualAmount: null,
  name: "",
  obligationDate: "",
  expenditureDate: "",
  dueDate: "2026-11-10",
  scheduledDate: "",
  cardApprovedDate: "",
  actualPaymentDate: "",
  status: "지급 예정",
  notes: "",
});
export const project = () => ({
  title: "기숙사 사무용품 구입",
  department: "행정실",
  budgetType: "school",
  approvedAmount: 500000,
  approvalDate: "2026-10-27",
  approvalCompletedAt: "",
  status: "진행 중",
  notes: "",
  payments: [
    payment(),
    payment("오피스디포", "transfer", 150000),
    payment("쿠팡", "transfer", 150000),
  ],
});
test("시설 계획은 세 항목을 생성하고 확인하지 않은 파손을 단정하지 않는다", () => {
  const text = generatePlan({
    title: "교무실 유리 교체",
    location: "교무실",
    condition: "",
    impact: "",
    action: "",
  });
  assert.equal(text.split("\n").length, 3);
  assert.ok(text.includes("현장 확인"));
  assert.ok(!text.includes("파손되어"));
  assert.ok(
    generatePlan({
      title: "조명 교체",
      location: "복도",
      condition: "조명 점멸 확인",
      impact: "통행 불편",
      action: "규격 확인 후 교체",
    }).includes("조명 점멸 확인"),
  );
});
test("락스·실리콘 용도 및 카드 기한의 경계일·완료·취소", () => {
  assert.match(generatePurpose("락스"), /청소/);
  assert.match(generatePurpose("실리콘"), /틈새 보수/);
  const p = payment();
  assert.equal(cardAlert(p, "2026-11-02")?.label, "정상");
  assert.equal(cardAlert(p, "2026-11-03")?.label, "주의");
  assert.equal(cardAlert(p, "2026-11-07")?.label, "긴급");
  assert.equal(cardAlert(p, "2026-11-11")?.label, "기한 초과");
  assert.equal(
    cardAlert(
      {
        ...p,
        status: "지급 완료",
        actualAmount: 200000,
        actualPaymentDate: "2026-11-09",
      },
      "2026-11-11",
    )?.label,
    "기한 초과",
  );
  assert.equal(
    cardAlert(
      { ...p, status: "지급 완료", expenditureDate: "2026-11-09" },
      "2026-11-11",
    ),
    null,
  );
  assert.equal(cardAlert({ ...p, status: "취소" }), null);
});
test("다중 업체·동일 업체·혼합결제·예정과 실제 지급 및 취소 합계", () => {
  const p = projectSchema.parse(project());
  assert.equal(totals(p).expected, 500000);
  assert.equal(totals(p).difference, 0);
  assert.equal(totals(p).card, 200000);
  assert.equal(totals(p).transfer, 300000);
  p.payments[0].expectedAmount = 230000;
  assert.equal(totals(p).difference, -30000);
  assert.ok(projectSchema.safeParse(p).success);
  p.payments[0].expenditureDate = "2026-10-27";
  assert.equal(p.payments[0].status, "지급 예정");
  assert.equal(totals(p).actual, 0);
  p.payments[0].status = "취소";
  assert.equal(totals(p).expected, 300000);
  assert.equal(totals(p).expenditure, 0);
  assert.ok(
    !projectSchema.safeParse({
      ...p,
      payments: [{ ...p.payments[1], status: "지급 완료" }],
    }).success,
  );
});
test("한국시간 날짜 및 금액 변경 이력", () => {
  assert.equal(koreanDate("2026-10-26T15:00:00Z"), "2026-10-27");
  const before = project(),
    after = structuredClone(before);
  after.payments[0].expectedAmount = 210000;
  const log = describeChanges("projects", before, after).join("\n");
  assert.match(log, /200000 → 210000/);
  assert.match(log, /쿠팡/);
});
test("SQLite 업무 CRUD·관계·원자적 이력·중복 및 충돌·삭제·백업복원", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("migrations/0001_office.sql", "utf8"));
  const store = new OfficeStore({
    all: async (sql, args = []) => db.prepare(sql).all(...(args as never[])),
    batch: async (statements) => {
      db.exec("BEGIN");
      try {
        for (const s of statements)
          db.prepare(s.sql).run(...((s.args as never[]) || []));
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  });
  try {
    const p = await store.put("projects", project(), "admin");
    assert.equal((await store.list("projects")).length, 1);
    assert.equal(
      db.prepare("SELECT count(*) n FROM expense_payments").get()!.n,
      3,
    );
    assert.equal((await store.list("vendors")).length, 2);
    const old = structuredClone(p);
    p.payments[0].expenditureDate = "2026-10-27";
    p.payments[0].expectedAmount = 210000;
    const updated = await store.put("projects", p, "admin", p.id);
    assert.equal(updated.payments[0].status, "지급 예정");
    assert.equal((await store.logs()).length, 3);
    await assert.rejects(
      () => store.put("projects", old, "admin", old.id),
      /다른 기기/,
    );
    assert.equal((await store.logs()).length, 3);
    const same = await store.get("projects", p.id);
    same.payments[0].id = same.payments[1].id;
    await assert.rejects(() => store.put("projects", same, "admin", p.id));
    assert.equal((await store.get("projects", p.id)).version, 2);
    const backup = await store.backup();
    await store.put(
      "projects",
      { version: updated.version },
      "admin",
      p.id,
      true,
    );
    assert.equal((await store.list("projects")).length, 0);
    assert.equal(
      db.prepare("SELECT count(*) n FROM expense_payments").get()!.n,
      0,
    );
    await store.restore(backup, "admin");
    assert.equal((await store.list("projects")).length, 1);
    assert.equal(
      db.prepare("SELECT count(*) n FROM expense_payments").get()!.n,
      3,
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM office_snapshots").get()!.n,
      1,
    );
    const broken = structuredClone(backup);
    broken.records.projects.push(broken.records.projects[0]);
    await assert.rejects(() => store.restore(broken, "admin"));
    assert.equal((await store.list("projects")).length, 1);
    assert.ok(
      dailyReport(await store.logs(), "2026-10-27").includes(
        "행정실 일일업무 처리현황",
      ),
    );
  } finally {
    db.close();
  }
});

test("유사 작업명은 저장한 문구를 추천하고 관계없는 작업은 추천하지 않는다", () => {
  const templates = [
    {
      title: "교무실 유리 교체 작업",
      type: "facility",
      content: "검토한 문구",
    },
  ];
  assert.equal(
    recommendTemplate(templates, "facility", "교무실 유리 교체")?.content,
    "검토한 문구",
  );
  assert.equal(
    recommendTemplate(templates, "facility", "운동장 배수로 보수"),
    undefined,
  );
});
