import { z } from "zod";
export const koreanDay = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      !isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s,
    "올바른 날짜를 입력하세요",
  );
const day = z.union([date, z.literal("")]);
const text = z.string().max(4000);
export const money = z.number().int().min(0).max(1_000_000_000_000);
export const statuses = ["계획", "진행 중", "완료", "보류", "취소"] as const;
export const paymentStatuses = [
  "지급 예정",
  "처리 중",
  "지급 완료",
  "보류",
  "취소",
] as const;
const base = {
  title: z.string().trim().min(1).max(200),
  notes: text.default(""),
  favorite: z.boolean().default(false),
  status: z.enum(statuses).default("계획"),
};
export const facilitySchema = z.object({
  ...base,
  location: text.default(""),
  condition: text.default(""),
  impact: text.default(""),
  action: text.default(""),
  content: text.default(""),
  plannedDate: day.default(""),
  vendor: text.default(""),
  expectedAmount: money.default(0),
  completedAt: day.default(""),
});
export const itemSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    specification: text.default(""),
    quantity: z.number().int().positive().max(1_000_000),
    unitPrice: money,
    purpose: text,
    location: text.default(""),
    notes: text.default(""),
  })
  .refine(
    (x) =>
      Number.isSafeInteger(x.quantity * x.unitPrice) &&
      x.quantity * x.unitPrice <= 1_000_000_000_000,
    "물품 합계가 허용 금액을 초과합니다",
  );
export const purchaseSchema = z.object({
  ...base,
  plannedDate: day.default(""),
  items: z.array(itemSchema).min(1),
});
export const paymentSchema = z
  .object({
    id: z.string().uuid(),
    vendor: z.string().trim().min(1).max(200),
    name: text.default(""),
    method: z.enum(["card", "transfer"]),
    expectedAmount: money,
    actualAmount: money.nullable().default(null),
    obligationDate: day.default(""),
    expenditureDate: day.default(""),
    dueDate: day.default(""),
    scheduledDate: day.default(""),
    cardApprovedDate: day.default(""),
    actualPaymentDate: day.default(""),
    status: z.enum(paymentStatuses).default("지급 예정"),
    notes: text.default(""),
  })
  .superRefine((p, c) => {
    if (
      p.status === "지급 완료" &&
      (p.actualAmount === null || !p.actualPaymentDate)
    )
      c.addIssue({
        code: "custom",
        message: "지급 완료에는 실제 지급금액과 실제 지급일이 필요합니다",
      });
  });
export const projectSchema = z
  .object({
    ...base,
    department: text.default(""),
    budgetType: z.enum(["school", "grant", "other"]),
    approvedAmount: money,
    approvalDate: day,
    approvalCompletedAt: day.default(""),
    payments: z.array(paymentSchema),
    legacyId: z.string().optional(),
  })
  .superRefine((p, c) => {
    if (new Set(p.payments.map((x) => x.id)).size !== p.payments.length)
      c.addIssue({ code: "custom", message: "지급 건 식별자가 중복됩니다" });
    if (
      p.payments.reduce((s, x) => s + x.expectedAmount, 0) >
      Number.MAX_SAFE_INTEGER
    )
      c.addIssue({ code: "custom", message: "합계 금액이 너무 큽니다" });
  });
export const schemas = {
  facilities: facilitySchema,
  purchases: purchaseSchema,
  projects: projectSchema,
  vendors: z.object({
    name: z.string().trim().min(1).max(200),
    notes: text.default(""),
  }),
  templates: z.object({
    title: z.string().min(1).max(200),
    type: z.enum(["facility", "purpose", "project"]),
    content: text,
  }),
  reports: z.object({ date, content: z.string().max(50000) }),
  preferences: z.object({
    title: z.literal("preferences"),
    data: z.record(z.string(), z.union([z.string(), z.boolean()])),
  }),
};
export type Kind = keyof typeof schemas;
export type Facility = z.infer<typeof facilitySchema>;
export type Purchase = z.infer<typeof purchaseSchema>;
export type Project = z.infer<typeof projectSchema>;
export type OfficePayment = z.infer<typeof paymentSchema>;
export type RecordMeta = {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  userId: string;
};
export type OfficeRecord<T = Record<string, unknown>> = T & RecordMeta;
export type Activity = {
  id: string;
  user_id: string;
  entity_type: string;
  entity_id: string;
  action_type: string;
  title: string;
  description: string;
  previous_value: string | null;
  new_value: string | null;
  created_at: string;
};
export function totals(p: Project) {
  const active = p.payments.filter((x) => x.status !== "취소");
  const sum = (a: OfficePayment[], f: "expectedAmount" | "actualAmount") =>
    a.reduce((s, x) => s + (x[f] ?? 0), 0);
  const expected = sum(active, "expectedAmount"),
    actual = sum(active, "actualAmount");
  return {
    expected,
    actual,
    difference: p.approvedAmount - expected,
    paid: sum(
      active.filter((x) => x.status === "지급 완료"),
      "actualAmount",
    ),
    unpaid: active
      .filter((x) => x.status !== "지급 완료")
      .reduce(
        (s, x) => s + Math.max(0, x.expectedAmount - (x.actualAmount ?? 0)),
        0,
      ),
    card: sum(
      active.filter((x) => x.method === "card"),
      "expectedAmount",
    ),
    transfer: sum(
      active.filter((x) => x.method === "transfer"),
      "expectedAmount",
    ),
    obligation: active.filter((x) => x.obligationDate).length,
    expenditure: active.filter((x) => x.expenditureDate).length,
    count: active.length,
  };
}
export function cardAlert(p: OfficePayment, now = koreanDay()) {
  if (
    p.method !== "card" ||
    !p.dueDate ||
    p.status === "취소" ||
    (p.expenditureDate && p.status === "지급 완료")
  )
    return null;
  const remaining = Math.round(
    (Date.parse(p.dueDate) - Date.parse(now)) / 86400000,
  );
  return {
    remaining,
    label:
      remaining < 0
        ? "기한 초과"
        : remaining <= 3
          ? "긴급"
          : remaining <= 7
            ? "주의"
            : "정상",
    priority: remaining < 0 ? 0 : remaining <= 3 ? 1 : remaining <= 7 ? 2 : 3,
  };
}
export function generatePlan(
  input: Pick<
    Facility,
    "title" | "location" | "condition" | "impact" | "action"
  >,
) {
  const place = input.location.trim() || "해당 작업 장소";
  return [
    `1. ${input.condition.trim() || `${place}의 ${input.title} 관련 시설 상태와 작업 필요 여부를 현장 확인할 예정임`}.`,
    `2. ${input.impact.trim() || "확인 결과에 따라 안전 및 시설 이용에 미치는 영향을 검토하고 필요한 이용 안내를 실시하고자 함"}.`,
    `3. ${input.action.trim() || `${input.title}에 필요한 규격과 안전조치를 확인한 후 적정한 작업을 시행하여 시설을 유지·관리하고자 함`}.`,
  ].join("\n");
}
const purposes: [RegExp, string][] = [
  [/락스|표백제/, "기숙사 세면장 및 샤워장 청소·위생관리용"],
  [/실리콘/, "교내 창호 및 세면대 주변 틈새 보수용"],
  [/LED|전구|조명/i, "교내 노후 조명기구 교체 및 유지관리용"],
  [/트랩|배수구/, "교내 화장실 및 세면장 배수시설 보수용"],
  [/절연테이프/, "교내 전기설비의 안전한 유지보수 작업용"],
  [/장갑/, "교내 시설관리 작업 시 손 보호 및 안전관리용"],
  [/나사|피스|드라이버/, "교내 시설물 부품 고정 및 유지보수 작업용"],
];
export function generatePurpose(name: string, location = "") {
  return (
    purposes.find(([r]) => r.test(name))?.[1] ||
    `${location || "교내"} 시설물 유지관리 및 안전한 보수 작업용`
  );
}
export function describeChanges(kind: Kind, before: any, after: any): string[] {
  if (!after) return [`${before.title || before.name || before.date} 삭제`];
  if (!before)
    return [
      `${after.title || after.name || after.date} ${kind === "projects" ? "사업 등록" : kind === "purchases" ? "관리물품 구입 업무 등록" : kind === "facilities" ? "작업계획 등록" : "등록"}`,
    ];
  const actions: string[] = [];
  if (before.status !== after.status)
    actions.push(`상태 ${before.status} → ${after.status}`);
  if (kind === "projects") {
    if (before.approvalCompletedAt !== after.approvalCompletedAt)
      actions.push(`품의 ${after.approvalCompletedAt ? "완료" : "완료 취소"}`);
    for (const p of after.payments) {
      const old = before.payments.find((x: OfficePayment) => x.id === p.id);
      const prefix = `${p.vendor} ${p.expectedAmount.toLocaleString("ko-KR")}원`;
      if (!old) {
        actions.push(`${prefix} 지급 건 추가`);
        continue;
      }
      for (const [key, label] of [
        ["expectedAmount", "예정금액"],
        ["actualAmount", "실제 지급금액"],
        ["obligationDate", "원인행위"],
        ["expenditureDate", "지출결의"],
        ["status", "지급상태"],
        ["dueDate", "처리기한"],
        ["actualPaymentDate", "실제 지급일"],
        ["cardApprovedDate", "카드 승인일"],
      ] as const)
        if (old[key] !== p[key])
          actions.push(
            `${prefix} ${label}: ${old[key] ?? "미입력"} → ${p[key] ?? "미입력"}`,
          );
    }
    for (const p of before.payments)
      if (!after.payments.some((x: OfficePayment) => x.id === p.id))
        actions.push(
          `${p.vendor} ${p.expectedAmount.toLocaleString("ko-KR")}원 지급 건 삭제`,
        );
  }
  return actions.length ? actions : ["내용 수정"];
}
export function dailyReport(logs: Activity[], dateValue: string) {
  const list = logs.filter((x) => koreanDate(x.created_at) === dateValue);
  return (
    `행정실 일일업무 처리현황\n${dateValue}\n\n` +
    [
      ["시설관리업무", ["facilities", "purchases"]],
      ["지출업무", ["projects", "legacy"]],
      ["기타", ["reports", "templates", "preferences", "vendors", "backup"]],
    ]
      .map(
        ([label, kinds], i) =>
          `${i + 1}. ${label}\n` +
          list
            .filter((x) => (kinds as string[]).includes(x.entity_type))
            .map((x, j) => `  ${j + 1}. ${x.title} — ${x.description}`)
            .join("\n"),
      )
      .join("\n\n")
  );
}
export function koreanDate(iso: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export function recommendTemplate<
  T extends { title: string; type: string; content: string },
>(templates: T[], type: string, title: string): T | undefined {
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const key = normalize(title);
  if (key.length < 2) return undefined;
  const candidates = templates.filter((t) => t.type === type);
  const exact = candidates.find((t) => normalize(t.title) === key);
  if (exact) return exact;
  const grams = (s: string) =>
    new Set(
      Array.from({ length: Math.max(0, s.length - 1) }, (_, i) =>
        s.slice(i, i + 2),
      ),
    );
  const target = grams(key);
  return candidates
    .map((t) => {
      const other = grams(normalize(t.title));
      const overlap = [...target].filter((g) => other.has(g)).length;
      return {
        t,
        score: overlap / Math.max(1, new Set([...target, ...other]).size),
      };
    })
    .filter((x) => x.score >= 0.55)
    .sort((a, b) => b.score - a.score)[0]?.t;
}
