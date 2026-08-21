// 읽기 의도 — 이 경우에만 캘린더를 조회해 맥락으로 넣는다
const CALENDAR_READ_KEYWORDS = [
  "일정", "스케줄", "캘린더", "회의", "미팅", "약속",
  "오늘 뭐", "이번 주", "내일 뭐", "몇 시에", "일정 알려",
  "schedule", "calendar", "meeting",
];

// 쓰기 의도 — 현재 채팅 경로에는 일정 생성/수정 기능이 없다.
// 예전에는 이 단어들도 읽기 키워드에 섞여 있었고, 모델이 "등록했습니다" 라고
// 답해도 실제로는 아무 일도 일어나지 않았다.
const CALENDAR_WRITE_KEYWORDS = [
  "잡아줘", "잡아 줘", "등록해", "추가해", "생성해", "만들어줘",
  "옮겨줘", "변경해", "취소해", "삭제해",
];

function hasCalendarIntent(text: string): boolean {
  const lower = text.toLowerCase();
  return CALENDAR_READ_KEYWORDS.some((kw) => lower.includes(kw));
}

function hasCalendarWriteIntent(text: string): boolean {
  const lower = text.toLowerCase();
  const mentionsCalendar =
    CALENDAR_READ_KEYWORDS.some((kw) => lower.includes(kw)) ||
    /\d\s*시|오전|오후|내일|모레|다음\s*주/.test(lower);
  return mentionsCalendar && CALENDAR_WRITE_KEYWORDS.some((kw) => lower.includes(kw));
}

// --- 검증 ---
const READ_ONLY = [
  "오늘 일정 알려줘", "이번 주 스케줄 어때?", "내일 뭐 있지?",
  "다음 미팅 몇 시에 있어?", "캘린더 확인해줘", "what is my schedule",
];
const WRITE = [
  "내일 3시에 미팅 잡아줘", "회의 등록해줘", "오후 2시 약속 추가해줘",
  "그 일정 취소해줘", "미팅을 모레로 옮겨줘", "다음 주 월요일 일정 만들어줘",
];
const NEITHER = [
  "배송 지연 어떻게 할까?", "단백질 많은 음식 3가지",
  "이 코드 리뷰해줘", "보고서 초안 잡아줘",
];

let fail = 0;
const check = (label, input, wantRead, wantWrite) => {
  const r = hasCalendarIntent(input), w = hasCalendarWriteIntent(input);
  const ok = r === wantRead && w === wantWrite;
  if (!ok) fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} [${label}] "${input}" -> 읽기=${r}(기대${wantRead}) 쓰기=${w}(기대${wantWrite})`);
};

console.log("### 읽기 의도만 — 조회는 하되 쓰기 경고는 없어야");
READ_ONLY.forEach(t => check("읽기", t, true, false));
console.log("");
console.log("### 쓰기 의도 — 반드시 쓰기 경고가 붙어야");
WRITE.forEach(t => check("쓰기", t, hasCalendarIntent(t), true));
console.log("");
console.log("### 캘린더와 무관 — 둘 다 false");
NEITHER.forEach(t => check("무관", t, false, false));
console.log("");
console.log(fail ? `실패 ${fail}건` : "전체 통과");
process.exit(fail ? 1 : 0);
