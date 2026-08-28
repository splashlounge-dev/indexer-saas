const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

function getHost(url) {
  try { return new URL(url).host; } catch (e) { return null; }
}

// Extract all <script type="application/ld+json">...</script> blocks
function extractJsonLdBlocks(html) {
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const blocks = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

// Extract @type value(s) from a parsed JSON-LD object (handles nested @graph, arrays)
function extractTypes(obj, typesSet) {
  if (Array.isArray(obj)) {
    obj.forEach(item => extractTypes(item, typesSet));
    return;
  }
  if (obj && typeof obj === 'object') {
    if (obj['@type']) {
      if (Array.isArray(obj['@type'])) {
        obj['@type'].forEach(t => typesSet.add(t));
      } else {
        typesSet.add(obj['@type']);
      }
    }
    if (obj['@graph']) {
      extractTypes(obj['@graph'], typesSet);
    }
    // Check common nested schema properties that often carry their own @type
    ['mainEntity', 'itemListElement', 'author', 'publisher', 'offers'].forEach(key => {
      if (obj[key]) extractTypes(obj[key], typesSet);
    });
  }
}

// Basic microdata detection (itemscope/itemtype) as a fallback signal
function hasMicrodata(html) {
  return /itemscope/i.test(html) && /itemtype\s*=\s*["']https?:\/\/schema\.org/i.test(html);
}

function extractMicrodataTypes(html) {
  const regex = /itemtype\s*=\s*["']https?:\/\/schema\.org\/([A-Za-z]+)["']/gi;
  const types = new Set();
  let match;
  while ((match = regex.exec(html)) !== null) {
    types.add(match[1]);
  }
  return [...types];
}

router.post('/api/schema-check', async (req, res) => {
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
    jsonLdBlockCount: 0,
    validBlockCount: 0,
    invalidBlockCount: 0,
    types: [],
    hasMicrodata: false,
    microdataTypes: [],
    parseErrors: [],
    verdict: 'unknown',
  };

  try {
    const pageRes = await fetch(url, {
      redirect: 'follow',
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuickIndexBot/1.0)' },
    });

    result.httpStatus = pageRes.status;

    if (!pageRes.ok) {
      result.verdict = 'error';
      result.parseErrors.push(`Page returned HTTP ${pageRes.status}`);
      cache.set(url, { result, time: Date.now() });
      return res.json(result);
    }

    const html = await pageRes.text();
    const blocks = extractJsonLdBlocks(html);
    result.jsonLdBlockCount = blocks.length;

    const typesSet = new Set();

    blocks.forEach((block, i) => {
      try {
        const parsed = JSON.parse(block);
        extractTypes(parsed, typesSet);
        result.validBlockCount++;
      } catch (e) {
        result.invalidBlockCount++;
        result.parseErrors.push(`Block ${i + 1}: invalid JSON — ${e.message}`);
      }
    });

    result.types = [...typesSet];

    result.hasMicrodata = hasMicrodata(html);
    if (result.hasMicrodata) {
      result.microdataTypes = extractMicrodataTypes(html);
    }

    if (result.jsonLdBlockCount === 0 && !result.hasMicrodata) {
      result.verdict = 'none';
    } else if (result.invalidBlockCount > 0) {
      result.verdict = 'has_errors';
    } else {
      result.verdict = 'valid';
    }

    cache.set(url, { result, time: Date.now() });
    res.json(result);
  } catch (err) {
    console.error('schema-check error:', err);
    res.status(500).json({
      url,
      error: err.message || 'Schema check failed',
    });
  }
});

module.exports = router;
