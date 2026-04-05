import type { Env } from "./memory";

const SCOPES = "https://www.googleapis.com/auth/calendar";
const AUTH_URI = "https://accounts.google.com/o/oauth2/auth";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

interface TokenData {
  access_token: string;
  refresh_token?: string;
  token_uri: string;
  client_id: string;
  client_secret: string;
  expiry: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  location: string;
  description: string;
  link?: string;
}

function tokenKey(userId: string): string {
  return `cal_token:${userId}`;
}

export function getAuthUrl(env: Env, userId: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: env.GOOGLE_REDIRECT_URI!,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state: userId,
  });
  return `${AUTH_URI}?${params.toString()}`;
}

export async function handleCallback(
  env: Env,
  code: string,
  userId: string
): Promise<boolean> {
  try {
    const res = await fetch(TOKEN_URI, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: env.GOOGLE_REDIRECT_URI!,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    const token: TokenData = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_uri: TOKEN_URI,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      expiry: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    };
    await env.TOKEN_STORE.put(tokenKey(userId), JSON.stringify(token));
    return true;
  } catch {
    return false;
  }
}

export async function getAccessToken(
  env: Env,
  userId: string
): Promise<string | null> {
  const raw = await env.TOKEN_STORE.get(tokenKey(userId));
  if (!raw) return null;
  const token = JSON.parse(raw) as TokenData;
  if (token.expiry && new Date(token.expiry) < new Date()) {
    if (!token.refresh_token) return null;
    try {
      const res = await fetch(TOKEN_URI, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID!,
          client_secret: env.GOOGLE_CLIENT_SECRET!,
          refresh_token: token.refresh_token,
          grant_type: "refresh_token",
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        access_token: string;
        expires_in: number;
      };
      token.access_token = data.access_token;
      token.expiry = new Date(Date.now() + data.expires_in * 1000).toISOString();
      await env.TOKEN_STORE.put(tokenKey(userId), JSON.stringify(token));
    } catch {
      return null;
    }
  }
  return token.access_token;
}

export async function isConnected(env: Env, userId: string): Promise<boolean> {
  const raw = await env.TOKEN_STORE.get(tokenKey(userId));
  return raw !== null;
}

export async function disconnect(env: Env, userId: string): Promise<void> {
  await env.TOKEN_STORE.delete(tokenKey(userId));
}

export async function listEvents(
  env: Env,
  userId: string,
  timeMin: string,
  timeMax: string,
  maxResults = 10
): Promise<CalendarEvent[] | null> {
  const accessToken = await getAccessToken(env, userId);
  if (!accessToken) return null;
  try {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      maxResults: String(maxResults),
      singleEvents: "true",
      orderBy: "startTime",
    });
    const res = await fetch(
      `${CALENDAR_API}/calendars/primary/events?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      items?: Array<{
        id: string;
        summary?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
        location?: string;
        description?: string;
      }>;
    };
    return (data.items || []).map((e) => ({
      id: e.id,
      summary: e.summary || "(제목 없음)",
      start: e.start?.dateTime || e.start?.date || "",
      end: e.end?.dateTime || e.end?.date || "",
      location: e.location || "",
      description: e.description || "",
    }));
  } catch {
    return null;
  }
}

export async function createEvent(
  env: Env,
  userId: string,
  summary: string,
  startTime: string,
  endTime: string,
  description = "",
  location = ""
): Promise<{ id: string; summary: string; start: string; end: string; link: string } | null> {
  const accessToken = await getAccessToken(env, userId);
  if (!accessToken) return null;
  const body: Record<string, unknown> = {
    summary,
    start: { dateTime: startTime, timeZone: "Asia/Seoul" },
    end: { dateTime: endTime, timeZone: "Asia/Seoul" },
  };
  if (description) body.description = description;
  if (location) body.location = location;
  try {
    const res = await fetch(`${CALENDAR_API}/calendars/primary/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const created = (await res.json()) as {
      id: string;
      summary: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      htmlLink?: string;
    };
    return {
      id: created.id,
      summary: created.summary,
      start: created.start?.dateTime || created.start?.date || "",
      end: created.end?.dateTime || created.end?.date || "",
      link: created.htmlLink || "",
    };
  } catch {
    return null;
  }
}

export async function updateEvent(
  env: Env,
  userId: string,
  eventId: string,
  updates: {
    summary?: string;
    start_time?: string;
    end_time?: string;
    description?: string;
    location?: string;
  }
): Promise<{ id: string; summary: string; start: string; end: string } | null> {
  const accessToken = await getAccessToken(env, userId);
  if (!accessToken) return null;
  try {
    const getRes = await fetch(
      `${CALENDAR_API}/calendars/primary/events/${eventId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!getRes.ok) return null;
    const existing = (await getRes.json()) as Record<string, unknown>;
    if (updates.summary !== undefined) existing.summary = updates.summary;
    if (updates.start_time !== undefined)
      existing.start = { dateTime: updates.start_time, timeZone: "Asia/Seoul" };
    if (updates.end_time !== undefined)
      existing.end = { dateTime: updates.end_time, timeZone: "Asia/Seoul" };
    if (updates.description !== undefined) existing.description = updates.description;
    if (updates.location !== undefined) existing.location = updates.location;
    const res = await fetch(
      `${CALENDAR_API}/calendars/primary/events/${eventId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(existing),
      }
    );
    if (!res.ok) return null;
    const updated = (await res.json()) as {
      id: string;
      summary: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
    };
    return {
      id: updated.id,
      summary: updated.summary,
      start: updated.start?.dateTime || updated.start?.date || "",
      end: updated.end?.dateTime || updated.end?.date || "",
    };
  } catch {
    return null;
  }
}

export async function deleteEvent(
  env: Env,
  userId: string,
  eventId: string
): Promise<boolean> {
  const accessToken = await getAccessToken(env, userId);
  if (!accessToken) return false;
  try {
    const res = await fetch(
      `${CALENDAR_API}/calendars/primary/events/${eventId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    return res.ok || res.status === 204;
  } catch {
    return false;
  }
}

export async function getTodayEventsText(
  env: Env,
  userId: string
): Promise<string | null> {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart);
  todayEnd.setDate(todayEnd.getDate() + 1);
  const events = await listEvents(
    env,
    userId,
    todayStart.toISOString(),
    todayEnd.toISOString(),
    20
  );
  if (!events || events.length === 0) return null;
  return events
    .map((e) => {
      if (e.start.includes("T")) {
        const t = e.start.split("T")[1].substring(0, 5);
        return `- ${t} ${e.summary}`;
      }
      return `- (종일) ${e.summary}`;
    })
    .join("\n");
}

export async function getWeekEventsText(
  env: Env,
  userId: string
): Promise<string | null> {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(todayStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const events = await listEvents(
    env,
    userId,
    todayStart.toISOString(),
    weekEnd.toISOString(),
    30
  );
  if (!events || events.length === 0) return null;
  const lines: string[] = [];
  let currentDate = "";
  for (const e of events) {
    let datePart: string;
    let timePart: string;
    if (e.start.includes("T")) {
      datePart = e.start.split("T")[0];
      timePart = e.start.split("T")[1].substring(0, 5);
    } else {
      datePart = e.start;
      timePart = "종일";
    }
    if (datePart !== currentDate) {
      currentDate = datePart;
      lines.push(`\n[${datePart}]`);
    }
    lines.push(`  - ${timePart} ${e.summary}`);
  }
  return lines.join("\n");
}
