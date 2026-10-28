// Run only against the selected school checkout. Read-only legacy export; source data is never modified.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { proposalSchema } from "../server/domain.ts";
import { projectSchema } from "../shared/office.ts";
const [source, target] = process.argv.slice(2);
if (!source || !target)
  throw new Error(
    "사용법: npm run migrate:legacy -- 기존백업.json 새통합백업.json",
  );
const input = JSON.parse(readFileSync(source, "utf8"));
if (input.format !== "school-expense-v1" || !Array.isArray(input.proposals))
  throw new Error("기존 지출 화면에서 다운로드한 백업을 선택하세요");
const now = new Date().toISOString();
const projects = input.proposals.map((raw: any) => {
  const p = proposalSchema.parse(raw);
  return {
    ...projectSchema.parse({
      title: p.title,
      department: p.department,
      budgetType: p.payments.some((x) =>
        x.allocations.some((a) => a.source === "grant"),
      )
        ? "grant"
        : "school",
      approvedAmount: p.total,
      approvalDate: p.approved,
      approvalCompletedAt: p.approved,
      status: "진행 중",
      notes: p.note,
      legacyId: raw.id,
      payments: p.payments.map((x) => ({
        id: x.id,
        vendor: x.vendor,
        name: x.note,
        method: x.method,
        expectedAmount: x.planned,
        actualAmount: x.actual,
        obligationDate: x.stages.commit.done ? x.stages.commit.date : "",
        expenditureDate: x.stages.resolution.done
          ? x.stages.resolution.date
          : "",
        dueDate: x.resolutionDue || x.due,
        scheduledDate: x.due,
        cardApprovedDate:
          x.method === "card" && x.stages.payment.done
            ? x.stages.payment.date
            : "",
        actualPaymentDate:
          x.method === "transfer" && x.stages.payment.done
            ? x.stages.payment.date
            : "",
        status:
          x.method === "transfer" && x.stages.payment.done
            ? "지급 완료"
            : "지급 예정",
        notes: x.note,
      })),
    }),
    id: raw.id,
    version: raw.version,
    createdAt: raw.createdAt,
    updatedAt: now,
    userId: "admin",
    _deleted: false,
  };
});
const names = [
  ...new Set(
    projects.flatMap((p: any) => p.payments.map((x: any) => x.vendor)),
  ),
] as string[];
const vendors = names.map((name) => ({
  id: randomUUID(),
  name,
  notes: "기존 품의에서 가져온 업체",
  version: 1,
  createdAt: now,
  updatedAt: now,
  userId: "admin",
  _deleted: false,
}));
writeFileSync(
  target,
  JSON.stringify(
    {
      format: "school-office-v1",
      createdAt: now,
      records: {
        facilities: [],
        purchases: [],
        vendors,
        projects,
        templates: [],
        reports: [],
        preferences: [],
      },
      activities: [],
    },
    null,
    2,
  ),
  { mode: 0o600, flag: "wx" },
);
console.log(
  `${projects.length}개 품의를 변환했습니다. 원본 백업을 보관하세요. 첨부·재원 배분·증빙·기존 사용자·기존 변경 이력은 원본에 유지하며 새 통합 모델로 옮기지 않습니다. 카드 승인은 실제 정산 완료로 추정하지 않습니다.`,
);
