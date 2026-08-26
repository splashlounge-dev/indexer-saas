const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

const MAX_URLS = 10000;
const CONCURRENCY = 15; // how many URLs are checked in parallel

var jobs = new Map(); // jobId -> job state

// ---------- Indexability logic ----------
function isBlockedByRobotsTxt(robotsTxt, pathToCheck) {
  var lines = robotsTxt.split('\n').map(function (l) { return l.trim(); });
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
  var startedAt = Date.now();
  var result = {
    url: url,
    finalUrl: url,
    redirected: false,
    httpStatus: null,
    verdict: 'unknown',
    reasons: [],
    elapsedMs: 0,
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
    result.finalUrl = pageRes.url;
    result.redirected = pageRes.url.replace(/\/$/, '') !== url.replace(/\/$/, '');
    if (result.redirected) {
      result.reasons.push('Redirects to ' + pageRes.url);
    }

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

  result.elapsedMs = Date.now() - startedAt;
  return result;
}

function extractUrlsFromSitemap(xml) {
  var locMatches = xml.match(/<loc>(.*?)<\/loc>/gi) || [];
  return locMatches
    .map(function (tag) { return tag.replace(/<\/?loc>/gi, '').trim(); })
    .filter(Boolean);
}

// ---------- Concurrency-limited processing with live job updates ----------
async function processJob(job) {
  var robotsTxtCache = new Map();
  var urls = job.urls;
  var nextIndex = 0;

  async function worker() {
    while (nextIndex < urls.length) {
      var currentIndex = nextIndex++;
      var url = urls[currentIndex];
      var result = await checkOneUrl(url, robotsTxtCache);
      job.results[currentIndex] = result;
      job.checked++;

      if (result.verdict === 'indexable') job.summary.indexable++;
      else if (result.verdict === 'likely_not_indexable') job.summary.likelyBlocked++;
      else if (result.verdict === 'not_indexable') job.summary.blocked++;
      else job.summary.errors++;

      if (result.redirected) job.summary.redirected++;
    }
  }

  var workers = [];
  var workerCount = Math.min(CONCURRENCY, urls.length);
  for (var w = 0; w < workerCount; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  job.done = true;
  job.finishedAt = Date.now();
}

router.post('/api/audit-sitemap/start', async (req, res) => {
  var sitemapUrl = req.body.sitemapUrl;

  if (!sitemapUrl || !/^https?:\/\//i.test(sitemapUrl)) {
    return res.status(400).json({ error: 'Provide a valid sitemap URL (must start with http:// or https://)' });
  }

  try {
    var sitemapRes = await fetch(sitemapUrl, { timeout: 10000 });
    if (!sitemapRes.ok) {
      return res.status(400).json({ error: 'Could not fetch sitemap (HTTP ' + sitemapRes.status + ')' });
    }
    var xml = await sitemapRes.text();
    var allUrls = extractUrlsFromSitemap(xml);

    if (allUrls.length === 0) {
      return res.status(400).json({ error: 'No <loc> URLs found - is this a valid sitemap.xml?' });
    }

    var totalFound = allUrls.length;
    var truncated = allUrls.length > MAX_URLS;
    var urls = truncated ? allUrls.slice(0, MAX_URLS) : allUrls;

    var jobId = uuidv4();
    var job = {
      id: jobId,
      sitemapUrl: sitemapUrl,
      urls: urls,
      totalFoundInSitemap: totalFound,
      truncated: truncated,
      total: urls.length,
      checked: 0,
      results: new Array(urls.length),
      summary: { indexable: 0, likelyBlocked: 0, blocked: 0, errors: 0, redirected: 0 },
      startedAt: Date.now(),
      finishedAt: null,
      done: false,
    };
    jobs.set(jobId, job);

    // fire and forget - client polls for progress
    processJob(job).catch(function (err) {
      job.done = true;
      job.error = err.message || 'Audit failed';
    });

    // clean up old jobs after 30 minutes to avoid unbounded memory growth
    setTimeout(function () { jobs.delete(jobId); }, 30 * 60 * 1000);

    res.json({
      jobId: jobId,
      total: job.total,
      totalFoundInSitemap: totalFound,
      truncated: truncated,
    });
  } catch (err) {
    console.error('audit-sitemap start error:', err);
    res.status(500).json({ error: err.message || 'Failed to start audit' });
  }
});

router.get('/api/audit-sitemap/status/:jobId', (req, res) => {
  var job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found (it may have expired).' });
  }

  var now = job.finishedAt || Date.now();
  var elapsedMs = now - job.startedAt;
  var avgMsPerUrl = job.checked > 0 ? elapsedMs / job.checked : null;
  var remaining = job.total - job.checked;
  var estimatedRemainingMs = avgMsPerUrl !== null ? Math.round(avgMsPerUrl * remaining) : null;

  var payload = {
    jobId: job.id,
    total: job.total,
    checked: job.checked,
    done: job.done,
    error: job.error || null,
    elapsedMs: elapsedMs,
    estimatedRemainingMs: job.done ? 0 : estimatedRemainingMs,
    summary: job.summary,
    totalFoundInSitemap: job.totalFoundInSitemap,
    truncated: job.truncated,
    sitemapUrl: job.sitemapUrl,
  };

  if (job.done) {
    payload.results = job.results;
  }

  res.json(payload);
});

module.exports = router;
