import React, { useEffect, useState } from "react";
import {
  Building2,
  ShoppingBasket,
  Wallet,
  CalendarClock,
  ClipboardList,
  Search,
  LayoutDashboard,
  Settings,
  Star,
  Plus,
  Download,
  ArrowRight,
  ShieldCheck,
} from "lucide-react";
import { api, save, download, type User } from "./api.ts";
import {
  koreanDay,
  koreanDate,
  statuses,
  paymentStatuses,
  generatePlan,
  recommendTemplate,
  generatePurpose,
  totals,
  cardAlert,
  dailyReport,
  type Kind,
  type Facility,
  type Purchase,
  type Project,
  type OfficePayment,
  type OfficeRecord,
  type Activity,
} from "../shared/office.ts";
import "./office.css";
export const officeNav = [
  ["office-dashboard", "통합 대시보드", LayoutDashboard],
  ["facilities", "시설 작업계획", Building2],
  ["purchases", "시설관리물품 구입", ShoppingBasket],
  ["projects", "지출사업 관리", Wallet],
  ["vendors", "업체별 지급관리", ClipboardList],
  ["deadlines", "카드결제 기한관리", CalendarClock],
  ["activities", "오늘 한 일", ClipboardList],
  ["search", "업무 통합검색", Search],
  ["office-settings", "통합 설정·백업", Settings],
] as const;
export type OfficeView = (typeof officeNav)[number][0];
type Row = OfficeRecord<any>;
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const budgetNames = { school: "학교 자체예산", grant: "지원금", other: "기타" };
const emptyPayment = (): OfficePayment => ({
  id: crypto.randomUUID(),
  vendor: "",
  name: "",
  method: "card",
  expectedAmount: 0,
  actualAmount: null,
  obligationDate: "",
  expenditureDate: "",
  dueDate: "",
  scheduledDate: "",
  cardApprovedDate: "",
  actualPaymentDate: "",
  status: "지급 예정",
  notes: "",
});
const fresh = (kind: Kind): any =>
  kind === "facilities"
    ? {
        title: "",
        location: "",
        condition: "",
        impact: "",
        action: "",
        content: "",
        plannedDate: "",
        vendor: "",
        expectedAmount: 0,
        completedAt: "",
        status: "계획",
        notes: "",
        favorite: false,
      }
    : kind === "purchases"
      ? {
          title: "",
          plannedDate: koreanDay(),
          status: "계획",
          notes: "",
          favorite: false,
          items: [
            {
              id: crypto.randomUUID(),
              name: "",
              specification: "",
              quantity: 1,
              unitPrice: 0,
              purpose: "",
              location: "",
              notes: "",
            },
          ],
        }
      : {
          title: "",
          department: "",
          budgetType: "school",
          approvedAmount: 0,
          approvalDate: koreanDay(),
          approvalCompletedAt: "",
          status: "계획",
          notes: "",
          favorite: false,
          payments: [],
        };
function Field({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  options,
}: {
  label: string;
  value: any;
  onChange: (v: any) => void;
  type?: string;
  required?: boolean;
  options?: readonly string[];
}) {
  return (
    <label className="os-field">
      <span>
        {label}
        {required ? " *" : ""}
      </span>
      {options ? (
        <select
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      ) : type === "textarea" ? (
        <textarea
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
        />
      ) : (
        <input
          type={type}
          required={required}
          value={value ?? ""}
          min={type === "number" ? 0 : undefined}
          step={type === "number" ? 1 : undefined}
          onChange={(e) =>
            onChange(
              type === "number"
                ? e.target.value === ""
                  ? null
                  : Number(e.target.value)
                : e.target.value,
            )
          }
        />
      )}
    </label>
  );
}
function Tone({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function OfficeWorkspace({
  view,
  onView,
  user,
}: {
  view: OfficeView;
  onView: (v: OfficeView) => void;
  user: User;
}) {
  const [data, setData] = useState<{
    facilities: Row[];
    purchases: Row[];
    projects: Row[];
    templates: Row[];
    vendors: Row[];
    reports: Row[];
  }>({
    facilities: [],
    purchases: [],
    projects: [],
    templates: [],
    vendors: [],
    reports: [],
  });
  const [logs, setLogs] = useState<Activity[]>([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
    [method, setMethod] = useState(""),
    [budget, setBudget] = useState(""),
    [sort, setSort] = useState("created"),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [favorites, setFavorites] = useState(false),
    [payFilter, setPayFilter] = useState("");
  const [editing, setEditing] = useState<{
      kind: Kind;
      value: any;
      draftKey: string;
    } | null>(null),
    [reportDay, setReportDay] = useState(koreanDay()),
    [report, setReport] = useState(""),
    [reportEdited, setReportEdited] = useState(false),
    [snapshots, setSnapshots] = useState<any[]>([]);
  async function refresh() {
    const kinds = [
      "facilities",
      "purchases",
      "projects",
      "templates",
      "vendors",
      "reports",
    ] as const;
    const rows = await Promise.all(
      kinds.map((k) => api<Row[]>(`/office/${k}`)),
    );
    setData(
      Object.fromEntries(kinds.map((k, i) => [k, rows[i]])) as typeof data,
    );
    setLogs(await api<Activity[]>("/office/activities"));
    setLoaded(true);
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    setQuery("");
    setStatus("");
    setMethod("");
    setBudget("");
    setFrom("");
    setTo("");
    setPayFilter("");
    setFavorites(false);
  }, [view]);
  useEffect(() => {
    if (!reportEdited)
      setReport(
        data.reports.find((x) => x.date === reportDay)?.content ||
          dailyReport(logs, reportDay),
      );
  }, [logs, reportDay, data.reports, reportEdited]);
  async function run(fn: () => Promise<unknown>, message = "저장했습니다") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
      setNotice(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function open(kind: Kind, value?: Row) {
    const draftKey = `office-draft:${user.id}:${kind}:${value?.id || "new"}`;
    let draft: any = null;
    try {
      draft = JSON.parse(localStorage.getItem(draftKey) || "null");
    } catch {}
    setEditing({
      kind,
      value:
        draft ||
        structuredClone(
          value || { ...fresh(kind), requestId: crypto.randomUUID() },
        ),
      draftKey,
    });
    if (draft)
      setNotice(
        "이 기기에 저장된 입력 초안을 복구했습니다. 최신 자료와 비교한 뒤 저장하세요.",
      );
  }
  function change(value: any) {
    if (!editing) return;
    setEditing({ ...editing, value });
    try {
      localStorage.setItem(editing.draftKey, JSON.stringify(value));
    } catch {
      setError("이 기기의 초안 저장 공간이 부족합니다. 서버에 저장하세요.");
    }
  }
  async function persist(kind: Kind, value: any) {
    return save(
      `/office/${kind}${value.id ? "/" + value.id : ""}`,
      value,
      value.id ? "PUT" : "POST",
    );
  }
  async function writeTemplate(type: string, title: string, content: string) {
    const old = data.templates.find(
      (x) => x.type === type && x.title === title,
    );
    await persist("templates", { ...old, title, type, content });
  }
  const projects = data.projects as OfficeRecord<Project>[],
    facilities = data.facilities as OfficeRecord<Facility>[],
    purchases = data.purchases as OfficeRecord<Purchase>[];
  const payments = projects.flatMap((project) =>
    project.payments.map((payment) => ({
      project,
      payment,
      alert: cardAlert(payment),
    })),
  );
  const urgent = payments
    .filter((x) => x.alert && x.alert.priority < 3)
    .sort((a, b) => a.alert!.remaining - b.alert!.remaining);
  const totalActive = projects.filter(
    (x) => !["완료", "취소"].includes(x.status),
  );
  const todayLogs = logs.filter(
    (x) => koreanDate(x.created_at) === koreanDay(),
  );
  const canWrite = user.role !== "viewer";
  const filterRow = (x: Row) =>
    [
      x.title,
      x.name,
      x.notes,
      ...(x.items || []).map((i: any) => i.name),
      ...(x.payments || []).map((p: any) => p.vendor),
    ]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase()) &&
    (!status || x.status === status) &&
    (!favorites || x.favorite) &&
    (!from ||
      (x.plannedDate || x.approvalDate || x.createdAt.slice(0, 10)) >= from) &&
    (!to ||
      (x.plannedDate || x.approvalDate || x.createdAt.slice(0, 10)) <= to) &&
    (!budget || x.budgetType === budget);
  const sortRows = (rows: Row[]) =>
    rows.filter(filterRow).sort((a, b) =>
      sort === "amount"
        ? amount(b) - amount(a)
        : sort === "due"
          ? (
              a.plannedDate ||
              a.payments
                ?.map((p: any) => p.dueDate)
                .filter(Boolean)
                .sort()[0] ||
              "9999"
            ).localeCompare(
              b.plannedDate ||
                b.payments
                  ?.map((p: any) => p.dueDate)
                  .filter(Boolean)
                  .sort()[0] ||
                "9999",
            )
          : b.createdAt.localeCompare(a.createdAt),
    );
  function amount(x: Row) {
    return (
      x.approvedAmount ??
      x.expectedAmount ??
      x.items?.reduce((s: number, i: any) => s + i.quantity * i.unitPrice, 0) ??
      0
    );
  }
  const visiblePayments = payments
    .filter(
      ({ project, payment, alert }) =>
        (view !== "deadlines" || payment.method === "card") &&
        `${project.title} ${payment.vendor} ${payment.name}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (!method || payment.method === method) &&
        (!budget || project.budgetType === budget) &&
        (!from || (payment.scheduledDate || project.approvalDate) >= from) &&
        (!to || (payment.scheduledDate || project.approvalDate) <= to) &&
        (!payFilter ||
          (payFilter === "unpaid" &&
            !["지급 완료", "취소"].includes(payment.status)) ||
          (payFilter === "paid" && payment.status === "지급 완료") ||
          (payFilter === "pending" && payment.status === "지급 예정") ||
          (payFilter === "resolution" &&
            !payment.expenditureDate &&
            payment.status !== "취소") ||
          (payFilter === "urgent" && alert && alert.priority < 3) ||
          (payFilter === "cancelled" && payment.status === "취소")),
    )
    .sort((a, b) =>
      view === "deadlines"
        ? (a.alert?.remaining ?? 999999) - (b.alert?.remaining ?? 999999)
        : sort === "amount"
          ? b.payment.expectedAmount - a.payment.expectedAmount
          : sort === "due"
            ? (a.payment.dueDate || "9999").localeCompare(
                b.payment.dueDate || "9999",
              )
            : b.project.createdAt.localeCompare(a.project.createdAt),
    );
  async function excel(name: string, rows: Record<string, unknown>[]) {
    const { default: ExcelJS } = await import("exceljs");
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("업무대장");
    const keys = Object.keys(rows[0] || { "자료 없음": "" });
    sheet.columns = keys.map((k) => ({ header: k, key: k, width: 22 }));
    for (const row of rows) sheet.addRow(row);
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    const buffer = await book.xlsx.writeBuffer();
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(buffer)], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}-${koreanDay()}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function exportCurrent() {
    if (view === "vendors" || view === "deadlines")
      return excel(
        view === "vendors" ? "업체별 지급관리대장" : "카드결제 기한관리대장",
        visiblePayments.map(({ project: p, payment: x }) => ({
          사업명: p.title,
          업체명: x.vendor,
          "예산 구분": budgetNames[p.budgetType],
          "지급 건명": x.name,
          결제방식: x.method === "card" ? "카드결제" : "계좌이체",
          예정금액: x.expectedAmount,
          실제금액: x.actualAmount ?? "",
          원인행위: x.obligationDate,
          지출결의: x.expenditureDate,
          지급상태: x.status,
          처리기한: x.dueDate,
          "실제 지급일": x.actualPaymentDate,
        })),
      );
    if (view === "activities")
      return excel(
        "오늘 한 일",
        logs
          .filter((x) => koreanDate(x.created_at) === reportDay)
          .map((x) => ({
            일시: new Date(x.created_at).toLocaleString("ko-KR", {
              timeZone: "Asia/Seoul",
            }),
            구분: x.entity_type,
            제목: x.title,
            처리내역: x.description,
          })),
      );
    const kind =
      view === "facilities"
        ? "facilities"
        : view === "purchases"
          ? "purchases"
          : "projects";
    return excel(
      "학교 업무대장",
      sortRows(data[kind]).flatMap((x) =>
        kind === "purchases"
          ? x.items.map((i: any) => ({
              업무명: x.title,
              물품명: i.name,
              규격: i.specification,
              수량: i.quantity,
              단가: i.unitPrice,
              합계: i.quantity * i.unitPrice,
              용도: i.purpose,
              상태: x.status,
            }))
          : kind === "facilities"
            ? [
                {
                  작업명: x.title,
                  장소: x.location,
                  작업내용: x.content,
                  예정일: x.plannedDate,
                  업체: x.vendor,
                  예상금액: x.expectedAmount,
                  상태: x.status,
                },
              ]
            : [
                {
                  사업명: x.title,
                  부서: x.department,
                  예산: x.budgetType,
                  품의액: x.approvedAmount,
                  예정액: totals(x).expected,
                  실제액: totals(x).actual,
                  상태: x.status,
                },
              ],
      ),
    );
  }
  async function copy(content: string) {
    try {
      await navigator.clipboard.writeText(content);
      setNotice("전체 내용을 복사했습니다");
    } catch {
      setError(
        "자동 복사를 허용하지 않는 브라우저입니다. 내용을 선택해 복사하세요.",
      );
    }
  }
  function filters() {
    return (
      <div className="os-filters">
        <Field
          label="업무·사업·업체·물품 검색"
          value={query}
          onChange={setQuery}
        />
        <Field label="시작일" type="date" value={from} onChange={setFrom} />
        <Field label="종료일" type="date" value={to} onChange={setTo} />
        <label className="os-field">
          <span>정렬</span>
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="created">최근 등록순</option>
            <option value="amount">금액 큰 순</option>
            <option value="due">처리기한순</option>
          </select>
        </label>
        {["facilities", "purchases", "projects", "search"].includes(view) && (
          <>
            <Field
              label="상태"
              value={status}
              onChange={setStatus}
              options={["", ...statuses]}
            />
            <label>
              <input
                type="checkbox"
                checked={favorites}
                onChange={(e) => setFavorites(e.target.checked)}
              />{" "}
              즐겨찾기만
            </label>
          </>
        )}
        {["projects", "vendors", "deadlines"].includes(view) && (
          <label className="os-field">
            <span>예산 구분</span>
            <select value={budget} onChange={(e) => setBudget(e.target.value)}>
              <option value="">전체</option>
              {Object.entries(budgetNames).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        )}
        {["vendors", "deadlines"].includes(view) && (
          <>
            <label className="os-field">
              <span>결제 방식</span>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
              >
                <option value="">전체</option>
                <option value="card">카드결제</option>
                <option value="transfer">계좌이체</option>
              </select>
            </label>
            <label className="os-field">
              <span>지급 필터</span>
              <select
                value={payFilter}
                onChange={(e) => setPayFilter(e.target.value)}
              >
                <option value="">전체</option>
                <option value="pending">지급 예정</option>
                <option value="paid">지급 완료</option>
                <option value="unpaid">미지급</option>
                <option value="resolution">지출결의 미완료</option>
                <option value="urgent">기한 임박·초과</option>
                <option value="cancelled">취소</option>
              </select>
            </label>
          </>
        )}
      </div>
    );
  }
  const fields = (
    value: any,
    set: (v: any) => void,
    defs: [string, string, string?][],
  ) =>
    defs.map(([key, label, type]) => (
      <Field
        key={key}
        label={label}
        value={value[key]}
        type={type}
        onChange={(v) => set({ ...value, [key]: v })}
      />
    ));
  return (
    <section className="office-workspace">
      <div className="os-toolbar">
        <p>
          <ShieldCheck size={16} /> 학교 행정업무 · 한국시간 기준 · 무료 문구
          생성
        </p>
        <div>
          <button
            onClick={() =>
              refresh()
                .then(() => setNotice("최신 자료를 불러왔습니다"))
                .catch((e) => setError(e.message))
            }
          >
            새로고침
          </button>
          {!["office-dashboard", "office-settings", "search"].includes(
            view,
          ) && (
            <button
              onClick={() => exportCurrent().catch((e) => setError(e.message))}
            >
              <Download size={15} /> Excel 다운로드
            </button>
          )}
          {canWrite &&
            ["facilities", "purchases", "projects"].includes(view) && (
              <button className="primary" onClick={() => open(view as Kind)}>
                <Plus size={16} />
                {view === "facilities"
                  ? "작업계획 작성"
                  : view === "purchases"
                    ? "구입 업무 등록"
                    : "신규 사업 등록"}
              </button>
            )}
        </div>
      </div>
      {error && (
        <div role="alert" className="os-error">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="os-notice">
          {notice}
        </div>
      )}
      {!loaded && !error && <p>업무 자료를 불러오는 중입니다…</p>}
      {view === "office-dashboard" && (
        <>
          <div className="os-hero">
            <div>
              <span className="eyebrow">SCHOOL OFFICE OS</span>
              <h2>시설부터 지출까지, 오늘의 업무를 한곳에서</h2>
              <p>처리기한과 업체별 진행상황을 확인하고 업무를 이어가세요.</p>
            </div>
            <Building2 size={64} />
          </div>
          <div className="os-metrics">
            {[
              [
                "진행 중 시설업무",
                facilities.filter((x) => x.status === "진행 중").length,
                "facilities",
              ],
              [
                "미완료 시설업무",
                facilities.filter((x) => !["완료", "취소"].includes(x.status))
                  .length,
                "facilities",
              ],
              ["진행 중 지출사업", totalActive.length, "projects"],
              [
                "품의 미완료",
                totalActive.filter((x) => !x.approvalCompletedAt).length,
                "projects",
              ],
              [
                "원인행위 미완료",
                payments.filter(
                  (x) =>
                    !x.payment.obligationDate && x.payment.status !== "취소",
                ).length,
                "vendors",
              ],
              [
                "지출결의 미완료",
                payments.filter(
                  (x) =>
                    !x.payment.expenditureDate && x.payment.status !== "취소",
                ).length,
                "vendors",
              ],
              [
                "대금 지급 예정",
                payments.filter(
                  (x) => !["지급 완료", "취소"].includes(x.payment.status),
                ).length,
                "vendors",
              ],
              [
                "카드기한 임박",
                urgent.filter((x) => x.alert!.remaining >= 0).length,
                "deadlines",
              ],
              [
                "기한 초과",
                urgent.filter((x) => x.alert!.remaining < 0).length,
                "deadlines",
              ],
              [
                "오늘 처리한 업무",
                todayLogs.filter((x) =>
                  ["facilities", "purchases", "projects", "legacy"].includes(
                    x.entity_type,
                  ),
                ).length,
                "activities",
              ],
            ].map(([label, count, target]) => (
              <button key={label} onClick={() => onView(target as OfficeView)}>
                <span>{label}</span>
                <strong>
                  {count}
                  <small>건</small>
                </strong>
                <ArrowRight size={17} />
              </button>
            ))}
          </div>
          <div className="os-two">
            <article className="os-panel">
              <h3>우선 확인할 카드결제</h3>
              {urgent.slice(0, 8).map(({ project, payment, alert }) => (
                <button
                  className="os-task"
                  key={payment.id}
                  onClick={() => open("projects", project)}
                >
                  <Tone tone={alert!.priority <= 1 ? "red" : "orange"}>
                    {alert!.label}
                  </Tone>
                  <b>{project.title}</b>
                  <span>
                    {payment.vendor} · {won(payment.expectedAmount)}
                  </span>
                  <small>
                    {payment.dueDate} · {alert!.remaining}일 · 지출결의{" "}
                    {payment.expenditureDate ? "완료" : "미완료"}
                  </small>
                </button>
              ))}
              {!urgent.length && (
                <p className="os-empty">
                  임박하거나 초과한 카드기한이 없습니다.
                </p>
              )}
            </article>
            <article className="os-panel">
              <h3>최근 등록한 업무</h3>
              {[
                ...facilities.map((x) => ({
                  ...x,
                  kind: "facilities" as Kind,
                })),
                ...purchases.map((x) => ({ ...x, kind: "purchases" as Kind })),
                ...projects.map((x) => ({ ...x, kind: "projects" as Kind })),
              ]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .slice(0, 8)
                .map((x) => (
                  <button
                    className="os-task"
                    key={x.id}
                    onClick={() => open(x.kind, x)}
                  >
                    <b>{x.title}</b>
                    <span>
                      {x.status} · {koreanDate(x.createdAt)}
                    </span>
                  </button>
                ))}
            </article>
          </div>
        </>
      )}
      {["facilities", "purchases", "projects", "search"].includes(view) && (
        <>
          {filters()}
          {(view === "search"
            ? ["facilities", "purchases", "projects"]
            : [view]
          ).map((k) => {
            const kind = k as "facilities" | "purchases" | "projects",
              rows = sortRows(data[kind]);
            return (
              <article key={k} className="os-panel">
                <h3>
                  {kind === "facilities"
                    ? "시설업무 관리대장"
                    : kind === "purchases"
                      ? "시설관리물품 구입내역"
                      : "사업별 지출관리대장"}{" "}
                  <small>{rows.length}건</small>
                </h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>중요</th>
                        <th>업무명</th>
                        <th>
                          {kind === "facilities"
                            ? "작업 장소"
                            : kind === "purchases"
                              ? "품목 수"
                              : "예산 구분"}
                        </th>
                        <th>예정·품의금액</th>
                        <th>상태</th>
                        <th>예정·품의일</th>
                        <th>처리</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((x) => (
                        <tr key={x.id}>
                          <td>
                            <button
                              aria-label={`${x.title} 즐겨찾기`}
                              disabled={!canWrite || busy}
                              onClick={() =>
                                run(() =>
                                  persist(kind, {
                                    ...x,
                                    favorite: !x.favorite,
                                  }),
                                )
                              }
                            >
                              <Star
                                size={16}
                                fill={x.favorite ? "#e9b84b" : "none"}
                              />
                            </button>
                          </td>
                          <td>
                            <button
                              className="text-button"
                              onClick={() => open(kind, x)}
                            >
                              {x.title}
                            </button>
                            {kind === "projects" && (
                              <small className="os-block">
                                원인행위 {totals(x).obligation}/
                                {totals(x).count} · 지출결의{" "}
                                {totals(x).expenditure}/{totals(x).count}건 완료
                              </small>
                            )}
                          </td>
                          <td>
                            {kind === "facilities" ? (
                              x.location
                            ) : kind === "purchases" ? (
                              `${x.items.length}개`
                            ) : (
                              <Tone
                                tone={
                                  x.budgetType === "school"
                                    ? "blue"
                                    : x.budgetType === "grant"
                                      ? "purple"
                                      : "neutral"
                                }
                              >
                                {
                                  budgetNames[
                                    x.budgetType as keyof typeof budgetNames
                                  ]
                                }
                              </Tone>
                            )}
                          </td>
                          <td>{won(amount(x))}</td>
                          <td>
                            <Tone
                              tone={
                                x.status === "완료"
                                  ? "green"
                                  : x.status === "진행 중"
                                    ? "blue"
                                    : "neutral"
                              }
                            >
                              {x.status}
                            </Tone>
                          </td>
                          <td>{x.plannedDate || x.approvalDate || "미정"}</td>
                          <td>
                            <button onClick={() => open(kind, x)}>
                              상세보기
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!rows.length && (
                  <p className="os-empty">
                    등록된 업무가 없습니다. 새 업무를 등록하거나 검색 조건을
                    바꾸세요.
                  </p>
                )}
              </article>
            );
          })}
        </>
      )}
      {["vendors", "deadlines"].includes(view) && (
        <>
          {filters()}
          <div className="os-summary">
            {(() => {
              const active = visiblePayments.filter(
                (x) => x.payment.status !== "취소",
              );
              return [
                [
                  "예정 합계",
                  active.reduce((s, x) => s + x.payment.expectedAmount, 0),
                ],
                [
                  "실제 합계",
                  active.reduce((s, x) => s + (x.payment.actualAmount ?? 0), 0),
                ],
                [
                  "카드결제",
                  active
                    .filter((x) => x.payment.method === "card")
                    .reduce((s, x) => s + x.payment.expectedAmount, 0),
                ],
                [
                  "계좌이체",
                  active
                    .filter((x) => x.payment.method === "transfer")
                    .reduce((s, x) => s + x.payment.expectedAmount, 0),
                ],
                [
                  "미지급 잔액",
                  active
                    .filter((x) => x.payment.status !== "지급 완료")
                    .reduce(
                      (s, x) =>
                        s +
                        Math.max(
                          0,
                          x.payment.expectedAmount -
                            (x.payment.actualAmount ?? 0),
                        ),
                      0,
                    ),
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <small>{label}</small>
                  <b>{won(Number(value))}</b>
                </div>
              ));
            })()}
          </div>
          <article className="os-panel">
            <h3>
              {view === "vendors" ? "업체별 결제·지급 건" : "카드결제 처리기한"}{" "}
              <small>{visiblePayments.length}건</small>
            </h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {[
                      "업체명 / 사업명",
                      "예산",
                      "결제방식",
                      "예정액",
                      "실제 지급액",
                      "원인행위",
                      "지출결의",
                      "지급상태",
                      "처리기한",
                    ].map((x) => (
                      <th key={x}>{x}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visiblePayments.map(({ project: p, payment: x, alert }) => (
                    <tr key={x.id}>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => open("projects", p)}
                        >
                          {x.vendor}
                        </button>
                        <small className="os-block">
                          {p.title} / {x.name}
                        </small>
                      </td>
                      <td>{budgetNames[p.budgetType]}</td>
                      <td>{x.method === "card" ? "카드결제" : "계좌이체"}</td>
                      <td>{won(x.expectedAmount)}</td>
                      <td>
                        {x.actualAmount === null
                          ? "미입력"
                          : won(x.actualAmount)}
                      </td>
                      <td>{x.obligationDate || "미완료"}</td>
                      <td>{x.expenditureDate || "미완료"}</td>
                      <td>{x.status}</td>
                      <td>
                        {x.dueDate || "미정"}
                        {alert && (
                          <>
                            <br />
                            <Tone
                              tone={
                                alert.priority <= 1
                                  ? "red"
                                  : alert.priority === 2
                                    ? "orange"
                                    : "neutral"
                              }
                            >
                              {alert.label} · {alert.remaining}일
                            </Tone>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!visiblePayments.length && (
              <p className="os-empty">조건에 맞는 지급 건이 없습니다.</p>
            )}
          </article>
          <article className="os-panel">
            <h3>업체별 기간 집계</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>업체</th>
                    <th>지급 건수</th>
                    <th>지급 예정액</th>
                    <th>실제 지급액</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ...new Set(visiblePayments.map((x) => x.payment.vendor)),
                  ].map((v) => {
                    const rows = visiblePayments.filter(
                      (x) =>
                        x.payment.vendor === v && x.payment.status !== "취소",
                    );
                    return (
                      <tr key={v}>
                        <td>
                          <button onClick={() => setQuery(v)}>{v}</button>
                        </td>
                        <td>{rows.length}</td>
                        <td>
                          {won(
                            rows.reduce(
                              (s, x) => s + x.payment.expectedAmount,
                              0,
                            ),
                          )}
                        </td>
                        <td>
                          {won(
                            rows.reduce(
                              (s, x) => s + (x.payment.actualAmount ?? 0),
                              0,
                            ),
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </article>
        </>
      )}
      {view === "activities" && (
        <>
          <div className="os-filters">
            <Field
              label="조회 날짜 (한국시간)"
              value={reportDay}
              type="date"
              onChange={(v) => {
                setReportEdited(false);
                setReportDay(v);
              }}
            />
            <button
              onClick={() => {
                setReportEdited(false);
                setReport(dailyReport(logs, reportDay));
              }}
            >
              보고서 다시 작성
            </button>
          </div>
          <div className="os-two">
            <article className="os-panel">
              <h3>{reportDay} 업무 활동</h3>
              {logs
                .filter((x) => koreanDate(x.created_at) === reportDay)
                .map((x) => (
                  <div key={x.id} className="os-log">
                    <time>
                      {new Date(x.created_at).toLocaleTimeString("ko-KR", {
                        timeZone: "Asia/Seoul",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                    <div>
                      <b>{x.title}</b>
                      <p>{x.description}</p>
                      <details>
                        <summary>변경 전·후 이력</summary>
                        <pre>{x.previous_value || "신규"}</pre>
                        <pre>{x.new_value || "삭제 또는 시스템 처리"}</pre>
                      </details>
                    </div>
                  </div>
                ))}
            </article>
            <article className="os-panel os-report">
              <h3>행정실 일일업무 처리현황</h3>
              <pre className="os-print-report">{report}</pre>
              <textarea
                aria-label="일일업무보고 내용"
                rows={24}
                value={report}
                onChange={(e) => {
                  setReportEdited(true);
                  setReport(e.target.value);
                }}
              />
              <div className="os-actions">
                <button onClick={() => copy(report)}>전체 복사</button>
                <button onClick={() => window.print()}>인쇄 / PDF 저장</button>
                <button
                  className="primary"
                  disabled={!canWrite || busy}
                  onClick={() =>
                    run(async () => {
                      const old = data.reports.find(
                        (x) => x.date === reportDay,
                      );
                      await persist("reports", {
                        ...old,
                        date: reportDay,
                        content: report,
                      });
                    }, "보고서를 저장했습니다")
                  }
                >
                  보고서 저장
                </button>
              </div>
            </article>
          </div>
        </>
      )}
      {view === "office-settings" && (
        <div className="os-two">
          <article className="os-panel">
            <h3>백업과 복원</h3>
            <p>
              통합 업무 자료·물품·지급 건·문구·보고서·활동 이력을 보관합니다.
              비밀번호와 세션은 포함하지 않습니다.
            </p>
            <div className="os-actions">
              <button
                disabled={user.role !== "admin"}
                onClick={() =>
                  download(
                    "/office/backup",
                    `school-office-${koreanDay()}.json`,
                  ).catch((e) => setError(e.message))
                }
              >
                업무 백업 다운로드
              </button>
              <label className="file-button">
                백업 복원
                <input
                  aria-label="통합 백업 복원 파일"
                  type="file"
                  accept=".json"
                  hidden
                  disabled={user.role !== "admin" || busy}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    if (file.size > 10 * 1024 * 1024) {
                      setError("복원 파일은 10MB 이하여야 합니다");
                      return;
                    }
                    if (
                      !confirm(
                        "현재 통합 업무 자료를 교체합니다. 계속하시겠습니까? 복원 전 스냅샷이 자동 생성됩니다.",
                      )
                    )
                      return;
                    await run(
                      async () =>
                        save("/office/restore", JSON.parse(await file.text())),
                      "백업을 복원했습니다",
                    );
                  }}
                />
              </label>
              <button
                disabled={user.role !== "admin"}
                onClick={() =>
                  api<any[]>("/office/snapshots")
                    .then(setSnapshots)
                    .catch((e) => setError(e.message))
                }
              >
                복원 전 스냅샷 조회
              </button>
            </div>
            {snapshots.map((x) => (
              <p key={x.id}>
                <button
                  onClick={() =>
                    download(
                      "/office/snapshots/" + x.id,
                      `school-office-recovery-${x.id}.json`,
                    ).catch((e) => setError(e.message))
                  }
                >
                  {x.created_at} 다운로드
                </button>
              </p>
            ))}
            <p className="os-hint">
              기존 지출 화면의 첨부·기존 품의는 기존 설정 화면에서 별도로
              백업합니다. 통합자료는 삭제 시 이력을 남기며, 복원 전 스냅샷을
              보관합니다.
            </p>
            {!import.meta.env.VITE_CLOUD && (
              <button
                disabled={user.role !== "admin" || busy}
                onClick={() =>
                  run(
                    () => save("/office/import-legacy", {}),
                    "기존 품의를 통합 지출사업으로 가져왔습니다. 이후 두 화면의 수정은 각각 관리됩니다.",
                  )
                }
              >
                기존 지출 품의 가져오기 (원본 유지)
              </button>
            )}
          </article>
          <article className="os-panel">
            <h3>문구·반복 업무 템플릿</h3>
            <p>저장한 작업내용과 물품 용도를 다음 입력 때 재사용합니다.</p>
            {data.templates.map((t) => (
              <div key={t.id} className="os-task">
                <b>{t.title}</b>
                <span>
                  {t.type === "purpose"
                    ? "물품 용도"
                    : t.type === "project"
                      ? "반복 지출사업"
                      : "시설 작업계획"}
                </span>
                <p>
                  {t.type === "project" ? "사업 입력 양식 저장됨" : t.content}
                </p>
                <button
                  disabled={!canWrite}
                  onClick={() => {
                    if (t.type === "project") {
                      try {
                        const value = JSON.parse(t.content);
                        value.payments = value.payments.map((p: any) => ({
                          ...p,
                          id: crypto.randomUUID(),
                          status: "지급 예정",
                          actualAmount: null,
                          actualPaymentDate: "",
                          obligationDate: "",
                          expenditureDate: "",
                          cardApprovedDate: "",
                        }));
                        setEditing({
                          kind: "projects",
                          value,
                          draftKey: `office-draft:${user.id}:projects:new`,
                        });
                      } catch {
                        setError("반복 업무 양식을 읽을 수 없습니다");
                      }
                    } else if (t.type === "facility") {
                      const value = {
                        ...fresh("facilities"),
                        title: t.title,
                        content: t.content,
                      };
                      setEditing({
                        kind: "facilities",
                        value,
                        draftKey: `office-draft:${user.id}:facilities:new`,
                      });
                    }
                  }}
                >
                  양식으로 새 업무 작성
                </button>
              </div>
            ))}
            <details>
              <summary>비밀번호 변경</summary>
              <PasswordChange onError={setError} />
            </details>
            <p className="os-hint">
              민감한 학교 자료를 외부 AI로 전송하지 않습니다. 로그인 없이 서버
              데이터에 접근할 수 없습니다. Cloudflare 배포 전
              BEGINNER_CLOUDFLARE_GUIDE.md의 무료 한도 및 학교 규정 점검 항목을
              확인하세요.
            </p>
          </article>
        </div>
      )}
      {editing && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="통합 업무 상세"
            className="os-editor"
          >
            <header>
              <div>
                <span className="eyebrow">SCHOOL OFFICE OS</span>
                <h2>
                  {editing.kind === "facilities"
                    ? "시설 작업계획"
                    : editing.kind === "purchases"
                      ? "시설관리물품 구입"
                      : "지출사업 상세"}
                </h2>
              </div>
              <button onClick={() => setEditing(null)}>닫기</button>
            </header>
            {error && (
              <div role="alert" className="os-error">
                {error}
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  await persist(editing.kind, editing.value);
                  localStorage.removeItem(editing.draftKey);
                  setEditing(null);
                });
              }}
            >
              <fieldset disabled={!canWrite || busy}>
                <div className="os-form-grid">
                  <Field
                    label={editing.kind === "projects" ? "사업명" : "업무명"}
                    required
                    value={editing.value.title}
                    onChange={(v) => change({ ...editing.value, title: v })}
                  />
                  <Field
                    label="상태"
                    value={editing.value.status}
                    options={statuses}
                    onChange={(v) =>
                      change({
                        ...editing.value,
                        status: v,
                        ...(editing.kind === "facilities" && v === "완료"
                          ? { completedAt: koreanDay() }
                          : {}),
                      })
                    }
                  />
                </div>
                {["facilities", "purchases"].includes(editing.kind) && (
                  <div className="os-actions">
                    <button
                      type="button"
                      onClick={() =>
                        change({ ...editing.value, status: "진행 중" })
                      }
                    >
                      진행 중 처리
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        change({
                          ...editing.value,
                          status: "완료",
                          ...(editing.kind === "facilities"
                            ? { completedAt: koreanDay() }
                            : {}),
                        })
                      }
                    >
                      완료 처리
                    </button>
                    <small>상태 변경 후 저장하세요.</small>
                  </div>
                )}
                {editing.kind === "facilities" && (
                  <>
                    <div className="os-form-grid">
                      {fields(editing.value, change, [
                        ["location", "작업 장소"],
                        ["condition", "확인된 현재 상태"],
                        ["impact", "영향·불편사항"],
                        ["action", "조치 내용"],
                        ["plannedDate", "작업 예정일", "date"],
                        ["vendor", "업체명"],
                        ["expectedAmount", "예상 금액", "number"],
                        ["completedAt", "완료일", "date"],
                      ])}
                    </div>
                    <div className="os-actions">
                      <button
                        type="button"
                        onClick={() => {
                          const old = recommendTemplate(
                            data.templates as any[],
                            "facility",
                            editing.value.title,
                          );
                          change({
                            ...editing.value,
                            content:
                              old?.content || generatePlan(editing.value),
                          });
                        }}
                      >
                        자동 작성
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          change({
                            ...editing.value,
                            content: generatePlan(editing.value),
                          })
                        }
                      >
                        다시 작성
                      </button>
                      <button
                        type="button"
                        onClick={() => copy(editing.value.content)}
                      >
                        전체 복사
                      </button>
                    </div>
                    <p className="os-hint">
                      미확인 파손·하자는 사실로 단정하지 않습니다. 현장 확인 후
                      아래 문구를 수정하세요.
                    </p>
                    <Field
                      label="작업내용 (직접 수정)"
                      type="textarea"
                      value={editing.value.content}
                      onChange={(v) => change({ ...editing.value, content: v })}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        run(
                          () =>
                            writeTemplate(
                              "facility",
                              editing.value.title,
                              editing.value.content,
                            ),
                          "최종 문구를 템플릿으로 저장했습니다",
                        )
                      }
                    >
                      수정한 문구 템플릿 저장
                    </button>
                  </>
                )}
                {editing.kind === "purchases" && (
                  <>
                    <Field
                      label="구입 예정일"
                      type="date"
                      value={editing.value.plannedDate}
                      onChange={(v) =>
                        change({ ...editing.value, plannedDate: v })
                      }
                    />
                    {editing.value.items.map((item: any, i: number) => {
                      const set = (v: any) =>
                        change({
                          ...editing.value,
                          items: editing.value.items.map((x: any, j: number) =>
                            i === j ? v : x,
                          ),
                        });
                      return (
                        <article className="os-payment" key={item.id}>
                          <h3>물품 {i + 1}</h3>
                          <div className="os-form-grid">
                            {fields(item, set, [
                              ["name", "물품명"],
                              ["specification", "규격"],
                              ["quantity", "수량", "number"],
                              ["unitPrice", "단가", "number"],
                              ["location", "사용 장소"],
                              ["notes", "물품 비고"],
                            ])}
                          </div>
                          <Field
                            label="구입 용도"
                            value={item.purpose}
                            onChange={(v) => set({ ...item, purpose: v })}
                          />
                          <p>
                            합계{" "}
                            <b>
                              {won(
                                (item.quantity || 0) * (item.unitPrice || 0),
                              )}
                            </b>
                          </p>
                          <div className="os-actions">
                            <button
                              type="button"
                              onClick={() => {
                                const old = data.templates.find(
                                  (t) =>
                                    t.type === "purpose" &&
                                    t.title === item.name,
                                );
                                set({
                                  ...item,
                                  purpose:
                                    old?.content ||
                                    generatePurpose(item.name, item.location),
                                });
                              }}
                            >
                              용도 자동 생성
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                run(
                                  () =>
                                    writeTemplate(
                                      "purpose",
                                      item.name,
                                      item.purpose,
                                    ),
                                  "물품 용도를 저장했습니다",
                                )
                              }
                            >
                              최종 용도 기억하기
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                change({
                                  ...editing.value,
                                  items: editing.value.items.filter(
                                    (x: any) => x.id !== item.id,
                                  ),
                                })
                              }
                            >
                              물품 삭제
                            </button>
                          </div>
                        </article>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() =>
                        change({
                          ...editing.value,
                          items: [
                            ...editing.value.items,
                            fresh("purchases").items[0],
                          ],
                        })
                      }
                    >
                      + 물품 추가
                    </button>
                    <h3>구입 합계 {won(amount(editing.value))}</h3>
                  </>
                )}
                {editing.kind === "projects" && (
                  <>
                    <div className="os-form-grid">
                      {fields(editing.value, change, [
                        ["department", "담당부서 (선택)"],
                        ["approvedAmount", "품의 금액", "number"],
                        ["approvalDate", "품의일", "date"],
                        ["approvalCompletedAt", "품의 결재 완료일", "date"],
                      ])}
                      <label className="os-field">
                        <span>예산 구분</span>
                        <select
                          value={editing.value.budgetType}
                          onChange={(e) =>
                            change({
                              ...editing.value,
                              budgetType: e.target.value,
                            })
                          }
                        >
                          {Object.entries(budgetNames).map(([k, v]) => (
                            <option key={k} value={k}>
                              {v}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="os-actions">
                      <button
                        type="button"
                        onClick={() =>
                          change({
                            ...editing.value,
                            approvalCompletedAt: editing.value
                              .approvalCompletedAt
                              ? ""
                              : koreanDay(),
                          })
                        }
                      >
                        {editing.value.approvalCompletedAt
                          ? "품의 완료 취소"
                          : "품의 완료"}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          run(
                            () =>
                              writeTemplate(
                                "project",
                                editing.value.title,
                                JSON.stringify({
                                  ...editing.value,
                                  id: undefined,
                                  version: undefined,
                                  legacyId: undefined,
                                }),
                              ),
                            "반복 사업 양식을 저장했습니다",
                          )
                        }
                      >
                        반복 업무 템플릿 저장
                      </button>
                    </div>
                    {(() => {
                      const t = totals(editing.value);
                      return (
                        <div className="os-project-summary">
                          <div className="os-summary-grid">
                            <span>
                              품의 금액{" "}
                              <b>{won(editing.value.approvedAmount || 0)}</b>
                            </span>
                            <span>
                              지급 예정 합계 <b>{won(t.expected)}</b>
                            </span>
                            <span>
                              실제 지급 합계 <b>{won(t.actual)}</b>
                            </span>
                            <span>
                              차액 <b>{won(t.difference)}</b>
                            </span>
                            <span>
                              지급 완료 금액 <b>{won(t.paid)}</b>
                            </span>
                            <span>
                              미지급 잔액 <b>{won(t.unpaid)}</b>
                            </span>
                            <span>
                              카드 예정액 <b>{won(t.card)}</b>
                            </span>
                            <span>
                              이체 예정액 <b>{won(t.transfer)}</b>
                            </span>
                          </div>
                          <p
                            className={
                              t.difference < 0
                                ? "os-error"
                                : t.difference > 0
                                  ? "os-warning"
                                  : "os-notice"
                            }
                          >
                            {t.difference < 0
                              ? "품의 금액 초과"
                              : t.difference > 0
                                ? "미배정 금액 있음"
                                : "금액 일치"}{" "}
                            · 금액 불일치도 저장할 수 있습니다.
                          </p>
                          <p>
                            원인행위 {t.obligation}/{t.count}건 완료 · 지출결의{" "}
                            {t.expenditure}/{t.count}건 완료{" "}
                            {t.count > 0 && t.expenditure === t.count
                              ? "(전체 완료)"
                              : t.expenditure > 0
                                ? "(부분 완료)"
                                : ""}
                          </p>
                        </div>
                      );
                    })()}
                    <p className="os-hint">
                      지출결의와 실제 지급은 별개입니다. 카드 승인일도 정산
                      지급일과 구분합니다. 취소 건은 활성 합계에서 제외합니다.
                    </p>
                    <datalist id="office-vendor-names">
                      {[
                        ...new Set([
                          ...data.vendors.map((v) => v.name),
                          ...payments.map((x) => x.payment.vendor),
                        ]),
                      ].map((v) => (
                        <option key={v} value={v} />
                      ))}
                    </datalist>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            {[
                              "업체명",
                              "결제방식",
                              "지급예정액",
                              "실제지급액",
                              "원인행위",
                              "지출결의",
                              "지급상태",
                            ].map((x) => (
                              <th key={x}>{x}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {editing.value.payments.map((p: OfficePayment) => (
                            <tr key={p.id}>
                              <td>{p.vendor || "미입력"}</td>
                              <td>{p.method === "card" ? "카드" : "이체"}</td>
                              <td>{won(p.expectedAmount || 0)}</td>
                              <td>
                                {p.actualAmount === null
                                  ? "미입력"
                                  : won(p.actualAmount)}
                              </td>
                              <td>{p.obligationDate || "미완료"}</td>
                              <td>{p.expenditureDate || "미완료"}</td>
                              <td>{p.status}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {editing.value.payments.map(
                      (p: OfficePayment, i: number) => {
                        const set = (v: OfficePayment) =>
                          change({
                            ...editing.value,
                            payments: editing.value.payments.map(
                              (x: OfficePayment, j: number) =>
                                i === j ? v : x,
                            ),
                          });
                        return (
                          <article className="os-payment" key={p.id}>
                            <h3>
                              결제·지급 건 {i + 1} · {p.vendor || "새 업체"}
                            </h3>
                            <div className="os-form-grid">
                              <label className="os-field">
                                <span>업체명 *</span>
                                <input
                                  list="office-vendor-names"
                                  required
                                  value={p.vendor}
                                  onChange={(e) =>
                                    set({ ...p, vendor: e.target.value })
                                  }
                                />
                              </label>
                              <label className="os-field">
                                <span>결제 방식</span>
                                <select
                                  aria-label="결제 방식"
                                  value={p.method}
                                  onChange={(e) =>
                                    set({
                                      ...p,
                                      method: e.target.value as
                                        "card" | "transfer",
                                    })
                                  }
                                >
                                  <option value="card">카드결제</option>
                                  <option value="transfer">계좌이체</option>
                                </select>
                              </label>
                              {fields(p, set, [
                                ["name", "결제·지급 건명"],
                                ["expectedAmount", "지급 예정금액", "number"],
                                [
                                  "actualAmount",
                                  "최종 실제 지급금액",
                                  "number",
                                ],
                                ["dueDate", "처리기한", "date"],
                              ])}
                            </div>
                            <details>
                              <summary>상세 날짜·비고 수정</summary>
                              <div className="os-form-grid">
                                {fields(p, set, [
                                  ["scheduledDate", "결제·지급 예정일", "date"],
                                  [
                                    "cardApprovedDate",
                                    "실제 카드 승인일",
                                    "date",
                                  ],
                                  [
                                    "actualPaymentDate",
                                    "실제 대금 지급일",
                                    "date",
                                  ],
                                  ["obligationDate", "원인행위 완료일", "date"],
                                  [
                                    "expenditureDate",
                                    "지출결의 완료일",
                                    "date",
                                  ],
                                  ["notes", "지급 건 비고"],
                                ])}
                              </div>
                            </details>
                            <Field
                              label="대금 지급 상태"
                              value={p.status}
                              options={paymentStatuses}
                              onChange={(v) => set({ ...p, status: v })}
                            />
                            <div className="os-actions">
                              <button
                                type="button"
                                onClick={() =>
                                  set({
                                    ...p,
                                    obligationDate: p.obligationDate
                                      ? ""
                                      : koreanDay(),
                                  })
                                }
                              >
                                {p.obligationDate
                                  ? "원인행위 완료 취소"
                                  : "원인행위 완료"}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  set({
                                    ...p,
                                    expenditureDate: p.expenditureDate
                                      ? ""
                                      : koreanDay(),
                                  })
                                }
                              >
                                {p.expenditureDate
                                  ? "지출결의 완료 취소"
                                  : "지출결의 완료"}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (p.status === "지급 완료")
                                    set({
                                      ...p,
                                      status: "지급 예정",
                                      actualPaymentDate: "",
                                    });
                                  else if (p.actualAmount === null)
                                    setError(
                                      "실제 지급금액을 직접 입력한 뒤 지급 완료를 선택하세요",
                                    );
                                  else
                                    set({
                                      ...p,
                                      status: "지급 완료",
                                      actualPaymentDate:
                                        p.actualPaymentDate || koreanDay(),
                                    });
                                }}
                              >
                                {p.status === "지급 완료"
                                  ? "지급 완료 취소"
                                  : "지급 완료"}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (
                                    confirm(
                                      "이 지급 건을 삭제할까요? 저장 시 삭제 이력이 남습니다.",
                                    )
                                  )
                                    change({
                                      ...editing.value,
                                      payments: editing.value.payments.filter(
                                        (x: OfficePayment) => x.id !== p.id,
                                      ),
                                    });
                                }}
                              >
                                지급 건 삭제
                              </button>
                            </div>
                          </article>
                        );
                      },
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        change({
                          ...editing.value,
                          payments: [...editing.value.payments, emptyPayment()],
                        })
                      }
                    >
                      + 결제·지급 건 추가
                    </button>
                  </>
                )}
                <Field
                  label="비고"
                  type="textarea"
                  value={editing.value.notes}
                  onChange={(v) => change({ ...editing.value, notes: v })}
                />
                <div className="os-actions">
                  <button type="submit" className="primary">
                    저장
                  </button>
                  {editing.value.id && user.role === "admin" && (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        if (
                          confirm(
                            "이 업무를 삭제하시겠습니까? 변경 이력은 보존합니다.",
                          )
                        )
                          run(async () => {
                            await save(
                              `/office/${editing.kind}/${editing.value.id}`,
                              { version: editing.value.version },
                              "DELETE",
                            );
                            localStorage.removeItem(editing.draftKey);
                            setEditing(null);
                          }, "삭제했습니다");
                      }}
                    >
                      삭제
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      localStorage.removeItem(editing.draftKey);
                      setEditing(null);
                    }}
                  >
                    초안 버리기
                  </button>
                </div>
              </fieldset>
            </form>
            {editing.value.id && (
              <details>
                <summary>이 업무 변경 이력</summary>
                {logs
                  .filter((x) => x.entity_id === editing.value.id)
                  .map((x) => (
                    <p key={x.id}>
                      {new Date(x.created_at).toLocaleString("ko-KR", {
                        timeZone: "Asia/Seoul",
                      })}{" "}
                      · {x.description}
                    </p>
                  ))}
              </details>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
function PasswordChange({ onError }: { onError: (s: string) => void }) {
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await save("/password", { current, next });
          location.reload();
        } catch (e) {
          onError((e as Error).message);
        }
      }}
    >
      <Field
        label="현재 비밀번호"
        type="password"
        value={current}
        onChange={setCurrent}
      />
      <Field
        label="새 비밀번호 (12자 이상)"
        type="password"
        value={next}
        onChange={setNext}
      />
      <button>비밀번호 변경 후 다시 로그인</button>
    </form>
  );
}
