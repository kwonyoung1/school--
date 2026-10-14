import { db, seed, listProposals, audit, transaction } from "./db.ts";
await transaction(async () => {
  if (await db.prepare("SELECT id FROM proposals LIMIT 1").get()) {
    console.log("기존 자료가 있어 예시 생성을 생략했습니다.");
    return;
  }
  await seed();
  await audit(
    { id: "local-setup", name: "초기화" },
    "예시 자료 생성",
    "seed",
    "가상 품의 2건",
  );
  console.log(
    "가상 품의 2건 생성 완료 (카드 2건 + 계좌이체 1건 혼합 예시 포함)",
  );
});
db.close();
