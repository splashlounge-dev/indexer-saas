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
 *
 * NAV HEADER UPDATE
 * ---------------------------------------------------------------------
 * Added a shared navigation header that is auto-injected into every
 * .html page served from /public (and the root "/"), linking all the
 * site's tools together. Edit NAV_LINKS below to add/remove/reorder
 * links - no need to touch every HTML file by hand.
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const fetch = require("node-fetch");
const { v4: uuidv4 } = require("uuid");
const checkIndexRoute = require("./check-index-route");
const seoAuditRoute = require("./seo-audit-route");
const sitemapAuditRoute = require("./sitemap-audit-route");
const schemaCheckerRoute = require("./schema-checker-route");
const webVitalsRoute = require("./web-vitals-route");
const socialPreviewRoute = require("./social-preview-route");

const app = express();
const PORT = process.env.PORT || 3000;

// This MUST be your real public Railway/production URL in production -
// used both to serve our own IndexNow key and to build the /hub URL.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:3000";

const PUBLIC_DIR = path.join(__dirname, "public");

// ---------- Shared nav header (auto-injected into every HTML page) ----------
const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/check-index.html", label: "Check Index" },
  { href: "/seo-audit.html", label: "SEO Audit" },
  { href: "/sitemap-audit.html", label: "Sitemap Audit" },
  { href: "/schema-checker.html", label: "Schema Checker" },
  { href: "/web-vitals.html", label: "Web Vitals" },
  { href: "/social-preview.html", label: "Social Preview" },
];

function buildNavHtml(activePath) {
  const links = NAV_LINKS.map((l) => {
    const isActive = l.href === activePath || (l.href === "/" && activePath === "/index.html");
    return `<a href="${l.href}"${isActive ? ' class="active"' : ""}>${l.label}</a>`;
  }).join("\n        ");

  // Self-contained: styles + markup, safe to inject into any page's <body>.
  return `<style>
        .qi-nav{position:sticky;top:0;z-index:999;display:flex;align-items:center;justify-content:space-between;
          padding:14px 28px;background:rgba(10,14,20,.86);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
          border-bottom:1px solid rgba(255,255,255,.07);
          font-family:ui-monospace,'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;}
        .qi-brand{display:flex;align-items:center;gap:10px;color:#EDF1F5;font-weight:600;font-size:15px;
          letter-spacing:-.02em;text-decoration:none;white-space:nowrap;}
        .qi-dot{width:8px;height:8px;border-radius:50%;background:#00E6A0;flex:none;
          animation:qi-pulse 2s infinite;}
        @keyframes qi-pulse{
          0%{box-shadow:0 0 0 0 rgba(0,230,160,.55);}
          70%{box-shadow:0 0 0 7px rgba(0,230,160,0);}
          100%{box-shadow:0 0 0 0 rgba(0,230,160,0);}
        }
        .qi-links{display:flex;align-items:center;gap:28px;}
        .qi-links a{position:relative;color:#7C8798;text-decoration:none;font-size:13px;
          letter-spacing:.02em;padding:6px 1px;transition:color .18s ease;}
        .qi-links a::after{content:"";position:absolute;left:0;bottom:0;width:100%;height:1.5px;
          background:#00E6A0;transform:scaleX(0);transform-origin:right;transition:transform .25s ease;}
        .qi-links a:hover{color:#EDF1F5;}
        .qi-links a:hover::after{transform:scaleX(1);transform-origin:left;}
        .qi-links a.active{color:#00E6A0;}
        .qi-links a.active::after{transform:scaleX(1);}
        .qi-toggle{display:none;}
        .qi-burger{display:none;flex-direction:column;gap:4px;cursor:pointer;padding:4px;}
        .qi-burger span{width:20px;height:2px;background:#EDF1F5;border-radius:1px;}
        @media (max-width:720px){
          .qi-links{position:absolute;top:100%;left:0;right:0;flex-direction:column;align-items:flex-start;
            gap:0;background:rgba(10,14,20,.98);border-bottom:1px solid rgba(255,255,255,.07);
            max-height:0;overflow:hidden;transition:max-height .25s ease;}
          .qi-links a{padding:14px 28px;width:100%;box-sizing:border-box;}
          .qi-links a::after{display:none;}
          .qi-burger{display:flex;}
          .qi-toggle:checked ~ .qi-links{max-height:400px;}
        }
      </style>
      <nav class="qi-nav">
        <a href="/" class="qi-brand"><span class="qi-dot"></span>QuickIndex</a>
        <input type="checkbox" id="qi-toggle" class="qi-toggle">
        <label for="qi-toggle" class="qi-burger" aria-label="Toggle menu"><span></span><span></span><span></span></label>
        <div class="qi-links">
        ${links}
        </div>
      </nav>`;
}

// Reads an HTML file from /public and injects the nav right after <body>
// (or prepends it if no <body> tag is found), then sends the result.
function serveHtmlWithNav(filePath, activePath, res, next) {
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return next();
    const nav = buildNavHtml(activePath);
    const injected = /<body[^>]*>/i.test(html)
      ? html.replace(/<body[^>]*>/i, (match) => `${match}\n      ${nav}`)
      : `${nav}\n${html}`;
    res.type("html").send(injected);
  });
}

// Intercept every request for an .html file under /public and inject the
// nav before falling back to the plain static handler below.
app.get(/\.html$/, (req, res, next) => {
  const filePath = path.join(PUBLIC_DIR, decodeURIComponent(req.path));
  serveHtmlWithNav(filePath, req.path, res, next);
});

// Also inject the nav on the root "/" (served from public/index.html).
app.get("/", (req, res, next) => {
  serveHtmlWithNav(path.join(PUBLIC_DIR, "index.html"), "/", res, next);
});

app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use(checkIndexRoute);
app.use(seoAuditRoute);
app.use(sitemapAuditRoute);
app.use(schemaCheckerRoute);
app.use(webVitalsRoute);
app.use(socialPreviewRoute);

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
      ${buildNavHtml("/hub")}
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
