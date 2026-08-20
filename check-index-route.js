const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

function getHost(url) {
  try { return new URL(url).host; } catch (e) { return null; }
}

// Small robots.txt parser - checks Disallow/Allow rules for "*" and "googlebot" groups.
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
  const metaRegex = /<meta\s+[^>]*name=["']robots["'][^>]*content=["']([^"']+)["'][^>]*>/i;
  const match = html.match(metaRegex);
  return match ? match[1].toLowerCase() : null;
}

function extractCanonical(html) {
  const linkRegex = /<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i;
  const match = html.match(linkRegex);
  return match ? match[1] : null;
}

router.post('/api/check-index', async (req, res) => {
  const { url } = req.body;

  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const cached = cache.get(url);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
    return res.json({ ...cached.result, cached: true });
  }

  const host = getHost(url);
  if (!host) {
    return res.status(400).json({ error: 'Could not parse host from URL' });
  }

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

  try {
    // 1. Check robots.txt
    try {
      const robotsUrl = `https://${host}/robots.txt`;
      const robotsRes = await fetch(robotsUrl, { timeout: 8000 });
      if (robotsRes.ok) {
        const robotsTxt = await robotsRes.text();
        const pathToCheck = new URL(url).pathname || '/';
        result.robotsTxtBlocked = isBlockedByRobotsTxt(robotsTxt, pathToCheck);
        if (result.robotsTxtBlocked) result.reasons.push('Blocked by robots.txt');
      } else {
        result.robotsTxtBlocked = false;
      }
    } catch (e) {
      result.robotsTxtBlocked = null;
    }

    // 2. Fetch the actual page
    const pageRes = await fetch(url, {
      redirect: 'follow',
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuickIndexBot/1.0)' },
    });

    result.httpStatus = pageRes.status;
    result.finalUrl = pageRes.url;
    result.redirected = pageRes.url !== url;
    if (result.redirected) {
      result.reasons.push(`Redirects to a different URL (${pageRes.status})`);
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

    // Final verdict
    if (result.httpStatus >= 400) {
      result.verdict = 'not_indexable';
    } else if (result.robotsTxtBlocked || result.metaRobotsBlocked || result.xRobotsBlocked) {
      result.verdict = 'not_indexable';
    } else if (result.canonicalMismatch) {
      result.verdict = 'likely_not_indexable';
    } else {
      result.verdict = 'indexable';
    }

    // Keep an "indexed" boolean for backward compatibility with older frontend code
    result.indexed = result.verdict === 'indexable';

    cache.set(url, { result, time: Date.now() });
    res.json(result);
  } catch (err) {
    console.error('check-index error:', err);
    res.status(500).json({
      url,
      indexed: null,
      verdict: 'error',
      error: err.message || 'Lookup failed',
    });
  }
});

module.exports = router;
