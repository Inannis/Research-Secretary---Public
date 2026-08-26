// Operational UI enhancements layered on top of the canonical SPA.
//
// This module keeps the large app-core.js untouched. It adds the current
// Claude per-item controls plus the durable-URL-state scraper mode selector,
// then rewrites only the operational requests that need those newer routes or
// parameters. The same code runs in the local FastAPI UI and the Pages bridge.

const nativeFetch = window.fetch.bind(window);
let claudePipelineActive = false;

function byId(id) {
  return document.getElementById(id);
}

function addOption(select, value, label, { first = false } = {}) {
  if (!select || [...select.options].some(option => option.value === value)) return;
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  if (first && select.firstChild) select.insertBefore(option, select.firstChild);
  else select.appendChild(option);
}

function ensureRunnerIndicatorVisible() {
  const indicator = byId("local-runner-indicator");
  if (!indicator) return;
  indicator.style.display = "inline-block";
}

function ensurePipelineItemLimit() {
  if (byId("p-itemcount")) return;
  const runButton = byId("btn-run-pipeline");
  if (!runButton?.parentElement) return;

  const label = document.createElement("label");
  label.className = "inline-label";
  label.title = "Maximum raw items for the Claude per-item run. Leave blank to drain the matching queue.";
  label.append("Claude items ");
  const input = document.createElement("input");
  input.id = "p-itemcount";
  input.type = "number";
  input.min = "1";
  input.placeholder = "all";
  input.style.width = "82px";
  label.appendChild(input);
  runButton.parentElement.insertBefore(label, runButton);
}

function ensureScraperModeControl() {
  if (byId("scraper-mode-select")) return;
  const oldMode = byId("scraper-mode-toggle");
  const oldSafe = byId("scraper-skip-safe-toggle");
  const row = oldMode?.closest("div") || byId("btn-scrape-all")?.parentElement;
  if (!row) return;

  // Keep the legacy elements in the DOM because app-core/index bridge code may
  // still read them, but make the canonical three-mode selector the only visible
  // control. Request rewriting below overrides the legacy all/newest parameters.
  const oldModeLabel = oldMode?.closest("label");
  const oldSafeLabel = oldSafe?.closest("label");
  if (oldModeLabel) oldModeLabel.style.display = "none";
  if (oldSafeLabel) oldSafeLabel.style.display = "none";
  [...row.querySelectorAll("span")].forEach(span => {
    if ((span.textContent || "").includes("Skip known")) span.style.display = "none";
  });

  const label = document.createElement("label");
  label.className = "inline-label";
  label.title = "normal refreshes stale known pages after 7 days; new only never refetches known URLs; full re-scrape ignores URL freshness.";
  label.append("Scrape mode ");

  const select = document.createElement("select");
  select.id = "scraper-mode-select";
  for (const [value, text] of [
    ["normal", "Normal — new + 7-day refresh"],
    ["new_only", "New only — never refetch known"],
    ["full_rescrape", "Full re-scrape — fetch all listed"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
  }
  select.value = "normal";
  label.appendChild(select);

  const refreshButton = byId("btn-refresh-scrapers");
  row.insertBefore(label, refreshButton || null);
}

function syncClaudeControlState() {
  const pEval = byId("p-eval-model");
  const pPrefilter = byId("p-prefilter");
  const pItems = byId("p-itemcount");
  const pipelineClaude = pEval?.value === "claude";

  if (pPrefilter) {
    if (pipelineClaude) {
      if (pPrefilter.value !== "claude") pPrefilter.value = "claude";
      pPrefilter.disabled = true;
      pPrefilter.title = "The current Claude per-item routine uses its own Claude prefilter before Claude evaluation.";
    } else {
      pPrefilter.disabled = false;
      if (pPrefilter.value === "claude") pPrefilter.value = "default";
      pPrefilter.title = "";
    }
  }
  if (pItems) {
    pItems.disabled = !pipelineClaude;
    pItems.title = pipelineClaude
      ? "Maximum items to process; blank means drain the selected queue."
      : "Item limit applies to the Claude per-item engine.";
  }

  const rEval = byId("r-eval-model");
  const rPrefilter = byId("r-prefilter");
  if (rEval?.value === "claude" && rPrefilter?.value === "off") {
    rPrefilter.value = "default";
  }
}

function enhanceControls() {
  ensureRunnerIndicatorVisible();

  const pEval = byId("p-eval-model");
  const pPrefilter = byId("p-prefilter");
  const rEval = byId("r-eval-model");

  addOption(pPrefilter, "claude", "Claude — per-item prefilter", { first: true });
  addOption(pEval, "claude", "Claude — per-item chain (current default)", { first: true });
  if (pEval) pEval.value = "claude";
  if (pPrefilter) pPrefilter.value = "claude";

  const researcherClaude = rEval && [...rEval.options].find(option => option.value === "claude");
  if (researcherClaude) researcherClaude.textContent = "Claude — per-item evaluation";

  ensurePipelineItemLimit();
  ensureScraperModeControl();
  pEval?.addEventListener("change", syncClaudeControlState);
  pPrefilter?.addEventListener("change", syncClaudeControlState);
  rEval?.addEventListener("change", syncClaudeControlState);
  byId("r-prefilter")?.addEventListener("change", syncClaudeControlState);
  syncClaudeControlState();
}

function rewriteRunnerRequest(input, init) {
  const rawUrl = typeof input === "string" ? input : input?.url;
  if (!rawUrl) return null;

  let url;
  try {
    url = new URL(rawUrl, window.location.href);
  } catch {
    return null;
  }

  if (url.pathname === "/scraper/run/stream") {
    const mode = byId("scraper-mode-select")?.value || "normal";
    url.searchParams.set("mode", mode);
    url.searchParams.delete("skip_newest_safe");
    return [url.toString(), init];
  }

  if (url.pathname === "/pipeline/run/stream") {
    if (byId("p-eval-model")?.value !== "claude") {
      claudePipelineActive = false;
      return null;
    }
    const rewritten = new URL("/pipeline/claude/stream", url.origin);
    const source = url.searchParams.get("source");
    const itemcount = byId("p-itemcount")?.value?.trim();
    if (source) rewritten.searchParams.set("source", source);
    if (itemcount) rewritten.searchParams.set("itemcount", itemcount);
    claudePipelineActive = true;
    return [rewritten.toString(), init];
  }

  if (url.pathname === "/pipeline/abort" && claudePipelineActive) {
    return [new URL("/pipeline/claude/abort", url.origin).toString(), init];
  }

  if (url.pathname === "/researcher/run/stream" && byId("r-eval-model")?.value === "claude") {
    const rewritten = new URL("/researcher/claude/stream", url.origin);
    const mode = byId("r-mode")?.value;
    const limit = byId("r-limit")?.value?.trim();
    const prefilter = byId("r-prefilter")?.value;
    if (mode) rewritten.searchParams.set("mode", mode);
    if (limit) rewritten.searchParams.set("limit", limit);
    if (byId("r-deep")?.checked) rewritten.searchParams.set("deep", "true");
    if (prefilter === "groq") rewritten.searchParams.set("prefilter_provider", "groq");
    return [rewritten.toString(), init];
  }

  return null;
}

window.fetch = function patchedFetch(input, init) {
  const rewritten = rewriteRunnerRequest(input, init);
  if (rewritten) return nativeFetch(rewritten[0], rewritten[1]);
  return nativeFetch(input, init);
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", enhanceControls, { once: true });
} else {
  enhanceControls();
}
