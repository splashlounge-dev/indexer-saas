const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

function getHost(url) {
  try { return new URL(url).host; } catch (e) { return null; }
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim().replace(/\s+/g, ' ') : null;
}

function extractMetaDescription(html) {
  const match = html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i)
             || html.match(/<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
  return match ? match[1].trim() : null;
}

function countTags(html, tag) {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi');
  const matches = html.match(regex);
  return matches ? matches.length : 0;
}

function extractH1Text(html) {
  const match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!match) return null;
  return match[1].replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' ');
}

function countImagesMissingAlt(html) {
  const imgTags = html.match(/<img\s[^>]*>/gi) || [];
  let missing = 0;
  for (const tag of imgTags) {
    const altMatch = tag.match(/alt=["']([^"']*)["']/i);
    if (!altMatch || altMatch[1].trim() === '') missing++;
  }
  return { total: imgTags.length, missing };
}

function hasCanonical(html) {
  return /<link\s+[^>]*rel=["']canonical["']/i.test(html);
}

function hasViewportMeta(html) {
  return /<meta\s+[^>]*name=["']viewport["']/i.test(html);
}

router.post('/api/seo-audit', async (req, res) => {
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
    title: null,
    titleLength: 0,
    titleIssue: null,
    metaDescription: null,
    metaDescriptionLength: 0,
    metaDescriptionIssue: null,
    h1Count: 0,
    h1Text: null,
    h2Count: 0,
    h3Count: 0,
    imagesTotal: 0,
    imagesMissingAlt: 0,
    hasCanonical: false,
    hasViewport: false,
    issues: [],
    score: 0,
    scoreMax: 8,
  };

  try {
    const pageRes = await fetch(url, {
      redirect: 'follow',
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuickIndexBot/1.0)' },
    });

    result.httpStatus = pageRes.status;

    if (!pageRes.ok) {
      result.issues.push(`Page returned HTTP ${pageRes.status}`);
      cache.set(url, { result, time: Date.now() });
      return res.json(result);
    }

    const html = await pageRes.text();
    let score = 0;

    // Title
    const title = extractTitle(html);
    result.title = title;
    result.titleLength = title ? title.length : 0;
    if (!title) {
      result.titleIssue = 'Missing <title> tag';
      result.issues.push('Missing <title> tag');
    } else if (title.length < 30) {
      result.titleIssue = 'Title is short (under 30 characters)';
      result.issues.push('Title tag is short — may not use available search snippet space');
      score++;
    } else if (title.length > 60) {
      result.titleIssue = 'Title is long (over 60 characters, may get truncated)';
      result.issues.push('Title tag is long — likely to be truncated in search results');
      score++;
    } else {
      score += 2;
    }

    // Meta description
    const desc = extractMetaDescription(html);
    result.metaDescription = desc;
    result.metaDescriptionLength = desc ? desc.length : 0;
    if (!desc) {
      result.metaDescriptionIssue = 'Missing meta description';
      result.issues.push('Missing meta description');
    } else if (desc.length < 70) {
      result.metaDescriptionIssue = 'Description is short (under 70 characters)';
      result.issues.push('Meta description is short — could use more of the available space');
      score++;
    } else if (desc.length > 160) {
      result.metaDescriptionIssue = 'Description is long (over 160 characters, may get truncated)';
      result.issues.push('Meta description is long — likely to be truncated in search results');
      score++;
    } else {
      score += 2;
    }

    // H1
    result.h1Count = countTags(html, 'h1');
    result.h1Text = extractH1Text(html);
    if (result.h1Count === 0) {
      result.issues.push('No <h1> tag found');
    } else if (result.h1Count > 1) {
      result.issues.push(`Multiple <h1> tags found (${result.h1Count}) — should typically have exactly one`);
      score++;
    } else {
      score++;
    }

    // H2/H3
    result.h2Count = countTags(html, 'h2');
    result.h3Count = countTags(html, 'h3');
    if (result.h2Count === 0) {
      result.issues.push('No <h2> tags found — content may lack clear structure');
    } else {
      score++;
    }

    // Images alt text
    const imgStats = countImagesMissingAlt(html);
    result.imagesTotal = imgStats.total;
    result.imagesMissingAlt = imgStats.missing;
    if (imgStats.total > 0 && imgStats.missing > 0) {
      result.issues.push(`${imgStats.missing} of ${imgStats.total} images missing alt text`);
    } else if (imgStats.total > 0) {
      score++;
    }

    // Canonical
    result.hasCanonical = hasCanonical(html);
    if (!result.hasCanonical) {
      result.issues.push('No canonical tag found');
    } else {
      score++;
    }

    // Viewport (mobile-friendliness signal)
    result.hasViewport = hasViewportMeta(html);
    if (!result.hasViewport) {
      result.issues.push('No viewport meta tag — page may not be mobile-friendly');
    } else {
      score++;
    }

    result.score = score;
    result.grade = score >= 7 ? 'good' : score >= 4 ? 'needs_work' : 'poor';

    cache.set(url, { result, time: Date.now() });
    res.json(result);
  } catch (err) {
    console.error('seo-audit error:', err);
    res.status(500).json({
      url,
      error: err.message || 'Audit failed',
    });
  }
});

module.exports = router;
