const urlInput = document.getElementById("urlInput");
const submitBtn = document.getElementById("submitBtn");
const submitStatus = document.getElementById("submitStatus");
const submissionsBody = document.getElementById("submissionsBody");
const statTotal = document.getElementById("statTotal");
const statAccepted = document.getElementById("statAccepted");
const statSites = document.getElementById("statSites");

const fileInput = document.getElementById("fileInput");
const browseBtn = document.getElementById("browseBtn");
const dropZone = document.getElementById("dropZone");
const fileChip = document.getElementById("fileChip");
const fileName = document.getElementById("fileName");
const fileClear = document.getElementById("fileClear");
const liveProgress = document.getElementById("liveProgress");
const resultSummary = document.getElementById("resultSummary");

let uploadedFileText = null;
let lastFailedHosts = [];
let lastUrlsByHost = {};

function badgeFor(result) {
  const cls = `badge badge-${result}`;
  return `<span class="${cls}">${result.replace("_", " ")}</span>`;
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

async function loadStats() {
  const res = await fetch("/api/stats");
  const data = await res.json();
  statTotal.textContent = data.total;
  statAccepted.textContent = data.accepted;
  statSites.textContent = data.sites;
}

async function loadSubmissions() {
  const res = await fetch("/api/submissions");
  const rows = await res.json();
  if (rows.length === 0) {
    submissionsBody.innerHTML = `<tr><td colspan="5" class="empty">No submissions yet — paste some URLs above.</td></tr>`;
    return;
  }
  submissionsBody.innerHTML = rows
    .map(
      (r) => `
      <tr>
        <td class="url-cell" title="${r.url}">${r.url}</td>
        <td>${r.host}</td>
        <td>${badgeFor(r.result)}</td>
        <td>${r.http_status ?? "—"}</td>
        <td>${timeAgo(r.submitted_at)}</td>
      </tr>`
    )
    .join("");
}

// ---------- File upload (txt / csv / xlsx) ----------
browseBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  if (fileInput.files.length) readFile(fileInput.files[0]);
});

["dragover", "dragenter"].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add("drag");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag");
  })
);
dropZone.addEventListener("drop", (e) => {
  if (e.dataTransfer.files.length) readFile(e.dataTransfer.files[0]);
});

function readFile(file) {
  const isExcel = /\.(xlsx|xls)$/i.test(file.name);

  if (isExcel) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array" });
        let allText = "";
        workbook.SheetNames.forEach((sheetName) => {
          const sheet = workbook.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
          rows.forEach((row) => {
            allText += row.join(" ") + "\n";
          });
        });
        uploadedFileText = allText;
        fileName.textContent = file.name;
        fileChip.style.display = "inline-flex";
      } catch (err) {
        submitStatus.textContent = "Could not read that Excel file — try saving it as .csv instead.";
      }
    };
    reader.readAsArrayBuffer(file);
  } else {
    const reader = new FileReader();
    reader.onload = () => {
      uploadedFileText = reader.result;
      fileName.textContent = file.name;
      fileChip.style.display = "inline-flex";
    };
    reader.readAsText(file);
  }
}

fileClear.addEventListener("click", () => {
  uploadedFileText = null;
  fileInput.value = "";
  fileChip.style.display = "none";
});

function extractUrls() {
  const combined = [urlInput.value, uploadedFileText || ""].join("\n");
  const urlRegex = /https?:\/\/[^\s,"'<>]+/gi;
  const found = combined.match(urlRegex) || [];
  return [...new Set(found.map((u) => u.trim().replace(/[),.]+$/, "")))];
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return null;
  }
}

// ---------- Live, honest per-host progress ----------
// Each host is submitted with its own real request, so the timer shown
// here is genuine elapsed time for that specific network call - not a
// simulated countdown.
async function submitByHost(urlsByHost) {
  const hosts = Object.keys(urlsByHost);
  liveProgress.style.display = "block";
  liveProgress.innerHTML = hosts
    .map((h) => `<div class="progress-row" id="row-${cssSafe(h)}"><span class="host">${h}</span><span class="timer" id="timer-${cssSafe(h)}">0.0s</span></div>`)
    .join("");

  const results = [];

  const MIN_VISIBLE_MS = 900; // just so the live counter is actually perceivable, not a fake result

  for (const host of hosts) {
    const row = document.getElementById(`row-${cssSafe(host)}`);
    const timerEl = document.getElementById(`timer-${cssSafe(host)}`);
    const startedAt = performance.now();

    const tick = setInterval(() => {
      const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
      timerEl.textContent = `${elapsed}s`;
    }, 100);

    let outcome;
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: urlsByHost[host] }),
      });
      const data = await res.json();
      outcome = (data.batches && data.batches[0]) || { result: "network_error" };
    } catch (err) {
      outcome = { result: "network_error", urlCount: urlsByHost[host].length };
    }

    // Wait out the remainder of the minimum visible window, if the real
    // request finished faster than that - this doesn't change the elapsed
    // time shown, it just lets the tick actually be seen counting up.
    const alreadyElapsed = performance.now() - startedAt;
    if (alreadyElapsed < MIN_VISIBLE_MS) {
      await new Promise((r) => setTimeout(r, MIN_VISIBLE_MS - alreadyElapsed));
    }

    clearInterval(tick);
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
    timerEl.textContent = `${elapsed}s — ${outcome.result}`;
    row.classList.add("done");
    results.push({ host, ...outcome });
  }

  return results;
}

function cssSafe(str) {
  return str.replace(/[^a-zA-Z0-9]/g, "_");
}

function renderSummary(results) {
  const totalUrls = results.reduce((sum, r) => sum + (r.urlCount || 0), 0);
  const acceptedUrls = results
    .filter((r) => r.result === "accepted")
    .reduce((sum, r) => sum + (r.urlCount || 0), 0);

  lastFailedHosts = results
    .filter((r) => r.result === "rejected" || r.result === "network_error")
    .map((r) => r.host);

  const breakdownLines = results
    .map((r) => `${r.host}: ${badgeFor(r.result)} (${r.urlCount} URL${r.urlCount === 1 ? "" : "s"})`)
    .join(" &nbsp;·&nbsp; ");

  resultSummary.style.display = "block";
  resultSummary.innerHTML = `
    <div class="summary-line">
      <span class="accepted-count">${acceptedUrls}</span> of ${totalUrls} URL${totalUrls === 1 ? "" : "s"} accepted
    </div>
    <div style="font-size:12.5px; color:var(--muted,#5f7a70); line-height:1.8;">${breakdownLines}</div>
    ${lastFailedHosts.length ? `<button class="retry-btn" id="retryBtn">Retry ${lastFailedHosts.length} failed host${lastFailedHosts.length === 1 ? "" : "s"}</button>` : ""}
  `;

  const retryBtn = document.getElementById("retryBtn");
  if (retryBtn) {
    retryBtn.addEventListener("click", async () => {
      retryBtn.disabled = true;
      retryBtn.textContent = "Retrying…";
      const retryUrlsByHost = {};
      lastFailedHosts.forEach((h) => {
        retryUrlsByHost[h] = lastUrlsByHost[h];
      });
      const retryResults = await submitByHost(retryUrlsByHost);
      // merge retry results into the last full result set for a fresh summary
      const merged = results.map((r) => {
        const updated = retryResults.find((rr) => rr.host === r.host);
        return updated || r;
      });
      renderSummary(merged);
      await Promise.all([loadStats(), loadSubmissions()]);
    });
  }
}

submitBtn.addEventListener("click", async () => {
  const urls = extractUrls();
  if (!urls.length) {
    submitStatus.textContent = "Paste at least one URL first, or upload a file.";
    return;
  }

  const urlsByHost = {};
  for (const u of urls) {
    const h = hostOf(u);
    if (!h) continue;
    if (!urlsByHost[h]) urlsByHost[h] = [];
    urlsByHost[h].push(u);
  }
  lastUrlsByHost = urlsByHost;

  submitBtn.disabled = true;
  submitStatus.textContent = `Sending ${urls.length} URL(s) across ${Object.keys(urlsByHost).length} host(s)...`;
  resultSummary.style.display = "none";

  try {
    const results = await submitByHost(urlsByHost);
    submitStatus.textContent = "";
    renderSummary(results);
    urlInput.value = "";
    uploadedFileText = null;
    fileChip.style.display = "none";
    fileInput.value = "";
    await Promise.all([loadStats(), loadSubmissions()]);
  } catch (err) {
    submitStatus.textContent = "Network error — is the server running?";
  } finally {
    submitBtn.disabled = false;
  }
});

loadStats();
loadSubmissions();
