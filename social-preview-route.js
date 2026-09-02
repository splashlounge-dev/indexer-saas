const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

function getHost(url) {
  try { return new URL(url).host; } catch (e) { return null; }
}

function extractTag(html, patterns) {
  for (const p of patterns) {
    const match = html.match(p);
    if (match) return match[1].trim();
  }
  return null;
}

function extractMeta(html, property) {
  // Handles both attribute orders: property/content and content/property, name/content too
  const patterns = [
    new RegExp(`<meta[^>]*(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["'][^>]*>`, 'i'),
  ];
  return extractTag(html, patterns);
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim().replace(/\s+/g, ' ') : null;
}

function extractCanonical(html) {
  const match = html.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i);
  return match ? match[1] : null;
}

function resolveUrl(maybeRelative, baseUrl) {
  if (!maybeRelative) return null;
  try {
    return new URL(maybeRelative, baseUrl).href;
  } catch (e) {
    return maybeRelative;
  }
}

function truncate(str, len) {
  if (!str) return str;
  return str.length > len ? str.slice(0, len - 1).trim() + '…' : str;
}

router.post('/api/social-preview', async (req, res) => {
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

  try {
    const pageRes = await fetch(url, {
      redirect: 'follow',
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuickIndexBot/1.0)' },
    });

    if (!pageRes.ok) {
      return res.status(200).json({ url, httpStatus: pageRes.status, error: `Page returned HTTP ${pageRes.status}` });
    }

    const html = await pageRes.text();
    const finalUrl = pageRes.url;

    const title = extractTitle(html);
    const metaDescription = extractMeta(html, 'description');
    const canonical = extractCanonical(html);

    const ogTitle = extractMeta(html, 'og:title');
    const ogDescription = extractMeta(html, 'og:description');
    const ogImage = extractMeta(html, 'og:image');
    const ogSiteName = extractMeta(html, 'og:site_name');
    const ogType = extractMeta(html, 'og:type');

    const twitterCard = extractMeta(html, 'twitter:card');
    const twitterTitle = extractMeta(html, 'twitter:title');
    const twitterDescription = extractMeta(html, 'twitter:description');
    const twitterImage = extractMeta(html, 'twitter:image') || extractMeta(html, 'twitter:image:src');

    // Effective values with sensible fallbacks, same logic real platforms use
    const effectiveOgTitle = ogTitle || title;
    const effectiveOgDescription = ogDescription || metaDescription;
    const effectiveOgImage = resolveUrl(ogImage, finalUrl);

    const effectiveTwitterTitle = twitterTitle || ogTitle || title;
    const effectiveTwitterDescription = twitterDescription || ogDescription || metaDescription;
    const effectiveTwitterImage = resolveUrl(twitterImage || ogImage, finalUrl);

    const result = {
      url,
      finalUrl,
      httpStatus: pageRes.status,
      host,

      title,
      metaDescription,
      canonical,

      og: {
        title: ogTitle,
        description: ogDescription,
        image: resolveUrl(ogImage, finalUrl),
        siteName: ogSiteName,
        type: ogType,
        present: !!(ogTitle || ogDescription || ogImage),
      },
      twitter: {
        card: twitterCard,
        title: twitterTitle,
        description: twitterDescription,
        image: resolveUrl(twitterImage, finalUrl),
        present: !!(twitterCard || twitterTitle || twitterImage),
      },

      googlePreview: {
        title: truncate(title || 'Untitled', 60),
        description: truncate(metaDescription || 'No meta description found.', 160),
        displayUrl: host + (new URL(finalUrl).pathname !== '/' ? new URL(finalUrl).pathname : ''),
      },
      facebookPreview: {
        title: truncate(effectiveOgTitle || 'Untitled', 90),
        description: truncate(effectiveOgDescription || '', 200),
        image: effectiveOgImage,
        domain: host.toUpperCase(),
      },
      twitterPreview: {
        title: truncate(effectiveTwitterTitle || 'Untitled', 70),
        description: truncate(effectiveTwitterDescription || '', 200),
        image: effectiveTwitterImage,
        domain: host,
        cardType: twitterCard || (effectiveTwitterImage ? 'summary_large_image' : 'summary'),
      },

      issues: [],
    };

    if (!ogTitle) result.issues.push('Missing og:title — falling back to page <title>');
    if (!ogDescription) result.issues.push('Missing og:description — falling back to meta description');
    if (!ogImage) result.issues.push('Missing og:image — link previews will show no image on Facebook/LinkedIn');
    if (!twitterCard) result.issues.push('Missing twitter:card — Twitter/X will fall back to Open Graph tags or show a plain link');
    if (!metaDescription) result.issues.push('Missing meta description — Google search snippet will be auto-generated from page content');

    cache.set(url, { result, time: Date.now() });
    res.json(result);
  } catch (err) {
    console.error('social-preview error:', err);
    res.status(500).json({ url, error: err.message || 'Lookup failed' });
  }
});

module.exports = router;
