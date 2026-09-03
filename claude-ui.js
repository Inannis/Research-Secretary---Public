// Operational UI enhancements layered on top of the canonical SPA.
//
// This module keeps the large app-core.js untouched. It adds the current
// Claude and Gemini per-item controls plus the durable-URL-state scraper mode selector,
// then rewrites only the operational requests that need those newer routes or
// parameters. The same code runs in the local FastAPI UI and the Pages bridge.

const nativeFetch = window.fetch.bind(window);
const NativeEventSource = typeof window !== "undefined" ? window.EventSource : undefined;
let activePipelineBackend = null;
let activeResearcherBackend = null;

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
  if (window.__DATA_SOURCE__ === "local") {
    indicator.style.display = "none";
    return;
  }
  indicator.style.display = "inline-block";
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
  const pipelineClaude = pEval?.value === "claude";
  const pipelineGemini = pEval?.value === "gemini_per_item";
  const isPerItem = pipelineClaude || pipelineGemini;
  const pipelineCodex = pEval?.value === "codex";

  // Clean up any legacy injected duplicate item limit label if present
  const legacyItemCount = byId("p-itemcount-label");
  if (legacyItemCount) legacyItemCount.remove();

  if (pPrefilter) {
    if (pipelineClaude) {
      if (pPrefilter.value !== "claude" && pPrefilter.value !== "off") pPrefilter.value = "claude";
      pPrefilter.disabled = false;
      pPrefilter.title = "Choose Claude prefilter, or Off to evaluate directly without prefilter.";
    } else if (pipelineGemini) {
      if (pPrefilter.value !== "gemini_per_item" && pPrefilter.value !== "off") pPrefilter.value = "gemini_per_item";
      pPrefilter.disabled = false;
      pPrefilter.title = "Choose Gemini prefilter, or Off to evaluate directly without prefilter.";
    } else {
      pPrefilter.disabled = false;
      if (pPrefilter.value === "claude" || pPrefilter.value === "gemini_per_item") pPrefilter.value = "default";
      pPrefilter.title = "";
    }
  }

  const pBatchSize = byId("p-batch-size");
  const pBatchLabel = byId("p-batch-size-label-text");
  const pBatchContainer = byId("p-batch-size-label");
  const pMaxItems = byId("p-max-items");
  const pWorkersLabel = byId("p-workers-label");
  const pBacklogLabel = byId("p-backlog-label");

  if (pBatchSize) {
    if (pipelineCodex) {
      pBatchSize.value = "1";
      pBatchSize.disabled = true;
      if (pBatchLabel) pBatchLabel.textContent = "Batch size";
      pBatchSize.placeholder = "1";
      const title = "Codex Luna is hard-locked to one opportunity per fresh thread.";
      pBatchSize.title = title;
      if (pBatchContainer) pBatchContainer.title = title;
    } else if (isPerItem) {
      pBatchSize.disabled = false;
      if (pBatchLabel) pBatchLabel.textContent = "Items / turn";
      pBatchSize.placeholder = "1";
      const title = "Items processed per headless session turn (turn size). Default is 1; >1 reuses session context across turns to save prompt and thinking tokens.";
      pBatchSize.title = title;
      if (pBatchContainer) pBatchContainer.title = title;
    } else {
      pBatchSize.disabled = false;
      if (pBatchLabel) pBatchLabel.textContent = "Batch size";
      pBatchSize.placeholder = "auto";
      const title = "Items packed per LLM call for API models. Leave blank for auto token-budget packing; 1 = individual calls.";
      pBatchSize.title = title;
      if (pBatchContainer) pBatchContainer.title = title;
    }
  }

  if (pMaxItems) {
    pMaxItems.disabled = false;
    pMaxItems.placeholder = "all";
    pMaxItems.title = isPerItem
      ? "Maximum items to process for this per-item run. Leave blank to drain the queue."
      : "Total raw items to process this run for API models. Leave blank to drain the matching queue.";
  }

  if (pWorkersLabel) {
    pWorkersLabel.style.display = isPerItem ? "inline-flex" : "none";
  }
  if (pBacklogLabel) {
    pBacklogLabel.style.display = isPerItem ? "inline-flex" : "none";
  }

  const rEval = byId("r-eval-model");
  const rPrefilter = byId("r-prefilter");
  if ((rEval?.value === "claude" || rEval?.value === "gemini_per_item") && rPrefilter?.value === "off") {
    rPrefilter.value = "default";
  }
}

function enhanceControls() {
  ensureRunnerIndicatorVisible();

  const pEval = byId("p-eval-model");
  const pPrefilter = byId("p-prefilter");
  const rEval = byId("r-eval-model");

  addOption(pPrefilter, "gemini_per_item", "Gemini — per-item prefilter (Antigravity)");
  addOption(pEval, "gemini_per_item", "Gemini — per-item chain (Antigravity)");
  addOption(rEval, "gemini_per_item", "Gemini — per-item evaluation (Antigravity)");

  addOption(pPrefilter, "claude", "Claude — per-item prefilter", { first: true });
  addOption(pEval, "claude", "Claude — per-item chain (current default)", { first: true });
  if (pEval) pEval.value = "claude";
  if (pPrefilter) pPrefilter.value = "claude";

  const researcherClaude = rEval && [...rEval.options].find(option => option.value === "claude");
  if (researcherClaude) researcherClaude.textContent = "Claude — per-item evaluation";

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
    const evalModel = byId("p-eval-model")?.value;
    if (evalModel !== "claude" && evalModel !== "gemini_per_item") {
      activePipelineBackend = null;
      const batchSize = byId("p-batch-size")?.value?.trim();
      const maxItems = byId("p-max-items")?.value?.trim();
      if (batchSize && !url.searchParams.has("max_batch_items")) url.searchParams.set("max_batch_items", batchSize);
      if (maxItems && !url.searchParams.has("max_items")) url.searchParams.set("max_items", maxItems);
      return [url.toString(), init];
    }
    const backend = evalModel === "gemini_per_item" ? "gemini" : "claude";
    const rewritten = new URL(`/pipeline/${backend}/stream`, url.origin);
    const source = url.searchParams.get("source");
    const itemCount = byId("p-max-items")?.value?.trim() || url.searchParams.get("max_items") || url.searchParams.get("item_count");
    const prefilterVal = byId("p-prefilter")?.value;
    const mode = prefilterVal === "off" ? "evaluation-only" : "default";
    const turnSize = byId("p-batch-size")?.value?.trim() || url.searchParams.get("max_batch_items") || url.searchParams.get("turn_size");
    const workers = byId("p-workers")?.value?.trim() || url.searchParams.get("workers");
    const backlogOnly = byId("p-backlog-only")?.checked || url.searchParams.get("drain_prefilter_backlog") === "true";
    if (source) rewritten.searchParams.set("source", source);
    if (itemCount) {
      rewritten.searchParams.set("item_count", itemCount);
      rewritten.searchParams.set("max_items", itemCount);
    }
    if (mode) rewritten.searchParams.set("mode", mode);
    if (turnSize && parseInt(turnSize, 10) >= 1) {
      rewritten.searchParams.set("turn_size", turnSize);
      rewritten.searchParams.set("max_batch_items", turnSize);
    }
    if (workers && parseInt(workers, 10) >= 1) {
      rewritten.searchParams.set("workers", workers);
    }
    if (backlogOnly) {
      rewritten.searchParams.set("drain_prefilter_backlog", "true");
    }
    activePipelineBackend = backend;
    return [rewritten.toString(), init];
  }

  if (url.pathname === "/pipeline/abort" && activePipelineBackend) {
    return [new URL(`/pipeline/${activePipelineBackend}/abort`, url.origin).toString(), init];
  }

  if (url.pathname === "/researcher/run/stream") {
    const rEvalModel = byId("r-eval-model")?.value;
    if (rEvalModel === "claude" || rEvalModel === "gemini_per_item") {
      const backend = rEvalModel === "gemini_per_item" ? "gemini" : "claude";
      const rewritten = new URL(`/researcher/${backend}/stream`, url.origin);
      const mode = byId("r-mode")?.value;
      const limit = byId("r-limit")?.value?.trim();
      const prefilter = byId("r-prefilter")?.value;
      if (mode) rewritten.searchParams.set("mode", mode);
      if (limit) rewritten.searchParams.set("limit", limit);
      if (byId("r-deep")?.checked) rewritten.searchParams.set("deep", "true");
      if (prefilter === "groq") rewritten.searchParams.set("prefilter_provider", "groq");
      activeResearcherBackend = backend;
      return [rewritten.toString(), init];
    }
  }

  if (url.pathname === "/researcher/abort" && activeResearcherBackend) {
    return [new URL(`/researcher/${activeResearcherBackend}/abort`, url.origin).toString(), init];
  }

  return null;
}

window.fetch = function patchedFetch(input, init) {
  const rewritten = rewriteRunnerRequest(input, init);
  if (rewritten) return nativeFetch(rewritten[0], rewritten[1]);
  return nativeFetch(input, init);
};

if (NativeEventSource) {
  class PatchedEventSource extends NativeEventSource {
    constructor(url, init) {
      const rewritten = rewriteRunnerRequest(url, init);
      const targetUrl = rewritten ? rewritten[0] : url;
      if (init !== undefined) {
        super(targetUrl, init);
      } else {
        super(targetUrl);
      }
    }
  }
  window.EventSource = PatchedEventSource;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", enhanceControls, { once: true });
} else {
  enhanceControls();
}
