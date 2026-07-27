/**
 * QuickIndex - Phase 1 MVP (+ Google Indexing API, best-effort)
 * ------------------------
 * A minimal bulk-URL indexing tool, similar in spirit to Sinbyte's core loop:
 *   1. User submits a list of URLs
 *   2. Server pings IndexNow (Bing / Yandex / DuckDuckGo support this natively)
 *   3. Server ALSO pings the Google Indexing API (best-effort, see note below)
 *   4. Server stores the submission + timestamp so the user can see history
 *
 * IMPORTANT HONESTY NOTE (read this before showing it to users):
 * - IndexNow does NOT cover Google. Google has no public "instant index" API
 *   for normal content - the Indexing API is officially documented for
 *   JobPosting / BroadcastEvent (livestream) pages only. Calling it for
 *   ordinary pages often still returns a 200 "accepted" response, but Google
 *   is not obligated to actually crawl/index the page because of it, and
 *   using it outside that scope is outside Google's documented use case.
 *   Keep the UI honest about this - don't claim guaranteed Google indexing.
 * - Both IndexNow and the Google Indexing API return "accepted the
 *   notification", NOT "indexed". We store "submitted"/"accepted" status,
 *   never "indexed". True indexing status still needs Bing Webmaster Tools /
 *   Google Search Console.
 *
 * WHAT MAKES INDEXNOW WORK WITHOUT USERS HOSTING A KEY FILE THEMSELVES:
 * IndexNow supports a "keyLocation" parameter - the key file can be hosted
 * on OUR domain instead of the user's.
 *
 * WHAT GOOGLE NEEDS (unlike IndexNow, this can't be proxied through us):
 * Google's Indexing API is authenticated per Google Cloud service account,
 * and that service account must be added as an Owner on the target site in
 * Google Search Console. So, unlike IndexNow, Google submission here uses
 * OUR OWN service account credentials (set via env vars) - meaning it will
 * only work for sites where you have added our service account as an Owner
 * in Search Console. This is a Phase-1 simplification: a real multi-tenant
 * SaaS would need each customer to grant access to their own Search Console
 * property, which is a bigger Phase 2 feature (OAuth flow per customer).
 */

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const fetch = require("node-fetch");
const { v4: uuidv4 } = require("uuid");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 3000;

// In production this MUST be your real public domain (IndexNow calls back to
// verify the key file). For local testing, IndexNow submission will still be
// *sent*, but Bing cannot reach "localhost" to verify the key - see README.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:3000";

// ---------- Google Indexing API setup ----------
// Path to the service account JSON key file downloaded from Google Cloud.
// If not set, Google submission is silently skipped (IndexNow still works).
const GOOGLE_KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || null;
let googleAuthClient = null;

async function getGoogleAuthClient() {
  if (!GOOGLE_KEY_FILE) return null;
  if (googleAuthClient) return googleAuthClient;

  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/indexing"],
  });
  googleAuthClient = await auth.getClient();
  return googleAuthClient;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- Database ----------
const db = new Database(path.join(__dirname, "quickindex.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    host TEXT UNIQUE NOT NULL,
    indexnow_key TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    url TEXT NOT NULL,
    engine TEXT NOT NULL,
    http_status INTEGER,
    result TEXT,
    submitted_at TEXT NOT NULL,
    FOREIGN KEY (site_id) REFERENCES sites(id)
  );
`);

// ---------- Helpers ----------
function getHostFromUrl(u) {
  try {
    return new URL(u).host;
  } catch (e) {
    return null;
  }
}

function getOrCreateSiteKey(host) {
  let site = db.prepare("SELECT * FROM sites WHERE host = ?").get(host);
  if (site) return site;

  const key = crypto.randomBytes(16).toString("hex"); // IndexNow key: 8-128 hex chars
  const id = uuidv4();
  db.prepare(
    "INSERT INTO sites (id, host, indexnow_key, created_at) VALUES (?, ?, ?, ?)"
  ).run(id, host, key, new Date().toISOString());

  return db.prepare("SELECT * FROM sites WHERE host = ?").get(host);
}

// Serve the IndexNow key file for a given site, from OUR server.
// This is what lets users skip hosting anything themselves.
app.get("/indexnow-keys/:key.txt", (req, res) => {
  const key = req.params.key;
  const site = db.prepare("SELECT * FROM sites WHERE indexnow_key = ?").get(key);
  if (!site) return res.status(404).send("Key not found");
  res.type("text/plain").send(key);
});

// ---------- Core: submit URLs to IndexNow ----------
async function submitToIndexNow(host, key, urls) {
  const keyLocation = `${PUBLIC_BASE_URL}/indexnow-keys/${key}.txt`;

  const body = {
    host,
    key,
    keyLocation,
    urlList: urls,
  };

  try {
    const resp = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    return { status: resp.status, ok: resp.ok };
  } catch (err) {
    return { status: 0, ok: false, error: err.message };
  }
}

// ---------- Core: submit ONE url to Google Indexing API ----------
// Google's API is per-URL, not batch - so we call it once per URL and
// summarize the results for that host afterwards.
async function submitToGoogle(url) {
  const client = await getGoogleAuthClient();
  if (!client) {
    return { status: 0, ok: false, skipped: true, error: "Google not configured" };
  }

  try {
    const resp = await client.request({
      url: "https://indexing.googleapis.com/v3/urlNotifications:publish",
      method: "POST",
      data: {
        url,
        type: "URL_UPDATED",
      },
    });
    return { status: resp.status, ok: resp.status >= 200 && resp.status < 300 };
  } catch (err) {
    const status = err?.response?.status || 0;
    return { status, ok: false, error: err.message };
  }
}

// ---------- API routes ----------

// Submit a batch of URLs
app.post("/api/submit", async (req, res) => {
  const { urls } = req.body;

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: "Provide a non-empty 'urls' array." });
  }
  if (urls.length > 10000) {
    return res.status(400).json({ error: "Max 10,000 URLs per submission." });
  }

  // Group URLs by host - IndexNow requires one host per request
  const byHost = {};
  for (const raw of urls) {
    const u = raw.trim();
    if (!u) continue;
    const host = getHostFromUrl(u);
    if (!host) continue;
    if (!byHost[host]) byHost[host] = [];
    byHost[host].push(u);
  }

  if (Object.keys(byHost).length === 0) {
    return res.status(400).json({ error: "No valid URLs found (must include https://)." });
  }

  const results = [];
  const insertStmt = db.prepare(
    "INSERT INTO submissions (id, site_id, url, engine, http_status, result, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );

  for (const [host, hostUrls] of Object.entries(byHost)) {
    const site = getOrCreateSiteKey(host);
    const now = new Date().toISOString();

    // --- IndexNow (Bing / Yandex / DuckDuckGo) ---
    const indexNowOutcome = await submitToIndexNow(host, site.indexnow_key, hostUrls);
    const indexNowLabel = indexNowOutcome.ok
      ? "accepted"
      : indexNowOutcome.status === 0
      ? "network_error"
      : "rejected";

    for (const u of hostUrls) {
      insertStmt.run(uuidv4(), site.id, u, "indexnow", indexNowOutcome.status, indexNowLabel, now);
    }

    results.push({
      host,
      engine: "indexnow",
      urlCount: hostUrls.length,
      httpStatus: indexNowOutcome.status,
      result: indexNowLabel,
    });

    // --- Google Indexing API (best-effort, per-URL) ---
    let googleAccepted = 0;
    let googleSkipped = false;
    for (const u of hostUrls) {
      const outcome = await submitToGoogle(u);
      if (outcome.skipped) {
        googleSkipped = true;
        continue;
      }
      const label = outcome.ok ? "accepted" : "rejected";
      if (outcome.ok) googleAccepted++;
      insertStmt.run(uuidv4(), site.id, u, "google", outcome.status, label, now);
    }

    if (!googleSkipped) {
      results.push({
        host,
        engine: "google",
        urlCount: hostUrls.length,
        accepted: googleAccepted,
        result: googleAccepted === hostUrls.length ? "accepted" : "partial",
      });
    }
  }

  res.json({ ok: true, batches: results });
});

// List recent submissions (dashboard table)
app.get("/api/submissions", (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.id, s.url, s.engine, s.http_status, s.result, s.submitted_at, sites.host
       FROM submissions s
       JOIN sites ON sites.id = s.site_id
       ORDER BY s.submitted_at DESC
       LIMIT 500`
    )
    .all();
  res.json(rows);
});

// Simple summary stats for the dashboard header
app.get("/api/stats", (req, res) => {
  const total = db.prepare("SELECT COUNT(*) as c FROM submissions").get().c;
  const accepted = db
    .prepare("SELECT COUNT(*) as c FROM submissions WHERE result = 'accepted'")
    .get().c;
  const sites = db.prepare("SELECT COUNT(*) as c FROM sites").get().c;
  res.json({ total, accepted, sites });
});

app.listen(PORT, () => {
  console.log(`QuickIndex running at http://localhost:${PORT}`);
  console.log(`(Set PUBLIC_BASE_URL env var to your real domain before deploying)`);
  if (!GOOGLE_KEY_FILE) {
    console.log(
      `(Google Indexing API not configured - set GOOGLE_SERVICE_ACCOUNT_KEY_FILE to enable it)`
    );
  }
});
