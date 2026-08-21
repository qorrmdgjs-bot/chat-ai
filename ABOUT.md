# 채팅 AI (chat-ai)

Cloudflare Workers 위에서 도는 1인용 AI 채팅 어시스턴트. 업무용과 개인용 두 채널을 나눠 쓰고,
대화가 쌓이면 스스로 요약과 사용자 프로필을 만들어 다음 대화의 맥락으로 재사용한다.
Google 캘린더를 붙이면 일정을 읽어 답변에 반영한다.

**배포 주소:** https://chat-ai.hr-ee4.workers.dev

---

## 1. 무엇이 다른가

일반적인 AI 채팅앱과 비교했을 때 이 앱의 성격은 세 가지로 요약된다.

**서버가 기억한다.** 대화 이력이 브라우저가 아니라 D1(SQLite)에 남는다. 브라우저를 닫아도,
새로고침해도 이어진다. 다만 사용자 식별이 localStorage의 UUID 하나뿐이라 기기 간 동기화는 되지 않는다.

**기억을 압축한다.** 전체 이력을 매번 모델에 넣지 않는다. 최근 20개 메시지 + LLM이 만든 요약 +
LLM이 추론한 사용자 프로필, 이 세 가지만 넣는다. 대화가 아무리 길어져도 프롬프트 크기가 일정하다.

**용도별로 인격이 갈린다.** `업무`/`개인` 채널은 UI 탭이 아니라 데이터와 프롬프트가 완전히 분리된
두 개의 공간이다. 이력·요약·프로필이 채널별로 따로 쌓인다.

## 2. 기능

| 기능 | 설명 |
|---|---|
| 스트리밍 채팅 | SSE로 토큰 단위 출력, 중단 버튼으로 도중 정지 가능 |
| 2채널 | `업무`(파트너 역할) / `개인`(생활 어시스턴트). 데이터 격리 |
| 자동 요약 | 채널당 메시지 10개마다 200자 이내로 갱신 |
| 자동 프로필 | 20개마다 스타일·고민·관심주제·소통방식 4항목 추출 |
| Google 캘린더 | OAuth 연동 후 오늘/이번주 일정을 답변 맥락에 주입 (읽기 전용) |
| PWA | 설치 가능, 오프라인 셸 캐시, iOS safe-area 대응 |
| 사이드바 | 현재 요약·프로필·캘린더 상태를 실시간 확인 |
| 기록 초기화 | 현재 채널의 이력·요약·프로필 일괄 삭제 |
| 메시지 복사 | 마크다운 원문 그대로 복사 |
| 레이트리밋 | IP 단위 시간당 40회 |

## 3. 동작 방식

### 한 번의 대화 요청에서 일어나는 일

```
POST /api/chat  { user_input, user_id, channel }
   │
   ├─ 0. 입력 검증 + 레이트리밋 (IP 시간당 40회)
   │
   ├─ 1. 캘린더 의도 감지 — 읽기 의도와 쓰기 의도를 따로 판정
   │      읽기: 연동돼 있으면 KST 기준 오늘/이번주 일정을 읽어 맥락에 넣는다
   │            조회 실패 / 일정 0건 / 미연동을 각각 다르게 표기한다
   │      쓰기: 등록 기능이 없음을 명시해 모델이 허위로 답하지 않게 한다
   │
   ├─ 2. 맥락 3종을 병렬 조회 (Promise.all)
   │      최근 메시지 20개 · 요약 1건 · 프로필 1건
   │
   ├─ 3. 프롬프트 조립
   │      [system]    채널별 역할 정의
   │      [user]      "[참고 맥락]" + 요약 + 프로필 + 캘린더
   │      [assistant] "맥락 파악했습니다"      ← 맥락 주입용 가짜 턴
   │      [...]       최근 대화 20개
   │      [user]      이번 입력
   │
   ├─ 4. 사용자 메시지를 D1에 저장 (모델 호출 전)
   │
   ├─ 5. Workers AI 스트리밍 호출 → SSE로 클라이언트에 중계
   │
   └─ 6. 응답 완료 후 waitUntil() 백그라운드 작업
          · assistant 메시지 저장
          · 누적 개수가 10의 배수면 요약 갱신
          · 20의 배수면 프로필 갱신
```

요약·프로필 갱신은 응답을 끊지 않도록 `executionCtx.waitUntil()`로 뒤에서 돈다.
사용자는 대기하지 않는다.

### 기억이 만들어지는 규칙

| 대상 | 트리거 | 입력 범위 | 저장 |
|---|---|---|---|
| 요약 | 마지막 갱신 후 10개 누적 | 최근 20개 | `summaries` 1행 (덮어쓰기) |
| 프로필 | 마지막 갱신 후 20개 누적 | 최근 50개 | `profiles` 1행 (필드별 병합) |

"정확히 N의 배수" 가 아니라 마지막 갱신 시점(`message_count_at_update`) 대비 누적량으로
판단한다. 배수 방식은 메시지 저장이 한 번만 실패해도 카운트가 어긋나 이후 영구히
갱신되지 않았다.

프로필은 JSON으로 뽑아 파싱한다. 파싱에 실패하면 건너뛰고, 모델이 일부 필드를
빠뜨리면 그 필드는 기존 값을 유지한다.

## 4. 구조

```
src/
├── index.ts     Hono 앱 · 라우트 · 프롬프트 · UI(HTML/CSS/JS 인라인)
├── memory.ts    D1 CRUD · 요약/프로필 생성 로직
├── calendar.ts  Google OAuth · Calendar API 래퍼
└── time.ts      KST 기준 날짜 계산 (런타임은 UTC)
```

프런트엔드는 빌드 없이 `index.ts` 안의 템플릿 리터럴에 통째로 들어 있다.
프레임워크도 번들러도 없다. 워커 하나가 API와 UI를 모두 서빙한다.

### 인프라

| 바인딩 | 리소스 | 용도 |
|---|---|---|
| `AI` | Workers AI | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `DB` | D1 `chat-ai-db` | 메시지·요약·프로필 |
| `TOKEN_STORE` | KV | Google OAuth 토큰 (`cal_token:{user_id}`) |

### 설정값 (`wrangler.toml [vars]`)

| 변수 | 값 | 의미 |
|---|---|---|
| `AI_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 사용 모델 |
| `MAX_TOKENS` | `1024` | 응답 최대 길이 |
| `RECENT_MESSAGE_LIMIT` | `20` | 프롬프트에 넣을 최근 메시지 수 |
| `SUMMARY_TRIGGER_COUNT` | `10` | 요약 갱신 주기 |
| `PROFILE_TRIGGER_COUNT` | `20` | 프로필 갱신 주기 |
| `SUMMARY_WINDOW` | `20` | 요약 입력 메시지 수 |
| `PROFILE_WINDOW` | `50` | 프로필 입력 메시지 수 |

Google OAuth 값(`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI`)은
Worker Secret으로 관리한다. 없으면 캘린더 기능만 비활성화되고 채팅은 정상 동작한다.

## 5. 데이터 모델

```sql
CREATE TABLE messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   TEXT NOT NULL,
  channel   TEXT NOT NULL DEFAULT 'work',
  role      TEXT NOT NULL,           -- 'user' | 'assistant'
  content   TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'work',
  summary TEXT NOT NULL,
  message_count_at_update INTEGER DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'work',
  work_style TEXT,
  pain_points TEXT,
  key_topics TEXT,
  communication_preference TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

인덱스: `ix_messages_user_channel_timestamp`, `ix_summaries_user_channel`, `ix_profiles_user_channel`

`timestamp`는 초 단위 TEXT다. 정렬 기준으로 쓰이므로 같은 초에 저장된 두 행의 순서는 보장되지 않는다.

## 6. API

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/` | 채팅 UI |
| `GET` | `/manifest.json`, `/sw.js`, `/icon-{192,512}.png` | PWA 자산 |
| `POST` | `/api/chat` | 스트리밍 채팅 (SSE) |
| `GET` | `/api/history/:user_id?channel=&limit=` | 대화 이력 |
| `GET` | `/api/memory/:user_id?channel=` | 요약·프로필·메시지 수 |
| `DELETE` | `/api/memory/:user_id?channel=` | 채널 데이터 전체 삭제 |
| `GET` | `/api/calendar/auth?user_id=` | OAuth 인증 URL 발급 |
| `GET` | `/api/calendar/callback` | OAuth 콜백 |
| `GET` | `/api/calendar/status/:user_id` | 연동 여부 |
| `DELETE` | `/api/calendar/disconnect/:user_id` | 연동 해제 |
| `GET` | `/api/calendar/events/:user_id?days=` | 일정 조회 |
| `POST` / `PUT` | `/api/calendar/events` | 일정 생성 / 수정 |
| `DELETE` | `/api/calendar/events/:user_id/:event_id` | 일정 삭제 |
| `GET` | `/api/health` | 헬스체크 |

SSE 프레임 형식:
```
data: {"text":"안녕","done":false}
data: {"text":"","done":true}
```

## 7. 운영

### 로컬 실행

```bash
npm install
npm run dev      # wrangler dev
npm run build    # tsc --noEmit (타입체크만)
```

캘린더까지 테스트하려면 `.dev.vars`에 Google OAuth 값이 필요하다 (gitignore 대상).

### 배포

```bash
npx wrangler login
npx wrangler deploy
npx wrangler rollback     # 직전 버전으로 되돌리기
```

### 검증

`scripts/`에 회귀 검증 하네스가 있다. 프롬프트나 모델을 바꾼 뒤 배포 전후로 돌려 비교한다.

```bash
# AI 호출 없음 — 언제든 실행 가능
TZ=UTC npx tsx scripts/test_time.mjs        # KST 날짜/요일/일 경계
node scripts/test_trigger.mjs               # 메모리 갱신 트리거
npx tsx scripts/test_calendar_intent.mts    # 캘린더 읽기/쓰기 의도 분리
node scripts/check_inline_js.mjs [url]      # 인라인 JS 문법 (서버 실행 필요)

# AI 호출 있음 — 할당량을 소모한다
python scripts/probe.py        # 질문에 실제로 답하는가 (답변 성공률)
python scripts/lang_probe.py   # 한국어 응답에 외국어가 섞이는 비율
```

두 스크립트 모두 테스트 계정을 UUID로 만들고 끝나면 스스로 삭제한다.
인자로 다른 base URL을 넘기면 로컬 `wrangler dev`에도 쓸 수 있다.

> **주의:** Windows Git Bash에서 `curl -d '{"user_input":"한글..."}'` 로 테스트하면
> 한글이 CP949로 인코딩돼 서버에 깨진 채 도착한다. 모델이 엉뚱한 답을 하는 것처럼 보이므로
> 반드시 UTF-8을 보장하는 스크립트로 테스트할 것.

### 데이터 조회

```bash
npx wrangler d1 execute chat-ai-db --remote --command "SELECT user_id, channel, COUNT(*) FROM messages GROUP BY 1,2"
```

## 8. 설계상의 선택과 한계

1인용이라는 전제 위에서 여러 가지를 의도적으로 생략했다. 아래는 현재 남아 있는 제약이다.

**인증이 없다.** 사용자 식별은 브라우저 localStorage의 `chat_ai_uid` UUID 하나다.
- 브라우저 데이터를 지우면 대화 기록에 접근할 방법이 사라진다 (DB에는 남지만 찾을 수 없다)
- 기기 간 동기화가 안 된다. PC와 폰이 서로 다른 사용자로 취급된다
- `user_id`를 아는 사람은 해당 대화와 캘린더에 접근할 수 있다

완화책으로 CORS를 동일 출처로 제한하고 IP 단위 시간당 40회 상한을 두었다.
브라우저에서의 교차 출처 호출과 단일 IP의 남용은 막지만, **IP를 바꿔가며 하는 접근이나
`curl` 같은 비브라우저 클라이언트는 막지 못한다.** 근본 해결은 인증이다.

**AI 무료 할당량이 하루 10,000 뉴런이다.** 대략 하루 100~200회 대화면 소진되고,
소진되면 그날은 더 이상 답하지 못한다. 이 경우 429와 함께 원인을 안내한다.
상시 사용하려면 Workers Paid 플랜이 필요하다.

**대화가 하나뿐이다.** 채널당 단일 연속 로그다. 스레드 분리, 제목, 검색, 내보내기가 없다.

**캘린더는 읽기 전용이다.** 쓰기 API는 존재하지만 채팅에서 호출되지 않는다
(tool calling 미구현). "일정 잡아줘" 같은 요청은 등록 불가를 명시하고, 대신 사용자가
직접 넣을 수 있도록 제목·날짜·시간을 정리해 준다.

**응답 길이가 1024 토큰으로 제한된다.** 잘려도 표시가 없고 이어쓰기 기능이 없다.

**모델이 한국어 응답에 한자·가나를 섞는다.** `llama-3.3-70b-instruct-fp8-fast`의
특성으로, 15개 질문 중 8개(53%)에서 관측된다. 프롬프트로 금지해도 개선되지 않음이
측정으로 확인됐다.

```
회의 전 목적과议程를 명확하게    운동을 피하세요.運動은 신체에
엔도르핀을 분泌시켜            헤드폰을 사용하거나,通知를 끄거나
```

같은 15문항을 다른 모델로 돌린 결과는 아래와 같다. 모델 교체가 유일한 해결책으로 보인다.

| 모델 | 외국어 혼입 | 비고 |
|---|---|---|
| llama-3.3-70b-fp8-fast (현재) | 9/15 (60%) | |
| mistral-small-3.1-24b | 0/15 | ctx 128k |
| llama-4-scout-17b-16e | 0/15 | ctx 131k |
| gpt-oss-120b · gemma-4-26b | 측정 불가 | 추론형, 아래 참고 |

**`AI_MODEL` 교체는 한 줄짜리가 아니다.** 워커의 SSE 파서는 `parsed.response`만 읽는데,
추론형 모델(gpt-oss, gemma-4 등)은 `choices[0].delta.reasoning_content`로 흘리고
`response`를 채우지 않는다. 그런 모델로 바꾸면 응답이 통째로 빈 문자열이 되고
아무 오류도 나지 않는다. 교체 전에 반드시 `scripts/probe.py`로 확인할 것.

### 알려진 함정

**Windows Git Bash에서 한글 테스트.** `curl -d '{"user_input":"한글..."}'`로 보내면
CP949로 인코딩돼 서버에 깨진 채 도착한다. 모델이 엉뚱한 답을 하는 것처럼 보여
오진하기 쉽다. 반드시 UTF-8을 보장하는 스크립트로 테스트할 것.

**템플릿 리터럴 안의 클라이언트 JS.** UI는 `index.ts`의 백틱 문자열 안에 있어서,
JS 문자열에 `
`을 쓰면 TypeScript가 실제 개행으로 바꿔 인라인 스크립트가 깨진다.
반드시 `\n`으로 이중 이스케이프할 것. 타입체크로는 잡히지 않으므로
`scripts/check_inline_js.mjs`로 확인한다.

## 9. 기술 스택

- **런타임** Cloudflare Workers
- **프레임워크** Hono 4
- **모델** Workers AI — Llama 3.3 70B Instruct (FP8)
- **저장소** D1 (SQLite) · KV
- **언어** TypeScript 5 (`--noEmit`, 번들은 wrangler 담당)
- **프런트엔드** 바닐라 JS / CSS, 빌드 없음
