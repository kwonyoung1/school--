import express from "express";
import {
  databaseAttachments,
  readAttachment,
  writeAttachment,
  removeAttachment,
  transaction,
} from "./storage.ts";
import helmet from "helmet";
import multer from "multer";
import ExcelJS from "exceljs";
import { z } from "zod";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  readdirSync,
  mkdirSync,
  cpSync,
} from "node:fs";
import { resolve, join } from "node:path";
import {
  db,
  dataDir,
  passwordHash,
  passwordMatches,
  audit,
  listProposals,
  getProposal,
  getSettings,
  insertProposal,
  seed,
} from "./db.ts";
import {
  proposalSchema,
  settingsSchema,
  today,
  type ProposalInput,
  type Proposal,
} from "./domain.ts";
import { registerOffice } from "./office.ts";
import { OfficeError } from "../shared/office-store.ts";
const app = express();
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy:
      process.env.NODE_ENV === "production"
        ? {
            directives: {
              "script-src": ["'self'"],
              "img-src": ["'self'", "data:"],
              "connect-src": ["'self'"],
              "upgrade-insecure-requests": null,
            },
          }
        : false,
    strictTransportSecurity:
      process.env.SECURE_COOKIE === "true" ? undefined : false,
  }),
);
app.use(express.json({ limit: "30mb" }));
// Render probes this public endpoint; no financial or user data is exposed.
app.get("/api/health", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    await db.prepare("SELECT 1").get();
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
type User = {
  id: string;
  username: string;
  name: string;
  role: "admin" | "staff" | "viewer";
  active: number;
  password: string;
};
type Session = {
  csrf: string;
  expires: number;
};
const wrap =
  (fn: (req: express.Request, res: express.Response) => unknown) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  };
const auth: express.RequestHandler = async (req, res, next) => {
  const token = req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("sid="))
    ?.slice(4);
  const session = token
    ? ((await db
        .prepare(
          "SELECT sessions.*, users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>? AND active=1",
        )
        .get(digest(token), Date.now())) as (User & Session) | undefined)
    : undefined;
  if (!session) {
    res.status(401).json({ error: "로그인이 필요합니다" });
    return;
  }
  res.locals.user = session;
  res.locals.csrf = session.csrf;
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (req.headers["x-csrf-token"] !== session.csrf) {
      res
        .status(403)
        .json({ error: "요청 검증에 실패했습니다. 다시 로그인하세요" });
      return;
    }
  }
  next();
};
const role =
  (roles: string[]): express.RequestHandler =>
  (_req, res, next) => {
    if (!roles.includes(res.locals.user.role)) {
      res.status(403).json({ error: "이 작업에 대한 권한이 없습니다" });
      return;
    }
    next();
  };
const writer = role(["admin", "staff"]);
const admin = role(["admin"]);
const transact = transaction;
app.post(
  "/api/login",
  wrap(async (req, res) => {
    const input = z
      .object({
        username: z.string().min(1).max(100),
        password: z.string().min(1).max(200),
      })
      .parse(req.body);
    const key = digest(req.socket.remoteAddress + "|" + input.username);
    const attempt = (await db
      .prepare("SELECT * FROM login_attempts WHERE key=?")
      .get(key)) as
      | {
          count: number;
          until_at: number;
        }
      | undefined;
    if (attempt && attempt.until_at > Date.now() && attempt.count >= 5)
      return res
        .status(429)
        .json({ error: "로그인 시도가 많습니다. 15분 후 다시 시도하세요" });
    const user = (await db
      .prepare("SELECT * FROM users WHERE username=? AND active=1")
      .get(input.username)) as User | undefined;
    if (!passwordMatches(input.password, user?.password || dummyHash)) {
      const count =
        attempt && attempt.until_at > Date.now() ? attempt.count + 1 : 1;
      await db
        .prepare("INSERT OR REPLACE INTO login_attempts VALUES(?,?,?)")
        .run(key, count, Date.now() + 15 * 60 * 1000);
      return res
        .status(401)
        .json({ error: "아이디 또는 비밀번호가 올바르지 않습니다" });
    }
    if (!user) return res.status(401).json({ error: "로그인 실패" });
    await db.prepare("DELETE FROM login_attempts WHERE key=?").run(key);
    await db.prepare("DELETE FROM sessions WHERE expires<=?").run(Date.now());
    const token = randomBytes(32).toString("hex"),
      csrf = randomBytes(32).toString("hex");
    await db
      .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
      .run(digest(token), user.id, csrf, Date.now() + 8 * 60 * 60 * 1000);
    res.cookie("sid", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.SECURE_COOKIE === "true",
      maxAge: 8 * 60 * 60 * 1000,
      path: "/",
    });
    await audit(user, "로그인", "", "세션 발급");
    return res.json({
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
      },
      csrf,
    });
  }),
);
const dummyHash = passwordHash(randomBytes(32).toString("hex"));
app.use(
  "/api",
  (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  },
  auth,
);
await registerOffice(app);
app.get("/api/me", (_req, res) => {
  const { id, username, name, role } = res.locals.user;
  res.json({ user: { id, username, name, role }, csrf: res.locals.csrf });
});
app.post("/api/logout", async (req, res) => {
  const token = req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("sid="))
    ?.slice(4);
  if (token)
    await db.prepare("DELETE FROM sessions WHERE token=?").run(digest(token));
  res.clearCookie("sid", { path: "/" }).json({ ok: true });
});
app.get("/api/proposals", async (_req, res) => res.json(await listProposals()));
app.post(
  "/api/proposals",
  writer,
  wrap(async (req, res) => {
    const input = proposalSchema.parse(req.body);
    const p = await transact(async () => {
      const p = await insertProposal(input);
      await audit(res.locals.user, "품의 등록", p.id, JSON.stringify(p));
      return p;
    });
    res.status(201).json(p);
  }),
);
app.put(
  "/api/proposals/:id",
  writer,
  wrap(async (req, res) => {
    const input = proposalSchema.parse(req.body);
    const version = z.number().int().positive().parse(req.body.version);
    const p = await transact(async () => {
      const current = await getProposal(String(req.params.id));
      if (!current) return null;
      if (current.version !== version) return "conflict";
      const attached = (await db
        .prepare("SELECT payment_id FROM attachments WHERE proposal_id=?")
        .all(current.id)) as {
        payment_id: string;
      }[];
      if (
        attached.some((a) => !input.payments.some((x) => x.id === a.payment_id))
      )
        return "attachments";
      const updated = {
        ...input,
        id: current.id,
        management: current.management,
        createdAt: current.createdAt,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      await db
        .prepare("UPDATE proposals SET data=?,version=? WHERE id=?")
        .run(JSON.stringify(updated), updated.version, current.id);
      await audit(
        res.locals.user,
        "품의 수정",
        current.id,
        JSON.stringify({ before: current, after: updated }),
      );
      return updated;
    });
    if (!p) return res.status(404).json({ error: "품의를 찾을 수 없습니다" });
    if (p === "conflict")
      return res.status(409).json({
        error:
          "다른 사용자가 수정했습니다. 목록을 새로고침한 후 다시 수정하세요",
      });
    if (p === "attachments")
      return res.status(400).json({
        error:
          "첨부파일이 연결된 결제 항목은 삭제할 수 없습니다. 증빙 첨부 탭에서 파일을 먼저 삭제하세요",
      });
    return res.json(p);
  }),
);
app.delete(
  "/api/proposals/:id",
  admin,
  wrap(async (req, res) => {
    const input = z
      .object({
        version: z.number().int().positive(),
        confirmation: z.string(),
      })
      .parse(req.body);
    const current = await getProposal(String(req.params.id));
    if (!current)
      return res.status(404).json({ error: "품의를 찾을 수 없습니다" });
    if (input.confirmation !== current.management)
      return res
        .status(400)
        .json({ error: "삭제할 관리번호가 일치하지 않습니다" });
    if (input.version !== current.version)
      return res.status(409).json({
        error: "다른 사용자가 수정했습니다. 새로고침 후 다시 삭제하세요",
      });
    await makeBackup(true);
    const result = await transact(async () => {
      const p = await getProposal(current.id);
      if (!p) return "missing";
      if (p.version !== input.version) return "conflict";
      await db
        .prepare("INSERT INTO proposal_deletions VALUES(?,?,?)")
        .run(p.id, new Date().toISOString(), res.locals.user.id);
      await audit(res.locals.user, "품의 삭제", p.id, JSON.stringify(p));
      return "ok";
    });
    if (result === "missing")
      return res.status(404).json({ error: "이미 삭제된 품의입니다" });
    if (result === "conflict")
      return res.status(409).json({
        error: "다른 사용자가 수정했습니다. 새로고침 후 다시 삭제하세요",
      });
    return res.json({ ok: true });
  }),
);
app.get("/api/settings", async (_req, res) => res.json(await getSettings()));
app.put(
  "/api/settings",
  admin,
  wrap(async (req, res) => {
    const settings = settingsSchema.parse(req.body);
    await transact(async () => {
      const before = await getSettings();
      await db
        .prepare("UPDATE settings SET data=? WHERE id=1")
        .run(JSON.stringify(settings));
      await audit(
        res.locals.user,
        "설정 변경",
        "settings",
        JSON.stringify({ before, after: settings }),
      );
    });
    res.json(settings);
  }),
);
app.get(
  "/api/audit",
  wrap(async (req, res) => {
    const target = req.query.target;
    const rows = target
      ? await db
          .prepare(
            "SELECT * FROM audit WHERE target=? ORDER BY id DESC LIMIT 300",
          )
          .all(String(target))
      : await db
          .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 300")
          .all();
    res.json(rows);
  }),
);
app.get("/api/users", admin, async (_req, res) =>
  res.json(
    await db.prepare("SELECT id,username,name,role,active FROM users").all(),
  ),
);
const userSchema = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_.-]{3,40}$/),
  name: z.string().trim().min(1).max(100),
  role: z.enum(["admin", "staff", "viewer"]),
  password: z.string().min(12).max(200),
});
app.post(
  "/api/users",
  admin,
  wrap(async (req, res) => {
    const u = userSchema.parse(req.body),
      id = randomUUID();
    await transact(async () => {
      await db
        .prepare(
          "INSERT INTO users(id,username,name,role,password) VALUES(?,?,?,?,?)",
        )
        .run(id, u.username, u.name, u.role, passwordHash(u.password));
      await audit(
        res.locals.user,
        "사용자 생성",
        id,
        u.username + " / " + u.role,
      );
    });
    res
      .status(201)
      .json({ id, username: u.username, name: u.name, role: u.role });
  }),
);
app.put(
  "/api/users/:id",
  admin,
  wrap(async (req, res) => {
    const input = z
      .object({
        active: z.boolean(),
        role: z.enum(["admin", "staff", "viewer"]),
      })
      .parse(req.body);
    const id = String(req.params.id);
    if (id === res.locals.user.id)
      return res
        .status(400)
        .json({ error: "자신의 관리자 권한은 이 화면에서 변경할 수 없습니다" });
    await transact(async () => {
      await db
        .prepare("UPDATE users SET active=?,role=? WHERE id=?")
        .run(input.active ? 1 : 0, input.role, id);
      await db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
      await audit(
        res.locals.user,
        "사용자 권한 변경",
        id,
        JSON.stringify(input),
      );
    });
    return res.json({ ok: true });
  }),
);
app.post(
  "/api/password",
  wrap(async (req, res) => {
    const p = z
      .object({
        current: z.string().max(200),
        next: z.string().min(12).max(200),
      })
      .parse(req.body);
    if (!passwordMatches(p.current, res.locals.user.password))
      return res
        .status(400)
        .json({ error: "현재 비밀번호가 올바르지 않습니다" });
    await transact(async () => {
      await db
        .prepare("UPDATE users SET password=? WHERE id=?")
        .run(passwordHash(p.next), res.locals.user.id);
      await db
        .prepare("DELETE FROM sessions WHERE user_id=?")
        .run(res.locals.user.id);
      await audit(
        res.locals.user,
        "비밀번호 변경",
        res.locals.user.id,
        "모든 세션 만료",
      );
    });
    res.clearCookie("sid", { path: "/" });
    return res.json({ ok: true });
  }),
);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5 },
});
function fileMime(buffer: Buffer) {
  if (buffer.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
    return "image/jpeg";
  return null;
}
app.get("/api/proposals/:id/attachments", async (req, res) => {
  if (!(await getProposal(String(req.params.id))))
    return res.status(404).json({ error: "품의를 찾을 수 없습니다" });
  return res.json(
    await db
      .prepare(
        "SELECT id,proposal_id,payment_id,name,mime,size,created_at FROM attachments WHERE proposal_id=?",
      )
      .all(String(req.params.id)),
  );
});
app.post(
  "/api/proposals/:id/attachments",
  writer,
  upload.single("file"),
  wrap(async (req, res) => {
    const p = await getProposal(String(req.params.id));
    if (!p) return res.status(404).json({ error: "품의가 없습니다" });
    const paymentId = z.string().uuid().parse(req.body.paymentId);
    if (!p.payments.some((x) => x.id === paymentId))
      return res.status(400).json({ error: "결제 항목을 찾을 수 없습니다" });
    const f = req.file;
    if (!f) return res.status(400).json({ error: "파일을 선택하세요" });
    const mime = fileMime(f.buffer);
    const extension =
      mime === "application/pdf"
        ? ".pdf"
        : mime === "image/png"
          ? ".png"
          : mime === "image/jpeg"
            ? ".jpg"
            : "";
    if (
      !mime ||
      !new RegExp(
        mime === "image/jpeg"
          ? "\\.(jpe?g)$"
          : extension.replace(".", "\\.") + "$",
        "i",
      ).test(f.originalname)
    )
      return res.status(400).json({
        error:
          "내용이 확인된 PDF, PNG, JPG 파일만 첨부할 수 있습니다 (최대 10MB)",
      });
    const name = f.originalname.replace(/[\\/\x00-\x1f]/g, "_").slice(0, 200);
    const id = randomUUID();
    try {
      await transact(async () => {
        await writeAttachment(id, f.buffer);
        await db
          .prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?)")
          .run(
            id,
            p.id,
            paymentId,
            name,
            mime,
            f.size,
            id,
            new Date().toISOString(),
          );
        await audit(res.locals.user, "파일 첨부", p.id, name);
      });
    } catch (e) {
      await removeAttachment(id);
      throw e;
    }
    return res.status(201).json({ id, name });
  }),
);
app.get(
  "/api/attachments/:id",
  wrap(async (req, res) => {
    const a = (await db
      .prepare(
        "SELECT a.* FROM attachments a WHERE NOT EXISTS (SELECT 1 FROM proposal_deletions d WHERE d.proposal_id=a.proposal_id) AND a.id=?",
      )
      .get(String(req.params.id))) as
      | {
          name: string;
          mime: string;
          path: string;
          proposal_id: string;
        }
      | undefined;
    if (!a || !(await getProposal(a.proposal_id)))
      return res.status(404).json({ error: "파일이 없습니다" });
    res.setHeader("Content-Type", a.mime);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.send(await readAttachment(a.path));
  }),
);
app.delete(
  "/api/attachments/:id",
  writer,
  wrap(async (req, res) => {
    const a = (await db
      .prepare(
        "SELECT a.* FROM attachments a WHERE NOT EXISTS (SELECT 1 FROM proposal_deletions d WHERE d.proposal_id=a.proposal_id) AND a.id=?",
      )
      .get(String(req.params.id))) as
      | {
          name: string;
          path: string;
          proposal_id: string;
        }
      | undefined;
    if (!a || !(await getProposal(a.proposal_id)))
      return res.status(404).json({ error: "파일이 없습니다" });
    await transact(async () => {
      await db
        .prepare("DELETE FROM attachments WHERE id=?")
        .run(String(req.params.id));
      await audit(res.locals.user, "파일 삭제", a.proposal_id, a.name);
    });
    await removeAttachment(a.path);
    return res.json({ ok: true });
  }),
);
const excelHeaders = [
  "관리번호",
  "품의번호",
  "품의 제목",
  "부서",
  "신청자",
  "결재일",
  "접수일",
  "품의 총금액",
  "예산과목",
  "처리기한",
  "비고",
  "조정사유",
  "결제ID",
  "결제방식",
  "업체명",
  "예정금액",
  "실제금액",
  "결제예정일",
  "지출결의예정일",
  "결제비고",
  "재원배분(JSON)",
  "증빙(JSON)",
  "단계(JSON)",
];
app.get(
  "/api/export",
  wrap(async (req, res) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("지출업무");
    sheet.addRow(excelHeaders);
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = { from: "A1", to: "W1" };
    const ids =
      typeof req.query.ids === "string"
        ? new Set(req.query.ids.split(","))
        : null;
    for (const p of (await listProposals()).filter(
      (p) => !ids || ids.has(p.id),
    ))
      for (const x of p.payments)
        sheet.addRow([
          p.management,
          p.number,
          p.title,
          p.department,
          p.applicant,
          p.approved,
          p.received,
          p.total,
          p.budget,
          p.due,
          p.note,
          p.adjustmentReason,
          x.id,
          x.method,
          x.vendor,
          x.planned,
          x.actual,
          x.due,
          x.resolutionDue,
          x.note,
          JSON.stringify(x.allocations),
          JSON.stringify(x.documents),
          JSON.stringify(x.stages),
        ]);
    sheet.columns.forEach((c, i) => {
      c.width = i >= 20 ? 40 : 20;
    });
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="expenses-${today()}.xlsx"`,
    );
    await workbook.xlsx.write(res);
    res.end();
  }),
);
function checkZip(buffer: Buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("올바른 XLSX 파일이 아닙니다");
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16),
    size = 0;
  if (count > 2000 || count === 65535)
    throw new Error("엑셀 파일이 너무 큽니다");
  for (let i = 0; i < count; i++) {
    if (
      cursor + 46 > buffer.length ||
      buffer.readUInt32LE(cursor) !== 0x02014b50
    )
      throw new Error("잘못된 엑셀 압축 구조");
    size += buffer.readUInt32LE(cursor + 24);
    if (size > 50 * 1024 * 1024)
      throw new Error("엑셀 압축 해제 크기가 50MB를 넘습니다");
    cursor +=
      46 +
      buffer.readUInt16LE(cursor + 28) +
      buffer.readUInt16LE(cursor + 30) +
      buffer.readUInt16LE(cursor + 32);
  }
}
app.post(
  "/api/import",
  writer,
  upload.single("file"),
  wrap(async (req, res) => {
    if (!req.file)
      return res.status(400).json({ error: "XLSX 파일을 선택하세요" });
    checkZip(req.file.buffer);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer as never);
    const sheet = workbook.getWorksheet("지출업무");
    if (!sheet || sheet.rowCount > 2001)
      return res.status(400).json({
        error: "지출업무 시트가 필요하며 최대 2,000행을 등록할 수 있습니다",
      });
    if (excelHeaders.some((s, i) => sheet.getRow(1).getCell(i + 1).value !== s))
      return res
        .status(400)
        .json({ error: "내보낸 엑셀 양식의 열 제목을 유지해 주세요" });
    const groups = new Map<string, ProposalInput>();
    for (let n = 2; n <= sheet.rowCount; n++) {
      const row = sheet.getRow(n);
      if (!row.getCell(3).value) continue;
      const cell = (i: number) => {
        const v = row.getCell(i).value;
        if (v !== null && typeof v !== "string" && typeof v !== "number")
          throw new Error(`${n}행: 수식 및 객체 셀은 사용할 수 없습니다`);
        return v;
      };
      const str = (i: number) => String(cell(i) ?? "");
      const num = (i: number) => Number(cell(i));
      const key = str(1) || `row-${n}`;
      const input = {
        number: str(2),
        title: str(3),
        department: str(4),
        applicant: str(5),
        approved: str(6),
        received: str(7),
        total: num(8),
        budget: str(9),
        due: str(10),
        note: str(11),
        adjustmentReason: str(12),
        payments: [],
      };
      const existing = groups.get(key);
      if (
        existing &&
        JSON.stringify({ ...existing, payments: [] }) !== JSON.stringify(input)
      )
        throw new Error(`${n}행: 동일 관리번호의 기본 정보가 서로 다릅니다`);
      const p = existing || input;
      const payment = {
        id: str(13) || randomUUID(),
        method: str(14),
        vendor: str(15),
        planned: num(16),
        actual: cell(17) === null ? null : num(17),
        due: str(18),
        resolutionDue: str(19),
        note: str(20),
        allocations: JSON.parse(str(21)),
        documents: JSON.parse(str(22)),
        stages: JSON.parse(str(23)),
      };
      p.payments.push(payment as ProposalInput["payments"][number]);
      groups.set(key, p);
    }
    if (!groups.size)
      return res.status(400).json({ error: "등록할 품의가 없습니다" });
    const inputs = [...groups.values()].map((x) => proposalSchema.parse(x));
    await transact(async () => {
      for (const input of inputs) {
        const p = await insertProposal(input);
        await audit(res.locals.user, "엑셀 등록", p.id, JSON.stringify(p));
      }
    });
    return res.json({ count: inputs.length });
  }),
);
async function businessBackup(snapshot?: {
  proposals: Proposal[];
  settings: unknown;
  attachments: any[];
}) {
  return transact(async () => {
    const attachments =
      snapshot?.attachments ||
      (await db
        .prepare(
          "SELECT a.* FROM attachments a WHERE NOT EXISTS (SELECT 1 FROM proposal_deletions d WHERE d.proposal_id=a.proposal_id)",
        )
        .all());
    const files = [];
    for (const a of attachments)
      files.push({
        ...a,
        content: (await readAttachment(a.path)).toString("base64"),
      });
    return {
      format: "school-expense-v1",
      exportedAt: new Date().toISOString(),
      proposals: snapshot?.proposals || (await listProposals()),
      settings: snapshot?.settings || (await getSettings()),
      attachments: files,
    };
  });
}
app.get(
  "/api/backup",
  admin,
  wrap(async (_req, res) => {
    const data = await businessBackup();
    await audit(
      res.locals.user,
      "백업 다운로드",
      "backup",
      "업무 자료, 첨부, 설정",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="school-backup-${today()}.json"`,
    );
    res.json(data);
  }),
);
app.get(
  "/api/recovery-backups",
  admin,
  wrap(async (_req, res) =>
    res.json(
      await db
        .prepare("SELECT id FROM recovery_snapshots ORDER BY id DESC")
        .all(),
    ),
  ),
);
app.get(
  "/api/recovery-backups/:id",
  admin,
  wrap(async (req, res) => {
    const row = await db
      .prepare("SELECT data FROM recovery_snapshots WHERE id=?")
      .get(String(req.params.id));
    if (!row) return res.status(404).json({ error: "백업을 찾을 수 없습니다" });
    const data = await businessBackup(JSON.parse(row.data));
    await audit(
      res.locals.user,
      "자동 백업 다운로드",
      String(req.params.id),
      "업무 자료, 첨부, 설정",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="school-recovery-backup.json"`,
    );
    return res.json(data);
  }),
);
const backupProposal = proposalSchema.safeExtend({
  id: z.string().uuid(),
  management: z.string().regex(/^\d{4}-\d{5,}$/),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const backupSchema = z.object({
  format: z.literal("school-expense-v1"),
  settings: settingsSchema,
  proposals: z.array(backupProposal).max(2000),
  attachments: z
    .array(
      z.object({
        id: z.string().uuid(),
        proposal_id: z.string().uuid(),
        payment_id: z.string().uuid(),
        name: z.string().min(1).max(200),
        mime: z.enum(["application/pdf", "image/png", "image/jpeg"]),
        size: z
          .number()
          .int()
          .min(1)
          .max(10 * 1024 * 1024),
        created_at: z.iso.datetime(),
        content: z.string().max(14 * 1024 * 1024),
      }),
    )
    .max(2000),
});
app.post(
  "/api/restore",
  admin,
  wrap(async (req, res) => {
    const b = backupSchema.parse(req.body);
    if (
      new Set(b.proposals.map((p) => p.id)).size !== b.proposals.length ||
      new Set(b.proposals.map((p) => p.management)).size !==
        b.proposals.length ||
      new Set(b.attachments.map((a) => a.id)).size !== b.attachments.length
    )
      return res.status(400).json({ error: "백업에 중복 식별자가 있습니다" });
    const files = b.attachments.map((a) => {
      const p = b.proposals.find((p) => p.id === a.proposal_id),
        buffer = Buffer.from(a.content, "base64");
      if (
        !p?.payments.some((x) => x.id === a.payment_id) ||
        buffer.length !== a.size ||
        fileMime(buffer) !== a.mime
      )
        throw new Error("백업 첨부파일 검증에 실패했습니다");
      return { a, buffer, path: randomUUID() };
    });
    await makeBackup(true);
    const written: string[] = [];
    try {
      await transact(async () => {
        for (const f of files) {
          await writeAttachment(f.path, f.buffer);
          written.push(f.path);
        }
        await db.exec(
          "DELETE FROM proposal_deletions;DELETE FROM attachments;DELETE FROM proposals",
        );
        for (const p of b.proposals)
          await db
            .prepare("INSERT INTO proposals VALUES(?,?,?,?)")
            .run(p.id, p.management, p.version, JSON.stringify(p));
        for (const f of files)
          await db
            .prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?)")
            .run(
              f.a.id,
              f.a.proposal_id,
              f.a.payment_id,
              f.a.name,
              f.a.mime,
              f.a.size,
              f.path,
              f.a.created_at,
            );
        await db
          .prepare("UPDATE settings SET data=? WHERE id=1")
          .run(JSON.stringify(b.settings));
        await audit(
          res.locals.user,
          "백업 복원",
          "backup",
          `${b.proposals.length}건 / 복원 전 복구 백업 생성`,
        );
      });
    } catch (e) {
      for (const path of written) await removeAttachment(path);
      throw e;
    }
    return res.json({ count: b.proposals.length });
  }),
);
app.post(
  "/api/seed",
  admin,
  wrap(async (_req, res) => {
    if (await db.prepare("SELECT id FROM proposals LIMIT 1").get())
      return res.status(409).json({
        error: "빈 데이터베이스에서만 예시 자료를 생성할 수 있습니다",
      });
    await transact(async () => {
      await seed();
      await audit(res.locals.user, "예시 자료 생성", "seed", "가상 품의 2건");
    });
    return res.json({ ok: true });
  }),
);
async function makeBackup(force = false) {
  if (databaseAttachments) {
    const id = force ? `${today()}-${Date.now()}` : today();
    if (
      await db.prepare("SELECT id FROM recovery_snapshots WHERE id=?").get(id)
    )
      return;
    await transaction(async () => {
      const snapshot = {
        proposals: await listProposals(),
        settings: await getSettings(),
        attachments: await db
          .prepare(
            "SELECT a.* FROM attachments a WHERE NOT EXISTS (SELECT 1 FROM proposal_deletions d WHERE d.proposal_id=a.proposal_id)",
          )
          .all(),
      };
      await db
        .prepare("INSERT INTO recovery_snapshots VALUES(?,?)")
        .run(id, JSON.stringify(snapshot));
      const old = await db
        .prepare(
          "SELECT id FROM recovery_snapshots ORDER BY id DESC LIMIT -1 OFFSET 7",
        )
        .all();
      for (const row of old)
        await db
          .prepare("DELETE FROM recovery_snapshots WHERE id=?")
          .run(row.id);
      const paths = await db
        .prepare("SELECT DISTINCT path FROM attachment_chunks")
        .all();
      for (const row of paths) await removeAttachment(row.path);
    });
    return;
  }
  const base = join(dataDir, "backups");
  const name = force ? `${today()}-${Date.now()}` : today();
  const path = join(base, name);
  if (existsSync(path)) return;
  mkdirSync(path, { mode: 0o700 });
  try {
    const dbPath = join(path, "school.sqlite");
    await db.exec(`VACUUM INTO '${dbPath.replace(/'/g, "''")}'`);
    cpSync(join(dataDir, "uploads"), join(path, "uploads"), {
      recursive: true,
    });
  } catch (e) {
    rmSync(path, { recursive: true, force: true });
    throw e;
  }
  const dirs = readdirSync(base)
    .filter((x) => /^\d{4}-\d{2}-\d{2}(-\d+)?$/.test(x))
    .sort()
    .reverse();
  for (const old of dirs.slice(7))
    rmSync(join(base, old), { recursive: true, force: true });
}
await makeBackup();
const timer = setInterval(
  async () => {
    try {
      await makeBackup();
    } catch (e) {
      console.error("자동 백업 실패:", (e as Error).message);
    }
  },
  60 * 60 * 1000,
);
timer.unref();
if (process.env.NODE_ENV === "production") {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (req, res) => {
    if (req.path.startsWith("/api/"))
      return res.status(404).json({ error: "API를 찾을 수 없습니다" });
    return res.sendFile(resolve("dist/index.html"));
  });
}
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (error instanceof OfficeError)
      return res.status(error.status).json({ error: error.message });
    if (error instanceof z.ZodError)
      return res
        .status(400)
        .json({ error: error.issues.map((x) => x.message).join(" · ") });
    if (error instanceof multer.MulterError)
      return res
        .status(400)
        .json({ error: "파일 크기는 10MB 이하, 파일은 한 개만 업로드하세요" });
    console.error("요청 실패:", (error as Error).message);
    return res.status(400).json({
      error: "요청을 처리하지 못했습니다. 입력 데이터나 파일 형식을 확인하세요",
    });
  },
);
app.listen(
  Number(process.env.PORT || 3001),
  process.env.HOST || "127.0.0.1",
  () => console.log(`지출업무 서버 실행 (포트 ${process.env.PORT || 3001})`),
);
