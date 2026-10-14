import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  complete,
  defaultSettings,
  stageIds,
  method,
  warnings,
  alerts,
  proposalSchema,
  type Payment,
  type Proposal,
} from "../server/domain.ts";
export function fixture(): Proposal {
  const payment = (
    method: "card" | "transfer",
    planned: number,
    done: boolean,
  ): Payment => ({
    id: randomUUID(),
    method,
    vendor: "가상업체",
    planned,
    actual: done ? planned : null,
    due: "2026-10-13",
    resolutionDue: "2026-10-14",
    note: "",
    allocations: [
      {
        source: "school",
        amount: planned,
        project: "",
        agency: "",
        start: "",
        end: "",
      },
    ],
    documents: [{ name: "증빙", required: true, received: done }],
    stages: Object.fromEntries(
      stageIds.map((id) => [
        id,
        {
          done,
          date: done ? "2026-10-01" : "",
          owner: done ? "가상담당자" : "",
          note: "",
          document: "",
          group: "",
        },
      ]),
    ) as Payment["stages"],
  });
  return {
    id: randomUUID(),
    management: "2026-00001",
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: "혼합결제 테스트",
    number: "TEST-001",
    department: "가상부서",
    applicant: "가상교사",
    approved: "2026-10-01",
    received: "2026-10-01",
    total: 1000000,
    budget: "교육운영비",
    due: "2026-10-13",
    note: "",
    adjustmentReason: "",
    payments: [
      payment("card", 300000, true),
      payment("card", 200000, true),
      payment("transfer", 500000, false),
    ],
  };
}
test("카드 2건 완료 + 계좌이체 1건 미완료이면 전체 완료 불가", () => {
  const p = fixture();
  assert.equal(method(p), "mixed");
  assert.equal(complete(p, defaultSettings), false);
  assert.equal(p.payments.filter((x) => x.stages.payment.done).length, 2);
});
test("모든 결제 및 증빙 완료 후 품의 최종 완료", () => {
  const p = fixture();
  const x = p.payments[2];
  x.actual = x.planned;
  x.documents.forEach((d) => (d.received = true));
  stageIds.forEach(
    (id) =>
      (x.stages[id] = {
        done: true,
        date: "2026-10-14",
        owner: "가상 담당자",
        note: "",
        group: "묶음",
        document: "DOC-001",
      }),
  );
  assert.equal(complete(p, defaultSettings), true);
  x.actual = 400000;
  assert.equal(complete(p, defaultSettings), false);
  assert.ok(warnings(p).some((w) => w.includes("실제")));
  p.adjustmentReason = "일부 주문 취소 100,000원";
  assert.equal(complete(p, defaultSettings), true);
});
test("하나의 결제에 자체예산·지원금 배분 및 합계 검증", () => {
  const p = fixture();
  p.payments[0].allocations = [
    {
      source: "school",
      amount: 100000,
      project: "",
      agency: "",
      start: "",
      end: "",
    },
    {
      source: "grant",
      amount: 200000,
      project: "가상지원",
      agency: "가상교육청",
      start: "2026-01-01",
      end: "2026-12-31",
    },
  ];
  assert.equal(warnings(p).length, 0);
  p.payments[0].allocations[0].amount = 1;
  assert.ok(warnings(p).some((w) => w.includes("배분")));
});
test("알림은 품의당 경고 사유를 모으고 우선순위를 유지", () => {
  const a = alerts(fixture(), defaultSettings, "2026-10-14");
  assert.equal(a[0].priority, 1);
  assert.ok(a.some((x) => x.message === "원인행위 미처리"));
  assert.ok(a.some((x) => x.message === "증빙서류 부족"));
  assert.equal(new Set(a.map((x) => x.message)).size, a.length);
});
test("입력 검증: 음수, 중복 ID, 완료 담당자 누락, 잘못된 날짜 거부", () => {
  const p = fixture();
  assert.ok(proposalSchema.safeParse(p).success);
  p.total = -1;
  assert.equal(proposalSchema.safeParse(p).success, false);
  p.total = 1000000;
  p.payments[1].id = p.payments[0].id;
  assert.equal(proposalSchema.safeParse(p).success, false);
  p.payments[1].id = randomUUID();
  p.payments[0].stages.commit.owner = "";
  assert.equal(proposalSchema.safeParse(p).success, false);
  p.approved = "2026-02-30";
  assert.equal(proposalSchema.safeParse(p).success, false);
});
