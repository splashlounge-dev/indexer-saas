const urlInput = document.getElementById("urlInput");
const submitBtn = document.getElementById("submitBtn");
const submitStatus = document.getElementById("submitStatus");
const submissionsBody = document.getElementById("submissionsBody");
const statTotal = document.getElementById("statTotal");
const statAccepted = document.getElementById("statAccepted");
const statSites = document.getElementById("statSites");

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

submitBtn.addEventListener("click", async () => {
  const raw = urlInput.value.trim();
  if (!raw) {
    submitStatus.textContent = "Paste at least one URL first.";
    return;
  }

  const urls = raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  submitBtn.disabled = true;
  submitStatus.textContent = `Sending ${urls.length} URL(s)...`;

  try {
    const res = await fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    const data = await res.json();

    if (!res.ok) {
      submitStatus.textContent = data.error || "Something went wrong.";
    } else {
      const summary = data.batches
        .map((b) => `${b.host}: ${b.result} (${b.urlCount})`)
        .join(" · ");
      submitStatus.textContent = summary;
      urlInput.value = "";
      await Promise.all([loadStats(), loadSubmissions()]);
    }
  } catch (err) {
    submitStatus.textContent = "Network error — is the server running?";
  } finally {
    submitBtn.disabled = false;
  }
});

loadStats();
loadSubmissions();
