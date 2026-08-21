/**
 * Cloudflare Workers 런타임은 항상 UTC로 동작한다.
 * new Date().getDay() / setHours(0,0,0,0) 같은 로컬 시각 API는 UTC를 기준으로 계산되므로
 * 한국 사용자의 "오늘"과 최대 9시간 어긋난다.
 * 이 모듈의 함수들은 모두 KST(UTC+9, 서머타임 없음)를 기준으로 계산한다.
 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const KO_DAYS = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];

/**
 * KST 벽시계 시각을 담은 Date.
 * 반드시 getUTC*() 로 읽어야 한다 (getFullYear() 등은 런타임 로컬 기준이라 의미가 없다).
 */
function kstWallClock(now: Date = new Date()): Date {
  return new Date(now.getTime() + KST_OFFSET_MS);
}

/** KST 기준 요일 이름 */
export function kstDayName(now: Date = new Date()): string {
  return KO_DAYS[kstWallClock(now).getUTCDay()];
}

/** KST 기준 날짜 문자열 (예: "2026년 8월 21일") */
export function kstDateString(now: Date = new Date()): string {
  return now.toLocaleDateString("ko-KR", {
    year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Seoul",
  });
}

/** KST 기준 오늘 자정에 해당하는 실제 시각 */
export function kstStartOfToday(now: Date = new Date()): Date {
  const k = kstWallClock(now);
  return new Date(
    Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - KST_OFFSET_MS
  );
}

/** KST 기준 오늘 자정에서 days일 뒤 */
export function kstStartOfDayPlus(days: number, now: Date = new Date()): Date {
  const start = kstStartOfToday(now);
  return new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
}
