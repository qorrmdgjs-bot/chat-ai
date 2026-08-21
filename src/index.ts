import { Hono } from "hono";
import { kstDateString, kstDayName } from "./time";
import { cors } from "hono/cors";
import {
  saveMessage,
  getRecentMessages,
  getSummary,
  getProfile,
  maybeUpdateMemory,
  type Env,
  type Profile,
} from "./memory";
import {
  isConnected,
  getAuthUrl,
  handleCallback,
  disconnect,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  getTodayEventsText,
  getWeekEventsText,
} from "./calendar";

const app = new Hono<{ Bindings: Env }>();

// UI 와 API 를 같은 워커가 서빙하므로 앱 자신의 요청은 동일 출처다.
// 예전에는 cors() 기본값이라 Access-Control-Allow-Origin: * 였고,
// 아무 웹페이지의 스크립트나 이 API 를 호출할 수 있었다.
app.use("/*", async (c, next) => {
  const origin = c.req.header("Origin");
  const self = new URL(c.req.url).origin;
  return cors({
    origin: (o) => (!o || o === self ? o || self : ""),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })(c, next);
});

// ─── 레이트리밋 ────────────────────────────────────────────────────────────
// 인증이 없는 공개 엔드포인트라 누구나 Workers AI 쿼터를 태울 수 있다.
// IP 단위 시간당 상한으로 무단 사용을 억제한다.
// (IP 를 바꿔가며 하는 공격은 막지 못한다. 근본 해결은 인증이다.)
const RATE_LIMIT_PER_HOUR = 40;

async function checkRateLimit(
  env: Env,
  ip: string
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const now = Date.now();
  const bucket = Math.floor(now / 3_600_000);
  const key = `rl:${ip}:${bucket}`;
  let cur = 0;
  try {
    cur = parseInt((await env.TOKEN_STORE.get(key)) || "0", 10) || 0;
  } catch {
    return { ok: true }; // KV 장애 시 사용자를 막지 않는다
  }
  if (cur >= RATE_LIMIT_PER_HOUR) {
    return { ok: false, retryAfter: Math.ceil(((bucket + 1) * 3_600_000 - now) / 1000) };
  }
  try {
    await env.TOKEN_STORE.put(key, String(cur + 1), { expirationTtl: 7200 });
  } catch {}
  return { ok: true };
}

// ─── 수정 ①: 프로파일 필드명 한국어 레이블 매핑 ────────────────────────────
const PROFILE_LABELS: Record<keyof Profile, string> = {
  work_style: "스타일",
  pain_points: "고민",
  key_topics: "관심 주제",
  communication_preference: "소통 방식",
};

const SYSTEM_PROMPTS: Record<string, string> = {
  work: `너는 사용자의 업무 파트너다.

역할:
- 단순 답변이 아니라, 대화를 통해 인사이트를 만든다
- 사용자의 과거 대화를 기억하고 맥락을 이어간다

규칙:
1. 이전 맥락을 반드시 반영하라
2. 반복되는 문제나 패턴을 발견하면 직접 짚어라
3. 질문과 제안을 섞어서 대화하라
4. 너무 길게 말하지 마라 — 핵심만, 명확하게
5. 업무 리스크·우선순위 관점을 항상 유지하라

언어:
- 한국어로 답한다.
- 코드, 명령어, 오류 메시지, 제품·서비스명, 기술 용어, URL, 식별자는 원문 그대로 쓴다.

목표:
- 사용자가 스스로 생각을 정리하고, 더 나은 결정을 내리게 만드는 것`,

  personal: `너는 다양한 분야에 박학다식한 전문가이자, 사용자의 개인 어시스턴트다.

전문 분야:
- 건강·운동·영양: 체력 관리, 식단, 수면, 스트레스 해소 등
- 자기계발: 습관 형성, 시간 관리, 독서, 학습 전략
- 생활·실용: 재테크, 여행, 요리, 생활 꿀팁
- 심리·관계: 스트레스 관리, 대인관계, 감정 조절
- 문화·교양: 역사, 과학, 철학, 예술, 시사 상식

성격:
- 친근하고 따뜻하지만, 전문적인 조언을 줄 때는 근거를 함께 제시한다
- 사용자의 건강이나 안전에 관한 질문에는 신중하게 답변한다
- 의학적 진단이나 처방은 하지 않으며, 필요시 전문가 상담을 권한다

규칙:
1. 이전 대화 맥락을 기억하고 이어간다
2. 일방적 정보 전달이 아니라, 대화하듯 자연스럽게 소통한다
3. 사용자의 상황과 맥락에 맞는 맞춤형 조언을 한다
4. 너무 길게 말하지 마라 — 핵심만, 명확하게
5. 잘 모르는 내용은 솔직하게 말하고, 확인할 수 있는 방법을 안내한다

언어:
- 한국어로 답한다.
- 코드, 명령어, 오류 메시지, 제품·서비스명, 기술 용어, URL, 식별자는 원문 그대로 쓴다.

목표:
- 사용자의 일상이 더 건강하고, 풍요로워지도록 돕는 것`,
};

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

function buildMessages(
  userInput: string,
  channel: string,
  recentHistory: { role: string; content: string }[],
  summary: string | null,
  profile: Profile | null,
  calendarContext: string | null
): { role: string; content: string }[] {
  const systemPrompt = SYSTEM_PROMPTS[channel] || SYSTEM_PROMPTS.work;
  const messages: { role: string; content: string }[] = [
    { role: "system", content: systemPrompt },
  ];

  const contextParts: string[] = [];
  if (summary) contextParts.push(`[대화 요약]\n${summary}`);

  if (profile) {
    // 수정 ③: 프로파일 레이블 한국어로 표시
    const profileText = (Object.entries(profile) as [keyof Profile, string | null][])
      .filter(([, v]) => v)
      .map(([k, v]) => `- ${PROFILE_LABELS[k]}: ${v}`)
      .join("\n");
    if (profileText) contextParts.push(`[사용자 프로필]\n${profileText}`);
  }

  if (calendarContext) {
    const dateStr = kstDateString();
    const dayStr = kstDayName();
    contextParts.push(
      `[오늘 날짜: ${dateStr} ${dayStr}]\n[Google 캘린더 일정]\n${calendarContext}`
    );
  }

  if (contextParts.length > 0) {
    messages.push({
      role: "user",
      content: `[참고 맥락 — 자연스럽게 반영]\n${contextParts.join("\n\n")}`,
    });
    messages.push({
      role: "assistant",
      content: "맥락 파악했습니다. 계속 진행하겠습니다.",
    });
  }

  for (const msg of recentHistory) {
    messages.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content,
    });
  }
  messages.push({ role: "user", content: userInput });
  return messages;
}

// ─── PWA Service Worker ────────────────────────────────────────────────────
const SW_JS = `
const CACHE = 'chat-ai-v1';
const OFFLINE_URLS = ['/'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(OFFLINE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/')) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match('/'))
  );
});
`.trim();

// ─── PWA Manifest ─────────────────────────────────────────────────────────
const MANIFEST = {
  name: "채팅 AI",
  short_name: "채팅AI",
  description: "업무·개인 AI 어시스턴트",
  start_url: "/",
  display: "standalone",
  background_color: "#0f172a",
  theme_color: "#6366f1",
  orientation: "portrait-primary",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
};

// ─── App Icon (SVG → PNG-like data URI served as PNG) ─────────────────────
// We serve a simple SVG-based icon
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <rect width="192" height="192" rx="40" fill="#6366f1"/>
  <text x="96" y="125" font-size="90" text-anchor="middle" font-family="system-ui,sans-serif">🤖</text>
</svg>`;

// ─── HTML UI ───────────────────────────────────────────────────────────────
const CHAT_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#6366f1">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="채팅AI">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon-192.png">
<title>채팅 AI</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f172a;--surface:#1e293b;--surface2:#334155;--border:#475569;
  --text:#f1f5f9;--text2:#94a3b8;--text3:#64748b;
  --primary:#6366f1;--primary-hover:#4f46e5;--primary-light:#818cf8;
  --user-bg:#4f46e5;--ai-bg:#1e293b;
  --work:#6366f1;--personal:#10b981;
  --danger:#ef4444;--success:#22c55e;--warning:#f59e0b;
  --radius:12px;--radius-sm:8px;--radius-xs:6px;
  --font:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans KR',sans-serif;
  --shadow:0 4px 24px rgba(0,0,0,.4);
}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--font);font-size:15px;line-height:1.6;overflow:hidden}

/* ── Layout ── */
#app{display:flex;flex-direction:column;height:100vh;height:100dvh}
header{
  display:flex;align-items:center;gap:8px;
  padding:10px 16px;padding-top:calc(env(safe-area-inset-top,0px) + 10px);
  padding-left:calc(env(safe-area-inset-left,0px) + 16px);
  padding-right:calc(env(safe-area-inset-right,0px) + 16px);
  background:var(--surface);
  border-bottom:1px solid var(--border);
  min-height:56px;flex-shrink:0;z-index:10;
}
.logo{font-size:18px;font-weight:700;color:var(--primary-light);white-space:nowrap}
.channel-tabs{display:flex;gap:4px;background:var(--bg);border-radius:var(--radius-sm);padding:3px}
.ch-btn{
  padding:5px 14px;border:none;border-radius:var(--radius-xs);
  font-size:13px;font-weight:600;cursor:pointer;transition:.15s;
  background:transparent;color:var(--text2);
}
.ch-btn.active[data-ch="work"]{background:var(--work);color:#fff}
.ch-btn.active[data-ch="personal"]{background:var(--personal);color:#fff}
.header-right{display:flex;gap:6px;align-items:center;margin-left:auto}
.icon-btn{
  width:36px;height:36px;border:1px solid var(--border);border-radius:var(--radius-sm);
  background:transparent;color:var(--text2);cursor:pointer;
  display:flex;align-items:center;justify-content:center;font-size:16px;transition:.15s;
  flex-shrink:0;
}
.icon-btn:hover{background:var(--surface2);color:var(--text)}

#install-btn{
  display:none;padding:6px 12px;border:1px solid var(--primary);
  border-radius:var(--radius-sm);background:transparent;color:var(--primary-light);
  font-size:12px;font-weight:600;cursor:pointer;transition:.15s;white-space:nowrap;flex-shrink:0;
}
#install-btn:hover{background:var(--primary);color:#fff}
#install-btn.visible{display:flex;align-items:center;gap:4px}

.main{display:flex;flex:1;overflow:hidden}

/* ── Chat ── */
.chat-wrap{display:flex;flex-direction:column;flex:1;min-width:0}
#messages{
  flex:1;overflow-y:auto;padding:16px;
  display:flex;flex-direction:column;gap:12px;
  scroll-behavior:smooth;
}
#messages::-webkit-scrollbar{width:4px}
#messages::-webkit-scrollbar-track{background:transparent}
#messages::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}

.msg{display:flex;gap:10px;max-width:85%}
.msg.user{align-self:flex-end;flex-direction:row-reverse}
.msg.assistant{align-self:flex-start}
.avatar{
  width:32px;height:32px;border-radius:50%;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;font-size:15px;
  background:var(--surface2);margin-top:2px;
}
.msg.user .avatar{background:var(--primary)}
.bubble{
  padding:10px 14px;border-radius:var(--radius);
  max-width:100%;word-break:break-word;line-height:1.65;
}
.msg.user .bubble{background:var(--user-bg);color:#fff;border-bottom-right-radius:4px}
.msg.assistant .bubble{background:var(--ai-bg);border:1px solid var(--border);border-bottom-left-radius:4px}
.bubble p{margin:.3em 0}
.bubble p:first-child{margin-top:0}
.bubble p:last-child{margin-bottom:0}
.bubble strong{color:var(--primary-light)}
.bubble code{
  background:rgba(99,102,241,.15);color:#a5b4fc;
  padding:1px 5px;border-radius:4px;font-size:13px;font-family:monospace;
}
.bubble pre{
  background:rgba(0,0,0,.3);border-radius:var(--radius-xs);
  padding:10px;margin:.5em 0;overflow-x:auto;
}
.bubble pre code{background:none;padding:0;color:#e2e8f0}
.bubble ul,
.bubble ol{padding-left:1.4em;margin:.3em 0}
.msg-time{font-size:11px;color:var(--text3);margin-top:4px;
  text-align:right;align-self:flex-end}
.msg.assistant .msg-time{text-align:left}

.typing{display:flex;gap:4px;padding:4px 0}
.typing span{
  width:7px;height:7px;border-radius:50%;
  background:var(--text3);animation:bounce .9s infinite;
}
.typing span:nth-child(2){animation-delay:.15s}
.typing span:nth-child(3){animation-delay:.3s}
@keyframes bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}

.empty-state{
  flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:12px;color:var(--text3);text-align:center;padding:40px;
}
.empty-state .icon{font-size:48px;margin-bottom:4px}
.empty-state h3{font-size:16px;color:var(--text2)}
.empty-state p{font-size:13px}

.input-area{
  display:flex;gap:8px;padding:12px 16px;
  padding-bottom:calc(env(safe-area-inset-bottom,0px) + 12px);
  padding-left:calc(env(safe-area-inset-left,0px) + 16px);
  padding-right:calc(env(safe-area-inset-right,0px) + 16px);
  border-top:1px solid var(--border);background:var(--surface);flex-shrink:0;
}
#input{
  flex:1;padding:10px 14px;border-radius:var(--radius);
  border:1px solid var(--border);background:var(--bg);
  color:var(--text);font-family:var(--font);font-size:14px;
  resize:none;min-height:44px;max-height:140px;line-height:1.5;
  outline:none;transition:.15s;
}
#input:focus{border-color:var(--primary)}
#input::placeholder{color:var(--text3)}
#send-btn{
  width:44px;height:44px;border-radius:var(--radius);
  border:none;background:var(--primary);color:#fff;
  font-size:18px;cursor:pointer;transition:.15s;
  display:flex;align-items:center;justify-content:center;flex-shrink:0;
  align-self:flex-end;
}
#send-btn:hover{background:var(--primary-hover)}
#send-btn:disabled{background:var(--border);cursor:not-allowed}
#send-btn.stop{background:var(--danger)}
#send-btn.stop:hover{background:#dc2626}

.msg-foot{display:flex;align-items:center;gap:8px;margin-top:4px}
.msg.user .msg-foot{flex-direction:row-reverse}
.copy-btn{
  border:none;background:transparent;color:var(--text3);cursor:pointer;
  font-size:11px;padding:1px 4px;border-radius:4px;line-height:1.4;
  opacity:0;transition:.15s;flex-shrink:0;
}
.msg:hover .copy-btn,.copy-btn:focus{opacity:1}
.copy-btn:hover{color:var(--primary-light);background:var(--surface2)}
@media(hover:none){.copy-btn{opacity:.6}}

/* ── Sidebar ── */
#sidebar{
  width:300px;border-left:1px solid var(--border);
  background:var(--surface);overflow-y:auto;flex-shrink:0;
  display:flex;flex-direction:column;
}
#sidebar::-webkit-scrollbar{width:4px}
#sidebar::-webkit-scrollbar-thumb{background:var(--border)}
#sidebar.hidden{display:none}

.sidebar-section{padding:16px;border-bottom:1px solid var(--border)}
.sidebar-section:last-child{border-bottom:none}
.section-title{
  font-size:12px;font-weight:700;text-transform:uppercase;
  letter-spacing:.05em;color:var(--text3);margin-bottom:10px;
  display:flex;align-items:center;gap:6px;
}
.section-title .icon{font-size:14px}

.info-card{
  background:var(--bg);border-radius:var(--radius-sm);
  padding:10px 12px;font-size:13px;color:var(--text2);line-height:1.6;
}
.info-card.empty{color:var(--text3);font-style:italic}

.profile-item{margin:4px 0;font-size:13px}
.profile-label{color:var(--text3);font-size:11px;margin-bottom:1px}
.profile-value{color:var(--text2)}

.cal-status{display:flex;align-items:center;gap:6px;font-size:13px}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dot.on{background:var(--success)}
.dot.off{background:var(--text3)}

.btn{
  width:100%;padding:8px;border-radius:var(--radius-sm);
  border:1px solid var(--border);background:var(--surface2);
  color:var(--text2);font-size:13px;font-weight:500;cursor:pointer;transition:.15s;
}
.btn:hover{border-color:var(--primary);color:var(--primary-light)}
.btn.danger{border-color:var(--danger);color:#f87171}
.btn.danger:hover{background:rgba(239,68,68,.1)}
.btn.primary{background:var(--primary);border-color:var(--primary);color:#fff}
.btn.primary:hover{background:var(--primary-hover)}
.btn+.btn{margin-top:6px}

/* ── Toast ── */
#toast{
  position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(20px);
  background:var(--surface2);border:1px solid var(--border);
  color:var(--text);padding:8px 16px;border-radius:var(--radius-sm);
  font-size:13px;opacity:0;transition:.25s;pointer-events:none;z-index:100;
  white-space:nowrap;
}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}

/* ── Responsive ── */
@media(max-width:680px){
  #sidebar{
    position:fixed;top:56px;right:0;bottom:0;
    width:85%;max-width:320px;z-index:50;
    box-shadow:var(--shadow);
    transform:translateX(100%);transition:.25s;
  }
  #sidebar.open{transform:translateX(0);display:flex}
  #sidebar.hidden{display:flex;transform:translateX(100%)}
}
@media(min-width:681px){
  #sidebar-btn{display:none}
  #sidebar.hidden{display:none!important}
}
</style>
</head>
<body>
<div id="app">
  <header>
    <div class="logo">🤖 채팅 AI</div>
    <div class="channel-tabs">
      <button class="ch-btn active" data-ch="work">업무</button>
      <button class="ch-btn" data-ch="personal">개인</button>
    </div>
    <div class="header-right">
      <button id="install-btn" title="앱으로 설치">📲 설치</button>
      <button class="icon-btn" id="sidebar-btn" title="사이드바">☰</button>
    </div>
  </header>

  <div class="main">
    <div class="chat-wrap">
      <div id="messages">
        <div class="empty-state" id="empty">
          <div class="icon">💬</div>
          <h3>안녕하세요!</h3>
          <p>무엇을 도와드릴까요?<br>업무 또는 개인 채널을 선택하고 대화를 시작하세요.</p>
        </div>
      </div>
      <div class="input-area">
        <textarea id="input" rows="1"></textarea>
        <button id="send-btn" title="전송">➤</button>
      </div>
    </div>

    <div id="sidebar">
      <div class="sidebar-section">
        <div class="section-title"><span class="icon">🧠</span> 대화 기억</div>
        <div id="mem-summary" class="info-card empty">아직 요약 없음</div>
      </div>
      <div class="sidebar-section">
        <div class="section-title"><span class="icon">👤</span> 나의 프로필</div>
        <div id="mem-profile" class="info-card empty">충분한 대화 후 자동으로 생성됩니다</div>
      </div>
      <div class="sidebar-section">
        <div class="section-title"><span class="icon">📅</span> Google 캘린더</div>
        <div id="cal-status" class="cal-status" style="margin-bottom:10px">
          <div class="dot off" id="cal-dot"></div>
          <span id="cal-label">연동되지 않음</span>
        </div>
        <button class="btn" id="cal-btn">캘린더 연동하기</button>
      </div>
      <div class="sidebar-section">
        <div class="section-title"><span class="icon">⚙️</span> 설정</div>
        <button class="btn danger" id="clear-btn">🗑️ 대화 기록 초기화</button>
      </div>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
(function(){
'use strict';

// ── User ID ──────────────────────────────────────────────────────────────
const USER_KEY = 'chat_ai_uid';
let userId = localStorage.getItem(USER_KEY);
if (!userId) {
  userId = ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
  localStorage.setItem(USER_KEY, userId);
}

// ── State ─────────────────────────────────────────────────────────────────
let channel = 'work';
let isStreaming = false;
let deferredInstall = null;
let abortCtl = null;

// 모바일에는 Shift 키가 없어 Enter=전송이면 줄바꿈을 아예 못 넣는다.
// 터치 기기에서는 Enter 를 줄바꿈으로 두고 전송은 버튼으로만 받는다.
const isTouch = window.matchMedia('(hover:none) and (pointer:coarse)').matches;

// ── PWA Install ───────────────────────────────────────────────────────────
const installBtn = document.getElementById('install-btn');
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  installBtn.classList.add('visible');
});
window.addEventListener('appinstalled', () => {
  installBtn.classList.remove('visible');
  showToast('앱이 설치되었습니다! 🎉');
  deferredInstall = null;
});
installBtn.addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  if (outcome === 'accepted') deferredInstall = null;
});

// Service Worker 등록
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── DOM Refs ──────────────────────────────────────────────────────────────
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const emptyEl = document.getElementById('empty');
const clearBtn = document.getElementById('clear-btn');
const sidebarEl = document.getElementById('sidebar');
const sidebarBtn = document.getElementById('sidebar-btn');
const calBtn = document.getElementById('cal-btn');
const calDot = document.getElementById('cal-dot');
const calLabel = document.getElementById('cal-label');
const memSummary = document.getElementById('mem-summary');
const memProfile = document.getElementById('mem-profile');

// ── Channel Toggle ────────────────────────────────────────────────────────
document.querySelectorAll('.ch-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (isStreaming) return;
    document.querySelectorAll('.ch-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    channel = btn.dataset.ch;
    clearMessages();
    loadHistory();
    loadMemory();
    loadCalendarStatus();
    showToast(channel === 'work' ? '업무 채널로 전환' : '개인 채널로 전환');
  });
});

// ── Sidebar ───────────────────────────────────────────────────────────────
let sidebarOpen = false;
sidebarBtn.addEventListener('click', () => {
  sidebarOpen = !sidebarOpen;
  if (window.innerWidth <= 680) {
    sidebarEl.classList.toggle('open', sidebarOpen);
    sidebarEl.classList.remove('hidden');
  } else {
    sidebarEl.classList.toggle('hidden', !sidebarOpen);
  }
});

// 사이드바 외부 클릭 닫기 (모바일)
document.addEventListener('click', (e) => {
  if (window.innerWidth > 680) return;
  if (!sidebarEl.contains(e.target) && e.target !== sidebarBtn) {
    sidebarOpen = false;
    sidebarEl.classList.remove('open');
  }
});

// ── Toast ─────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

// ── Messages ──────────────────────────────────────────────────────────────
function clearMessages() {
  while (messagesEl.firstChild) messagesEl.removeChild(messagesEl.firstChild);
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.id = 'empty';
  empty.innerHTML = '<div class="icon">💬</div><h3>안녕하세요!</h3><p>무엇을 도와드릴까요?</p>';
  messagesEl.appendChild(empty);
}

function removeEmpty() {
  const e = document.getElementById('empty');
  if (e) e.remove();
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function simpleMarkdown(text) {
  // 이스케이프를 가장 먼저 한 번만 수행한다.
  // 예전에는 코드블록 안에서만 이스케이프해서, 평문의 <img onerror=...> 가
  // innerHTML 로 그대로 실행됐다.
  return escapeHtml(text)
    .replace(/\`\`\`([\s\S]*?)\`\`\`/g, (_, c) => '<pre><code>' + c.trim() + '</code></pre>')
    .replace(/\`([^\`]+)\`/g, (_, c) => '<code>' + c + '</code>')
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
    .replace(/^#{1,3}\\s+(.+)$/gm, '<strong>$1</strong>')
    .replace(/^[\\-\\*]\\s+(.+)$/gm, '• $1')
    .replace(/^(\\d+)\\.\\s+(.+)$/gm, '$1. $2')
    .split('\\n\\n').map(p => '<p>' + p.replace(/\\n/g, '<br>') + '</p>').join('');
}

function timeStr(iso) {
  // iso 가 없으면 현재 시각. D1 의 timestamp 는 'YYYY-MM-DD HH:MM:SS' (UTC) 형식이라
  // 그대로 Date 에 넣으면 브라우저가 로컬시각으로 오해하므로 UTC 임을 명시한다.
  var d = iso ? new Date(iso.replace(' ', 'T') + (/[Zz+]/.test(iso) ? '' : 'Z')) : new Date();
  if (isNaN(d)) d = new Date();
  return d.toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit'});
}

function addMessage(role, text, streaming = false, ts = null) {
  removeEmpty();
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? '나' : '🤖';

  const right = document.createElement('div');

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (streaming) {
    const typing = document.createElement('div');
    typing.className = 'typing';
    typing.innerHTML = '<span></span><span></span><span></span>';
    bubble.appendChild(typing);
  } else {
    bubble.innerHTML = simpleMarkdown(text);
  }

  const timeEl = document.createElement('div');
  timeEl.className = 'msg-time';
  timeEl.textContent = timeStr(ts);

  const foot = document.createElement('div');
  foot.className = 'msg-foot';
  foot.appendChild(timeEl);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.type = 'button';
  copyBtn.textContent = '복사';
  copyBtn.title = '메시지 복사';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(bubble.dataset.raw || bubble.textContent);
      copyBtn.textContent = '복사됨';
    } catch {
      copyBtn.textContent = '실패';
    }
    setTimeout(() => { copyBtn.textContent = '복사'; }, 1500);
  });
  foot.appendChild(copyBtn);

  bubble.dataset.raw = streaming ? '' : text;

  right.appendChild(bubble);
  right.appendChild(foot);
  wrap.appendChild(avatar);
  wrap.appendChild(right);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return { wrap, bubble };
}

function updateBubble(bubble, text) {
  bubble.dataset.raw = text;
  bubble.innerHTML = simpleMarkdown(text);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── Send Message ──────────────────────────────────────────────────────────
async function sendMessage() {
  if (isStreaming) { stopStreaming(); return; }
  const text = inputEl.value.trim();
  if (!text) return;

  isStreaming = true;
  abortCtl = new AbortController();
  sendBtn.classList.add('stop');
  sendBtn.textContent = '■';
  sendBtn.title = '응답 중단';
  inputEl.value = '';
  autoResize();

  addMessage('user', text);

  const { bubble } = addMessage('assistant', '', true);
  let fullText = '';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_input: text, user_id: userId, channel }),
      signal: abortCtl.signal
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      updateBubble(bubble, '⚠️ ' + (err.error || '오류가 발생했습니다.'));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const p = JSON.parse(data);
          if (p.error) { updateBubble(bubble, '⚠️ ' + p.error); return; }
          if (p.text) { fullText += p.text; updateBubble(bubble, fullText); }
          if (p.done) break;
        } catch {}
      }
    }
    if (!fullText) updateBubble(bubble, '(응답 없음)');

    // 메모리 갱신 (5초 딜레이)
    setTimeout(() => loadMemory(), 5000);
  } catch (e) {
    if (e && e.name === 'AbortError') {
      // 중단 시점까지 받은 내용은 남긴다.
      updateBubble(bubble, fullText ? fullText + '\\n\\n_(중단됨)_' : '_(중단됨)_');
    } else {
      updateBubble(bubble, '⚠️ 네트워크 오류가 발생했습니다.');
    }
  } finally {
    isStreaming = false;
    abortCtl = null;
    sendBtn.classList.remove('stop');
    sendBtn.textContent = '\u27a4';
    sendBtn.title = '전송';
    if (!isTouch) inputEl.focus();
  }
}

function stopStreaming() {
  if (abortCtl) abortCtl.abort();
}

sendBtn.addEventListener('click', sendMessage);
inputEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (isTouch) return;                       // 모바일: Enter 는 줄바꿈, 전송은 버튼으로
  if (e.shiftKey || e.isComposing) return;   // 한글 조합 중 Enter 로 오전송되는 것도 막는다
  e.preventDefault();
  sendMessage();
});

// ── Auto Resize ───────────────────────────────────────────────────────────
function autoResize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
}
inputEl.addEventListener('input', autoResize);

// ── Load History ──────────────────────────────────────────────────────────
async function loadHistory() {
  try {
    const res = await fetch('/api/history/' + userId + '?channel=' + channel + '&limit=30');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.messages?.length) return;
    removeEmpty();
    for (const m of data.messages) {
      addMessage(m.role, m.content, false, m.timestamp);
    }
  } catch {}
}

// ── Load Memory ───────────────────────────────────────────────────────────
async function loadMemory() {
  try {
    const res = await fetch('/api/memory/' + userId + '?channel=' + channel);
    if (!res.ok) return;
    const data = await res.json();

    if (data.summary) {
      memSummary.className = 'info-card';
      memSummary.textContent = data.summary;
    } else {
      memSummary.className = 'info-card empty';
      memSummary.textContent = '아직 요약 없음 (메시지 누적 시 자동 생성)';
    }

    if (data.profile) {
      const p = data.profile;
      const labels = {
        work_style: '스타일', pain_points: '고민',
        key_topics: '관심 주제', communication_preference: '소통 방식'
      };
      const items = Object.entries(labels)
        .filter(([k]) => p[k])
        .map(([k, label]) => '<div class="profile-item"><div class="profile-label">' + label + '</div><div class="profile-value">' + escapeHtml(p[k]) + '</div></div>')
        .join('');
      if (items) {
        memProfile.className = 'info-card';
        memProfile.innerHTML = items;
      } else {
        memProfile.className = 'info-card empty';
        memProfile.textContent = '충분한 대화 후 자동으로 생성됩니다';
      }
    }
  } catch {}
}

// ── Calendar ──────────────────────────────────────────────────────────────
async function loadCalendarStatus() {
  try {
    const res = await fetch('/api/calendar/status/' + userId);
    if (!res.ok) return;
    const data = await res.json();
    if (data.connected) {
      calDot.className = 'dot on';
      calLabel.textContent = '연동됨';
      calBtn.textContent = '캘린더 연동 해제';
      calBtn.className = 'btn danger';
    } else {
      calDot.className = 'dot off';
      calLabel.textContent = '연동되지 않음';
      calBtn.textContent = '캘린더 연동하기';
      calBtn.className = 'btn primary';
    }
  } catch {}
}

calBtn.addEventListener('click', async () => {
  if (calBtn.textContent.includes('해제')) {
    await fetch('/api/calendar/disconnect/' + userId, { method: 'DELETE' });
    loadCalendarStatus();
    showToast('캘린더 연동이 해제되었습니다.');
  } else {
    const res = await fetch('/api/calendar/auth?user_id=' + userId);
    if (!res.ok) { showToast('Google OAuth 설정이 필요합니다.'); return; }
    const data = await res.json();
    if (data.auth_url) {
      const popup = window.open(data.auth_url, '_blank', 'width=500,height=600');
      const timer = setInterval(() => {
        if (popup?.closed) {
          clearInterval(timer);
          setTimeout(() => { loadCalendarStatus(); showToast('캘린더 연동 완료!'); }, 500);
        }
      }, 500);
    }
  }
});

// ── Clear Memory ──────────────────────────────────────────────────────────
clearBtn.addEventListener('click', async () => {
  if (!confirm('현재 채널의 모든 대화 기록이 삭제됩니다. 계속할까요?')) return;
  try {
    await fetch('/api/memory/' + userId + '?channel=' + channel, { method: 'DELETE' });
    clearMessages();
    memSummary.className = 'info-card empty';
    memSummary.textContent = '아직 요약 없음';
    memProfile.className = 'info-card empty';
    memProfile.textContent = '충분한 대화 후 자동으로 생성됩니다';
    showToast('대화 기록이 초기화되었습니다.');
  } catch { showToast('오류가 발생했습니다.'); }
});

// ── Init ──────────────────────────────────────────────────────────────────
inputEl.placeholder = isTouch
  ? '메시지를 입력하세요... (전송은 ➤ 버튼)'
  : '메시지를 입력하세요... (Shift+Enter 줄바꿈)';

loadHistory();
loadMemory();
loadCalendarStatus();

// 데스크탑: 사이드바 기본 열림
if (window.innerWidth > 680) {
  sidebarOpen = true;
  sidebarEl.classList.remove('hidden');
}
})();
</script>
</body>
</html>`;

// ─── Routes ────────────────────────────────────────────────────────────────

// GET / — 채팅 UI
app.get("/", (c) => c.html(CHAT_HTML));

// GET /manifest.json — PWA 매니페스트
app.get("/manifest.json", (c) =>
  c.json(MANIFEST, 200, { "Cache-Control": "public, max-age=86400" })
);

// GET /sw.js — 서비스 워커
app.get("/sw.js", (c) =>
  new Response(SW_JS, {
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-cache",
      "Service-Worker-Allowed": "/",
    },
  })
);

// GET /icon-192.png, /icon-512.png — SVG 아이콘
app.get("/icon-192.png", (c) =>
  new Response(ICON_SVG, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=604800" },
  })
);
app.get("/icon-512.png", (c) =>
  new Response(ICON_SVG, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=604800" },
  })
);

// POST /api/chat — 스트리밍 채팅
app.post("/api/chat", async (c) => {
  const env = c.env;
  let body: { user_input?: string; user_id?: string; channel?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "요청 형식이 올바르지 않습니다." }, 400);
  }

  if (!body.user_input?.trim()) {
    return c.json({ error: "입력값이 비어있습니다." }, 400);
  }
  if (!body.user_id?.trim()) {
    return c.json({ error: "user_id가 필요합니다." }, 400);
  }
  if (!["work", "personal"].includes(body.channel as string)) {
    return c.json({ error: "채널은 'work' 또는 'personal'만 가능합니다." }, 400);
  }

  const userId = body.user_id.trim();
  const channel = body.channel as string;

  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const rl = await checkRateLimit(env, ip);
  if (!rl.ok) {
    return c.json(
      { error: `요청이 너무 많습니다. ${Math.ceil(rl.retryAfter / 60)}분 후 다시 시도해 주세요.` },
      429,
      { "Retry-After": String(rl.retryAfter) }
    );
  }

  let calContext: string | null = null;
  if (hasCalendarIntent(body.user_input)) {
    if (await isConnected(env, userId)) {
      const wantsWeek =
        body.user_input.includes("이번 주") || body.user_input.includes("주간");
      const text = wantsWeek
        ? await getWeekEventsText(env, userId)
        : await getTodayEventsText(env, userId);
      // null = 조회 실패, "" = 일정 없음. 둘을 구분해야 AI 가 단언하지 않는다.
      calContext =
        text === null
          ? "(캘린더를 불러오지 못했습니다. 일정이 없다고 단정하지 말고, 연동 상태를 확인해 보라고 안내하라)"
          : text === ""
          ? "(해당 기간에 등록된 일정이 없습니다)"
          : text;
    } else {
      calContext =
        "(Google 캘린더가 연동되어 있지 않다. 일정을 아는 것처럼 답하지 말고, 사이드바에서 연동할 수 있다고 안내하라)";
    }
  }

  if (hasCalendarWriteIntent(body.user_input)) {
    const notice =
      "(중요: 너는 일정을 등록·수정·삭제할 수 없다. 등록했다고 말하지 마라. " +
      "대신 사용자가 직접 등록할 수 있도록 제목·날짜·시간을 정리해서 제시하라)";
    calContext = calContext ? calContext + "\n" + notice : notice;
  }

  const limit = parseInt(env.RECENT_MESSAGE_LIMIT);
  const [recentHistory, summary, profile] = await Promise.all([
    getRecentMessages(env.DB, userId, channel, limit),
    getSummary(env.DB, userId, channel),
    getProfile(env.DB, userId, channel),
  ]);

  const messages = buildMessages(
    body.user_input,
    channel,
    recentHistory,
    summary,
    profile,
    calContext
  );

  await saveMessage(env.DB, userId, channel, "user", body.user_input);

  const aiStream = await env.AI.run(
    env.AI_MODEL as Parameters<Ai["run"]>[0],
    { messages, max_tokens: parseInt(env.MAX_TOKENS), stream: true } as AiTextGenerationInput
  ) as ReadableStream;

  const reader = (aiStream as ReadableStream).getReader();
  const decoder = new TextDecoder();
  let fullResponse = "";

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data) as { response?: string };
              const text = parsed.response || "";
              if (text) {
                fullResponse += text;
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ text, done: false })}\n\n`)
                );
              }
            } catch {}
          }
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ text: "", done: true })}\n\n`)
        );
        controller.close();
        c.executionCtx.waitUntil(
          (async () => {
            await saveMessage(env.DB, userId, channel, "assistant", fullResponse);
            await maybeUpdateMemory(env, userId, channel);
          })()
        );
      } catch (err) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: String(err), done: true })}\n\n`)
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// GET /api/memory/:user_id
app.get("/api/memory/:user_id", async (c) => {
  const userId = c.req.param("user_id");
  const channel = c.req.query("channel") || "work";
  const env = c.env;
  const [summary, profile, countResult] = await Promise.all([
    getSummary(env.DB, userId, channel),
    getProfile(env.DB, userId, channel),
    env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM messages WHERE user_id = ? AND channel = ?"
    ).bind(userId, channel).first<{ cnt: number }>(),
  ]);
  return c.json({ user_id: userId, channel, summary, profile, recent_message_count: countResult?.cnt ?? 0 });
});

// DELETE /api/memory/:user_id
app.delete("/api/memory/:user_id", async (c) => {
  const userId = c.req.param("user_id");
  const channel = c.req.query("channel") || "work";
  const db = c.env.DB;
  await db.batch([
    db.prepare("DELETE FROM messages WHERE user_id = ? AND channel = ?").bind(userId, channel),
    db.prepare("DELETE FROM summaries WHERE user_id = ? AND channel = ?").bind(userId, channel),
    db.prepare("DELETE FROM profiles WHERE user_id = ? AND channel = ?").bind(userId, channel),
  ]);
  return c.json({ message: `${userId}(${channel}) 메모리 초기화 완료` });
});

// GET /api/history/:user_id
app.get("/api/history/:user_id", async (c) => {
  const userId = c.req.param("user_id");
  const channel = c.req.query("channel") || "work";
  const limit = parseInt(c.req.query("limit") || "20");
  const result = await c.env.DB.prepare(
    "SELECT role, content, timestamp FROM messages WHERE user_id = ? AND channel = ? ORDER BY id DESC LIMIT ?"
  ).bind(userId, channel, limit).all();
  return c.json({
    messages: ((result.results || []) as { role: string; content: string; timestamp: string }[])
      .reverse()
      .map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
  });
});

// GET /api/calendar/auth
app.get("/api/calendar/auth", async (c) => {
  const userId = c.req.query("user_id");
  if (!userId) return c.json({ error: "user_id 필요" }, 400);
  if (!c.env.GOOGLE_CLIENT_ID) return c.json({ error: "Google OAuth가 설정되지 않았습니다." }, 500);
  return c.json({ auth_url: getAuthUrl(c.env, userId) });
});

// GET /api/calendar/callback
app.get("/api/calendar/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.json({ error: "code/state 누락" }, 400);
  const success = await handleCallback(c.env, code, state);
  if (success) {
    return c.html(`<!DOCTYPE html><html lang="ko"><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#0f172a;color:#f1f5f9">
<div style="text-align:center">
  <div style="font-size:48px;margin-bottom:16px">✅</div>
  <h2 style="color:#6366f1;margin-bottom:8px">Google 캘린더 연동 완료!</h2>
  <p style="color:#94a3b8">이 창을 닫고 채팅으로 돌아가세요.</p>
  <script>setTimeout(()=>window.close(),2000)<\/script>
</div></body></html>`);
  }
  return c.json({ error: "인증에 실패했습니다." }, 400);
});

// GET /api/calendar/status/:user_id
app.get("/api/calendar/status/:user_id", async (c) => {
  const connected = await isConnected(c.env, c.req.param("user_id"));
  return c.json({ connected });
});

// DELETE /api/calendar/disconnect/:user_id
app.delete("/api/calendar/disconnect/:user_id", async (c) => {
  await disconnect(c.env, c.req.param("user_id"));
  return c.json({ message: "Google 캘린더 연동이 해제되었습니다." });
});

// GET /api/calendar/events/:user_id
app.get("/api/calendar/events/:user_id", async (c) => {
  const userId = c.req.param("user_id");
  const days = parseInt(c.req.query("days") || "7");
  const connected = await isConnected(c.env, userId);
  if (!connected) return c.json({ error: "Google 캘린더가 연동되지 않았습니다." }, 401);
  const now = new Date();
  const max = new Date(now);
  max.setDate(max.getDate() + days);
  const events = await listEvents(c.env, userId, now.toISOString(), max.toISOString());
  if (events === null) return c.json({ error: "일정을 가져오는데 실패했습니다." }, 500);
  return c.json({ events });
});

// POST /api/calendar/events
app.post("/api/calendar/events", async (c) => {
  const body = await c.req.json<{
    user_id: string; summary: string; start_time: string; end_time: string;
    description?: string; location?: string;
  }>();
  const connected = await isConnected(c.env, body.user_id);
  if (!connected) return c.json({ error: "Google 캘린더가 연동되지 않았습니다." }, 401);
  const result = await createEvent(c.env, body.user_id, body.summary, body.start_time, body.end_time, body.description, body.location);
  if (!result) return c.json({ error: "일정 생성에 실패했습니다." }, 500);
  return c.json(result);
});

// PUT /api/calendar/events
app.put("/api/calendar/events", async (c) => {
  const body = await c.req.json<{
    user_id: string; event_id: string; summary?: string;
    start_time?: string; end_time?: string; description?: string; location?: string;
  }>();
  const connected = await isConnected(c.env, body.user_id);
  if (!connected) return c.json({ error: "Google 캘린더가 연동되지 않았습니다." }, 401);
  const result = await updateEvent(c.env, body.user_id, body.event_id, {
    summary: body.summary, start_time: body.start_time, end_time: body.end_time,
    description: body.description, location: body.location,
  });
  if (!result) return c.json({ error: "일정 수정에 실패했습니다." }, 500);
  return c.json(result);
});

// DELETE /api/calendar/events/:user_id/:event_id
app.delete("/api/calendar/events/:user_id/:event_id", async (c) => {
  const userId = c.req.param("user_id");
  const eventId = c.req.param("event_id");
  const connected = await isConnected(c.env, userId);
  if (!connected) return c.json({ error: "Google 캘린더가 연동되지 않았습니다." }, 401);
  const success = await deleteEvent(c.env, userId, eventId);
  if (!success) return c.json({ error: "일정 삭제에 실패했습니다." }, 500);
  return c.json({ message: "일정이 삭제되었습니다." });
});

// 전역 오류 핸들러
// 예전에는 예외가 그대로 500 "Internal Server Error" 로 나가서
// UI 에 "오류가 발생했습니다" 만 뜨고 원인을 알 수 없었다.
app.onError((err, c) => {
  const msg = String(err?.message ?? err);
  console.error("unhandled:", msg);
  if (/neuron|daily free allocation|3040|4006/i.test(msg)) {
    return c.json(
      { error: "오늘의 AI 사용량(무료 할당량)을 모두 썼습니다. 내일 오전 9시경 초기화됩니다." },
      429
    );
  }
  if (/rate limit|429/i.test(msg)) {
    return c.json({ error: "요청이 몰리고 있습니다. 잠시 후 다시 시도해 주세요." }, 429);
  }
  return c.json({ error: "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." }, 500);
});

// GET /api/health
app.get("/api/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() })
);

export default app;
