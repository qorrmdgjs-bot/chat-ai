// src/time.ts 검증 — Workers 런타임과 동일하게 TZ=UTC 로 실행할 것
// 실행: npx tsx scripts/test_time.mjs   또는   node (아래는 로직 복제 없이 직접 임포트)
import { kstDayName, kstDateString, kstStartOfToday, kstStartOfDayPlus } from "../src/time.ts";

const KO = ["일요일","월요일","화요일","수요일","목요일","금요일","토요일"];
let fail = 0;
const eq = (label, got, want) => {
  const ok = got === want;
  if (!ok) { fail++; console.log(`  FAIL ${label}\n       got : ${got}\n       want: ${want}`); }
  return ok;
};

// 기준일: 2026-08-21(금) KST. UTC 로는 8/20 15:00 ~ 8/21 15:00 이 하루에 해당한다.
console.log("### KST 하루 경계 (2026-08-21 금요일)");
const cases = [
  // [UTC 시각,               기대 KST 날짜,        기대 요일,  기대 '오늘 시작'(UTC)]
  ["2026-08-20T15:00:00Z", "2026년 8월 21일", "금요일", "2026-08-20T15:00:00.000Z"], // KST 00:00 정각
  ["2026-08-20T23:59:59Z", "2026년 8월 21일", "금요일", "2026-08-20T15:00:00.000Z"], // KST 08:59 (기존 버그 구간)
  ["2026-08-21T00:00:00Z", "2026년 8월 21일", "금요일", "2026-08-20T15:00:00.000Z"], // KST 09:00
  ["2026-08-21T14:59:59Z", "2026년 8월 21일", "금요일", "2026-08-20T15:00:00.000Z"], // KST 23:59
  ["2026-08-21T15:00:00Z", "2026년 8월 22일", "토요일", "2026-08-21T15:00:00.000Z"], // KST 익일 00:00
];
for (const [utc, wantDate, wantDay, wantStart] of cases) {
  const now = new Date(utc);
  const okAll =
    eq(`${utc} 날짜`,  kstDateString(now),                 wantDate) &&
    eq(`${utc} 요일`,  kstDayName(now),                    wantDay) &&
    eq(`${utc} 시작`,  kstStartOfToday(now).toISOString(), wantStart);
  if (okAll) console.log(`  ok   ${utc}  ->  ${wantDate} ${wantDay}, 오늘시작 ${wantStart}`);
}

console.log("\n### 날짜와 요일이 서로 모순되지 않는가 (24시간 전 구간 1분 간격)");
let mismatch = 0;
for (let m = 0; m < 1440; m++) {
  const now = new Date(Date.UTC(2026, 7, 20, 0, m, 0));
  // KST 날짜 문자열에서 일(day)을 뽑아 Date 로 되돌린 뒤 요일을 재계산해 비교
  const [y, mo, d] = kstDateString(now).match(/\d+/g).map(Number);
  const expected = KO[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  if (kstDayName(now) !== expected) mismatch++;
}
if (mismatch) { fail++; console.log(`  FAIL ${mismatch}/1440 분에서 날짜-요일 불일치`); }
else console.log("  ok   1440/1440 분 모두 일치");

console.log("\n### '오늘' 구간이 정확히 24시간이고 KST 자정에 시작하는가");
for (let h = 0; h < 24; h++) {
  const now = new Date(Date.UTC(2026, 7, 20, h, 30, 0));
  const s = kstStartOfToday(now), e = kstStartOfDayPlus(1, now);
  const span = (e - s) / 3600000;
  const kstHour = new Date(s.getTime() + 9 * 3600000).getUTCHours();
  if (span !== 24 || kstHour !== 0) {
    fail++; console.log(`  FAIL UTC ${h}:30 -> 길이 ${span}h, KST 시작 시각 ${kstHour}시`);
  }
}
if (!fail) console.log("  ok   24/24 시간대 모두 24시간 · KST 00:00 시작");

console.log("\n### 이번 주 = 오늘 자정부터 7일");
const w0 = kstStartOfToday(new Date("2026-08-20T23:00:00Z"));
const w7 = kstStartOfDayPlus(7, new Date("2026-08-20T23:00:00Z"));
eq("주간 길이", (w7 - w0) / 86400000, 7) && console.log("  ok   7일");

console.log(fail ? `\n실패 ${fail}건` : "\n전체 통과");
process.exit(fail ? 1 : 0);
