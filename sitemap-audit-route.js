const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

// ---------- Reused indexability logic ----------
function isBlockedByRobotsTxt(robotsTxt, pathToCheck) {
  const lines = robotsTxt.split('\n').map(function (l) { return l.trim(); });
  var currentGroupApplies = false;
  var matchedDisallow = null;
  var matchedAllow = null;

  for (var i = 0; i < lines.length; i++) {
    var rawLine = lines[i];
    var line = rawLine.split('#')[0].trim();
    if (!line) continue;

    var colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    var rawKey = line.slice(0, colonIndex);
    var value = line.slice(colonIndex + 1).trim();
    var key = rawKey.trim().toLowerCase();

    if (key === 'user-agent') {
      currentGroupApplies = (value === '*' || value.toLowerCase() === 'googlebot');
      continue;
    }
    if (!currentGroupApplies) continue;

    if (key === 'disallow' && value) {
      if (pathToCheck.indexOf(value) === 0) {
        if (!matchedDisallow || value.length > matchedDisallow.length) matchedDisallow = value;
      }
    }
    if (key === 'allow' && value) {
      if (pathToCheck.indexOf(value) === 0) {
        if (!matchedAllow || value.length > matchedAllow.length) matchedAllow = value;
      }
    }
  }

  if (!matchedDisallow) return false;
  if (matchedAllow && matchedAllow.length >= matchedDisallow.length) return false;
  return true;
}

function extractMetaRobots(html) {
  var match = html.match(/<meta\s+[^>]*name=["']robots["'][^>]*content=["']([^"']+)["'][^>]*>/i);
  return match ? match[1].toLowerCase() : null;
}

function extractCanonical(html) {
  var match = html.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i);
  return match ? match[1] : null;
}

async function checkOneUrl(url, robotsTxtCache) {
  var result = {
    url: url,
    httpStatus: null,
    verdict: 'unknown',
    reasons: [],
  };

  try {
    var host = new URL(url).host;

    if (!robotsTxtCache.has(host)) {
      try {
        var robotsUrl = 'https://' + host + '/robots.txt';
        var robotsRes = await fetch(robotsUrl, { timeout: 8000 });
        robotsTxtCache.set(host, robotsRes.ok ? await robotsRes.text() : '');
      } catch (e) {
        robotsTxtCache.set(host, '');
      }
    }
    var robotsTxt = robotsTxtCache.get(host);
    var pathToCheck = new URL(url).pathname || '/';
    var robotsBlocked = robotsTxt ? isBlockedByRobotsTxt(robotsTxt, pathToCheck) : false;
    if (robotsBlocked) result.reasons.push('Blocked by robots.txt');

    var pageRes = await fetch(url, {
      redirect: 'follow',
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuickIndexBot/1.0)' },
    });
    result.httpStatus = pageRes.status;

    var xRobots = pageRes.headers.get('x-robots-tag');
    var xRobotsBlocked = xRobots ? xRobots.toLowerCase().indexOf('noindex') !== -1 : false;
    if (xRobotsBlocked) result.reasons.push('X-Robots-Tag header contains "noindex"');

    var metaBlocked = false;
    var canonicalMismatch = false;
    if (pageRes.ok) {
      var html = await pageRes.text();
      var metaRobots = extractMetaRobots(html);
      if (metaRobots && metaRobots.indexOf('noindex') !== -1) {
        metaBlocked = true;
        result.reasons.push('Meta robots tag contains "noindex"');
      }
      var canonical = extractCanonical(html);
      if (canonical) {
        try {
          var canonicalNorm = new URL(canonical, url).href.replace(/\/$/, '');
          if (canonicalNorm !== url.replace(/\/$/, '')) {
            canonicalMismatch = true;
            result.reasons.push('Canonical tag points to a different URL');
          }
        } catch (e) { /* ignore */ }
      }
    } else {
      result.reasons.push('Page returned HTTP ' + pageRes.status);
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
  var locMatches = xml.match(/<loc>(.*?)<\/loc>/gi) || [];
  return locMatches
    .map(function (tag) { return tag.replace(/<\/?loc>/gi, '').trim(); })
    .filter(Boolean);
}

router.post('/api/audit-sitemap', async (req, res) => {
  var sitemapUrl = req.body.sitemapUrl;

  if (!sitemapUrl || !/^https?:\/\//i.test(sitemapUrl)) {
    return res.status(400).json({ error: 'Provide a valid sitemap URL (must start with http:// or https://)' });
  }

  var cached = cache.get(sitemapUrl);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
    var cachedResponse = Object.assign({}, cached.result, { cached: true });
    return res.json(cachedResponse);
  }

  try {
    var sitemapRes = await fetch(sitemapUrl, { timeout: 10000 });
    if (!sitemapRes.ok) {
      return res.status(400).json({ error: 'Could not fetch sitemap (HTTP ' + sitemapRes.status + ')' });
    }
    var xml = await sitemapRes.text();
    var urls = extractUrlsFromSitemap(xml);

    if (urls.length === 0) {
      return res.status(400).json({ error: 'No <loc> URLs found - is this a valid sitemap.xml?' });
    }

    var MAX_URLS = 200; // keep this free tool responsive; larger sitemaps get sampled
    var totalFound = urls.length;
    var truncated = urls.length > MAX_URLS;
    if (truncated) urls = urls.slice(0, MAX_URLS);

    var robotsTxtCache = new Map();
    var results = [];
    for (var i = 0; i < urls.length; i++) {
      results.push(await checkOneUrl(urls[i], robotsTxtCache));
    }

    var summary = {
      total: results.length,
      indexable: results.filter(function (r) { return r.verdict === 'indexable'; }).length,
      likelyBlocked: results.filter(function (r) { return r.verdict === 'likely_not_indexable'; }).length,
      blocked: results.filter(function (r) { return r.verdict === 'not_indexable'; }).length,
      errors: results.filter(function (r) { return r.verdict === 'error'; }).length,
    };

    var responseBody = {
      sitemapUrl: sitemapUrl,
      truncated: truncated,
      totalFoundInSitemap: totalFound,
      summary: summary,
      results: results,
    };
    cache.set(sitemapUrl, { result: responseBody, time: Date.now() });
    res.json(responseBody);
  } catch (err) {
    console.error('audit-sitemap error:', err);
    res.status(500).json({ error: err.message || 'Failed to audit sitemap' });
  }
});

module.exports = router;
