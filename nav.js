// nav.js
// Central place to manage the site's navigation. Add a new tool here ONCE,
// and it will automatically appear on every page that includes this script.
// No more editing the nav in 6 different HTML files.

(function () {
  const TOOLS = [
    { href: "https://indexer-saas-production.up.railway.app/", label: "Submit URLs" },
    { href: "/check-index.html", label: "Check Indexability" },
    { href: "/seo-audit.html", label: "SEO Auditor" },
    { href: "/sitemap-audit.html", label: "Sitemap Auditor" },
    { href: "/schema-checker.html", label: "Schema Checker" },
    { href: "/web-vitals.html", label: "Web Vitals" },
    // To add a new tool in future: just add one line here, e.g.
    // { href: "/redirect-checker.html", label: "Redirect Checker" },
  ];

  function currentPath() {
    let path = window.location.pathname;
    if (path === "/" || path === "") path = "/index.html";
    return path;
  }

  function buildNavLinks() {
    const active = currentPath();
    return TOOLS.map(
      (t) =>
        `<a href="${t.href}"${t.href === active ? ' class="active"' : ""}>${t.label}</a>`
    ).join("\n    ");
  }

  function buildFooterLinks() {
    const links = TOOLS.map((t) => `<a href="${t.href}">${t.label}</a>`).join(" · ");
    return `QuickIndex — ${links}`;
  }

  document.addEventListener("DOMContentLoaded", function () {
    const navMount = document.getElementById("site-nav");
    if (navMount) navMount.innerHTML = buildNavLinks();

    const footerMount = document.getElementById("site-footer-links");
    if (footerMount) footerMount.innerHTML = buildFooterLinks();
  });
})();
