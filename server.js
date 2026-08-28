from pathlib import Path

src = Path("/mnt/data/Pasted text(4).txt")
text = src.read_text(encoding="utf-8")

# Fix the Railway crash caused by the missing local module.
text = text.replace('const webVitalsRoute = require("./web-vitals-route");\n', '')
text = text.replace('app.use(webVitalsRoute);\n', '')

# Insert the shared header after express.json(), while preserving every
# original route, database function, API endpoint, and app.listen().
marker = 'app.use(express.json());'
if marker not in text:
    raise ValueError("Could not find express.json() in the original server.js")

header_code = r'''
/* ---------- Shared Header Navigation ---------- */
const NAV_ITEMS = [
  { href: "/", label: "Indexing Request" },
  { href: "/check-index.html", label: "Check Index" },
  { href: "/web-vital.html", label: "Web Vitals" },
  { href: "/schema-checker.html", label: "Schema Checker" },
  { href: "/seo-audit.html", label: "SEO Audit" },
  { href: "/sitemap-audit.html", label: "Sitemap Audit" }
];

const NAV_HEADER = `
<header class="quickindex-header">
  <nav class="quickindex-nav" aria-label="Main navigation">
    ${NAV_ITEMS.map(item => `<a href="${item.href}">${item.label}</a>`).join("")}
  </nav>
</header>
<style>
  .quickindex-header {
    width: 100%;
    box-sizing: border-box;
    border-bottom: 1px solid #e5e7eb;
    background: #ffffff;
    position: sticky;
    top: 0;
    z-index: 9999;
  }
  .quickindex-nav {
    max-width: 1200px;
    margin: 0 auto;
    padding: 12px 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .quickindex-nav a {
    color: #1f2937;
    text-decoration: none;
    font-weight: 600;
    font-size: 14px;
    line-height: 1.4;
    padding: 9px 12px;
    border-radius: 7px;
  }
  .quickindex-nav a:hover {
    background: #f3f4f6;
  }
  @media (max-width: 700px) {
    .quickindex-nav {
      justify-content: flex-start;
      overflow-x: auto;
      flex-wrap: nowrap;
    }
    .quickindex-nav a {
      white-space: nowrap;
    }
  }
</style>`;

function injectNavigation(html) {
  if (typeof html !== "string") return html;
  if (html.includes('class="quickindex-header"')) return html;

  return html.replace(
    /<body([^>]*)>/i,
    `<body$1>${NAV_HEADER}`
  );
}

/* Add the same navigation to HTML responses. */
app.use((req, res, next) => {
  const originalSend = res.send.bind(res);

  res.send = function (body) {
    if (
      typeof body === "string" &&
      /<html[\s>]/i.test(body) &&
      /<body[\s>]/i.test(body)
    ) {
      body = injectNavigation(body);
    }

    return originalSend(body);
  };

  next();
});
'''

text = text.replace(marker, marker + header_code, 1)

# Make sure the static middleware and all original route registrations remain.
out = Path("/mnt/data/server-complete-updated.js")
out.write_text(text, encoding="utf-8")

required = [
    'label: "Indexing Request"',
    'href: "/check-index.html"',
    'href: "/web-vital.html"',
    'href: "/schema-checker.html"',
    'href: "/seo-audit.html"',
    'href: "/sitemap-audit.html"',
    'app.use(checkIndexRoute);',
    'app.use(seoAuditRoute);',
    'app.use(sitemapAuditRoute);',
    'app.use(schemaCheckerRoute);',
    'app.listen(PORT'
]
print(f"Created complete server.js: {out}")
print("Verified:", all(x in text for x in required))
print("Missing web-vitals-route import:", './web-vitals-route' in text)
print("Total lines:", len(text.splitlines()))
