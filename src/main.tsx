import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { api, save, download, setCsrf, type User } from "./api.ts";
import {
  today,
  days,
  method,
  complete,
  paymentComplete,
  alerts,
  funding,
  stageDone,
  stageIds,
  stageLabels,
  evidenceReady,
  warnings,
  defaultSettings,
  type Proposal,
  type ProposalInput,
  type Payment,
  type Settings,
  type StageId,
} from "../server/domain.ts";
import "./style.css";
import { OfficeWorkspace, officeNav, type OfficeView } from "./office.tsx";
const won = (n: number) => new Intl.NumberFormat("ko-KR").format(n) + "원";
const methodName = {
  card: "카드결제",
  transfer: "계좌이체",
  mixed: "혼합결제",
};
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const roleName = { admin: "관리자", staff: "담당자", viewer: "조회자" };
function newPayment(): Payment {
  return {
    id: crypto.randomUUID(),
    method: "card",
    vendor: "",
    planned: 0,
    actual: null,
    due: "",
    resolutionDue: "",
    note: "",
    allocations: [
      {
        source: "school",
        project: "",
        agency: "",
        start: "",
        end: "",
        amount: 0,
      },
    ],
    documents: [
      { name: "영수증", required: true, received: false },
      { name: "거래명세서", required: true, received: false },
    ],
    stages: Object.fromEntries(
      stageIds.map((id) => [
        id,
        {
          done: id === "receipt",
          date: id === "receipt" ? today() : "",
          owner: id === "receipt" ? "접수 담당자" : "",
          note: "",
          document: "",
          group: "",
        },
      ]),
    ) as Payment["stages"],
  };
}
function newProposal(): ProposalInput {
  return {
    title: "",
    number: "",
    department: "",
    applicant: "",
    approved: today(),
    received: today(),
    total: 0,
    budget: "",
    due: "",
    note: "",
    adjustmentReason: "",
    payments: [newPayment()],
  };
}
type View =
  | "dashboard"
  | "list"
  | "calendar"
  | "stats"
  | "archive"
  | "settings"
  | OfficeView;
type Filter =
  | "all"
  | "commit"
  | "card"
  | "transfer"
  | "evidence"
  | "resolution"
  | "done"
  | "overdue"
  | "pending";
function matches(p: Proposal, f: Filter, s: Settings) {
  if (f === "all") return true;
  if (f === "done") return complete(p, s);
  if (f === "pending") return !complete(p, s);
  if (f === "overdue") return !complete(p, s) && !!p.due && p.due < today();
  if (f === "evidence") return p.payments.some((x) => !evidenceReady(x));
  if (f === "card" || f === "transfer")
    return p.payments.some((x) => x.method === f && !stageDone(x, "payment"));
  return p.payments.some((x) => !stageDone(x, f));
}
function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={"badge " + tone}>{children}</span>;
}
function Funding({ p }: { p: ProposalInput }) {
  return (
    <span className="badges">
      {funding(p).map((s) => (
        <Badge key={s} tone={s === "school" ? "blue" : "purple"}>
          {s === "school" ? "학교 자체예산" : "지원금"}
        </Badge>
      ))}
    </span>
  );
}
function App() {
  const [user, setUser] = useState<User | null>(null),
    [loaded, setLoaded] = useState(false),
    [proposals, setProposals] = useState<Proposal[]>([]),
    [settings, setSettings] = useState<Settings>(defaultSettings),
    [view, setView] = useState<View>("dashboard"),
    [filter, setFilter] = useState<Filter>("all"),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [editing, setEditing] = useState<Proposal | ProposalInput | null>(null),
    [busy, setBusy] = useState(false);
  const notify = (s: string) => {
    setMessage(s);
    setError("");
  };
  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));
  async function refresh() {
    const [p, s] = await Promise.all([
      api<Proposal[]>("/proposals"),
      api<Settings>("/settings"),
    ]);
    setProposals(p);
    setSettings(s);
  }
  useEffect(() => {
    api<{ user: User; csrf: string }>("/me")
      .then((x) => {
        setCsrf(x.csrf);
        setUser(x.user);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
    const expire = () => {
      setUser(null);
      setEditing(null);
      setProposals([]);
      setError("세션이 만료되었습니다. 다시 로그인하세요");
    };
    window.addEventListener("session-expired", expire);
    return () => window.removeEventListener("session-expired", expire);
  }, []);
  useEffect(() => {
    if (user) refresh().catch(fail);
  }, [user]);
  async function run(fn: () => Promise<unknown>, message = "저장했습니다") {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      await refresh();
      notify(message);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  const openFilter = (f: Filter) => {
    setFilter(f);
    setView("list");
  };
  if (!loaded)
    return <div className="loading">업무 환경을 확인하고 있습니다…</div>;
  if (!user)
    return (
      <Login
        onLogin={(x) => {
          setUser(x.user);
          setCsrf(x.csrf);
          setError("");
        }}
        error={error}
      />
    );
  const cards: {
    label: string;
    filter: Filter;
    count: number;
    unit: string;
    tone: string;
  }[] = [
    {
      label: "전체 품의",
      filter: "all",
      count: proposals.length,
      unit: "품의",
      tone: "blue",
    },
    {
      label: "원인행위 미처리",
      filter: "commit",
      count: proposals
        .flatMap((p) => p.payments)
        .filter((x) => !stageDone(x, "commit")).length,
      unit: "결제 항목",
      tone: "red",
    },
    {
      label: "카드결제 대기",
      filter: "card",
      count: proposals
        .flatMap((p) => p.payments)
        .filter((x) => x.method === "card" && !stageDone(x, "payment")).length,
      unit: "결제 항목",
      tone: "orange",
    },
    {
      label: "계좌이체 대기",
      filter: "transfer",
      count: proposals
        .flatMap((p) => p.payments)
        .filter((x) => x.method === "transfer" && !stageDone(x, "payment"))
        .length,
      unit: "결제 항목",
      tone: "orange",
    },
    {
      label: "증빙서류 미확보",
      filter: "evidence",
      count: proposals
        .flatMap((p) => p.payments)
        .filter((x) => !evidenceReady(x)).length,
      unit: "결제 항목",
      tone: "yellow",
    },
    {
      label: "지출결의 미처리",
      filter: "resolution",
      count: proposals
        .flatMap((p) => p.payments)
        .filter((x) => !stageDone(x, "resolution")).length,
      unit: "결제 항목",
      tone: "red",
    },
    {
      label: "최종 완료",
      filter: "done",
      count: proposals.filter((p) => complete(p, settings)).length,
      unit: "품의",
      tone: "green",
    },
    {
      label: "처리 기한 경과",
      filter: "overdue",
      count: proposals.filter((p) => matches(p, "overdue", settings)).length,
      unit: "품의",
      tone: "red",
    },
  ];
  const nav: [View, string, string][] = [
    ["dashboard", "◫", "업무 대시보드"],
    ...officeNav.map(
      ([key, label]) => [key, "▦", label] as [View, string, string],
    ),
    ["list", "☷", "지출업무 목록"],
    ["calendar", "▦", "업무 달력"],
    ["stats", "▥", "집행 통계"],
    ["archive", "▣", "완료 보관함"],
    ["settings", "⚙", "설정·사용자"],
  ];
  const tasks = proposals
    .map((p) => ({ p, reasons: alerts(p, settings) }))
    .filter((x) => x.reasons.length)
    .sort(
      (a, b) =>
        a.reasons[0].priority - b.reasons[0].priority ||
        a.p.due.localeCompare(b.p.due),
    );
  const pending = proposals.filter((p) => !complete(p, settings)).length;
  return (
    <div className="app">
      <aside>
        <div className="brand">
          <b>
            School<span> Office OS</span>
          </b>
          <small>한국디지털미디어고등학교</small>
        </div>
        <div className="workspace">
          행정실 업무공간 <span>INTERNAL</span>
        </div>
        <nav>
          {nav.map(([key, icon, label]) => (
            <button
              key={key}
              className={view === key ? "active" : ""}
              onClick={() => {
                setView(key);
                setFilter("all");
              }}
            >
              <i>{icon}</i>
              {label}
              {key === "list" && <small>{pending}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="school-mark">D</div>
          <p>
            지출업무 통합관리<small>품의 접수부터 지출 완료까지</small>
          </p>
          <span className="version">MVP v0.1</span>
        </div>
      </aside>
      <div className="main">
        <header>
          <span>
            행정지원 <span className="slash">/</span>{" "}
            {nav.find((n) => n[0] === view)?.[2]}
          </span>
          <div className="header-right">
            <span>
              {today()} ·{" "}
              {new Intl.DateTimeFormat("ko-KR", {
                weekday: "long",
                timeZone: "Asia/Seoul",
              }).format(new Date())}
            </span>
            <button
              className="notification"
              onClick={() => setView("dashboard")}
              aria-label="미처리 알림"
            >
              ♧ <b>{tasks.length}</b>
            </button>
            <span className="avatar">{user.name[0]}</span>
            <span>
              {user.name} <small>{roleName[user.role]}</small>
            </span>
            <button
              className="text-button"
              onClick={async () => {
                try {
                  await save("/logout", {});
                  setUser(null);
                  setProposals([]);
                  setMessage("");
                } catch (e) {
                  fail(e);
                }
              }}
            >
              로그아웃
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">SCHOOL EXPENSE MANAGEMENT</div>
              <h1>{nav.find((n) => n[0] === view)?.[2]}</h1>
              <p>
                {view === "dashboard"
                  ? "오늘의 업무를 확인하고, 빠짐없이 지출을 관리하세요."
                  : "학교 지출업무를 정확하고 편리하게 관리합니다."}
              </p>
            </div>
            <div className="actions">
              <button
                onClick={() =>
                  refresh()
                    .then(() => notify("최신 자료를 불러왔습니다"))
                    .catch(fail)
                }
              >
                ↻ 새로고침
              </button>
              {user.role !== "viewer" && (
                <button
                  className="primary"
                  onClick={() => setEditing(newProposal())}
                >
                  ＋ 품의 등록
                </button>
              )}
            </div>
          </div>
          {error && (
            <div className="notice error" role="alert">
              {error}
              <button onClick={() => setError("")}>닫기</button>
            </div>
          )}
          {message && (
            <div className="notice success" role="status">
              {message}
              <button onClick={() => setMessage("")}>닫기</button>
            </div>
          )}
          {view === "dashboard" && (
            <>
              <div className="welcome">
                <div>
                  <Badge tone="blue">업무 브리핑</Badge>
                  <h2>
                    {pending
                      ? `진행 중인 품의 ${pending}건을 확인해 주세요.`
                      : "새로운 업무를 시작할 준비가 되었습니다."}
                  </h2>
                  <p>혼합결제 품의는 결제 항목별로 처리 상태를 관리합니다.</p>
                </div>
                <div className="welcome-icon">
                  ▤<span>✓</span>
                </div>
              </div>
              <div className="metrics">
                {cards.map((c) => (
                  <button
                    className="metric"
                    key={c.filter}
                    onClick={() => openFilter(c.filter)}
                  >
                    <span>
                      {c.label}
                      <i className={c.tone}>↗</i>
                    </span>
                    <strong>
                      {c.count}
                      <small>건</small>
                    </strong>
                    <small>{c.unit} 기준</small>
                  </button>
                ))}
              </div>
              <div className="dashboard-grid">
                <section className="panel priority">
                  <div className="panel-title">
                    <div>
                      <h2>
                        오늘 처리할 업무{" "}
                        <Badge tone="red">{tasks.length}</Badge>
                      </h2>
                      <p>기한과 진행 상태를 기준으로 우선순위를 정리했어요.</p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => openFilter("pending")}
                    >
                      전체 보기 →
                    </button>
                  </div>
                  {tasks.length ? (
                    tasks.slice(0, 6).map(({ p, reasons }, i) => (
                      <button
                        className="task"
                        key={p.id}
                        onClick={() => setEditing(clone(p))}
                      >
                        <span
                          className={
                            "task-rank " +
                            (reasons[0].priority <= 2 ? "urgent" : "")
                          }
                        >
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <div>
                          <b>{p.title}</b>
                          <small>
                            {p.management} · {p.applicant} · {won(p.total)}
                          </small>
                          <div className="badges">
                            {reasons.map((r) => (
                              <Badge
                                key={r.message}
                                tone={
                                  r.priority <= 1 ||
                                  r.priority === 3 ||
                                  r.priority === 4
                                    ? "red"
                                    : r.priority === 5
                                      ? "yellow"
                                      : "orange"
                                }
                              >
                                {r.message}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        <span>›</span>
                      </button>
                    ))
                  ) : (
                    <Empty
                      onCreate={() => setEditing(newProposal())}
                      canCreate={user.role !== "viewer"}
                    />
                  )}
                </section>
                <section className="panel overview">
                  <div className="panel-title">
                    <div>
                      <h2>진행 현황</h2>
                      <p>전체 품의 기준</p>
                    </div>
                    <span className="muted">{today().slice(0, 7)}</span>
                  </div>
                  <div
                    className="progress-ring"
                    style={
                      {
                        "--progress": `${proposals.length ? (proposals.filter((p) => complete(p, settings)).length / proposals.length) * 100 : 0}%`,
                      } as React.CSSProperties
                    }
                  >
                    <div>
                      <strong>
                        {proposals.length
                          ? Math.round(
                              (proposals.filter((p) => complete(p, settings))
                                .length /
                                proposals.length) *
                                100,
                            )
                          : 0}
                        <small>%</small>
                      </strong>
                      <span>업무 완료율</span>
                    </div>
                  </div>
                  <div className="legend">
                    <span>
                      <i className="dot green" />
                      완료 <b>{proposals.length - pending}건</b>
                    </span>
                    <span>
                      <i className="dot blue" />
                      진행 중 <b>{pending}건</b>
                    </span>
                  </div>
                  <div className="overview-total">
                    <span>총 집행 예정금액</span>
                    <strong>
                      {won(proposals.reduce((a, p) => a + p.total, 0))}
                    </strong>
                  </div>
                </section>
              </div>
              <FundingOverview proposals={proposals} settings={settings} />
              <section className="panel">
                <div className="panel-title">
                  <div>
                    <h2>최근 접수 품의</h2>
                    <p>재원 구분과 처리 상태를 함께 확인하세요.</p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => openFilter("all")}
                  >
                    전체 목록 →
                  </button>
                </div>
                <ProposalTable
                  items={proposals.slice(0, 5)}
                  settings={settings}
                  onEdit={setEditing}
                  user={user}
                  onQuick={(p, payment, id) =>
                    run(() => quick(p, payment, id, user))
                  }
                />
              </section>
              <div className="hint">
                ⓘ 파란색은 학교 자체예산, 보라색은 지원금입니다. 업무 경고
                색상과 별도로 표시됩니다.
              </div>
            </>
          )}
          {(view === "list" || view === "archive") && (
            <List
              proposals={proposals}
              settings={settings}
              user={user}
              initial={view === "archive" ? "done" : filter}
              archive={view === "archive"}
              onEdit={(p) => setEditing(clone(p))}
              onQuick={(p, x, id) => run(() => quick(p, x, id, user))}
              onImport={(file) =>
                run(async () => {
                  const form = new FormData();
                  form.append("file", file);
                  const r = await api<{ count: number }>("/import", {
                    method: "POST",
                    body: form,
                  });
                  notify(`${r.count}건 등록`);
                }, "엑셀 등록을 완료했습니다")
              }
              onError={fail}
            />
          )}
          {view === "calendar" && (
            <Calendar proposals={proposals} onEdit={setEditing} />
          )}
          {view === "stats" && (
            <Statistics proposals={proposals} settings={settings} />
          )}
          {view === "settings" && (
            <SettingsPanel
              settings={settings}
              user={user}
              onSave={(s) => run(() => save("/settings", s, "PUT"))}
              onError={fail}
              run={run}
              onSeed={() =>
                run(() => save("/seed", {}), "가상 품의 2건을 생성했습니다")
              }
            />
          )}
          {officeNav.some(([key]) => key === view) && (
            <OfficeWorkspace
              view={view as OfficeView}
              onView={setView}
              user={user}
            />
          )}
          <footer>
            한국디지털미디어고등학교 · 행정실 지출업무 통합관리{" "}
            <span>학교 내부 업무용 · Asia/Seoul</span>
          </footer>
        </main>
      </div>
      {editing && (
        <Editor
          initial={editing}
          settings={settings}
          user={user}
          onClose={() => setEditing(null)}
          onDelete={async () => {
            if (!("id" in editing)) return;
            await save(
              "/proposals/" + editing.id,
              { version: editing.version, confirmation: editing.management },
              "DELETE",
            );
            await refresh();
            setEditing(null);
            notify(
              "품의를 삭제했습니다. 연결된 결제 항목도 목록과 집계에서 제외했습니다.",
            );
          }}
          onSave={async (value) => {
            await save(
              "id" in editing ? `/proposals/${editing.id}` : "/proposals",
              value,
              "id" in editing ? "PUT" : "POST",
            );
            await refresh();
            setEditing(null);
            notify("품의를 저장했습니다");
          }}
        />
      )}
    </div>
  );
}
async function quick(p: Proposal, payment: Payment, id: StageId, user: User) {
  const copy = clone(p),
    x = copy.payments.find((x) => x.id === payment.id)!;
  if (id === "payment" && x.actual === null)
    throw new Error("품의 상세 화면에서 실제 결제금액을 먼저 입력하세요");
  if (id === "evidence" && !evidenceReady(x))
    throw new Error("증빙서류를 먼저 확인하세요");
  const s = x.stages[id];
  s.done = !s.done;
  if (s.done) {
    s.date = today();
    s.owner = user.name;
  }
  await save("/proposals/" + p.id, copy, "PUT");
}
function Login({
  onLogin,
  error,
}: {
  onLogin: (x: { user: User; csrf: string }) => void;
  error: string;
}) {
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [issue, setIssue] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <div className="login-brand">
        <div className="eyebrow">한국디지털미디어고등학교</div>
        <h1>
          빠짐없는 업무,
          <br />
          정확한 지출 관리.
        </h1>
        <p>
          행정실의 하루를 더 명확하게.
          <br />
          품의 접수부터 최종 완료까지 함께 관리하세요.
        </p>
        <div className="login-art">
          ▤<span>✓</span>
        </div>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            onLogin(
              await api("/login", {
                method: "POST",
                body: JSON.stringify({ username, password }),
              }),
            );
          } catch (e) {
            setIssue((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Badge tone="blue">행정실 업무공간</Badge>
        <h2>로그인</h2>
        <p>관리자가 발급한 계정으로 로그인해 주세요.</p>
        <label>
          아이디
          <input
            value={username}
            autoComplete="username"
            required
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label>
          비밀번호
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            required
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {(issue || error) && (
          <p className="error-text" role="alert">
            {issue || error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "확인 중…" : "로그인 →"}
        </button>
        <small>학교 내부 사용자 전용 · 접속 이력이 기록됩니다.</small>
      </form>
    </div>
  );
}
function Empty({
  onCreate,
  canCreate,
}: {
  onCreate: () => void;
  canCreate: boolean;
}) {
  return (
    <div className="empty">
      <span>▤</span>
      <h3>아직 등록된 품의가 없습니다</h3>
      <p>품의를 등록하면 진행 현황을 한눈에 볼 수 있어요.</p>
      {canCreate && <button onClick={onCreate}>＋ 첫 품의 등록</button>}
    </div>
  );
}
function ProposalTable({
  items,
  settings,
  onEdit,
  user,
  onQuick,
}: {
  items: Proposal[];
  settings: Settings;
  onEdit: (p: Proposal) => void;
  user: User;
  onQuick: (p: Proposal, x: Payment, id: StageId) => void;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const badge = (p: Proposal, id: StageId) => {
    const n = p.payments.filter((x) => stageDone(x, id)).length;
    return (
      <Badge
        tone={
          n === p.payments.length
            ? "green"
            : id === "evidence"
              ? "yellow"
              : id === "payment"
                ? "orange"
                : "red"
        }
      >
        {n === p.payments.length ? "완료" : `${n}/${p.payments.length} 처리`}
      </Badge>
    );
  };
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>접수일 / 관리번호</th>
            <th className="title-cell">품의 제목 / 예산 재원</th>
            <th>신청자</th>
            <th className="amount">총금액</th>
            <th>결제 방식</th>
            <th>원인행위</th>
            <th>결제·지급</th>
            <th>증빙서류</th>
            <th>지출결의</th>
            <th>진행 상태</th>
            <th>경과</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <React.Fragment key={p.id}>
              <tr
                className={
                  "fund-" + (funding(p).length > 1 ? "mixed" : funding(p)[0])
                }
              >
                <td>
                  {p.received}
                  <small>{p.management}</small>
                </td>
                <td>
                  <button
                    className="row-title"
                    onClick={() =>
                      setExpanded(
                        expanded.includes(p.id)
                          ? expanded.filter((x) => x !== p.id)
                          : [...expanded, p.id],
                      )
                    }
                  >
                    {expanded.includes(p.id) ? "▾" : "▸"} {p.title}
                  </button>
                  <Funding p={p} />
                </td>
                <td>
                  {p.applicant}
                  <small>{p.department}</small>
                </td>
                <td className="amount">
                  <b>{won(p.total)}</b>
                </td>
                <td>
                  <Badge tone={method(p) === "mixed" ? "purple" : "neutral"}>
                    {methodName[method(p)!]}
                  </Badge>
                </td>
                {(
                  ["commit", "payment", "evidence", "resolution"] as StageId[]
                ).map((id) => (
                  <td key={id}>{badge(p, id)}</td>
                ))}
                <td>
                  <Badge tone={complete(p, settings) ? "green" : "blue"}>
                    {complete(p, settings) ? "최종 완료" : "진행 중"}
                  </Badge>
                </td>
                <td>
                  {Math.max(0, days(p.received))}일
                  <button
                    className="text-button"
                    onClick={() => onEdit(clone(p))}
                  >
                    상세 ↗
                  </button>
                </td>
              </tr>
              {expanded.includes(p.id) && (
                <tr className="expanded">
                  <td colSpan={11}>
                    <div className="expanded-header">
                      <b>세부 결제 {p.payments.length}건</b>
                      <button onClick={() => onEdit(clone(p))}>
                        {user.role === "viewer"
                          ? "상세 보기"
                          : "상세 수정 · 첨부"}
                      </button>
                    </div>
                    {p.payments.map((x) => (
                      <div className="payment-strip" key={x.id}>
                        <span>
                          <Badge>{methodName[x.method]}</Badge>{" "}
                          <b>{x.vendor}</b>
                        </span>
                        <span>
                          예정 {won(x.planned)} / 실제{" "}
                          {x.actual === null ? "미입력" : won(x.actual)}
                        </span>
                        <span className="badges">
                          {settings.stages.map(({ id }) => (
                            <button
                              key={id}
                              disabled={user.role === "viewer"}
                              className={
                                "quick " + (stageDone(x, id) ? "done" : "")
                              }
                              onClick={() => onQuick(p, x, id)}
                            >
                              {stageDone(x, id) ? "✓" : "○"} {stageLabels[id]}
                            </button>
                          ))}
                        </span>
                      </div>
                    ))}
                    {warnings(p).map((w) => (
                      <p className="warning-text" key={w}>
                        ⚠ {w}
                      </p>
                    ))}
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
      {!items.length && (
        <div className="empty">
          <p>조건에 맞는 품의가 없습니다.</p>
        </div>
      )}
    </div>
  );
}
function List({
  proposals,
  settings,
  user,
  initial,
  archive,
  onEdit,
  onQuick,
  onImport,
  onError,
}: {
  proposals: Proposal[];
  settings: Settings;
  user: User;
  initial: Filter;
  archive: boolean;
  onEdit: (p: Proposal) => void;
  onQuick: (p: Proposal, x: Payment, id: StageId) => void;
  onImport: (f: File) => void;
  onError: (e: unknown) => void;
}) {
  const [filter, setFilter] = useState(initial),
    [query, setQuery] = useState(""),
    [pay, setPay] = useState("all"),
    [source, setSource] = useState("all"),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [sort, setSort] = useState("new");
  useEffect(() => setFilter(initial), [initial]);
  const rows = proposals
    .filter(
      (p) =>
        matches(p, archive ? "done" : filter, settings) &&
        (pay === "all" || method(p) === pay) &&
        (source === "all" ||
          funding(p).includes(source as "school" | "grant")) &&
        (!from || p.received >= from) &&
        (!to || p.received <= to) &&
        [
          p.title,
          p.applicant,
          p.number,
          p.management,
          ...p.payments.map((x) => x.vendor),
          ...p.payments.flatMap((x) => x.allocations.map((a) => a.project)),
        ]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "amount"
        ? b.total - a.total
        : sort === "due"
          ? (a.due || "9999").localeCompare(b.due || "9999")
          : b.received.localeCompare(a.received) ||
            b.management.localeCompare(a.management),
    );
  return (
    <section className="panel">
      <div className="filters">
        <div className="filter-top">
          <div className="search">
            ⌕{" "}
            <input
              aria-label="품의 검색"
              placeholder="품의 제목, 신청자, 업체, 품의번호, 지원사업명 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            onClick={() =>
              download("/export", "전체-지출업무.xlsx").catch(onError)
            }
          >
            ↓ 전체 엑셀
          </button>
          <button
            onClick={() =>
              download(
                "/export?ids=" + rows.map((p) => p.id).join(","),
                "조회-지출업무.xlsx",
              ).catch(onError)
            }
          >
            ↓ 조회 엑셀
          </button>
          {user.role !== "viewer" && (
            <label className="file-button">
              ↑ 엑셀 등록
              <input
                type="file"
                accept=".xlsx"
                onChange={(e) => {
                  if (e.target.files?.[0]) onImport(e.target.files[0]);
                  e.target.value = "";
                }}
              />
            </label>
          )}
        </div>
        <div className="filter-bottom">
          <select
            aria-label="처리 상태 필터"
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
            disabled={archive}
          >
            <option value="all">전체 상태</option>
            <option value="pending">미처리 품의</option>
            <option value="commit">원인행위 미처리</option>
            <option value="card">카드결제 대기</option>
            <option value="transfer">계좌이체 대기</option>
            <option value="evidence">증빙 미확보</option>
            <option value="resolution">지출결의 미처리</option>
            <option value="overdue">기한 경과</option>
            <option value="done">완료 품의</option>
          </select>
          <select
            aria-label="결제 방식 필터"
            value={pay}
            onChange={(e) => setPay(e.target.value)}
          >
            <option value="all">모든 결제 방식</option>
            <option value="card">카드결제만</option>
            <option value="transfer">계좌이체만</option>
            <option value="mixed">혼합결제만</option>
          </select>
          <select
            aria-label="재원 필터"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="all">전체 예산 재원</option>
            <option value="school">학교 자체예산</option>
            <option value="grant">지원금</option>
          </select>
          <label className="inline-label">
            접수일{" "}
            <input
              aria-label="검색 시작일"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />{" "}
            ~{" "}
            <input
              aria-label="검색 종료일"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <button
            className="text-button"
            onClick={() => {
              setQuery("");
              setPay("all");
              setSource("all");
              setFilter("all");
              setFrom("");
              setTo("");
            }}
          >
            초기화
          </button>
        </div>
      </div>
      <div className="list-summary">
        <span>
          총 <b>{rows.length}건</b> ·{" "}
          {won(rows.reduce((a, p) => a + p.total, 0))}
        </span>
        <select
          aria-label="정렬"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="new">최근 접수순</option>
          <option value="due">처리 기한순</option>
          <option value="amount">금액 높은순</option>
        </select>
      </div>
      <ProposalTable
        items={rows}
        settings={settings}
        onEdit={onEdit}
        user={user}
        onQuick={onQuick}
      />
      <div className="hint">
        엑셀 등록은 내보낸 양식을 사용합니다. 동일한 관리번호의 행은 하나의 새
        품의로 묶이며 기존 품의를 덮어쓰지 않습니다.
      </div>
    </section>
  );
}
type Attachment = {
  id: string;
  payment_id: string;
  name: string;
  size: number;
  created_at: string;
};
type Audit = {
  id: number;
  at: string;
  actor: string;
  action: string;
  detail: string;
  target: string;
};
function Editor({
  initial,
  settings,
  user,
  onClose,
  onSave,
  onDelete,
}: {
  initial: Proposal | ProposalInput;
  settings: Settings;
  user: User;
  onClose: () => void;
  onDelete: () => Promise<void>;
  onSave: (p: Proposal | ProposalInput) => Promise<void>;
}) {
  const [value, setValue] = useState(clone(initial)),
    [tab, setTab] = useState("basic"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [attachments, setAttachments] = useState<Attachment[]>([]),
    [history, setHistory] = useState<Audit[]>([]);
  const id = "id" in initial ? initial.id : null,
    readonly = user.role === "viewer";
  const update = (patch: Partial<ProposalInput>) =>
    setValue((v) => ({ ...v, ...patch }));
  const change = (paymentId: string, fn: (p: Payment) => void) =>
    setValue((v) => {
      const copy = clone(v);
      fn(copy.payments.find((x) => x.id === paymentId)!);
      return copy;
    });
  const loadFiles = () =>
    id
      ? api<Attachment[]>(`/proposals/${id}/attachments`).then(setAttachments)
      : Promise.resolve();
  useEffect(() => {
    if (id) {
      loadFiles().catch((e) => setError(e.message));
      api<Audit[]>("/audit?target=" + id)
        .then(setHistory)
        .catch((e) => setError(e.message));
    }
  }, [id]);
  async function fileAction(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await loadFiles();
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const field = (
    key: Exclude<keyof ProposalInput, "payments">,
    label: string,
    type = "text",
    required = false,
  ) => (
    <label key={key}>
      {label}
      <input
        type={type}
        required={required}
        min={type === "number" ? 0 : undefined}
        value={value[key]}
        onChange={(e) =>
          update({
            [key]: type === "number" ? Number(e.target.value) : e.target.value,
          })
        }
      />
    </label>
  );
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-title"
      >
        <div className="editor-header">
          <div>
            <small>
              {"management" in value ? value.management : "새 품의"}
            </small>
            <h2 id="editor-title">
              {readonly ? "품의 상세" : "품의 등록·수정"}
            </h2>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            aria-label="닫기"
          >
            ✕
          </button>
        </div>
        <div className="tabs">
          {[
            ["basic", "기본 정보"],
            ["payments", `결제 세부 ${value.payments.length}건`],
            ["files", "증빙 첨부"],
            ["history", "변경 이력"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={tab === key ? "active" : ""}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await onSave(value);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="editor-body">
            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
            {warnings(value).map((w) => (
              <div className="validation-warning" key={w}>
                ⚠ {w}
              </div>
            ))}
            {tab === "basic" && (
              <fieldset disabled={readonly || busy}>
                <div className="section-label">
                  품의 기본 정보{" "}
                  <span>결제 방식은 세부 항목에서 자동 판별됩니다.</span>
                </div>
                <div className="form-grid">
                  {field("title", "품의 제목 *", "text", true)}
                  {field("number", "품의번호 (선택)")}
                  {field("department", "품의 부서")}
                  {field("applicant", "신청 교직원 *", "text", true)}
                  {field("approved", "결재 완료일 *", "date", true)}
                  {field("received", "접수일 *", "date", true)}
                  {field("total", "품의 총금액 (원) *", "number", true)}
                  {field("budget", "예산과목")}
                  {field("due", "희망 처리일 / 납기일", "date")}
                </div>
                <div className="form-grid">
                  <label>
                    품의 비고
                    <textarea
                      value={value.note}
                      onChange={(e) => update({ note: e.target.value })}
                    />
                  </label>
                  <label>
                    금액 변경·일부 취소 조정 사유
                    <textarea
                      value={value.adjustmentReason}
                      onChange={(e) =>
                        update({ adjustmentReason: e.target.value })
                      }
                    />
                    <small>
                      금액 불일치 시 사유가 없으면 최종 완료로 집계되지
                      않습니다.
                    </small>
                  </label>
                </div>
                <div className="summary-bar">
                  <span>
                    결제 방식 <b>{methodName[method(value)!]}</b>
                  </span>
                  <span>
                    결제 항목 <b>{value.payments.length}건</b>
                  </span>
                  <span>
                    예정 합계{" "}
                    <b>
                      {won(value.payments.reduce((a, x) => a + x.planned, 0))}
                    </b>
                  </span>
                  <Funding p={value} />
                </div>
              </fieldset>
            )}
            {tab === "payments" && (
              <>
                <div className="section-label">
                  독립적인 결제·재원 관리{" "}
                  <span>
                    문서번호와 묶음명을 같게 입력하면 공동 처리 내역을 기록할 수
                    있습니다.
                  </span>
                </div>
                {value.payments.map((x, i) => (
                  <fieldset
                    disabled={readonly || busy}
                    className="payment-card"
                    key={x.id}
                  >
                    <div className="payment-card-heading">
                      <h3>
                        결제 항목 {i + 1}{" "}
                        <Badge
                          tone={
                            paymentComplete(x, settings) ? "green" : "orange"
                          }
                        >
                          {paymentComplete(x, settings) ? "완료" : "처리 중"}
                        </Badge>
                      </h3>
                      <button
                        type="button"
                        className="danger-text"
                        disabled={value.payments.length <= 1}
                        onClick={() =>
                          update({
                            payments: value.payments.filter(
                              (p) => p.id !== x.id,
                            ),
                          })
                        }
                      >
                        항목 삭제
                      </button>
                    </div>
                    <div className="form-grid four">
                      <label>
                        결제 방식
                        <select
                          value={x.method}
                          onChange={(e) =>
                            change(x.id, (p) => {
                              p.method = e.target.value as Payment["method"];
                              p.documents = (
                                p.method === "card"
                                  ? ["영수증", "거래명세서"]
                                  : [
                                      "세금계산서·계산서",
                                      "거래명세서",
                                      "통장 사본",
                                      "사업자등록증",
                                    ]
                              ).map((name) => ({
                                name,
                                required: ![
                                  "통장 사본",
                                  "사업자등록증",
                                ].includes(name),
                                received: false,
                              }));
                            })
                          }
                        >
                          <option value="card">카드결제</option>
                          <option value="transfer">계좌이체</option>
                        </select>
                      </label>
                      <label>
                        업체명 *
                        <input
                          required
                          value={x.vendor}
                          onChange={(e) =>
                            change(x.id, (p) => {
                              p.vendor = e.target.value;
                            })
                          }
                        />
                      </label>
                      <label>
                        예정금액 (원)
                        <input
                          type="number"
                          min="0"
                          required
                          value={x.planned}
                          onChange={(e) =>
                            change(x.id, (p) => {
                              p.planned = Number(e.target.value);
                            })
                          }
                        />
                      </label>
                      <label>
                        실제금액 (원)
                        <input
                          type="number"
                          min="0"
                          placeholder="결제 전에는 비워 두세요"
                          value={x.actual ?? ""}
                          onChange={(e) =>
                            change(x.id, (p) => {
                              p.actual =
                                e.target.value === ""
                                  ? null
                                  : Number(e.target.value);
                            })
                          }
                        />
                      </label>
                      <label>
                        결제·지급 예정일
                        <input
                          type="date"
                          value={x.due}
                          onChange={(e) =>
                            change(x.id, (p) => {
                              p.due = e.target.value;
                            })
                          }
                        />
                      </label>
                      <label>
                        지출결의 예정일
                        <input
                          type="date"
                          value={x.resolutionDue}
                          onChange={(e) =>
                            change(x.id, (p) => {
                              p.resolutionDue = e.target.value;
                            })
                          }
                        />
                      </label>
                      <label className="span-2">
                        특이사항
                        <input
                          value={x.note}
                          onChange={(e) =>
                            change(x.id, (p) => {
                              p.note = e.target.value;
                            })
                          }
                        />
                      </label>
                    </div>
                    <h4>
                      예산 재원 배분{" "}
                      <span className="muted">
                        합계{" "}
                        {won(x.allocations.reduce((a, y) => a + y.amount, 0))}
                      </span>
                    </h4>
                    {x.allocations.map((a, j) => (
                      <div className="allocation" key={j}>
                        <select
                          aria-label={`항목 ${i + 1} 재원 ${j + 1}`}
                          value={a.source}
                          onChange={(e) =>
                            change(x.id, (p) => {
                              p.allocations[j].source = e.target.value as
                                "school" | "grant";
                            })
                          }
                        >
                          <option value="school">학교 자체예산</option>
                          <option value="grant">지원금</option>
                        </select>
                        <label>
                          배분금액
                          <input
                            type="number"
                            min="0"
                            value={a.amount}
                            onChange={(e) =>
                              change(x.id, (p) => {
                                p.allocations[j].amount = Number(
                                  e.target.value,
                                );
                              })
                            }
                          />
                        </label>
                        {a.source === "grant" && (
                          <>
                            <label>
                              지원사업명
                              <input
                                value={a.project}
                                onChange={(e) =>
                                  change(x.id, (p) => {
                                    p.allocations[j].project = e.target.value;
                                  })
                                }
                              />
                            </label>
                            <label>
                              지원기관
                              <input
                                value={a.agency}
                                onChange={(e) =>
                                  change(x.id, (p) => {
                                    p.allocations[j].agency = e.target.value;
                                  })
                                }
                              />
                            </label>
                            <label>
                              사업 시작
                              <input
                                type="date"
                                value={a.start}
                                onChange={(e) =>
                                  change(x.id, (p) => {
                                    p.allocations[j].start = e.target.value;
                                  })
                                }
                              />
                            </label>
                            <label>
                              사업 종료
                              <input
                                type="date"
                                value={a.end}
                                onChange={(e) =>
                                  change(x.id, (p) => {
                                    p.allocations[j].end = e.target.value;
                                  })
                                }
                              />
                            </label>
                          </>
                        )}
                        <button
                          type="button"
                          disabled={x.allocations.length <= 1}
                          onClick={() =>
                            change(x.id, (p) => {
                              p.allocations.splice(j, 1);
                            })
                          }
                        >
                          삭제
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        change(x.id, (p) => {
                          p.allocations.push({
                            source: "school",
                            amount: 0,
                            project: "",
                            agency: "",
                            start: "",
                            end: "",
                          });
                        })
                      }
                    >
                      ＋ 재원 추가
                    </button>
                    <h4>
                      증빙서류{" "}
                      <span className="muted">
                        필요 여부와 확보 여부를 각각 지정하세요.
                      </span>
                    </h4>
                    <div className="documents">
                      {x.documents.map((d, j) => (
                        <div key={j}>
                          <input
                            aria-label="증빙서류명"
                            value={d.name}
                            onChange={(e) =>
                              change(x.id, (p) => {
                                p.documents[j].name = e.target.value;
                              })
                            }
                          />
                          <label>
                            <input
                              type="checkbox"
                              checked={d.required}
                              onChange={(e) =>
                                change(x.id, (p) => {
                                  p.documents[j].required = e.target.checked;
                                })
                              }
                            />
                            필수
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={d.received}
                              onChange={(e) =>
                                change(x.id, (p) => {
                                  p.documents[j].received = e.target.checked;
                                })
                              }
                            />
                            확보
                          </label>
                          <button
                            type="button"
                            onClick={() =>
                              change(x.id, (p) => {
                                p.documents.splice(j, 1);
                              })
                            }
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        change(x.id, (p) => {
                          p.documents.push({
                            name: "추가 증빙",
                            required: true,
                            received: false,
                          });
                        })
                      }
                    >
                      ＋ 증빙 항목
                    </button>
                    <h4>처리 단계</h4>
                    <div className="stage-table">
                      <div className="stage-row stage-head">
                        <span>단계 / 완료</span>
                        <span>처리일</span>
                        <span>담당자</span>
                        <span>문서번호</span>
                        <span>그룹명</span>
                        <span>비고</span>
                      </div>
                      {settings.stages.map(({ id, required }) => {
                        const s = x.stages[id];
                        return (
                          <div className="stage-row" key={id}>
                            <label>
                              <input
                                type="checkbox"
                                checked={s.done}
                                onChange={(e) =>
                                  change(x.id, (p) => {
                                    const stage = p.stages[id];
                                    stage.done = e.target.checked;
                                    if (stage.done) {
                                      stage.date = stage.date || today();
                                      stage.owner = stage.owner || user.name;
                                    }
                                  })
                                }
                              />
                              {stageLabels[id]}
                              {required && <small>*</small>}
                            </label>
                            <input
                              aria-label={stageLabels[id] + " 처리일"}
                              type="date"
                              value={s.date}
                              onChange={(e) =>
                                change(x.id, (p) => {
                                  p.stages[id].date = e.target.value;
                                })
                              }
                            />
                            {(
                              ["owner", "document", "group", "note"] as const
                            ).map((key) => (
                              <input
                                key={key}
                                aria-label={stageLabels[id] + " " + key}
                                value={s[key]}
                                onChange={(e) =>
                                  change(x.id, (p) => {
                                    p.stages[id][key] = e.target.value;
                                  })
                                }
                              />
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  </fieldset>
                ))}
                {!readonly && (
                  <button
                    type="button"
                    className="add-payment"
                    onClick={() =>
                      update({ payments: [...value.payments, newPayment()] })
                    }
                  >
                    ＋ 결제 항목 추가 (카드 / 계좌이체)
                  </button>
                )}
              </>
            )}
            {tab === "files" && (
              <div>
                <div className="section-label">
                  증빙서류 첨부{" "}
                  <span>
                    PDF·PNG·JPG / 개별 최대 10MB / 로그인 사용자만 다운로드 가능
                  </span>
                </div>
                {!id ? (
                  <div className="empty">
                    품의를 먼저 저장한 후 첨부파일을 등록하세요.
                  </div>
                ) : (
                  value.payments.map((x) => (
                    <div className="attachment-group" key={x.id}>
                      <h3>
                        {x.vendor} <Badge>{methodName[x.method]}</Badge>
                      </h3>
                      {attachments
                        .filter((a) => a.payment_id === x.id)
                        .map((a) => (
                          <div className="attachment" key={a.id}>
                            <span>
                              ▤ {a.name}{" "}
                              <small>{Math.round(a.size / 1024)}KB</small>
                            </span>
                            <div>
                              <button
                                type="button"
                                onClick={() =>
                                  download(
                                    "/attachments/" + a.id,
                                    a.name,
                                  ).catch((e) => setError(e.message))
                                }
                              >
                                다운로드
                              </button>
                              {!readonly && (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => {
                                    if (confirm("이 첨부파일을 삭제할까요?"))
                                      fileAction(() =>
                                        api("/attachments/" + a.id, {
                                          method: "DELETE",
                                        }),
                                      );
                                  }}
                                >
                                  삭제
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      {!readonly && (
                        <label className="file-button">
                          ＋ 파일 첨부
                          <input
                            type="file"
                            accept=".pdf,.png,.jpg,.jpeg"
                            disabled={busy}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file)
                                fileAction(async () => {
                                  const form = new FormData();
                                  form.append("file", file);
                                  form.append("paymentId", x.id);
                                  await api(`/proposals/${id}/attachments`, {
                                    method: "POST",
                                    body: form,
                                  });
                                });
                              e.target.value = "";
                            }}
                          />
                        </label>
                      )}
                      <p className="muted">
                        첨부 후 증빙 확보 여부는 결제 세부 탭에서 확인하여
                        변경하세요.
                      </p>
                    </div>
                  ))
                )}
              </div>
            )}
            {tab === "history" && (
              <div>
                <div className="section-label">
                  변경 이력{" "}
                  <span>최신 300건 · 등록·수정 내역은 서버에 저장됩니다.</span>
                </div>
                {history.length ? (
                  history.map((h) => (
                    <details className="history" key={h.id}>
                      <summary>
                        <Badge>{h.action}</Badge> {h.actor}{" "}
                        <small>
                          {new Date(h.at).toLocaleString("ko-KR", {
                            timeZone: "Asia/Seoul",
                          })}
                        </small>
                      </summary>
                      <pre>
                        {(() => {
                          try {
                            return JSON.stringify(
                              JSON.parse(h.detail),
                              null,
                              2,
                            );
                          } catch {
                            return h.detail;
                          }
                        })()}
                      </pre>
                    </details>
                  ))
                ) : (
                  <p className="empty">저장된 변경 이력이 없습니다.</p>
                )}
              </div>
            )}
          </div>
          <div className="editor-footer">
            <span>
              <Badge tone={complete(value, settings) ? "green" : "blue"}>
                {complete(value, settings) ? "최종 완료 가능" : "진행 중"}
              </Badge>{" "}
              모든 결제 항목의 필수 단계와 금액을 확인합니다.
            </span>
            <div>
              {id && user.role === "admin" && (
                <button
                  type="button"
                  className="danger-text"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      !confirm(
                        `「${initial.title}」 품의를 삭제할까요?\n연결된 결제 ${initial.payments.length}건과 첨부가 목록에서 제외됩니다. 삭제 이력과 복구 자료는 보관됩니다.`,
                      )
                    )
                      return;
                    setBusy(true);
                    setError("");
                    try {
                      await onDelete();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  품의 삭제
                </button>
              )}
              <button type="button" disabled={busy} onClick={onClose}>
                닫기
              </button>
              {!readonly && (
                <button className="primary" type="submit" disabled={busy}>
                  {busy ? "저장 중…" : "품의 저장"}
                </button>
              )}
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}
function Calendar({
  proposals,
  onEdit,
}: {
  proposals: Proposal[];
  onEdit: (p: Proposal) => void;
}) {
  const [month, setMonth] = useState(today().slice(0, 7));
  const events = proposals
    .flatMap((p) => [
      { date: p.received, label: "접수", p },
      ...(p.due ? [{ date: p.due, label: "처리기한", p }] : []),
      ...p.payments.flatMap((x) => [
        ...(x.due
          ? [{ date: x.due, label: methodName[x.method] + " · " + x.vendor, p }]
          : []),
        ...(x.resolutionDue
          ? [{ date: x.resolutionDue, label: "지출결의 · " + x.vendor, p }]
          : []),
      ]),
    ])
    .filter((x) => x.date.startsWith(month))
    .sort((a, b) => a.date.localeCompare(b.date));
  const count = new Date(
      Number(month.slice(0, 4)),
      Number(month.slice(5)),
      0,
    ).getDate(),
    offset = new Date(month + "-01T00:00:00Z").getUTCDay();
  return (
    <section className="panel">
      <div className="panel-title">
        <h2>업무 일정</h2>
        <input
          aria-label="달력 월"
          type="month"
          value={month}
          onChange={(e) => {
            if (e.target.value) setMonth(e.target.value);
          }}
        />
      </div>
      <div className="calendar-grid">
        {["일", "월", "화", "수", "목", "금", "토"].map((x) => (
          <div className="calendar-week" key={x}>
            {x}
          </div>
        ))}
        {Array.from({ length: offset }, (_, i) => (
          <div key={"empty" + i} />
        ))}
        {Array.from({ length: count }, (_, i) => {
          const date = `${month}-${String(i + 1).padStart(2, "0")}`;
          return (
            <div
              className={"calendar-day " + (date === today() ? "today" : "")}
              key={date}
            >
              <b>{i + 1}</b>
              {events
                .filter((x) => x.date === date)
                .map((x, j) => (
                  <button
                    key={j}
                    className={x.label === "처리기한" ? "deadline" : ""}
                    onClick={() => onEdit(clone(x.p))}
                  >
                    <small>{x.label}</small>
                    {x.p.title}
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
function FundingOverview({
  proposals,
  settings,
}: {
  proposals: Proposal[];
  settings: Settings;
}) {
  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h2>예산 재원별 현황</h2>
          <p>금액은 배분액 기준, 품의는 각 재원 안에서 중복을 제외합니다.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>예산 재원</th>
              <th>품의 건수</th>
              <th>집행 예정금액</th>
              <th>집행 완료금액</th>
              <th>미처리 품의</th>
            </tr>
          </thead>
          <tbody>
            {(["school", "grant"] as const).map((source) => {
              const rows = proposals.flatMap((p) =>
                p.payments.flatMap((x) =>
                  x.allocations
                    .filter((a) => a.source === source)
                    .map((a) => ({ p, x, a })),
                ),
              );
              return (
                <tr key={source}>
                  <td>
                    <Badge tone={source === "school" ? "blue" : "purple"}>
                      {source === "school" ? "학교 자체예산" : "지원금"}
                    </Badge>
                  </td>
                  <td>{new Set(rows.map((r) => r.p.id)).size}건</td>
                  <td>{won(rows.reduce((a, r) => a + r.a.amount, 0))}</td>
                  <td>
                    {won(
                      Math.round(
                        rows.reduce(
                          (a, r) =>
                            a +
                            (stageDone(r.x, "payment") && r.x.planned > 0
                              ? ((r.x.actual ?? 0) * r.a.amount) / r.x.planned
                              : 0),
                          0,
                        ),
                      ),
                    )}
                  </td>
                  <td>
                    {
                      new Set(
                        rows
                          .filter((r) => !paymentComplete(r.x, settings))
                          .map((r) => r.p.id),
                      ).size
                    }
                    건
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
function Statistics({
  proposals,
  settings,
}: {
  proposals: Proposal[];
  settings: Settings;
}) {
  const allocations = proposals.flatMap((p) =>
    p.payments.flatMap((x) => x.allocations.map((a) => ({ p, x, a }))),
  );
  const groups = [
    { key: "school", name: "학교 자체예산" },
    { key: "grant", name: "지원금" },
  ].map((g) => {
    const rows = allocations.filter((r) => r.a.source === g.key);
    return {
      ...g,
      count: new Set(rows.map((r) => r.p.id)).size,
      planned: rows.reduce((a, r) => a + r.a.amount, 0),
      actual: rows.reduce(
        (a, r) =>
          a +
          (stageDone(r.x, "payment") && r.x.planned > 0
            ? ((r.x.actual ?? 0) * r.a.amount) / r.x.planned
            : 0),
        0,
      ),
      pending: new Set(
        rows.filter((r) => !paymentComplete(r.x, settings)).map((r) => r.p.id),
      ).size,
    };
  });
  const months = [
    ...new Set(
      proposals.flatMap((p) =>
        p.payments
          .filter((x) => stageDone(x, "payment"))
          .map((x) => x.stages.payment.date.slice(0, 7)),
      ),
    ),
  ]
    .sort()
    .reverse();
  const projects = [
    ...new Set(
      allocations
        .filter((r) => r.a.source === "grant")
        .map((r) => r.a.project || "사업명 미입력"),
    ),
  ];
  return (
    <div className="stats">
      <div className="metrics three">
        <div className="metric">
          <span>전체 품의 · 중복 제외</span>
          <strong>
            {proposals.length}
            <small>건</small>
          </strong>
        </div>
        <div className="metric">
          <span>집행 예정금액 · 품의 총액</span>
          <strong className="money-large">
            {won(proposals.reduce((a, p) => a + p.total, 0))}
          </strong>
        </div>
        <div className="metric">
          <span>실제 집행금액 · 결제 완료 항목</span>
          <strong className="money-large">
            {won(
              proposals
                .flatMap((p) => p.payments)
                .filter((x) => stageDone(x, "payment"))
                .reduce((a, x) => a + (x.actual ?? 0), 0),
            )}
          </strong>
        </div>
      </div>
      <section className="panel">
        <div className="panel-title">
          <h2>예산 재원별 집행</h2>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>재원</th>
                <th>품의 수</th>
                <th>배분 예정금액</th>
                <th>집행 완료금액</th>
                <th>미처리 품의</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.key}>
                  <td>
                    <Badge tone={g.key === "school" ? "blue" : "purple"}>
                      {g.name}
                    </Badge>
                  </td>
                  <td>{g.count}건</td>
                  <td>{won(g.planned)}</td>
                  <td>{won(Math.round(g.actual))}</td>
                  <td>{g.pending}건</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">
          혼합 재원 품의는 각 재원 건수에 포함되지만 전체 건수는 한 번만
          집계합니다. 실제 집행은 결제 항목의 배분 비율로 계산하며, 0원 예정
          항목의 실집행은 배분할 수 없습니다.
        </p>
      </section>
      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-title">
            <h2>결제 방식별 통계</h2>
          </div>
          {(["card", "transfer"] as const).map((m) => {
            const rows = proposals
              .flatMap((p) => p.payments)
              .filter((x) => x.method === m);
            return (
              <div className="stat-row" key={m}>
                <b>{methodName[m]}</b>
                <span>{rows.length}개 항목</span>
                <span>예정 {won(rows.reduce((a, x) => a + x.planned, 0))}</span>
                <strong>
                  집행{" "}
                  {won(
                    rows
                      .filter((x) => stageDone(x, "payment"))
                      .reduce((a, x) => a + (x.actual ?? 0), 0),
                  )}
                </strong>
              </div>
            );
          })}
        </section>
        <section className="panel">
          <div className="panel-title">
            <h2>월별 실제 집행</h2>
          </div>
          {months.length ? (
            months.map((m) => (
              <div className="stat-row" key={m}>
                <b>{m}</b>
                <strong>
                  {won(
                    proposals
                      .flatMap((p) => p.payments)
                      .filter(
                        (x) =>
                          stageDone(x, "payment") &&
                          x.stages.payment.date.startsWith(m),
                      )
                      .reduce((a, x) => a + (x.actual ?? 0), 0),
                  )}
                </strong>
              </div>
            ))
          ) : (
            <p className="empty">결제 완료 내역이 없습니다.</p>
          )}
        </section>
      </div>
      <section className="panel">
        <div className="panel-title">
          <h2>지원사업별 현황</h2>
        </div>
        {projects.map((name) => {
          const rows = allocations.filter(
            (r) =>
              r.a.source === "grant" &&
              (r.a.project || "사업명 미입력") === name,
          );
          return (
            <div className="stat-row" key={name}>
              <Badge tone="purple">{name}</Badge>
              <span>{new Set(rows.map((r) => r.p.id)).size}건</span>
              <span>예정 {won(rows.reduce((a, r) => a + r.a.amount, 0))}</span>
              <strong>
                집행{" "}
                {won(
                  Math.round(
                    rows.reduce(
                      (a, r) =>
                        a +
                        (stageDone(r.x, "payment") && r.x.planned > 0
                          ? ((r.x.actual ?? 0) * r.a.amount) / r.x.planned
                          : 0),
                      0,
                    ),
                  ),
                )}
              </strong>
            </div>
          );
        })}
        {!projects.length && (
          <p className="empty">등록된 지원사업이 없습니다.</p>
        )}
      </section>
    </div>
  );
}
function SettingsPanel({
  settings,
  user,
  onSave,
  onError,
  run,
  onSeed,
}: {
  settings: Settings;
  user: User;
  onSave: (s: Settings) => void;
  onError: (e: unknown) => void;
  run: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
  onSeed: () => void;
}) {
  const [value, setValue] = useState(clone(settings)),
    [users, setUsers] = useState<(User & { active: number })[]>([]),
    [account, setAccount] = useState({
      username: "",
      name: "",
      role: "staff",
      password: "",
    }),
    [password, setPassword] = useState({ current: "", next: "" }),
    [history, setHistory] = useState<Audit[]>([]),
    [recoveryBackups, setRecoveryBackups] = useState<{ id: string }[]>([]);
  useEffect(() => setValue(clone(settings)), [settings]);
  const loadUsers = () =>
    api<(User & { active: number })[]>("/users").then(setUsers);
  useEffect(() => {
    if (user.role === "admin") loadUsers().catch(onError);
    api<Audit[]>("/audit").then(setHistory).catch(onError);
  }, []);
  useEffect(() => {
    if (user.role === "admin")
      api<{ id: string }[]>("/recovery-backups")
        .then(setRecoveryBackups)
        .catch(onError);
  }, [settings]);
  const move = (index: number, direction: number) => {
    const stages = clone(value.stages);
    [stages[index], stages[index + direction]] = [
      stages[index + direction],
      stages[index],
    ];
    setValue({ ...value, stages });
  };
  return (
    <div className="settings-layout">
      {user.role === "admin" && (
        <>
          <section className="panel">
            <div className="panel-title">
              <div>
                <h2>업무 단계 및 알림</h2>
                <p>
                  순서와 필수 여부는 관리 모델에 적용됩니다. 결제 완료는 항상
                  필요합니다.
                </p>
              </div>
            </div>
            <div className="settings-body">
              <div className="form-grid">
                {(
                  [
                    ["commitDays", "접수 후 원인행위 알림 (일)"],
                    ["dueDays", "결제·지급 임박 기준 (일)"],
                    ["resolutionDays", "카드결제 후 지출결의 알림 (일)"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      type="number"
                      min="0"
                      max={key === "dueDays" ? 60 : 365}
                      value={value[key]}
                      onChange={(e) =>
                        setValue({ ...value, [key]: Number(e.target.value) })
                      }
                    />
                  </label>
                ))}
              </div>
              {value.stages.map((s, i) => (
                <div className="settings-stage" key={s.id}>
                  <span>
                    <b>{i + 1}</b> {stageLabels[s.id]}
                  </span>
                  <label>
                    <input
                      type="checkbox"
                      checked={s.required}
                      onChange={(e) =>
                        setValue({
                          ...value,
                          stages: value.stages.map((x) =>
                            x.id === s.id
                              ? { ...x, required: e.target.checked }
                              : x,
                          ),
                        })
                      }
                    />{" "}
                    필수
                  </label>
                  <div>
                    <button disabled={i === 0} onClick={() => move(i, -1)}>
                      ↑
                    </button>
                    <button
                      disabled={i === value.stages.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>
                  </div>
                </div>
              ))}
              <button className="primary" onClick={() => onSave(value)}>
                설정 저장
              </button>
            </div>
          </section>
          <section className="panel">
            <div className="panel-title">
              <h2>사용자 관리</h2>
            </div>
            <div className="settings-body">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    await save("/users", account);
                    setAccount({
                      username: "",
                      name: "",
                      role: "staff",
                      password: "",
                    });
                    await loadUsers();
                  }, "사용자를 생성했습니다");
                }}
              >
                <div className="form-grid four">
                  <label>
                    아이디
                    <input
                      required
                      minLength={3}
                      value={account.username}
                      onChange={(e) =>
                        setAccount({ ...account, username: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    이름
                    <input
                      required
                      value={account.name}
                      onChange={(e) =>
                        setAccount({ ...account, name: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    권한
                    <select
                      value={account.role}
                      onChange={(e) =>
                        setAccount({ ...account, role: e.target.value })
                      }
                    >
                      <option value="staff">담당자 · 등록/수정</option>
                      <option value="viewer">조회자 · 조회/다운로드</option>
                      <option value="admin">관리자 · 전체 관리</option>
                    </select>
                  </label>
                  <label>
                    초기 비밀번호
                    <input
                      type="password"
                      required
                      minLength={12}
                      autoComplete="new-password"
                      value={account.password}
                      onChange={(e) =>
                        setAccount({ ...account, password: e.target.value })
                      }
                    />
                  </label>
                </div>
                <button type="submit">＋ 사용자 생성</button>
              </form>
              {users.map((u) => (
                <div className="user-row" key={u.id}>
                  <b>
                    {u.name} <small>{u.username}</small>
                  </b>
                  <select
                    aria-label={u.name + " 권한"}
                    disabled={u.id === user.id}
                    value={u.role}
                    onChange={(e) =>
                      run(async () => {
                        await save(
                          "/users/" + u.id,
                          { role: e.target.value, active: !!u.active },
                          "PUT",
                        );
                        await loadUsers();
                      })
                    }
                  >
                    <option value="admin">관리자</option>
                    <option value="staff">담당자</option>
                    <option value="viewer">조회자</option>
                  </select>
                  <Badge tone={u.active ? "green" : "red"}>
                    {u.active ? "활성" : "비활성"}
                  </Badge>
                  <button
                    disabled={u.id === user.id}
                    onClick={() =>
                      run(async () => {
                        await save(
                          "/users/" + u.id,
                          { role: u.role, active: !u.active },
                          "PUT",
                        );
                        await loadUsers();
                      })
                    }
                  >
                    {u.active ? "비활성화" : "활성화"}
                  </button>
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <div className="panel-title">
              <h2>백업·복원 및 예시 자료</h2>
            </div>
            <div className="settings-body">
              <p>
                업무 자료·설정·첨부파일을 JSON으로 백업합니다. 사용자와 기존
                변경 이력은 복원 대상에서 제외됩니다.
              </p>
              <div className="actions">
                <button
                  onClick={() =>
                    download("/backup", `school-backup-${today()}.json`).catch(
                      onError,
                    )
                  }
                >
                  ↓ 백업 다운로드
                </button>
                <label className="file-button">
                  ↑ 백업 복원
                  <input
                    type="file"
                    accept=".json"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (
                        file &&
                        confirm(
                          "현재 품의와 첨부 연결을 백업 내용으로 교체합니다. 계속할까요? (복원 전 자동 백업 생성)",
                        )
                      )
                        run(async () => {
                          if (file.size > 25 * 1024 * 1024)
                            throw new Error(
                              "웹 복원은 25MB 이하입니다. 큰 자료는 운영 문서의 전체 백업 절차를 사용하세요",
                            );
                          await save("/restore", JSON.parse(await file.text()));
                        }, "백업을 복원했습니다");
                      e.target.value = "";
                    }}
                  />
                </label>
                <button onClick={onSeed}>가상 예시 2건 생성</button>
              </div>
              {recoveryBackups.length > 0 && (
                <>
                  <h4>자동 복구 백업</h4>
                  <p>
                    원하는 시점의 백업을 다운로드한 뒤 백업 복원에서 선택하세요.
                  </p>
                  <div className="actions">
                    {recoveryBackups.map((b) => (
                      <button
                        key={b.id}
                        onClick={() =>
                          download(
                            "/recovery-backups/" + b.id,
                            `school-recovery-${b.id}.json`,
                          ).catch(onError)
                        }
                      >
                        ↓ {b.id.slice(0, 10)}{" "}
                        {b.id.length > 10 ? "복원 전" : "자동"}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <p className="muted">
                예시는 빈 데이터베이스에서만 생성됩니다. 매일 서버 실행 중 자동
                백업하며 최근 7개를 보관합니다.
              </p>
            </div>
          </section>
        </>
      )}
      <section className="panel">
        <div className="panel-title">
          <h2>내 비밀번호 변경</h2>
        </div>
        <form
          className="settings-body"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await save("/password", password);
              window.dispatchEvent(new Event("session-expired"));
            } catch (e) {
              onError(e);
            }
          }}
        >
          <div className="form-grid">
            <label>
              현재 비밀번호
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password.current}
                onChange={(e) =>
                  setPassword({ ...password, current: e.target.value })
                }
              />
            </label>
            <label>
              새 비밀번호 (12자 이상)
              <input
                type="password"
                minLength={12}
                required
                autoComplete="new-password"
                value={password.next}
                onChange={(e) =>
                  setPassword({ ...password, next: e.target.value })
                }
              />
            </label>
          </div>
          <button type="submit">변경 후 다시 로그인</button>
        </form>
      </section>
      <section className="panel">
        <div className="panel-title">
          <h2>최근 시스템 변경 이력</h2>
        </div>
        <div className="settings-body">
          {history.slice(0, 50).map((h) => (
            <div className="audit-row" key={h.id}>
              <Badge>{h.action}</Badge>
              <b>{h.actor}</b>
              <small>
                {new Date(h.at).toLocaleString("ko-KR", {
                  timeZone: "Asia/Seoul",
                })}
              </small>
            </div>
          ))}
          {!history.length && <p>이력이 없습니다.</p>}
        </div>
      </section>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
