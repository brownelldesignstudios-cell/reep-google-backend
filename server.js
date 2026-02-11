import express from "express";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cookieParser());
const path = require("path");

// Serve static ops pages (repo-relative from this server.js file)
const OPS_DIR = path.join(__dirname, "..", "..", "02_OPS_PAGES");
app.use(express.static(OPS_DIR));


// ---- CONFIG ----
const {
  PORT = 3000,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  GOOGLE_CALENDAR_ID = "primary",
  API_KEY,
  ALLOWED_ORIGINS = "", // comma-separated list, optional
} = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
  console.error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI in env");
  process.exit(1);
}

// Origins (optional). If blank, we allow any origin BUT still require API_KEY.
const allowedOrigins = ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);

// ---- Minimal CORS ----
app.use((req, res, next) => {
  const origin = req.headers.origin;

  // If no allowlist provided, allow all origins (Phase 0 friendly).
  const originAllowed = allowedOrigins.length === 0 || (origin && allowedOrigins.includes(origin));

  if (origin && originAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  }

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- API key guard (protect /api/* only) ----
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();

  if (!API_KEY) {
    return res.status(500).json({ error: "Server misconfigured: API_KEY missing" });
  }

  const key = req.header("X-API-Key");
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
});

// ---- OAuth client ----
const oauth2Client = new OAuth2Client(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// ---- Option A: IN-MEMORY TOKEN STORE ONLY ----
// Tokens die when Render restarts/cold-starts. That’s intentional for free tier.
let tokenStore = null;

function setTokens(tokens) {
  tokenStore = { ...(tokenStore || {}), ...(tokens || {}) };
  oauth2Client.setCredentials(tokenStore);
}

// ---- Event log (Phase 0) ----
// For free tier we’ll keep events in memory and ALSO best-effort append to a local file.
// File may reset on restart — acceptable in Phase 0.
const EVENTS_PATH = path.join(process.cwd(), "events.jsonl");
let eventsMem = [];

function nowIso() {
  return new Date().toISOString();
}

function appendEvent(eventObj) {
  eventsMem.push(eventObj);
  try {
    fs.appendFileSync(EVENTS_PATH, JSON.stringify(eventObj) + "\n", "utf8");
  } catch {
    // If filesystem is not writable/ephemeral, we still keep memory events for the session.
  }
}

function summarizeGoogleError(e) {
  const status = e?.code || e?.response?.status || 500;
  const data = e?.response?.data;
  const message =
    data?.error?.message ||
    data?.error_description ||
    e?.message ||
    "Unknown error";

  return {
    status,
    message,
    reason: data?.error?.errors?.[0]?.reason || undefined,
    domain: data?.error?.errors?.[0]?.domain || undefined,
    calendar_id: GOOGLE_CALENDAR_ID,
  };
}

function isConnected() {
  return !!(tokenStore && (tokenStore.access_token || tokenStore.refresh_token));
}

// ---- ROUTES ----

// Health (no auth)
app.get("/health", (req, res) => res.send("healthy"));

// Start OAuth (no API key)
app.get("/auth/google/start", (req, res) => {
  // NOTE: prompt=consent gives best chance of refresh_token in a session.
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar.readonly"],
  });
  res.redirect(url);
});

// OAuth callback (no API key)
app.get("/oauth/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error) return res.status(400).send(`OAuth error: ${error}`);
  if (!code) return res.status(400).send("Missing ?code=...");

  try {
    const { tokens } = await oauth2Client.getToken(code);
    setTokens(tokens);

    res.send("✅ Google connected (in-memory). If the service restarts, re-run /auth/google/start. Next: /auth/google/status");
  } catch (e) {
    console.error("TOKEN EXCHANGE ERROR:", e?.response?.data || e);
    res.status(500).send("Token exchange failed. Check server logs.");
  }
});

// Status (no API key)
app.get("/auth/google/status", (req, res) => {
  res.json({
    connected: isConnected(),
    has_refresh_token: !!(tokenStore && tokenStore.refresh_token),
    calendar_id: GOOGLE_CALENDAR_ID,
    note: "Option A: tokens are in-memory only; restart requires re-auth.",
  });
});

// ---- API (requires X-API-Key) ----

// Get jobs
app.get("/api/jobs", async (req, res) => {
  try {
    if (!isConnected()) {
      return res.status(401).json({ error: "Not connected. Run /auth/google/start" });
    }

    const date = req.query.date; // YYYY-MM-DD optional
    const now = new Date();
    const yyyyMmDd =
      date ||
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
        now.getDate()
      ).padStart(2, "0")}`;

    // Your “-06:00” window (America/Chicago standard offset).
    // Later we can make this dynamic if you want, but this is stable for now.
    const timeMin = new Date(`${yyyyMmDd}T00:00:00-06:00`).toISOString();
    const timeMax = new Date(`${yyyyMmDd}T23:59:59-06:00`).toISOString();

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    // Support selecting multiple calendars from the UI:
    // ?calendar_ids=id1,id2,id3
    const calendarIdsParam = req.query.calendar_ids || "";
    const calendarIds = calendarIdsParam
      ? String(calendarIdsParam)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [GOOGLE_CALENDAR_ID];

    // Fetch events from all requested calendars and merge results.
    const results = await Promise.all(
      calendarIds.map(async (calId) => {
        const r = await calendar.events.list({
          calendarId: calId,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 250,
        });
        const items = r.data.items || [];
        // Annotate calendar id for downstream use
        return items.map((ev) => ({ ...ev, __calendarId: calId }));
      })
    );

    const items = results.flat();

    const jobs = items.map((ev) => {
      const start = ev.start?.dateTime || ev.start?.date || null;
      const end = ev.end?.dateTime || ev.end?.date || null;
      const calendar_id = ev.__calendarId || GOOGLE_CALENDAR_ID;

      return {
        job_id: ev.id,
        summary: ev.summary || "(no title)",
        start_time: start,
        end_time: end,
        location: ev.location || "",
        description: ev.description || "",
        htmlLink: ev.htmlLink || "",
        calendar_id,
      };
    });

    res.json({
      date: yyyyMmDd,
      calendar_ids: calendarIds,
      count: jobs.length,
      jobs,
    });
  } catch (e) {
    console.error("EVENTS LIST ERROR (full):", e?.response?.data || e);
    res.status(500).json({ error: summarizeGoogleError(e) });
  }
});

// shoot_completed
app.post("/api/jobs/:job_id/shoot-complete", (req, res) => {
  const { job_id } = req.params;
  const { completed_at, notes, operator } = req.body || {};

  const eventObj = {
    type: "shoot_completed",
    ts: nowIso(),
    job_id,
    completed_at: completed_at || nowIso(),
    notes: notes || "",
    operator: operator || "",
  };

  appendEvent(eventObj);
  res.json({ ok: true, event: eventObj });
});

// operator_note
app.post("/api/jobs/:job_id/note", (req, res) => {
  const { job_id } = req.params;
  const { note, operator } = req.body || {};

  const eventObj = {
    type: "operator_note",
    ts: nowIso(),
    job_id,
    note: note || "",
    operator: operator || "",
  };

  appendEvent(eventObj);
  res.json({ ok: true, event: eventObj });
});

// message_sent
app.post("/api/jobs/:job_id/message", (req, res) => {
  const { job_id } = req.params;
  const { channel, to, template, body, operator } = req.body || {};

  const eventObj = {
    type: "message_sent",
    ts: nowIso(),
    job_id,
    channel: channel || "",
    to: to || "",
    template: template || "",
    body: body || "",
    operator: operator || "",
  };

  appendEvent(eventObj);
  res.json({ ok: true, event: eventObj });
});

// Review events (session memory + best-effort file)
app.get("/api/events", (req, res) => {
  try {
    const date = req.query.date; // YYYY-MM-DD optional
    let events = [...eventsMem];

    // Try to also load from file (if exists) so you can see across the current instance life.
    try {
      if (fs.existsSync(EVENTS_PATH)) {
        const lines = fs.readFileSync(EVENTS_PATH, "utf8").trim().split("\n").filter(Boolean);
        const fileEvents = lines.map((l) => JSON.parse(l));
        // Merge (simple concat) — duplicates are acceptable in Phase 0, but usually won’t happen
        events = fileEvents.length ? fileEvents : events;
      }
    } catch {
      // ignore file read errors
    }

    if (date) events = events.filter((e) => String(e.ts || "").startsWith(date));
    res.json({ count: events.length, events });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to read events" });
  }
});

app.listen(PORT, () => {
  console.log(`Server live on port ${PORT}`);
  console.log(`Health: /health`);
  console.log(`OAuth start: /auth/google/start`);
  console.log(`OAuth status: /auth/google/status`);
  console.log(`Jobs: /api/jobs`);
  console.log(`Events: /api/events`);
  console.log(`Using calendarId: ${GOOGLE_CALENDAR_ID}`);
  console.log(`Token storage: in-memory only (Option A)`);
});
