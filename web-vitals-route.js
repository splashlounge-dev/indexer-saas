const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY; // optional - reused from existing Custom Search setup if present

// Google's official Core Web Vitals thresholds
function rateMetric(name, value) {
  if (value === null || value === undefined) return 'unknown';
  const thresholds = {
    lcp: [2500, 4000],   // ms — good <=2500, poor >4000
    inp: [200, 500],     // ms — good <=200, poor >500
    cls: [0.1, 0.25],    // unitless — good <=0.1, poor >0.25
    fcp: [1800, 3000],   // ms
    ttfb: [800, 1800],   // ms
  };
  const [goodMax, poorMin] = thresholds[name] || [0, 0];
  if (value <= goodMax) return 'good';
  if (value > poorMin) return 'poor';
  return 'needs_improvement';
}

router.post('/api/web-vitals', async (req, res) => {
  const { url, strategy } = req.body;

  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const scanStrategy = strategy === 'desktop' ? 'desktop' : 'mobile';
  const cacheKey = `${url}::${scanStrategy}`;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
    return res.json({ ...cached.result, cached: true });
  }

  const result = {
    url,
    strategy: scanStrategy,
    lcp: null, lcpRating: 'unknown',
    inp: null, inpRating: 'unknown',
    cls: null, clsRating: 'unknown',
    fcp: null, fcpRating: 'unknown',
    ttfb: null, ttfbRating: 'unknown',
    performanceScore: null,
    fieldDataAvailable: false,
    verdict: 'unknown',
  };

  try {
    let apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${scanStrategy}&category=performance`;
    if (GOOGLE_API_KEY) apiUrl += `&key=${GOOGLE_API_KEY}`;

    const response = await fetch(apiUrl, { timeout: 30000 });
    const data = await response.json();

    if (data.error) {
      return res.status(response.status || 500).json({ url, error: data.error.message || 'PageSpeed Insights lookup failed' });
    }

    // Prefer real-world field data (CrUX) when available; fall back to lab data
    const fieldMetrics = data.loadingExperience && data.loadingExperience.metrics;
    const labMetrics = data.lighthouseResult && data.lighthouseResult.audits;

    if (fieldMetrics) {
      result.fieldDataAvailable = true;
      if (fieldMetrics.LARGEST_CONTENTFUL_PAINT_MS) {
        result.lcp = fieldMetrics.LARGEST_CONTENTFUL_PAINT_MS.percentile;
      }
      if (fieldMetrics.INTERACTION_TO_NEXT_PAINT) {
        result.inp = fieldMetrics.INTERACTION_TO_NEXT_PAINT.percentile;
      }
      if (fieldMetrics.CUMULATIVE_LAYOUT_SHIFT_SCORE) {
        result.cls = fieldMetrics.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100;
      }
    }

    // Fill any gaps with lab data (simulated, always available if Lighthouse ran)
    if (labMetrics) {
      if (result.lcp === null && labMetrics['largest-contentful-paint']) {
        result.lcp = Math.round(labMetrics['largest-contentful-paint'].numericValue);
      }
      if (labMetrics['first-contentful-paint']) {
        result.fcp = Math.round(labMetrics['first-contentful-paint'].numericValue);
      }
      if (labMetrics['server-response-time']) {
        result.ttfb = Math.round(labMetrics['server-response-time'].numericValue);
      }
      if (result.cls === null && labMetrics['cumulative-layout-shift']) {
        result.cls = labMetrics['cumulative-layout-shift'].numericValue;
      }
      // Lab data has no true INP (needs real interaction); use Total Blocking Time as a rough proxy signal only
      if (result.inp === null && labMetrics['total-blocking-time']) {
        result.inp = null; // don't fabricate INP from TBT — leave unknown rather than mislead
      }
    }

    if (data.lighthouseResult && data.lighthouseResult.categories && data.lighthouseResult.categories.performance) {
      result.performanceScore = Math.round(data.lighthouseResult.categories.performance.score * 100);
    }

    result.lcpRating = rateMetric('lcp', result.lcp);
    result.inpRating = rateMetric('inp', result.inp);
    result.clsRating = rateMetric('cls', result.cls);
    result.fcpRating = rateMetric('fcp', result.fcp);
    result.ttfbRating = rateMetric('ttfb', result.ttfb);

    const coreRatings = [result.lcpRating, result.clsRating].concat(result.inp !== null ? [result.inpRating] : []);
    if (coreRatings.includes('poor')) {
      result.verdict = 'poor';
    } else if (coreRatings.includes('needs_improvement')) {
      result.verdict = 'needs_improvement';
    } else if (coreRatings.every(r => r === 'good')) {
      result.verdict = 'good';
    } else {
      result.verdict = 'unknown';
    }

    cache.set(cacheKey, { result, time: Date.now() });
    res.json(result);
  } catch (err) {
    console.error('web-vitals error:', err);
    res.status(500).json({ url, error: err.message || 'Lookup failed' });
  }
});

module.exports = router;
