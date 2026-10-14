import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
const directory = resolve(process.env.DATA_DIR || "data");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const isNew = !existsSync(join(directory, "school.sqlite"));
let generated = false;
if (process.env.TURSO_DATABASE_URL && !process.env.ADMIN_PASSWORD)
  throw new Error(
    "호스팅 환경에 ADMIN_PASSWORD를 설정하세요. 자동 생성 값을 사용합니다.",
  );
if (isNew && !process.env.TURSO_DATABASE_URL && !process.env.ADMIN_PASSWORD) {
  process.env.ADMIN_PASSWORD = randomBytes(24).toString("base64url");
  generated = true;
}
const { db } = await import("./db.ts");
if (generated) {
  writeFileSync(
    join(directory, "initial-admin-password.txt"),
    process.env.ADMIN_PASSWORD!,
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "최초 비밀번호를 DATA_DIR/initial-admin-password.txt 에 저장했습니다. 로그인 후 변경하고 파일을 삭제하세요.",
  );
}
db.close();
console.log("데이터베이스 초기화 완료");
