# QuickIndex — Phase 1 MVP

A minimal bulk-URL indexing tool (like Sinbyte's core loop): paste URLs,
they get pushed to **IndexNow** (Bing, Yandex, DuckDuckGo), and you see a
dashboard of what was submitted and accepted.

## What's real vs. what's marketing

Be upfront with yourself and, later, with users:

- IndexNow **does not include Google**. There is no public "instant index"
  API for ordinary Google content — only JobPosting/BroadcastEvent pages
  qualify officially. Anything claiming guaranteed Google indexing via API
  is either misusing an ineligible endpoint or relying on indirect tricks
  (crawler pings, backlink signals) that help but don't guarantee anything.
- "Accepted" only means the engine received your notification. It is not
  proof of indexing. A real "is this indexed?" check requires querying
  Bing Webmaster Tools / Google Search Console — that's a good Phase 2
  feature to add (see below).

## Requirements
- Node.js 18+
- npm

## Setup

```bash
cd indexer-saas
npm install
npm start
```

Then open: **http://localhost:3000**

## How the "no key file needed" trick works

Normally, to use IndexNow you must upload a `<key>.txt` file to your own
site's root so the search engine can verify you own the domain. That's a
dealbreaker for a SaaS — you can't ask every user to edit their server.

Instead, this app hosts the key file **on its own server** and passes a
`keyLocation` URL pointing back to itself when submitting. IndexNow's spec
explicitly supports this. That's the one trick that makes this a real SaaS
instead of a "copy this file to your server" DIY tool.

**Important:** for this to actually work in production, `PUBLIC_BASE_URL`
must be a real, publicly reachable domain (not `localhost`) — because Bing
has to be able to fetch `yourdomain.com/indexnow-keys/<key>.txt` to verify
you. Set it like this before deploying:

```bash
PUBLIC_BASE_URL=https://yourdomain.com npm start
```

On your own machine / localhost, you can still submit URLs and see them
logged, but the engines won't be able to verify the key until this is
publicly hosted somewhere (e.g. a small VPS, Render, Railway, Fly.io).

## Project structure

```
indexer-saas/
  server.js          - Express server, SQLite DB, IndexNow submission logic
  package.json
  public/
    index.html        - Dashboard page
    style.css          - Styling
    app.js             - Frontend logic (calls the API)
  quickindex.db        - SQLite database (auto-created on first run)
```

## API endpoints (for reference / future integrations)

- `POST /api/submit` — body: `{ "urls": ["https://...", "https://..."] }`
- `GET /api/submissions` — recent submission history
- `GET /api/stats` — total / accepted / sites counts
- `GET /indexnow-keys/:key.txt` — serves the IndexNow verification key

## Phase 2 ideas (not built yet — next milestones)

1. **User accounts + login** (e.g. simple email/password or magic link)
2. **Payments** — Stripe, credit-based or subscription plans
3. **Real indexing checks** — periodically query whether a URL actually
   shows up in Bing/Google search results, and update status from
   "accepted" to "confirmed indexed"
4. **Sitemap import** — paste a sitemap URL instead of individual URLs
   (you already have `seo_site_crawler.py` for this — could reuse its
   sitemap-parsing logic)
5. **Scheduled re-submission** — auto re-ping URLs that haven't shown up
   as indexed after N days
6. **Multi-tenant site management** — dashboard per client/site instead
   of one global list
