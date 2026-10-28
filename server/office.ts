import type { Express } from "express";
import { readFileSync } from "node:fs";
import { db, transaction } from "./storage.ts";
import { OfficeStore, tables } from "../shared/office-store.ts";
import {
  generatePlan,
  generatePurpose,
  schemas,
  type Kind,
} from "../shared/office.ts";
import { listProposals } from "./db.ts";
export const office = new OfficeStore({
  all: async (sql, args = []) => db.prepare(sql).all(...(args as never[])),
  batch: async (statements) =>
    transaction(async () => {
      for (const s of statements)
        await db.prepare(s.sql).run(...((s.args as never[]) || []));
    }),
});
export async function registerOffice(app: Express) {
  await db.exec(
    readFileSync(
      new URL("../migrations/0001_office.sql", import.meta.url),
      "utf8",
    ),
  );
  // Preserve the original audit log while reflecting future legacy expense actions in the daily report.
  await db.exec(`CREATE TRIGGER IF NOT EXISTS office_legacy_activity AFTER INSERT ON audit
    WHEN NEW.action IN ('품의 등록','품의 수정','품의 삭제')
    BEGIN
      INSERT OR IGNORE INTO activity_logs(id,user_id,entity_type,entity_id,action_type,title,description,previous_value,new_value,created_at)
      VALUES('legacy-' || NEW.id,NEW.user_id,'legacy',NEW.target,NEW.action,
        COALESCE((SELECT json_extract(data,'$.title') FROM proposals WHERE id=NEW.target),'기존 지출업무'),
        NEW.action,NULL,NEW.detail,NEW.at);
      UPDATE office_revision SET version=version+1 WHERE id=1;
    END;`);
  app.get("/api/office/activities", async (req, res) =>
    res.json(
      await office.logs(
        typeof req.query.date === "string" ? req.query.date : undefined,
      ),
    ),
  );
  app.get("/api/office/backup", async (_req, res) => {
    if (res.locals.user.role !== "admin")
      return res.status(403).json({ error: "관리자만 백업할 수 있습니다" });
    res.json(await office.backup());
  });
  app.get("/api/office/snapshots", async (_req, res) => {
    if (res.locals.user.role !== "admin")
      return res.status(403).json({ error: "관리자 권한이 필요합니다" });
    res.json(
      await db
        .prepare(
          "SELECT id,created_at FROM office_snapshots ORDER BY created_at DESC",
        )
        .all(),
    );
  });
  app.get("/api/office/snapshots/:id", async (req, res) => {
    if (res.locals.user.role !== "admin")
      return res.status(403).json({ error: "관리자 권한이 필요합니다" });
    const row = await db
      .prepare("SELECT data FROM office_snapshots WHERE id=?")
      .get(String(req.params.id));
    if (!row) return res.status(404).json({ error: "백업을 찾을 수 없습니다" });
    res.json(JSON.parse(row.data));
  });
  app.post("/api/office/restore", async (req, res) => {
    if (res.locals.user.role !== "admin")
      return res.status(403).json({ error: "관리자 권한이 필요합니다" });
    res.json(await office.restore(req.body, res.locals.user.id));
  });
  app.post("/api/office/generate", async (req, res) => {
    if (req.body.type === "purpose") {
      const name = String(req.body.name || "").slice(0, 200);
      const old = (await office.list("templates")).find(
        (x) => x.type === "purpose" && x.title === name,
      );
      return res.json({
        content:
          old?.content ||
          generatePurpose(name, String(req.body.location || "")),
      });
    }
    res.json({ content: generatePlan(schemas.facilities.parse(req.body)) });
  });
  app.post("/api/office/import-legacy", async (_req, res) => {
    if (res.locals.user.role !== "admin")
      return res.status(403).json({ error: "관리자 권한이 필요합니다" });
    let count = 0;
    const existing = await office.list("projects");
    for (const p of await listProposals()) {
      if (existing.some((x) => x.legacyId === p.id)) continue;
      await office.put(
        "projects",
        {
          id: p.id,
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
          legacyId: p.id,
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
        },
        res.locals.user.id,
      );
      count++;
    }
    res.json({ count });
  });
  app.get("/api/office/:kind", async (req, res) => {
    const kind = req.params.kind as Kind;
    if (!Object.hasOwn(tables, kind))
      return res.status(404).json({ error: "메뉴를 찾을 수 없습니다" });
    res.json(await office.list(kind));
  });
  app.post("/api/office/:kind", async (req, res) => {
    if (res.locals.user.role === "viewer")
      return res.status(403).json({ error: "조회자는 수정할 수 없습니다" });
    const kind = req.params.kind as Kind;
    if (!Object.hasOwn(tables, kind))
      return res.status(404).json({ error: "메뉴를 찾을 수 없습니다" });
    res.status(201).json(await office.put(kind, req.body, res.locals.user.id));
  });
  for (const method of ["put", "delete"] as const)
    app[method]("/api/office/:kind/:id", async (req, res) => {
      if (
        res.locals.user.role === "viewer" ||
        (method === "delete" && res.locals.user.role !== "admin")
      )
        return res
          .status(403)
          .json({ error: "이 작업에 대한 권한이 없습니다" });
      const kind = req.params.kind as Kind;
      if (!Object.hasOwn(tables, kind))
        return res.status(404).json({ error: "메뉴를 찾을 수 없습니다" });
      res.json(
        await office.put(
          kind,
          req.body,
          res.locals.user.id,
          String(req.params.id),
          method === "delete",
        ),
      );
    });
}
