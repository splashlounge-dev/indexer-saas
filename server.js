/**
 * QuickIndex - server.js (FIXED for 422 "Keylocation is not allowed")
 * ---------------------------------------------------------------------
 * The real api.indexnow.org endpoint rejects a keyLocation that isn't on
 * the SAME host as the submission. So we no longer try to host the key
 * file on our own server for every client site - that was the bug.
 *
 * New flow:
 *   1. User enters their domain once, gets a unique key
 *   2. User uploads a tiny text file (containing just that key) to the
 *      ROOT of their OWN website, at:  https://<their-domain>/<key>.txt
 *   3. After that one-time step, submissions for that host will be
 *      accepted, because IndexNow checks the default location itself.
 */

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const fetch = require("node-fetch");
const { v4: uuidv4 } = require("uuid");
const checkIndexRoute = require("./check-index-route");
const seoAuditRoute = require("./seo-audit-route");
const sitemapAuditRoute = require("./sitemap-audit-route");
const schemaCheckerRoute = require("./schema-checker-route");
const webVitalsRoute = require("./web-vitals-route");

const app = express();
const PORT = process.env.PORT || 3000;

// This MUST be your real public Railway/production URL in production -
// used both to serve our own IndexNow key and to build the /hub URL.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:3000";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(checkIndexRoute);
app.use(seoAuditRoute);
app.use(sitemapAuditRoute);
app.use(schemaCheckerRoute);
app.use(webVitalsRoute);

// ---------- Database ----------
const db = new Database(path.join(__dirname, "quickindex.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    host TEXT UNIQUE NOT NULL,
    indexnow_key TEXT NOT NULL,
    key_verified INTEGER DEFAULT 0,
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

  CREATE TABLE IF NOT EXISTS discovery_urls (
    id TEXT PRIMARY KEY,
    url TEXT UNIQUE NOT NULL,
    added_at TEXT NOT NULL
  );
`);

// ---------- Self-hosted key for OUR OWN domain (the hub) ----------
// We own PUBLIC_BASE_URL, so we can serve the key file at our own root
// and it will always be reachable - no manual upload needed for this one.
function getSelfHost() {
  try {
    return new URL(PUBLIC_BASE_URL).host;
  } catch (e) {
    return "localhost";
  }
}

function getOrCreateSelfKey() {
  const host = getSelfHost();
  let site = db.prepare("SELECT * FROM sites WHERE host = ?").get(host);
  if (site) return site;

  const key = crypto.randomBytes(16).toString("hex");
  const id = uuidv4();
  db.prepare(
    "INSERT INTO sites (id, host, indexnow_key, key_verified, created_at) VALUES (?, ?, ?, 1, ?)"
  ).run(id, host, key, new Date().toISOString());
  return db.prepare("SELECT * FROM sites WHERE host = ?").get(host);
}

const selfSite = getOrCreateSelfKey();

// Serve our own key file at the root, e.g. /abc123.txt
app.get(`/${selfSite.indexnow_key}.txt`, (req, res) => {
  res.type("text/plain").send(selfSite.indexnow_key);
});

// ---------- Discovery Hub ----------
// For URLs we don't control, we can't upload a key file to their domain.
// Instead we list them as outbound links on a page WE control, then ping
// IndexNow about that page so crawlers visit it and follow the links.
app.get("/hub", (req, res) => {
  const urls = db.prepare("SELECT url FROM discovery_urls ORDER BY added_at DESC LIMIT 5000").all();
  const links = urls.map((r) => `<li><a href="${r.url}">${r.url}</a></li>`).join("\n");
  res.type("html").send(`
    <!DOCTYPE html>
    <html><head><title>Discovery Hub</title></head>
    <body>
      <h1>Discovery Hub</h1>
      <p>Outbound links for crawler discovery.</p>
      <ul>${links}</ul>
    </body></html>
  `);
});

async function pingHubUpdated() {
  const hubUrl = `${PUBLIC_BASE_URL}/hub`;
  return submitToIndexNow(selfSite.host, selfSite.indexnow_key, [hubUrl]);
}

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

  const key = crypto.randomBytes(16).toString("hex");
  const id = uuidv4();
  db.prepare(
    "INSERT INTO sites (id, host, indexnow_key, created_at) VALUES (?, ?, ?, ?)"
  ).run(id, host, key, new Date().toISOString());

  return db.prepare("SELECT * FROM sites WHERE host = ?").get(host);
}

// Get (or create) the key for a host, and the exact file the user must
// upload to their own site.
app.get("/api/site-key", (req, res) => {
  const host = (req.query.host || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!host) return res.status(400).json({ error: "Provide ?host=example.com" });

  const site = getOrCreateSiteKey(host);
  res.json({
    host: site.host,
    key: site.indexnow_key,
    fileName: `${site.indexnow_key}.txt`,
    fileContent: site.indexnow_key,
    uploadUrl: `https://${site.host}/${site.indexnow_key}.txt`,
  });
});

// Check whether the key file is actually live on the user's site yet
app.get("/api/verify-key", async (req, res) => {
  const host = (req.query.host || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!host) return res.status(400).json({ error: "Provide ?host=example.com" });

  const site = db.prepare("SELECT * FROM sites WHERE host = ?").get(host);
  if (!site) return res.status(404).json({ error: "No key generated for this host yet." });

  const keyUrl = `https://${host}/${site.indexnow_key}.txt`;
  try {
    const resp = await fetch(keyUrl);
    const text = (await resp.text()).trim();
    const verified = resp.ok && text === site.indexnow_key;
    db.prepare("UPDATE sites SET key_verified = ? WHERE id = ?").run(verified ? 1 : 0, site.id);
    res.json({ verified, keyUrl, httpStatus: resp.status });
  } catch (err) {
    res.json({ verified: false, keyUrl, error: err.message });
  }
});

// ---------- Core: submit URLs to IndexNow (no cross-domain keyLocation) ----------
async function submitToIndexNow(host, key, urls) {
  const body = { host, key, urlList: urls };

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

app.post("/api/submit", async (req, res) => {
  const { urls } = req.body;

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: "Provide a non-empty 'urls' array." });
  }
  if (urls.length > 10000) {
    return res.status(400).json({ error: "Max 10,000 URLs per submission." });
  }

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
  const insertDiscovery = db.prepare(
    "INSERT OR IGNORE INTO discovery_urls (id, url, added_at) VALUES (?, ?, ?)"
  );

  let addedToHub = 0;

  for (const [host, hostUrls] of Object.entries(byHost)) {
    const site = getOrCreateSiteKey(host);

    if (!site.key_verified) {
      // We don't control this domain - can't upload a key file there.
      // Route it through the Discovery Hub instead.
      const now = new Date().toISOString();
      for (const u of hostUrls) {
        insertDiscovery.run(uuidv4(), u, now);
        insertStmt.run(uuidv4(), site.id, u, "discovery_hub", 200, "queued_via_hub", now);
        addedToHub++;
      }
      results.push({
        host,
        urlCount: hostUrls.length,
        result: "queued_via_hub",
        message: `Not your verified domain - added to the Discovery Hub instead. To get direct IndexNow acceptance for ${host}, verify it: /api/site-key?host=${host}`,
      });
      continue;
    }

    const outcome = await submitToIndexNow(host, site.indexnow_key, hostUrls);
    const now = new Date().toISOString();
    const resultLabel = outcome.ok ? "accepted" : outcome.status === 0 ? "network_error" : "rejected";

    for (const u of hostUrls) {
      insertStmt.run(uuidv4(), site.id, u, "indexnow", outcome.status, resultLabel, now);
    }

    results.push({ host, urlCount: hostUrls.length, httpStatus: outcome.status, result: resultLabel });
  }

  if (addedToHub > 0) {
    await pingHubUpdated();
  }

  res.json({ ok: true, batches: results });
});

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

app.get("/api/stats", (req, res) => {
  const total = db.prepare("SELECT COUNT(*) as c FROM submissions").get().c;
  const accepted = db.prepare("SELECT COUNT(*) as c FROM submissions WHERE result = 'accepted'").get().c;
  const sites = db.prepare("SELECT COUNT(*) as c FROM sites").get().c;
  res.json({ total, accepted, sites });
});

app.listen(PORT, () => {
  console.log(`QuickIndex running on port ${PORT}`);
});
