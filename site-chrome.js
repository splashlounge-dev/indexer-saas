// site-chrome.js
// Central place that builds the site's header (brand + nav) and footer for
// every page. Add a new tool here ONCE and it appears everywhere.
//
// HOW TO USE IN A PAGE:
//   1. Put an empty mount point where the header goes:
//        <header class="topbar" id="site-header"></header>
//   2. Put an empty mount point where the footer goes:
//        <footer id="site-footer"></footer>
//   3. Include this script near the end of <body>:
//        <script src="site-chrome.js"></script>
//
// TO ADD A NEW TOOL LATER: just add one line to the TOOLS array below.

(function () {
  const TOOLS = [
    { href: "/index.html", label: "Submit URLs" },
    { href: "/check-index.html", label: "Check Indexability" },
    { href: "/seo-audit.html", label: "SEO Auditor" },
    { href: "/sitemap-audit.html", label: "Sitemap Auditor" },
    { href: "/schema-checker.html", label: "Schema Checker" },
    { href: "/web-vitals.html", label: "Web Vitals" },
    { href: "/social-preview.html", label: "Social Preview" },
    // Add new tools here, e.g.:
    // { href: "/redirect-checker.html", label: "Redirect Checker" },
  ];

  function currentPath() {
    let path = window.location.pathname;
    if (path === "/" || path === "") path = "/index.html";
    return path;
  }

  function buildNavLinksHtml() {
    const active = currentPath();
    return TOOLS.map(
      (t) => `<a href="${t.href}"${t.href === active ? ' class="active"' : ""}>${t.label}</a>`
    ).join("\n    ");
  }

  function buildHeaderHtml() {
    return `
    <div class="brand"><a href="/index.html"><span class="dot"></span>QuickIndex</a></div>
    <nav class="nav-links" aria-label="Main navigation">
      ${buildNavLinksHtml()}
    </nav>`;
  }

  function buildFooterHtml() {
    const links = TOOLS.map((t) => `<a href="${t.href}">${t.label}</a>`).join(" · ");
    return `<p>QuickIndex — ${links}</p>`;
  }

  document.addEventListener("DOMContentLoaded", function () {
    const headerMount = document.getElementById("site-header");
    if (headerMount) headerMount.innerHTML = buildHeaderHtml();

    const footerMount = document.getElementById("site-footer");
    if (footerMount) footerMount.innerHTML = buildFooterHtml();

    // Backward-compatible mount points, in case a page only has these instead
    const navOnlyMount = document.getElementById("site-nav");
    if (navOnlyMount) navOnlyMount.innerHTML = buildNavLinksHtml();

    const footerLinksOnlyMount = document.getElementById("site-footer-links");
    if (footerLinksOnlyMount) footerLinksOnlyMount.innerHTML = `QuickIndex — ${TOOLS.map((t) => `<a href="${t.href}">${t.label}</a>`).join(" · ")}`;
  });
})();
