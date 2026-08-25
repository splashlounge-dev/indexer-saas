const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

// ---------- Reused indexability logic ----------
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

async function checkOneUrl(url, robotsTxtCache) {
  const result = {
    url,
    httpStatus: null,
    verdict: 'unknown',
    reasons: [],
  };

  try {
    const host = new URL(url).host;

    if (!robotsTxtCache.has(host)) {
      try {
        const robotsRes = await fetch(`https://${host}/robots.txt`, { timeout: 8000 });
        robotsTxtCache.set(host, robotsRes.ok ? await robotsRes.text() : '');
      } catch (e) {
        robotsTxtCache.set(host, '');
      }
    }
    const robotsTxt = robotsTxtCache.get(host);
    const pathToCheck = new URL(url).pathname || '/';
    const robotsBlocked = robotsTxt ? isBlockedByRobotsTxt(robotsTxt, pathToCheck) : false;
    if (robotsBlocked) result.reasons.push('Blocked by robots.txt');

    const pageRes = await fetch(url, {
      redirect: 'follow',
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuickIndexBot/1.0)' },
    });
    result.httpStatus = pageRes.status;

    const xRobots = pageRes.headers.get('x-robots-tag');
    const xRobotsBlocked = xRobots ? xRobots.toLowerCase().includes('noindex') : false;
    if (xRobotsBlocked) result.reasons.push('X-Robots-Tag header contains "noindex"');

    let metaBlocked = false;
    let canonicalMismatch = false;
    if (pageRes.ok) {
      const html = await pageRes.text();
      const metaRobots = extractMetaRobots(html);
      if (metaRobots && metaRobots.includes('noindex')) {
        metaBlocked = true;
        result.reasons.push('Meta robots tag contains "noindex"');
      }
      const canonical = extractCanonical(html);
      if (canonical) {
        try {
          const canonicalNorm = new URL(canonical, url).href.replace(/\/$/, '');
          if (canonicalNorm !== url.replace(/\/$/, '')) {
            canonicalMismatch = true;
            result.reasons.push('Canonical tag points to a different URL');
          }
        } catch (e) { /* ignore */ }
      }
    } else {
      result.reasons.push(`Page returned HTTP ${pageRes.status}`);
    }

    if (result.httpStatus >= 400) {
      result.verdict = 'not_indexable';
    } else if (robotsBlocked || metaBlocked || xRobotsBlocked) {
      result.verdict = 'not_indexable';
    } else if (canonicalMismatch) {
      result.verdict = 'likely_not_indexable';
    } else {
      result.verdict = 'indexable';
    }
  } catch (err) {
    result.verdict = 'error';
    result.reasons.push(err.message || 'Fetch failed');
  }

  return result;
}

// ---------- Sitemap parsing ----------
function extractUrlsFromSitemap(xml) {
  const locMatches = xml.match(/<loc>(.*?)<\/loc>/gi) || [];
  return locMatches
    .map(tag => tag.replace(/<\/?loc>/gi, '').trim())
    .filter(Boolean);
}

router.post('/api/audit-sitemap', async (req, res) => {
  const { sitemapUrl } = req.body;

  if (!sitemapUrl || !/^https?:\/\//i.test(sitemapUrl)) {
    return res.status(400).json({ error: 'Provide a valid sitemap URL (must start with http:// or https://)' });
  }

  const cached = cache.get(sitemapUrl);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
    return res.json({ ...cached.result, cached: true });
  }

  try {
    const sitemapRes = await fetch(sitemapUrl, { timeout: 10000 });
    if (!sitemapRes.ok) {
      return res.status(400).json({ error: `Could not fetch sitemap (HTTP ${sitemapRes.status})` });
    }
    const xml = await sitemapRes.text();
    let urls = extractUrlsFromSitemap(xml);

    if (urls.length === 0) {
      return res.status(400).json({ error: 'No <loc> URLs found — is this a valid sitemap.xml?' });
    }

    const MAX_URLS = 200; // keep this free tool responsive; larger sitemaps get sampled
    const truncated = urls.length > MAX_URLS;
    if (truncated) urls = urls.slice(0, MAX_URLS);

    const robotsTxtCache = new Map();
    const results = [];
    for (const url of urls) {
      results.push(await checkOneUrl(url, robotsTxtCache));
    }

    const summary = {
      total: results.length,
      indexable: results.filter(r => r.verdict === 'indexable').length,
      likelyBlocked: results.filter(r => r.verdict === 'likely_not_indexable').length,
      blocked: results.filter(r => r.verdict === 'not_indexable').length,
      errors: results.filter(r => r.verdict === 'error').length,
    };

    const responseBody = { sitemapUrl, truncated, totalFoundInSitemap: extractUrlsFromSitemap(xml).length, summary, results };
    cache.set(sitemapUrl, { result: responseBody, time: Date.now() });
    res.json(responseBody);
  } catch (err) {
    console.error('audit-sitemap error:', err);
    res.status(500).json({ error: err.message || 'Failed to audit sitemap' });
  }
});

module.exports = router;
