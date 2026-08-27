const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const MAX_URLS = 10000;
const MAX_SUBSITEMAPS = 100;
const CONCURRENCY = 25;
const FETCH_TIMEOUT_MS = 9000;

const urlCache = new Map();
const URL_CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

function getHost(url) {
  try { return new URL(url).host; } catch (e) { return null; }
}

// ---------- robots.txt parsing (same logic as check-index-route.js) ----------
function isBlockedByRobotsTxt(robotsTxt, pathToCheck) {
  const lines = robotsTxt.split('\n').map(l => l.trim());
  let currentGroupApplies = false;
  let matchedDisallow = null;
  let matchedAllow = null;

  for (const rawLine of lines) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    const [rawKey, ...rest] = line.split(':');
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      currentGroupApplies = (value === '*' || value.toLowerCase() === 'googlebot');
      continue;
    }
    if (!currentGroupApplies) continue;

    if (key === 'disallow' && value) {
      if (pathToCheck.startsWith(value)) {
        if (!matchedDisallow || value.length > matchedDisallow.length) matchedDisallow = value;
      }
    }
    if (key === 'allow' && value) {
      if (pathToCheck.startsWith(value)) {
        if (!matchedAllow || value.length > matchedAllow.length) matchedAllow = value;
      }
    }
  }

  if (!matchedDisallow) return false;
  if (matchedAllow && matchedAllow.length >= matchedDisallow.length) return false;
  return true;
}

function extractMetaRobots(html) {
  const match = html.match(/<meta\s+[^>]*name=["']robots["'][^>]*content=["']([^"']+)["'][^>]*>/i);
  return match ? match[1].toLowerCase() : null;
}

function extractCanonical(html) {
  const match = html.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i);
  return match ? match[1] : null;
}

// ---------- per-host robots.txt cache (shared across one audit run) ----------
async function getRobotsTxt(host, robotsCacheForRun) {
  if (robotsCacheForRun.has(host)) return robotsCacheForRun.get(host);
  try {
    const robotsRes = await fetchWithTimeout(`https://${host}/robots.txt`);
    const text = robotsRes.ok ? await robotsRes.text() : null;
    robotsCacheForRun.set(host, text);
    return text;
  } catch (e) {
    robotsCacheForRun.set(host, null);
    return null;
  }
}

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, timeout: FETCH_TIMEOUT_MS });
}

// ---------- sitemap XML parsing ----------
function extractLocs(xml) {
  const matches = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)];
  return matches.map(m => m[1].trim());
}

function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(xml);
}

async function fetchAllSitemapUrls(rootSitemapUrl) {
  const seenSitemaps = new Set();
  const allUrls = [];
  const queue = [rootSitemapUrl];

  while (queue.length > 0 && seenSitemaps.size < MAX_SUBSITEMAPS && allUrls.length < MAX_URLS) {
    const sitemapUrl = queue.shift();
    if (seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);

    let xml;
    try {
      const res = await fetchWithTimeout(sitemapUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuickIndexBot/1.0)' },
      });
      if (!res.ok) continue;
      xml = await res.text();
    } catch (e) {
      continue;
    }

    if (isSitemapIndex(xml)) {
      const subSitemaps = extractLocs(xml);
      for (const s of subSitemaps) {
        if (!seenSitemaps.has(s)) queue.push(s);
      }
    } else {
      const locs = extractLocs(xml);
      for (const u of locs) {
        allUrls.push(u);
        if (allUrls.length >= MAX_URLS) break;
      }
    }
  }

  return allUrls;
}

// ---------- single URL check (same signals as check-index-route.js) ----------
async function checkUrl(url, robotsCacheForRun) {
  const cached = urlCache.get(url);
  if (cached && Date.now() - cached.time < URL_CACHE_TTL_MS) {
    return cached.result;
  }

  const host = getHost(url);
  const result = {
    url,
    httpStatus: null,
    finalUrl: url,
    redirected: false,
    robotsTxtBlocked: null,
    metaRobots: null,
    metaRobotsBlocked: false,
    xRobotsTag: null,
    xRobotsBlocked: false,
    canonical: null,
    canonicalMismatch: false,
    verdict: 'unknown',
    reasons: [],
  };

  if (!host) {
    result.verdict = 'error';
    result.reasons.push('Could not parse host from URL');
    return result;
  }

  try {
    const robotsTxt = await getRobotsTxt(host, robotsCacheForRun);
    if (robotsTxt) {
      const pathToCheck = new URL(url).pathname || '/';
      result.robotsTxtBlocked = isBlockedByRobotsTxt(robotsTxt, pathToCheck);
      if (result.robotsTxtBlocked) result.reasons.push('Blocked by robots.txt');
    } else {
      result.robotsTxtBlocked = false;
    }

    const pageRes = await fetchWithTimeout(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuickIndexBot/1.0)' },
    });

    result.httpStatus = pageRes.status;
    result.finalUrl = pageRes.url;
    result.redirected = pageRes.url !== url;
    if (result.redirected) {
      result.reasons.push(`Redirects to a different URL (${pageRes.status}) → ${pageRes.url}`);
    }

    const xRobotsHeader = pageRes.headers.get('x-robots-tag');
    if (xRobotsHeader) {
      result.xRobotsTag = xRobotsHeader.toLowerCase();
      if (result.xRobotsTag.includes('noindex')) {
        result.xRobotsBlocked = true;
        result.reasons.push('X-Robots-Tag header contains "noindex"');
      }
    }

    if (pageRes.ok) {
      const html = await pageRes.text();

      const metaRobots = extractMetaRobots(html);
      if (metaRobots) {
        result.metaRobots = metaRobots;
        if (metaRobots.includes('noindex')) {
          result.metaRobotsBlocked = true;
          result.reasons.push('Meta robots tag contains "noindex"');
        }
      }

      const canonical = extractCanonical(html);
      if (canonical) {
        result.canonical = canonical;
        try {
          const canonicalNormalized = new URL(canonical, url).href.replace(/\/$/, '');
          const originalNormalized = url.replace(/\/$/, '');
          if (canonicalNormalized !== originalNormalized) {
            result.canonicalMismatch = true;
            result.reasons.push('Canonical tag points to a different URL');
          }
        } catch (e) { /* ignore malformed canonical */ }
      }
    } else {
      result.reasons.push(`Page returned HTTP ${pageRes.status}`);
    }

    if (result.httpStatus >= 400) {
      result.verdict = 'not_indexable';
    } else if (result.robotsTxtBlocked || result.metaRobotsBlocked || result.xRobotsBlocked) {
      result.verdict = 'not_indexable';
    } else if (result.canonicalMismatch) {
      result.verdict = 'likely_not_indexable';
    } else {
      result.verdict = 'indexable';
    }

    urlCache.set(url, { result, time: Date.now() });
    return result;
  } catch (err) {
    result.verdict = 'error';
    result.reasons.push(err.message || 'Lookup failed');
    return result;
  }
}

// ---------- concurrency-limited batch runner ----------
async function runWithConcurrency(items, limit, workerFn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await workerFn(items[currentIndex]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

router.post('/api/audit-sitemap', async (req, res) => {
  const { sitemapUrl } = req.body;

  if (!sitemapUrl || !/^https?:\/\//i.test(sitemapUrl)) {
    return res.status(400).json({ error: 'Invalid sitemap URL' });
  }

  const startTime = Date.now();

  try {
    const allUrls = await fetchAllSitemapUrls(sitemapUrl);

    if (allUrls.length === 0) {
      return res.status(400).json({ error: 'No URLs found in that sitemap (check the URL and try again).' });
    }

    const truncated = allUrls.length >= MAX_URLS;
    const urlsToCheck = allUrls.slice(0, MAX_URLS);

    const robotsCacheForRun = new Map();
    const results = await runWithConcurrency(urlsToCheck, CONCURRENCY, (url) => checkUrl(url, robotsCacheForRun));

    const summary = {
      total: results.length,
      indexable: results.filter(r => r.verdict === 'indexable').length,
      likelyBlocked: results.filter(r => r.verdict === 'likely_not_indexable').length,
      blocked: results.filter(r => r.verdict === 'not_indexable').length,
      errors: results.filter(r => r.verdict === 'error').length,
      redirected: results.filter(r => r.redirected).length,
    };

    const durationMs = Date.now() - startTime;

    res.json({
      sitemapUrl,
      totalFoundInSitemap: allUrls.length,
      truncated,
      summary,
      durationMs,
      results,
    });
  } catch (err) {
    console.error('audit-sitemap error:', err);
    res.status(500).json({ error: err.message || 'Sitemap audit failed' });
  }
});

module.exports = router;
