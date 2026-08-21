// 메모리 갱신 트리거 로직 검증 (AI 호출 없음)
// 기존: total % trigger === 0   /   변경: total - 마지막갱신 >= trigger
const TRIG = 10;
const oldFire = (total) => total > 0 && total % TRIG === 0;
const newFire = (total, at) => total > 0 && total - at >= TRIG;

function simulate(fire, dropAt) {
  // 한 턴마다 user+assistant 2건 저장. dropAt 번째 턴에서 assistant 저장 1건 실패.
  let total = 0, at = 0; const fired = [];
  for (let turn = 1; turn <= 40; turn++) {
    total += 1;                                  // user
    if (turn !== dropAt) total += 1;             // assistant (dropAt 턴은 유실)
    if (fire(total, at)) { fired.push(total); at = total; }
  }
  return fired;
}

let fail = 0;
const show = (label, got, wantCount) => {
  const ok = got.length === wantCount;
  if (!ok) fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}\n         갱신 시점: [${got.join(", ")}]  (${got.length}회)`);
};

console.log("### 정상 흐름 (유실 없음) — 80메시지, 10마다 갱신이면 8회");
show("기존 로직", simulate(oldFire, -1), 8);
show("변경 로직", simulate(newFire, -1), 8);

console.log("\n### 5번째 턴에서 assistant 저장 1건 유실 — 이후에도 갱신돼야 한다");
const oldDrop = simulate(oldFire, 5);
const newDrop = simulate(newFire, 5);
console.log(`  ${oldDrop.length === 0 ? "확인" : "??? "} 기존 로직: [${oldDrop.join(", ")}] (${oldDrop.length}회)  <- 카운트가 홀수로 어긋나 영구 정지`);
if (oldDrop.length !== 0) { fail++; console.log("  FAIL 기존 로직이 정지하지 않음 — 테스트 전제 오류"); }
show("변경 로직", newDrop, 7);

console.log("\n### 유실이 여러 번 나도 계속 갱신되며, 밀린 분량이 남지 않는가");
{
  let total = 0, at = 0, fired = 0, maxGap = 0;
  for (let turn = 1; turn <= 60; turn++) {
    total += 1;
    if (turn % 7 !== 0) total += 1;            // 7턴마다 assistant 유실
    if (newFire(total, at)) { maxGap = Math.max(maxGap, total - at); fired++; at = total; }
  }
  const backlog = total - at;                  // 아직 요약되지 않고 남은 분량
  // 불변식: 갱신이 계속 일어나고, 끝난 시점에 밀린 분량이 트리거 미만이어야 한다.
  const ok = fired > 0 && backlog < TRIG && maxGap <= TRIG + 1;
  if (!ok) fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} 총 ${total}메시지 -> ${fired}회 갱신, 미처리 ${backlog}개(<${TRIG}), 최대 간격 ${maxGap}`);
}

console.log(fail ? `\n실패 ${fail}건` : "\n전체 통과");
process.exit(fail ? 1 : 0);
