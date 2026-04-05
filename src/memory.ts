export const SUMMARY_PROMPT = `다음은 사용자와의 대화 기록이다.
핵심 내용을 200자 이내로 한국어로 요약하라.

포함 항목:
- 주로 다룬 주제
- 논의된 주요 이슈나 결정사항
- 미해결 과제나 다음 단계

대화 기록:
{conversation}

요약:`;

export const PROFILE_PROMPT = `다음은 사용자와의 대화 내용이다.
아래 JSON 형식으로만 반환하라. 다른 텍스트 없이 순수 JSON만 반환할 것.

{
  "work_style": "사용자의 특성이나 스타일",
  "pain_points": "반복적으로 언급된 고민이나 어려움",
  "key_topics": "주요 관심 영역",
  "communication_preference": "소통 방식 특성"
}

대화 기록:
{conversation}`;

export interface Profile {
  work_style: string | null;
  pain_points: string | null;
  key_topics: string | null;
  communication_preference: string | null;
}

export async function saveMessage(
  db: D1Database,
  userId: string,
  channel: string,
  role: string,
  content: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO messages (user_id, channel, role, content, timestamp) VALUES (?, ?, ?, ?, datetime('now'))"
    )
    .bind(userId, channel, role, content)
    .run();
}

export async function getRecentMessages(
  db: D1Database,
  userId: string,
  channel: string,
  limit: number
): Promise<{ role: string; content: string }[]> {
  const result = await db
    .prepare(
      "SELECT role, content FROM messages WHERE user_id = ? AND channel = ? ORDER BY timestamp DESC LIMIT ?"
    )
    .bind(userId, channel, limit)
    .all();
  return ((result.results || []) as { role: string; content: string }[])
    .reverse()
    .map((m) => ({ role: m.role, content: m.content }));
}

export async function getTotalMessageCount(
  db: D1Database,
  userId: string,
  channel: string
): Promise<number> {
  const result = await db
    .prepare(
      "SELECT COUNT(*) as cnt FROM messages WHERE user_id = ? AND channel = ?"
    )
    .bind(userId, channel)
    .first<{ cnt: number }>();
  return result?.cnt ?? 0;
}

export async function getSummary(
  db: D1Database,
  userId: string,
  channel: string
): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT summary FROM summaries WHERE user_id = ? AND channel = ?"
    )
    .bind(userId, channel)
    .first<{ summary: string }>();
  return row?.summary ?? null;
}

export async function getProfile(
  db: D1Database,
  userId: string,
  channel: string
): Promise<Profile | null> {
  const row = await db
    .prepare(
      "SELECT work_style, pain_points, key_topics, communication_preference FROM profiles WHERE user_id = ? AND channel = ?"
    )
    .bind(userId, channel)
    .first<Profile>();
  if (!row) return null;
  return {
    work_style: row.work_style,
    pain_points: row.pain_points,
    key_topics: row.key_topics,
    communication_preference: row.communication_preference,
  };
}

export async function updateSummary(
  db: D1Database,
  userId: string,
  channel: string,
  summary: string,
  msgCount: number
): Promise<void> {
  const existing = await db
    .prepare(
      "SELECT id FROM summaries WHERE user_id = ? AND channel = ?"
    )
    .bind(userId, channel)
    .first();
  if (existing) {
    await db
      .prepare(
        "UPDATE summaries SET summary = ?, message_count_at_update = ?, updated_at = datetime('now') WHERE user_id = ? AND channel = ?"
      )
      .bind(summary, msgCount, userId, channel)
      .run();
  } else {
    await db
      .prepare(
        "INSERT INTO summaries (user_id, channel, summary, message_count_at_update, updated_at) VALUES (?, ?, ?, ?, datetime('now'))"
      )
      .bind(userId, channel, summary, msgCount)
      .run();
  }
}

export async function updateProfile(
  db: D1Database,
  userId: string,
  channel: string,
  profileData: Partial<Profile>
): Promise<void> {
  const existing = await db
    .prepare(
      "SELECT id FROM profiles WHERE user_id = ? AND channel = ?"
    )
    .bind(userId, channel)
    .first();
  if (existing) {
    await db
      .prepare(
        "UPDATE profiles SET work_style = ?, pain_points = ?, key_topics = ?, communication_preference = ?, updated_at = datetime('now') WHERE user_id = ? AND channel = ?"
      )
      .bind(
        profileData.work_style ?? null,
        profileData.pain_points ?? null,
        profileData.key_topics ?? null,
        profileData.communication_preference ?? null,
        userId,
        channel
      )
      .run();
  } else {
    await db
      .prepare(
        "INSERT INTO profiles (user_id, channel, work_style, pain_points, key_topics, communication_preference, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
      )
      .bind(
        userId,
        channel,
        profileData.work_style ?? null,
        profileData.pain_points ?? null,
        profileData.key_topics ?? null,
        profileData.communication_preference ?? null
      )
      .run();
  }
}

async function callAI(
  ai: Ai,
  model: string,
  prompt: string
): Promise<string | null> {
  try {
    const result = (await ai.run(model as Parameters<Ai["run"]>[0], {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500,
    } as AiTextGenerationInput)) as AiTextGenerationOutput;
    return (result as { response?: string }).response?.trim() ?? null;
  } catch {
    return null;
  }
}

export interface Env {
  DB: D1Database;
  TOKEN_STORE: KVNamespace;
  AI: Ai;
  AI_MODEL: string;
  MAX_TOKENS: string;
  RECENT_MESSAGE_LIMIT: string;
  SUMMARY_TRIGGER_COUNT: string;
  PROFILE_TRIGGER_COUNT: string;
  SUMMARY_WINDOW: string;
  PROFILE_WINDOW: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
}

export async function maybeUpdateMemory(
  env: Env,
  userId: string,
  channel: string
): Promise<void> {
  const total = await getTotalMessageCount(env.DB, userId, channel);
  const summaryTrigger = parseInt(env.SUMMARY_TRIGGER_COUNT);
  const profileTrigger = parseInt(env.PROFILE_TRIGGER_COUNT);

  if (total > 0 && total % summaryTrigger === 0) {
    const summaryWindow = parseInt(env.SUMMARY_WINDOW);
    const msgs = await env.DB.prepare(
      "SELECT role, content FROM messages WHERE user_id = ? AND channel = ? ORDER BY timestamp DESC LIMIT ?"
    )
      .bind(userId, channel, summaryWindow)
      .all();
    const conversation = ((msgs.results || []) as { role: string; content: string }[])
      .reverse()
      .map((m) => `[${m.role.toUpperCase()}] ${m.content}`)
      .join("\n");
    const summary = await callAI(
      env.AI,
      env.AI_MODEL,
      SUMMARY_PROMPT.replace("{conversation}", conversation)
    );
    if (summary) {
      await updateSummary(env.DB, userId, channel, summary, total);
    }
  }

  if (total > 0 && total % profileTrigger === 0) {
    const profileWindow = parseInt(env.PROFILE_WINDOW);
    const msgs = await env.DB.prepare(
      "SELECT role, content FROM messages WHERE user_id = ? AND channel = ? ORDER BY timestamp ASC LIMIT ?"
    )
      .bind(userId, channel, profileWindow)
      .all();
    const conversation = ((msgs.results || []) as { role: string; content: string }[])
      .map((m) => `[${m.role.toUpperCase()}] ${m.content}`)
      .join("\n");
    const raw = await callAI(
      env.AI,
      env.AI_MODEL,
      PROFILE_PROMPT.replace("{conversation}", conversation)
    );
    if (raw) {
      try {
        const cleaned = raw.replace(/```json/g, "").replace(/```/g, "").trim();
        const profileData = JSON.parse(cleaned) as Partial<Profile>;
        await updateProfile(env.DB, userId, channel, profileData);
      } catch {
        // JSON 파싱 실패 시 무시
      }
    }
  }
}
