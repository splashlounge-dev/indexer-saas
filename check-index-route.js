const express = require('express');
const router = express.Router();

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;

const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;

router.post('/api/check-index', async (req, res) => {
  const { url } = req.body;

  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const cached = cache.get(url);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
    return res.json({ url, indexed: cached.indexed, cached: true });
  }

  if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) {
    return res.status(500).json({ error: 'Google API credentials not configured' });
  }

  try {
    const query = `site:${url}`;
    const apiUrl = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CSE_ID}&q=${encodeURIComponent(query)}`;

    const response = await fetch(apiUrl);
    const data = await response.json();

    if (data.error) {
      return res.status(429).json({ url, indexed: null, error: data.error.message });
    }

    const indexed = !!(data.searchInformation && parseInt(data.searchInformation.totalResults, 10) > 0);

    cache.set(url, { indexed, time: Date.now() });

    res.json({ url, indexed });
  } catch (err) {
    console.error('check-index error:', err);
    res.status(500).json({ url, indexed: null, error: 'Lookup failed' });
  }
});

module.exports = router;
