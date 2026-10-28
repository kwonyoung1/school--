import {
  schemas,
  describeChanges,
  type Kind,
  type Activity,
  type RecordMeta,
} from "./office.ts";
export type Statement = { sql: string; args?: unknown[] };
export interface SQL {
  all(sql: string, args?: unknown[]): Promise<any[]>;
  batch(statements: Statement[]): Promise<void>;
}
export const tables: Record<Kind, string> = {
  facilities: "facility_tasks",
  purchases: "facility_purchases",
  vendors: "expense_vendors",
  projects: "expense_projects",
  templates: "item_purpose_templates",
  reports: "daily_reports",
  preferences: "user_settings",
};
export class OfficeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export class OfficeStore {
  sql: SQL;
  constructor(sql: SQL) {
    this.sql = sql;
  }
  async list(kind: Kind) {
    return (
      await this.sql.all(
        `SELECT data FROM ${tables[kind]} WHERE deleted=0 ORDER BY updated_at DESC`,
      )
    ).map((x) => JSON.parse(x.data));
  }
  async get(kind: Kind, id: string) {
    const rows = await this.sql.all(
      `SELECT data FROM ${tables[kind]} WHERE id=? AND deleted=0`,
      [id],
    );
    return rows[0] ? JSON.parse(rows[0].data) : null;
  }
  async logs(date?: string) {
    const rows = await this.sql.all(
      "SELECT * FROM activity_logs ORDER BY created_at DESC,id DESC",
    );
    return date
      ? rows.filter(
          (x) =>
            new Date(Date.parse(x.created_at) + 9 * 3600000)
              .toISOString()
              .slice(0, 10) === date,
        )
      : rows;
  }
  async put(
    kind: Kind,
    input: any,
    userId: string,
    id?: string,
    remove = false,
  ) {
    const before = id ? await this.get(kind, id) : null;
    if (id && !before) throw new OfficeError(404, "업무를 찾을 수 없습니다");
    if (id && input.version !== before.version)
      throw new OfficeError(
        409,
        "다른 기기에서 수정했습니다. 새로고침 후 다시 입력하세요",
      );
    const data = remove ? before : schemas[kind].parse(input);
    if (
      kind === "purchases" &&
      new Set(data.items.map((x: any) => x.id)).size !== data.items.length
    )
      throw new OfficeError(400, "물품 ID가 중복됩니다");
    const now = new Date().toISOString();
    const requestId = input.requestId || input.id;
    if (!id && requestId && !/^[0-9a-f-]{36}$/i.test(requestId))
      throw new OfficeError(400, "올바른 업무 식별자가 필요합니다");
    const after = {
      ...data,
      id: id || requestId || crypto.randomUUID(),
      version: (before?.version || 0) + 1,
      createdAt: before?.createdAt || now,
      updatedAt: now,
      userId: before?.userId || userId,
    };
    const table = tables[kind];
    const statements: Statement[] = [];
    if (id)
      statements.push(
        {
          sql: `UPDATE ${table} SET data=?,version=?,updated_at=?,deleted=? WHERE id=? AND version=? AND deleted=0`,
          args: [
            JSON.stringify(after),
            after.version,
            now,
            remove ? 1 : 0,
            id,
            before.version,
          ],
        },
        { sql: "INSERT INTO office_write_guard(value) VALUES(changes())" },
        { sql: "DELETE FROM office_write_guard" },
      );
    else
      statements.push({
        sql: `INSERT INTO ${table}(id,user_id,version,data,created_at,updated_at,deleted) VALUES(?,?,?,?,?,?,0)`,
        args: [after.id, userId, 1, JSON.stringify(after), now, now],
      });
    if (new TextEncoder().encode(JSON.stringify(after)).length > 700000)
      throw new OfficeError(
        413,
        "한 업무의 내용이 너무 큽니다. D1 무료 환경에서는 업무를 나누어 등록하세요",
      );
    if (kind === "projects") {
      const vendorRows = after.payments.map((p: any) => ({
        id: crypto.randomUUID(),
        userId,
        title: p.vendor,
        name: p.vendor,
        notes: "",
        version: 1,
        createdAt: now,
        updatedAt: now,
      }));
      statements.push({
        sql: "INSERT OR IGNORE INTO expense_vendors(id,user_id,version,data,created_at,updated_at,deleted) SELECT json_extract(value,'$.id'),?,1,value,?,?,0 FROM json_each(?)",
        args: [userId, now, now, JSON.stringify(vendorRows)],
      });
      statements.push({
        sql: "DELETE FROM expense_payments WHERE project_id=?",
        args: [after.id],
      });
      if (!remove)
        statements.push({
          sql: "INSERT INTO expense_payments(id,project_id,vendor_name,payment_method,expected_amount,actual_amount,payment_status,data,vendor_id) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.vendor'),json_extract(value,'$.method'),json_extract(value,'$.expectedAmount'),json_extract(value,'$.actualAmount'),json_extract(value,'$.status'),value,(SELECT id FROM expense_vendors WHERE deleted=0 AND json_extract(data,'$.name')=json_extract(value,'$.vendor') LIMIT 1) FROM json_each(?)",
          args: [after.id, JSON.stringify(after.payments)],
        });
    }
    if (kind === "purchases") {
      statements.push({
        sql: "DELETE FROM facility_purchase_items WHERE purchase_id=?",
        args: [after.id],
      });
      if (!remove)
        statements.push({
          sql: "INSERT INTO facility_purchase_items(id,purchase_id,data) SELECT json_extract(value,'$.id'),?,value FROM json_each(?)",
          args: [after.id, JSON.stringify(after.items)],
        });
    }
    if (!remove && (kind === "facilities" || kind === "purchases")) {
      const templates =
        kind === "facilities" && after.content
          ? [{ title: after.title, type: "facility", content: after.content }]
          : kind === "purchases"
            ? after.items
                .filter((x: any) => x.purpose)
                .map((x: any) => ({
                  title: x.name,
                  type: "purpose",
                  content: x.purpose,
                }))
            : [];
      const unique = new Map(
        templates.map((t: any) => [t.type + ":" + t.title, t]),
      );
      const rows = [...unique.values()].map((t: any) => ({
        ...t,
        id: crypto.randomUUID(),
        version: 1,
        userId,
        createdAt: now,
        updatedAt: now,
      }));
      if (rows.length)
        statements.push({
          sql: "INSERT INTO item_purpose_templates(id,user_id,version,data,created_at,updated_at,deleted) SELECT json_extract(value,'$.id'),?,1,value,?,?,0 FROM json_each(?) WHERE 1 ON CONFLICT DO UPDATE SET data=json_set(excluded.data,'$.id',item_purpose_templates.id,'$.createdAt',item_purpose_templates.created_at,'$.version',item_purpose_templates.version+1),version=item_purpose_templates.version+1,updated_at=excluded.updated_at",
          args: [userId, now, now, JSON.stringify(rows)],
        });
    }
    const logs = describeChanges(kind, before, remove ? null : after).map(
      (description) => ({ id: crypto.randomUUID(), description }),
    );
    statements.push({
      sql: "INSERT INTO activity_logs(id,user_id,entity_type,entity_id,action_type,title,description,previous_value,new_value,created_at) SELECT json_extract(value,'$.id'),?,?,?,?,?,json_extract(value,'$.description'),?,?,? FROM json_each(?)",
      args: [
        userId,
        kind,
        after.id,
        remove ? "delete" : id ? "update" : "create",
        after.title || after.name || after.date || kind,
        before ? JSON.stringify(before) : null,
        remove ? null : JSON.stringify(after),
        now,
        JSON.stringify(logs),
      ],
    });
    try {
      statements.push({
        sql: "UPDATE office_revision SET version=version+1 WHERE id=1",
      });
      await this.sql.batch(statements);
    } catch (e) {
      if (/CHECK|UNIQUE|constraint/i.test(String(e)))
        throw new OfficeError(
          409,
          "중복 등록 또는 동시 수정 충돌입니다. 새로고침하세요",
        );
      throw e;
    }
    return after;
  }
  async backup() {
    // A single statement observes a consistent snapshot without exceeding D1's compound-SELECT limit.
    const branches = Object.entries(tables).map(
      ([kind, table]) =>
        `WHEN '${kind}' THEN (SELECT json_group_array(json_set(data,'$._deleted',deleted)) FROM ${table})`,
    );
    branches.push(
      `WHEN '_activities' THEN (SELECT json_group_array(json_object('id',id,'user_id',user_id,'entity_type',entity_type,'entity_id',entity_id,'action_type',action_type,'title',title,'description',description,'previous_value',previous_value,'new_value',new_value,'created_at',created_at)) FROM activity_logs)`,
    );
    branches.push(
      `WHEN '_revision' THEN (SELECT json_array(version) FROM office_revision WHERE id=1)`,
    );
    const kinds = [...Object.keys(tables), "_activities", "_revision"]
      .map((k) => `('${k}')`)
      .join(",");
    const rows = await this.sql.all(
      `WITH kinds(kind) AS (VALUES ${kinds}) SELECT kinds.kind,e.value AS data,json_extract(e.value,'$._deleted') AS deleted FROM kinds,json_each(CASE kinds.kind ${branches.join(" ")} END) e`,
    );
    const records: Record<string, any[]> = {};
    for (const kind of Object.keys(tables)) records[kind] = [];
    const activities: Activity[] = [];
    let revision = 0;
    for (const r of rows) {
      if (r.kind === "_activities") activities.push(JSON.parse(r.data));
      else if (r.kind === "_revision") revision = Number(r.data);
      else
        records[r.kind].push({ ...JSON.parse(r.data), _deleted: !!r.deleted });
    }
    return {
      format: "school-office-v1",
      createdAt: new Date().toISOString(),
      revision,
      records,
      activities,
    };
  }
  async restore(input: any, userId: string) {
    if (
      input?.format !== "school-office-v1" ||
      !input.records ||
      !Array.isArray(input.activities)
    )
      throw new OfficeError(400, "School Office OS 백업 파일을 선택하세요");
    const meta = (value: any): RecordMeta => {
      if (
        !value ||
        typeof value.id !== "string" ||
        !/^[-a-zA-Z0-9]{1,100}$/.test(value.id) ||
        !Number.isInteger(value.version) ||
        value.version < 1 ||
        typeof value.userId !== "string" ||
        isNaN(Date.parse(value.createdAt)) ||
        isNaN(Date.parse(value.updatedAt))
      )
        throw new OfficeError(400, "백업 식별자 또는 버전이 올바르지 않습니다");
      return {
        id: value.id,
        version: value.version,
        userId: value.userId,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      };
    };
    const records: Record<string, any[]> = {};
    let count = 0;
    for (const kind of Object.keys(tables) as Kind[]) {
      if (!Array.isArray(input.records[kind]))
        throw new OfficeError(400, "백업 테이블이 누락되었습니다");
      records[kind] = input.records[kind].map((x: any) => ({
        ...schemas[kind].parse(x),
        ...meta(x),
        _deleted: !!x._deleted,
      }));
      if (new Set(records[kind].map((x) => x.id)).size !== records[kind].length)
        throw new OfficeError(400, "중복된 백업 식별자입니다");
      count += records[kind].length;
    }
    if (count > 10000)
      throw new OfficeError(
        400,
        "한 번에 복원할 수 있는 업무는 10,000건입니다",
      );
    const activeVendors = new Set(
      records.vendors.filter((x) => !x._deleted).map((x) => x.name),
    );
    const paymentIds: string[] = [],
      itemIds: string[] = [];
    for (const p of records.projects.filter((x) => !x._deleted))
      for (const payment of p.payments) {
        paymentIds.push(payment.id);
        if (!activeVendors.has(payment.vendor))
          throw new OfficeError(
            400,
            "백업 지급 건의 업체 연결이 누락되었습니다",
          );
      }
    for (const p of records.purchases.filter((x) => !x._deleted))
      for (const item of p.items) itemIds.push(item.id);
    if (
      new Set(paymentIds).size !== paymentIds.length ||
      new Set(itemIds).size !== itemIds.length
    )
      throw new OfficeError(400, "백업의 지급 건 또는 물품 ID가 중복됩니다");
    const snapshot = await this.backup();
    if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 1800000)
      throw new OfficeError(
        413,
        "복원 전 스냅샷이 D1 단일 행 한도를 초과합니다. D1 SQL 내보내기와 Time Travel 복구를 사용하세요",
      );
    const statements: Statement[] = [
      {
        sql: "UPDATE office_revision SET version=version+1 WHERE id=1 AND version=?",
        args: [snapshot.revision],
      },
      { sql: "INSERT INTO office_write_guard(value) VALUES(changes())" },
      { sql: "DELETE FROM office_write_guard" },
      {
        sql: "INSERT INTO office_snapshots(id,data,created_at) VALUES(?,?,?)",
        args: [
          crypto.randomUUID(),
          JSON.stringify(snapshot),
          new Date().toISOString(),
        ],
      },
      { sql: "DELETE FROM expense_payments" },
      { sql: "DELETE FROM facility_purchase_items" },
    ];
    for (const kind of Object.keys(tables) as Kind[]) {
      statements.push({ sql: `DELETE FROM ${tables[kind]}` });
      if (
        new TextEncoder().encode(JSON.stringify(records[kind])).length > 1800000
      )
        throw new OfficeError(
          413,
          "해당 업무 분류의 복원 자료가 D1 단일 값 한도를 초과합니다. D1 관리 도구를 사용하세요",
        );
      const rows = records[kind].map(({ _deleted, ...r }) => ({
        ...r,
        version:
          Math.max(
            r.version,
            snapshot.records[kind].find((x) => x.id === r.id)?.version || 0,
          ) + 1,
        deleted: _deleted ? 1 : 0,
      }));
      statements.push({
        sql: `INSERT INTO ${tables[kind]}(id,user_id,version,data,created_at,updated_at,deleted) SELECT json_extract(value,'$.id'),json_extract(value,'$.userId'),json_extract(value,'$.version'),json_remove(value,'$.deleted'),json_extract(value,'$.createdAt'),json_extract(value,'$.updatedAt'),json_extract(value,'$.deleted') FROM json_each(?)`,
        args: [JSON.stringify(rows)],
      });
    }
    statements.push(
      {
        sql: "INSERT INTO expense_payments SELECT json_extract(p.value,'$.id'),e.id,json_extract(p.value,'$.vendor'),json_extract(p.value,'$.method'),json_extract(p.value,'$.expectedAmount'),json_extract(p.value,'$.actualAmount'),json_extract(p.value,'$.status'),p.value,(SELECT id FROM expense_vendors WHERE deleted=0 AND json_extract(data,'$.name')=json_extract(p.value,'$.vendor') LIMIT 1) FROM expense_projects e,json_each(e.data,'$.payments') p WHERE e.deleted=0",
      },
      {
        sql: "INSERT INTO facility_purchase_items SELECT json_extract(p.value,'$.id'),e.id,p.value FROM facility_purchases e,json_each(e.data,'$.items') p WHERE e.deleted=0",
      },
    );
    // Keep current history and import missing historical entries; never rewrite existing audit records.
    for (const log of input.activities) {
      if (
        !log ||
        typeof log.id !== "string" ||
        typeof log.description !== "string" ||
        typeof log.title !== "string" ||
        isNaN(Date.parse(log.created_at))
      )
        throw new OfficeError(400, "백업 활동 기록 오류");
    }
    statements.push({
      sql: "INSERT OR IGNORE INTO activity_logs SELECT json_extract(value,'$.id'),json_extract(value,'$.user_id'),json_extract(value,'$.entity_type'),json_extract(value,'$.entity_id'),json_extract(value,'$.action_type'),json_extract(value,'$.title'),json_extract(value,'$.description'),json_extract(value,'$.previous_value'),json_extract(value,'$.new_value'),json_extract(value,'$.created_at') FROM json_each(?)",
      args: [JSON.stringify(input.activities)],
    });
    statements.push({
      sql: "INSERT INTO activity_logs VALUES(?,?,?,?,?,?,?,?,?,?)",
      args: [
        crypto.randomUUID(),
        userId,
        "backup",
        "restore",
        "restore",
        "백업 복원",
        `${count}건 복원 · 복원 전 스냅샷 보관`,
        null,
        null,
        new Date().toISOString(),
      ],
    });
    statements.push({
      sql: "DELETE FROM office_snapshots WHERE id NOT IN (SELECT id FROM office_snapshots ORDER BY created_at DESC LIMIT 7)",
    });
    try {
      await this.sql.batch(statements);
    } catch (e) {
      if (/CHECK|UNIQUE|constraint/i.test(String(e)))
        throw new OfficeError(
          409,
          "복원 중 다른 기기에서 수정했거나 백업 데이터가 충돌했습니다. 새 백업을 받고 다시 확인하세요",
        );
      throw e;
    }
    return { count };
  }
}
