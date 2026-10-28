import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { projectSchema } from "../shared/office.ts";
test("기존 품의 백업 변환은 원본·첨부를 유지하며 동일 업체/지급 ID와 카드 정산을 보존한다", () => {
  const directory = mkdtempSync(join(tmpdir(), "office-migrate-"));
  try {
    const seeded = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "server/seed.ts"],
      {
        env: {
          ...process.env,
          DATA_DIR: directory,
          ADMIN_PASSWORD: randomBytes(24).toString("hex"),
        },
        encoding: "utf8",
      },
    );
    assert.equal(seeded.status, 0, seeded.stderr);
    const db = new DatabaseSync(join(directory, "school.sqlite"));
    const proposals = db
      .prepare("SELECT data FROM proposals")
      .all()
      .map((x) => JSON.parse(String(x.data)));
    db.close();
    const source = join(directory, "source.json"),
      target = join(directory, "converted.json");
    const content = JSON.stringify({
      format: "school-expense-v1",
      proposals,
      attachments: [{ name: "원본 첨부 보관" }],
    });
    writeFileSync(source, content);
    const converted = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "scripts/export-legacy-office.ts",
        source,
        target,
      ],
      { encoding: "utf8" },
    );
    assert.equal(converted.status, 0, converted.stderr);
    assert.equal(readFileSync(source, "utf8"), content);
    const result = JSON.parse(readFileSync(target, "utf8"));
    assert.equal(result.records.projects.length, 2);
    const p = result.records.projects[0];
    assert.ok(projectSchema.safeParse(p).success);
    assert.equal(p.id, proposals[0].id);
    assert.equal(p.payments[0].id, proposals[0].payments[0].id);
    const card = p.payments.find((x: any) => x.method === "card");
    assert.equal(card.status, "지급 예정");
    assert.equal(card.actualPaymentDate, "");
    assert.ok(card.cardApprovedDate);
    assert.ok(result.records.vendors.length > 0);
    const again = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "scripts/export-legacy-office.ts",
        source,
        target,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(again.status, 0);
    assert.equal(readFileSync(source, "utf8"), content);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
