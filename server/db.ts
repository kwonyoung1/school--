import { db, dataDir, transaction } from "./storage.ts";
export { db, dataDir, transaction } from "./storage.ts";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import {
  defaultSettings,
  today,
  type Proposal,
  type Payment,
  stageIds,
} from "./domain.ts";
await db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,password TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, management TEXT UNIQUE NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,user_id TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,detail TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL REFERENCES proposals(id),payment_id TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,path TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attachment_chunks(path TEXT NOT NULL,part INTEGER NOT NULL,content BLOB NOT NULL,PRIMARY KEY(path,part));
CREATE TABLE IF NOT EXISTS recovery_snapshots(id TEXT PRIMARY KEY,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until_at INTEGER NOT NULL);
`);
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}
export function passwordMatches(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}
export async function audit(
  user: {
    id: string;
    name: string;
  },
  action: string,
  target: string,
  detail: string,
) {
  await db
    .prepare(
      "INSERT INTO audit(at,user_id,actor,action,target,detail) VALUES(?,?,?,?,?,?)",
    )
    .run(new Date().toISOString(), user.id, user.name, action, target, detail);
}
if (!(await db.prepare("SELECT id FROM settings").get()))
  await db
    .prepare("INSERT INTO settings VALUES(1,?)")
    .run(JSON.stringify(defaultSettings));
if (!(await db.prepare("SELECT id FROM users LIMIT 1").get())) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 12)
    throw new Error(
      "최초 실행 시 ADMIN_PASSWORD에 12자 이상의 관리자 비밀번호를 설정하세요.",
    );
  await db
    .prepare(
      "INSERT INTO users(id,username,name,role,password) VALUES(?,?,?,?,?)",
    )
    .run(
      randomUUID(),
      process.env.ADMIN_USERNAME || "admin",
      "관리자",
      "admin",
      passwordHash(password),
    );
  console.log("최초 관리자 계정 생성 완료 (비밀번호는 출력하지 않습니다)");
}
export async function listProposals(): Promise<Proposal[]> {
  return (
    (await db
      .prepare("SELECT data FROM proposals ORDER BY management DESC")
      .all()) as {
      data: string;
    }[]
  ).map((x) => JSON.parse(x.data));
}
export async function getProposal(id: string): Promise<Proposal | undefined> {
  const row = (await db
    .prepare("SELECT data FROM proposals WHERE id=?")
    .get(id)) as
    | {
        data: string;
      }
    | undefined;
  return row ? JSON.parse(row.data) : undefined;
}
export async function getSettings() {
  return JSON.parse(
    (
      (await db.prepare("SELECT data FROM settings WHERE id=1").get()) as {
        data: string;
      }
    ).data,
  );
}
export async function insertProposal(
  input: Omit<
    Proposal,
    "id" | "management" | "version" | "createdAt" | "updatedAt"
  >,
): Promise<Proposal> {
  const id = randomUUID(),
    at = new Date().toISOString();
  const next = Number(
    (
      (await db
        .prepare(
          "SELECT COALESCE(MAX(CAST(substr(management,6) AS INTEGER)),0)+1 AS n FROM proposals WHERE management LIKE ?",
        )
        .get(today().slice(0, 4) + "-%")) as {
        n: number;
      }
    ).n,
  );
  const p: Proposal = {
    ...input,
    id,
    management: `${today().slice(0, 4)}-${String(next).padStart(5, "0")}`,
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
  await db
    .prepare("INSERT INTO proposals VALUES(?,?,?,?)")
    .run(id, p.management, p.version, JSON.stringify(p));
  return p;
}
export async function seed() {
  if ((await listProposals()).length) return;
  const date = today();
  const ago = (n: number) =>
    new Date(Date.parse(date) - n * 86400000).toISOString().slice(0, 10);
  const payment = (
    vendor: string,
    method: "card" | "transfer",
    amount: number,
    done: boolean,
    source: "school" | "grant",
  ): Payment => ({
    id: randomUUID(),
    vendor,
    method,
    planned: amount,
    actual: done ? amount : null,
    due: ago(1),
    resolutionDue: date,
    note: "가상 업체 및 테스트 거래입니다",
    allocations: [
      {
        source,
        project: source === "grant" ? "비즈쿨 지원사업" : "",
        agency: source === "grant" ? "가상교육청" : "",
        start: "",
        end: "",
        amount,
      },
    ],
    documents: (method === "card"
      ? ["영수증", "거래명세서"]
      : ["세금계산서·계산서", "거래명세서", "통장 사본", "사업자등록증"]
    ).map((name) => ({ name, required: true, received: done })),
    stages: Object.fromEntries(
      stageIds.map((id) => [
        id,
        {
          done: done || id === "receipt",
          date: done || id === "receipt" ? ago(7) : "",
          owner: done || id === "receipt" ? "가상 담당자" : "",
          note: "",
          document: done ? "TEST-001" : "",
          group: done ? "테스트 묶음" : " ",
        },
      ]),
    ) as Payment["stages"],
  });
  const base = {
    number: "TEST-2026-001",
    department: "정보교육부",
    applicant: "가상 교직원",
    approved: ago(8),
    received: ago(7),
    budget: "교육운영비",
    due: ago(1),
    note: "테스트용 가상 데이터",
    adjustmentReason: "",
  };
  await insertProposal({
    ...base,
    title: "정보관 실습실 기자재 구입 · 혼합결제 예시",
    total: 1000000,
    payments: [
      payment("가상 A업체", "card", 300000, true, "school"),
      payment("가상 B업체", "card", 200000, true, "grant"),
      payment("가상 C업체", "transfer", 500000, false, "grant"),
    ],
  });
  await insertProposal({
    ...base,
    number: "TEST-2026-002",
    title: "행정실 사무용품 구입 · 완료 예시",
    total: 150000,
    due: date,
    payments: [payment("가상 문구업체", "card", 150000, true, "school")],
  });
}
