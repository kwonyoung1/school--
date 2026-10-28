import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
if (!existsSync(".dev.vars")) {
  writeFileSync(
    ".dev.vars",
    `ADMIN_USERNAME=admin\nADMIN_PASSWORD=${randomBytes(24).toString("base64url")}\nLOCAL_DEV=true\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "로컬 Workers 관리자 설정을 .dev.vars에 저장했습니다. 비밀번호를 로그나 채팅에 출력하지 마세요.",
  );
} else console.log("기존 .dev.vars를 유지합니다.");
