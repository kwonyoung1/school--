import { z } from "zod";
export const stageIds = [
  "receipt",
  "commit",
  "payment",
  "evidence",
  "resolution",
] as const;
export type StageId = (typeof stageIds)[number];
export const stageLabels: Record<StageId, string> = {
  receipt: "품의 접수",
  commit: "원인행위",
  payment: "결제·지급",
  evidence: "증빙서류",
  resolution: "지출결의",
};
const text = z.string().max(2000);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      !Number.isNaN(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s,
    "올바른 날짜를 입력하세요",
  );
const optionalDay = z.union([day, z.literal("")]);
const money = z.number().int().min(0).max(1_000_000_000_000);
export const stageSchema = z.object({
  done: z.boolean(),
  date: optionalDay,
  owner: text,
  note: text,
  document: text,
  group: text,
});
export const allocationSchema = z.object({
  source: z.enum(["school", "grant"]),
  project: text,
  agency: text,
  start: optionalDay,
  end: optionalDay,
  amount: money,
});
export const paymentSchema = z.object({
  id: z.string().uuid(),
  method: z.enum(["card", "transfer"]),
  vendor: z.string().trim().min(1).max(200),
  planned: money,
  actual: money.nullable(),
  due: optionalDay,
  resolutionDue: optionalDay,
  note: text,
  allocations: z.array(allocationSchema).min(1).max(30),
  documents: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        required: z.boolean(),
        received: z.boolean(),
      }),
    )
    .max(30),
  stages: z.object({
    receipt: stageSchema,
    commit: stageSchema,
    payment: stageSchema,
    evidence: stageSchema,
    resolution: stageSchema,
  }),
});
export const proposalSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    number: text,
    department: text,
    applicant: z.string().trim().min(1).max(100),
    approved: day,
    received: day,
    total: money.refine((n) => n > 0),
    budget: text,
    due: optionalDay,
    note: text,
    adjustmentReason: text,
    payments: z.array(paymentSchema).min(1).max(100),
  })
  .superRefine((p, ctx) => {
    if (new Set(p.payments.map((x) => x.id)).size !== p.payments.length)
      ctx.addIssue({ code: "custom", message: "결제 항목 ID가 중복됩니다" });
    for (const [i, payment] of p.payments.entries()) {
      for (const id of stageIds) {
        const s = payment.stages[id];
        if (s.done && (!s.date || !s.owner.trim()))
          ctx.addIssue({
            code: "custom",
            path: ["payments", i, "stages", id],
            message: "처리 완료 시 처리일자와 담당자가 필요합니다",
          });
      }
      if (payment.stages.payment.done && payment.actual === null)
        ctx.addIssue({
          code: "custom",
          message: "결제 완료 시 실제 금액을 입력하세요",
        });
    }
  });
export type ProposalInput = z.infer<typeof proposalSchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type Proposal = ProposalInput & {
  id: string;
  management: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export const settingsSchema = z
  .object({
    commitDays: z.number().int().min(0).max(365),
    dueDays: z.number().int().min(0).max(60),
    resolutionDays: z.number().int().min(0).max(365),
    stages: z
      .array(z.object({ id: z.enum(stageIds), required: z.boolean() }))
      .length(5),
  })
  .refine(
    (s) => new Set(s.stages.map((x) => x.id)).size === 5,
    "단계는 중복 없이 모두 포함해야 합니다",
  );
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  commitDays: 3,
  dueDays: 3,
  resolutionDays: 5,
  stages: stageIds.map((id) => ({ id, required: true })),
};
export function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
export function days(from: string, to = today()) {
  return Math.floor((Date.parse(to) - Date.parse(from)) / 86400000);
}
export function method(p: ProposalInput) {
  const kinds = new Set(p.payments.map((x) => x.method));
  return kinds.size > 1 ? "mixed" : p.payments[0]?.method;
}
export function evidenceReady(p: Payment) {
  return p.documents.every((d) => !d.required || d.received);
}
export function stageDone(p: Payment, id: StageId) {
  return (
    p.stages[id].done &&
    (id !== "evidence" || evidenceReady(p)) &&
    (id !== "payment" || p.actual !== null)
  );
}
export function paymentComplete(p: Payment, s: Settings) {
  return (
    stageDone(p, "payment") &&
    s.stages.every((x) => !x.required || stageDone(p, x.id))
  );
}
export function warnings(p: ProposalInput) {
  const result: string[] = [];
  const planned = p.payments.reduce((a, x) => a + x.planned, 0);
  const actual = p.payments.reduce((a, x) => a + (x.actual ?? 0), 0);
  if (planned !== p.total)
    result.push("결제 예정금액 합계와 품의 총금액이 다릅니다");
  if (p.payments.every((x) => stageDone(x, "payment")) && actual !== p.total)
    result.push("실제 결제금액 합계와 품의 총금액이 다릅니다");
  if (
    p.payments.some(
      (x) => x.allocations.reduce((a, y) => a + y.amount, 0) !== x.planned,
    )
  )
    result.push("결제 항목의 재원 배분 합계와 예정금액이 다릅니다");
  if (
    p.payments
      .flatMap((x) => x.allocations)
      .reduce((a, x) => a + x.amount, 0) !== p.total
  )
    result.push("재원 배분 총합과 품의 총금액이 다릅니다");
  return result;
}
export function complete(p: ProposalInput, s: Settings) {
  return (
    p.payments.every((x) => paymentComplete(x, s)) &&
    (warnings(p).length === 0 || !!p.adjustmentReason.trim())
  );
}
export function alerts(p: Proposal, s: Settings, date = today()) {
  if (complete(p, s)) return [];
  const a: { priority: number; message: string }[] = [];
  if (p.due && p.due < date) a.push({ priority: 1, message: "처리 기한 경과" });
  if (
    p.due === date ||
    p.payments.some((x) => !stageDone(x, "payment") && x.due === date) ||
    p.payments.some(
      (x) => !stageDone(x, "resolution") && x.resolutionDue === date,
    )
  )
    a.push({ priority: 2, message: "오늘 처리 예정" });
  if (
    p.payments.some((x) => !stageDone(x, "commit")) &&
    days(p.received, date) >= s.commitDays
  )
    a.push({ priority: 3, message: "원인행위 미처리" });
  if (
    p.payments.some(
      (x) =>
        stageDone(x, "payment") &&
        !stageDone(x, "resolution") &&
        (x.method === "transfer" ||
          days(x.stages.payment.date, date) >= s.resolutionDays),
    )
  )
    a.push({ priority: 4, message: "결제 후 지출결의 미처리" });
  if (p.payments.some((x) => !evidenceReady(x)))
    a.push({ priority: 5, message: "증빙서류 부족" });
  if (
    p.payments.some(
      (x) =>
        !stageDone(x, "payment") &&
        x.due &&
        days(date, x.due) >= 0 &&
        days(date, x.due) <= s.dueDays,
    )
  )
    a.push({ priority: 6, message: "결제·지급 예정일 임박" });
  return a;
}
export function funding(p: ProposalInput) {
  return [
    ...new Set(p.payments.flatMap((x) => x.allocations.map((a) => a.source))),
  ];
}
