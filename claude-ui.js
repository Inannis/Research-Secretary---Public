// Pages/local-UI enhancement for the current Claude per-item runner.
//
// The existing index.html loopback bridge owns runner discovery, SSE parsing,
// button state and Stop behaviour. This module only adds the missing Claude UI
// controls and redirects those existing requests to the Claude-specific local
// endpoints. Keeping that logic here avoids duplicating the large SPA/bridge.

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
  // The indicator originally reused .pipeline-badge, whose historical CSS is
  // intentionally display:none until a pending count exists. The local runner
  // status must always be visible, including while offline.
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
    // Researcher discovery currently hands survivors to Claude after the
    // researcher's normal prefilter stage; there is no meaningful eval-only
    // handoff when prefilter is disabled.
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

// Module scripts run after parsing, but keep this resilient if the loading
// arrangement changes later.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", enhanceControls, { once: true });
} else {
  enhanceControls();
}
