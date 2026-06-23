// Literal port of web/static/app.js onto direct Turso access (Phase 7C,
// redone 2026-06-23 — see DECISIONS.md). Every pure rendering/formatting
// function below is copied verbatim from the local app; only the
// data-fetching layer (apiFetch -> q()/exec()) and the operational-trigger
// functions (which need a live server and can't survive going static) are
// different — those request work via command_queue instead (see the
// Researcher/Pipeline/Aggregator sections near the bottom).
import { createClient } from "https://esm.sh/@libsql/client@0.17.4/web";

const TURSO_URL = "libsql://artdb-inannis.aws-eu-west-1.turso.io";
const TOKEN_KEY = "turso_auth_token";
let client = null;

function getStoredToken() { return localStorage.getItem(TOKEN_KEY); }
function connect(token) { client = createClient({ url: TURSO_URL, authToken: token }); }
async function tryConnect(token) {
  connect(token);
  await client.execute({ sql: "SELECT 1", args: [] });
}

// Direct-SQL replacement for apiFetch() GETs: returns rows as plain objects.
async function q(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows.map((row) => {
    const obj = {};
    res.columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

// Direct-SQL replacement for apiFetch() writes.
async function exec(sql, args = []) {
  return client.execute({ sql, args });
}

function showApp() {
  document.getElementById("login-screen").hidden = true;
  document.getElementById("app").hidden = false;
}
function showLogin(errorMsg) {
  document.getElementById("login-screen").hidden = false;
  document.getElementById("app").hidden = true;
  const err = document.getElementById("login-error");
  if (errorMsg) { err.textContent = errorMsg; err.hidden = false; }
  else { err.hidden = true; }
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = document.getElementById("login-token").value.trim();
  if (!token) return;
  try {
    await tryConnect(token);
    localStorage.setItem(TOKEN_KEY, token);
    showApp();
    await init();
  } catch (err) {
    showLogin("Connection failed — check the token and try again.");
  }
});

document.getElementById("logout-btn").addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  client = null;
  showLogin();
});

// ───────────────────────────────────────────────────────────────────────────
// Everything below this line is ported from web/static/app.js. Pure
// rendering/formatting functions are verbatim; data-fetching functions are
// rewritten onto q()/exec() instead of apiFetch(); operational-trigger
// functions are rewritten onto command_queue (see the Researcher/Pipeline/
// Aggregator sections near the end).
// ───────────────────────────────────────────────────────────────────────────

const GROUPED_PER_PAGE = 100000; // fetch everything in one shot; see web/static/app.js's note on grouping across page boundaries
let currentFilters = { eligibility: "not_ineligible" };
let currentPage = 1;
let lastResult = null;
const LS_SORT_KEY = "artdb_sort";
function loadSort() {
  try { const s = localStorage.getItem(LS_SORT_KEY); if (s) return JSON.parse(s); } catch {}
  return { by: null, dir: "asc" };
}
const _savedSort = loadSort();
let sortBy = _savedSort.by;
let sortDir = _savedSort.dir;
let showLlmOutput = (() => { try { return localStorage.getItem("artdb_llm_output") === "1"; } catch { return false; } })();
let _detailPanelMode = null;
let editFieldsMode = false;

// ── Grouping ──────────────────────────────────────────────────────────────────
const LS_GROUP_KEY = "artdb_group";
const LS_EXPANDED_KEY = "artdb_expanded";
const LS_GROUP_SIMILAR_KEY = "artdb_group_similar";
const LS_SUBEXPANDED_KEY = "artdb_subexpanded";
const LS_SUBDEFAULTED_KEY = "artdb_subdefaulted";
let groupByInstitution = (() => {
  try { const s = localStorage.getItem(LS_GROUP_KEY); return s === null ? true : JSON.parse(s); } catch { return true; }
})();
let groupBySimilar = (() => {
  try { const s = localStorage.getItem(LS_GROUP_SIMILAR_KEY); return s === null ? false : JSON.parse(s); } catch { return false; }
})();
let _expandedGroups = (() => {
  try { const s = localStorage.getItem(LS_EXPANDED_KEY); return new Set(s ? JSON.parse(s) : []); } catch { return new Set(); }
})();
let _expandedSubgroups = (() => {
  try { const s = localStorage.getItem(LS_SUBEXPANDED_KEY); return new Set(s ? JSON.parse(s) : []); } catch { return new Set(); }
})();
let _subDefaultApplied = (() => {
  try { const s = localStorage.getItem(LS_SUBDEFAULTED_KEY); return new Set(s ? JSON.parse(s) : []); } catch { return new Set(); }
})();
function saveGroupState() { localStorage.setItem(LS_GROUP_KEY, JSON.stringify(groupByInstitution)); }
function saveGroupSimilarState() { localStorage.setItem(LS_GROUP_SIMILAR_KEY, JSON.stringify(groupBySimilar)); }
function saveExpandedGroups() { localStorage.setItem(LS_EXPANDED_KEY, JSON.stringify([..._expandedGroups])); }
function saveExpandedSubgroups() { localStorage.setItem(LS_SUBEXPANDED_KEY, JSON.stringify([..._expandedSubgroups])); }
function saveSubDefaultApplied() { localStorage.setItem(LS_SUBDEFAULTED_KEY, JSON.stringify([..._subDefaultApplied])); }
function toggleGroup(key) {
  if (_expandedGroups.has(key)) _expandedGroups.delete(key);
  else _expandedGroups.add(key);
  saveExpandedGroups();
  if (lastResult) renderTable(lastResult);
}
function toggleSubgroup(key) {
  if (_expandedSubgroups.has(key)) _expandedSubgroups.delete(key);
  else _expandedSubgroups.add(key);
  saveExpandedSubgroups();
  if (lastResult) renderTable(lastResult);
}
let _detailLeftWidth = null;
let _detailIdList = [];
let _detailIndex = -1;

// ── Tier tooltips ────────────────────────────────────────────────────────────
const TIER_LABELS = {
  1: "Tier 1 — clear visual/fine/conceptual-arts pathway AND excellent terms",
  2: "Tier 2 — clear visual/fine/conceptual-arts pathway AND concrete, good terms",
  3: "Tier 3 — real but uncertain: vague framing OR decent terms",
  4: "Tier 4 — in scope but thin: boilerplate, no concrete terms, or weak relevance",
};
function tierTitle(tier) { return TIER_LABELS[tier] || ""; }

// ── Country lookup ────────────────────────────────────────────────────────────
const ISO_COUNTRIES = {
  "AD":"Andorra",
  "AE":"United Arab Emirates",
  "AF":"Afghanistan",
  "AG":"Antigua and Barbuda",
  "AI":"Anguilla",
  "AL":"Albania",
  "AM":"Armenia",
  "AO":"Angola",
  "AQ":"Antarctica",
  "AR":"Argentina",
  "AS":"American Samoa",
  "AT":"Austria",
  "AU":"Australia",
  "AW":"Aruba",
  "AX":"\u00c5land Islands",
  "AZ":"Azerbaijan",
  "BA":"Bosnia and Herzegovina",
  "BB":"Barbados",
  "BD":"Bangladesh",
  "BE":"Belgium",
  "BF":"Burkina Faso",
  "BG":"Bulgaria",
  "BH":"Bahrain",
  "BI":"Burundi",
  "BJ":"Benin",
  "BL":"Saint Barth\u00e9lemy",
  "BM":"Bermuda",
  "BN":"Brunei Darussalam",
  "BO":"Bolivia",
  "BQ":"Bonaire, Sint Eustatius and Saba",
  "BR":"Brazil",
  "BS":"Bahamas",
  "BT":"Bhutan",
  "BV":"Bouvet Island",
  "BW":"Botswana",
  "BY":"Belarus",
  "BZ":"Belize",
  "CA":"Canada",
  "CC":"Cocos (Keeling) Islands",
  "CD":"Congo, The Democratic Republic of the",
  "CF":"Central African Republic",
  "CG":"Congo",
  "CH":"Switzerland",
  "CI":"C\u00f4te d'Ivoire",
  "CK":"Cook Islands",
  "CL":"Chile",
  "CM":"Cameroon",
  "CN":"China",
  "CO":"Colombia",
  "CR":"Costa Rica",
  "CU":"Cuba",
  "CV":"Cabo Verde",
  "CW":"Cura\u00e7ao",
  "CX":"Christmas Island",
  "CY":"Cyprus",
  "CZ":"Czechia",
  "DE":"Germany",
  "DJ":"Djibouti",
  "DK":"Denmark",
  "DM":"Dominica",
  "DO":"Dominican Republic",
  "DZ":"Algeria",
  "EC":"Ecuador",
  "EE":"Estonia",
  "EG":"Egypt",
  "EH":"Western Sahara",
  "ER":"Eritrea",
  "ES":"Spain",
  "ET":"Ethiopia",
  "FI":"Finland",
  "FJ":"Fiji",
  "FK":"Falkland Islands (Malvinas)",
  "FM":"Micronesia, Federated States of",
  "FO":"Faroe Islands",
  "FR":"France",
  "GA":"Gabon",
  "GB":"United Kingdom",
  "GD":"Grenada",
  "GE":"Georgia",
  "GF":"French Guiana",
  "GG":"Guernsey",
  "GH":"Ghana",
  "GI":"Gibraltar",
  "GL":"Greenland",
  "GM":"Gambia",
  "GN":"Guinea",
  "GP":"Guadeloupe",
  "GQ":"Equatorial Guinea",
  "GR":"Greece",
  "GS":"South Georgia and the South Sandwich Islands",
  "GT":"Guatemala",
  "GU":"Guam",
  "GW":"Guinea-Bissau",
  "GY":"Guyana",
  "HK":"Hong Kong",
  "HM":"Heard Island and McDonald Islands",
  "HN":"Honduras",
  "HR":"Croatia",
  "HT":"Haiti",
  "HU":"Hungary",
  "ID":"Indonesia",
  "IE":"Ireland",
  "IL":"Israel",
  "IM":"Isle of Man",
  "IN":"India",
  "IO":"British Indian Ocean Territory",
  "IQ":"Iraq",
  "IR":"Iran",
  "IS":"Iceland",
  "IT":"Italy",
  "JE":"Jersey",
  "JM":"Jamaica",
  "JO":"Jordan",
  "JP":"Japan",
  "KE":"Kenya",
  "KG":"Kyrgyzstan",
  "KH":"Cambodia",
  "KI":"Kiribati",
  "KM":"Comoros",
  "KN":"Saint Kitts and Nevis",
  "KP":"North Korea",
  "KR":"South Korea",
  "KW":"Kuwait",
  "KY":"Cayman Islands",
  "KZ":"Kazakhstan",
  "LA":"Laos",
  "LB":"Lebanon",
  "LC":"Saint Lucia",
  "LI":"Liechtenstein",
  "LK":"Sri Lanka",
  "LR":"Liberia",
  "LS":"Lesotho",
  "LT":"Lithuania",
  "LU":"Luxembourg",
  "LV":"Latvia",
  "LY":"Libya",
  "MA":"Morocco",
  "MC":"Monaco",
  "MD":"Moldova",
  "ME":"Montenegro",
  "MF":"Saint Martin (French part)",
  "MG":"Madagascar",
  "MH":"Marshall Islands",
  "MK":"North Macedonia",
  "ML":"Mali",
  "MM":"Myanmar",
  "MN":"Mongolia",
  "MO":"Macao",
  "MP":"Northern Mariana Islands",
  "MQ":"Martinique",
  "MR":"Mauritania",
  "MS":"Montserrat",
  "MT":"Malta",
  "MU":"Mauritius",
  "MV":"Maldives",
  "MW":"Malawi",
  "MX":"Mexico",
  "MY":"Malaysia",
  "MZ":"Mozambique",
  "NA":"Namibia",
  "NC":"New Caledonia",
  "NE":"Niger",
  "NF":"Norfolk Island",
  "NG":"Nigeria",
  "NI":"Nicaragua",
  "NL":"Netherlands",
  "NO":"Norway",
  "NP":"Nepal",
  "NR":"Nauru",
  "NU":"Niue",
  "NZ":"New Zealand",
  "OM":"Oman",
  "PA":"Panama",
  "PE":"Peru",
  "PF":"French Polynesia",
  "PG":"Papua New Guinea",
  "PH":"Philippines",
  "PK":"Pakistan",
  "PL":"Poland",
  "PM":"Saint Pierre and Miquelon",
  "PN":"Pitcairn",
  "PR":"Puerto Rico",
  "PS":"Palestine, State of",
  "PT":"Portugal",
  "PW":"Palau",
  "PY":"Paraguay",
  "QA":"Qatar",
  "RE":"R\u00e9union",
  "RO":"Romania",
  "RS":"Serbia",
  "RU":"Russian Federation",
  "RW":"Rwanda",
  "SA":"Saudi Arabia",
  "SB":"Solomon Islands",
  "SC":"Seychelles",
  "SD":"Sudan",
  "SE":"Sweden",
  "SG":"Singapore",
  "SH":"Saint Helena, Ascension and Tristan da Cunha",
  "SI":"Slovenia",
  "SJ":"Svalbard and Jan Mayen",
  "SK":"Slovakia",
  "SL":"Sierra Leone",
  "SM":"San Marino",
  "SN":"Senegal",
  "SO":"Somalia",
  "SR":"Suriname",
  "SS":"South Sudan",
  "ST":"Sao Tome and Principe",
  "SV":"El Salvador",
  "SX":"Sint Maarten (Dutch part)",
  "SY":"Syria",
  "SZ":"Eswatini",
  "TC":"Turks and Caicos Islands",
  "TD":"Chad",
  "TF":"French Southern Territories",
  "TG":"Togo",
  "TH":"Thailand",
  "TJ":"Tajikistan",
  "TK":"Tokelau",
  "TL":"Timor-Leste",
  "TM":"Turkmenistan",
  "TN":"Tunisia",
  "TO":"Tonga",
  "TR":"T\u00fcrkiye",
  "TT":"Trinidad and Tobago",
  "TV":"Tuvalu",
  "TW":"Taiwan",
  "TZ":"Tanzania",
  "UA":"Ukraine",
  "UG":"Uganda",
  "UM":"United States Minor Outlying Islands",
  "US":"United States",
  "UY":"Uruguay",
  "UZ":"Uzbekistan",
  "VA":"Holy See (Vatican City State)",
  "VC":"Saint Vincent and the Grenadines",
  "VE":"Venezuela",
  "VG":"Virgin Islands, British",
  "VI":"Virgin Islands, U.S.",
  "VN":"Vietnam",
  "VU":"Vanuatu",
  "WF":"Wallis and Futuna",
  "WS":"Samoa",
  "YE":"Yemen",
  "YT":"Mayotte",
  "ZA":"South Africa",
  "ZM":"Zambia",
  "ZW":"Zimbabwe",
};
const COUNTRY_FROM_NAME = Object.fromEntries(
  Object.entries(ISO_COUNTRIES).map(([k, v]) => [v.toLowerCase(), k])
);
function countryName(code) { return code ? (ISO_COUNTRIES[code] || code) : ""; }

const ISO_LANGUAGES = {
  "de":"German","en":"English","fr":"French","it":"Italian","es":"Spanish",
  "pt":"Portuguese","nl":"Dutch","pl":"Polish","cs":"Czech","sk":"Slovak",
  "hu":"Hungarian","ro":"Romanian","hr":"Croatian","sl":"Slovenian",
  "bg":"Bulgarian","el":"Greek","sv":"Swedish","da":"Danish","fi":"Finnish",
  "no":"Norwegian","tr":"Turkish","ru":"Russian","uk":"Ukrainian","ar":"Arabic",
  "zh":"Chinese","ja":"Japanese","ko":"Korean","ca":"Catalan","eu":"Basque",
};
function langName(code) { return ISO_LANGUAGES[code] || code; }
function fmtLanguages(val) {
  if (!val) return null;
  const arr = parseJsonField(val);
  if (Array.isArray(arr) && arr.length) return arr.map(langName).join(", ");
  return String(val);
}

function countryCode(input) {
  if (!input) return "";
  const s = input.trim().toLowerCase();
  if (s === "eu" || s === "european union") return "_EU";
  if (s === "europe" || s === "european" || s === "eur") return "_EUR";
  if (s.length === 2) return s.toUpperCase();
  return COUNTRY_FROM_NAME[s] || input.trim().toUpperCase();
}

// ── Column definitions ────────────────────────────────────────────────────────

const COLUMNS = [
  { key: "id",          label: "ID",          default: false },
  { key: "tier",        label: "Tier",        default: true  },
  { key: "title",       label: "Title",       default: true  },
  { key: "institution", label: "Institution", default: true  },
  { key: "country",     label: "Country",     default: true  },
  { key: "city",        label: "City",        default: false },
  { key: "deadline",    label: "Deadline",    default: true  },
  { key: "duration",    label: "Duration",    default: false },
  { key: "period",      label: "Period",      default: false },
  { key: "stipend",     label: "Stipend",     default: false },
  { key: "cost",        label: "Cost",        default: true  },
  { key: "obligations", label: "Obligations", default: false },
  { key: "eligibility", label: "Eligibility", default: true  },
  { key: "scope",       label: "Scope",       default: true  },
  { key: "class",       label: "Class",       default: true  },
  { key: "type",        label: "Type",        default: false },
  { key: "recurring",   label: "Recurring",   default: false },
  { key: "status",      label: "Status",      default: false },
  { key: "added",       label: "Date added",  default: false },
  { key: "added_by",    label: "Added by",    default: false },
  { key: "summary",     label: "Summary",     default: false },
  { key: "notes",       label: "Notes",       default: false },
  { key: "source",      label: "Source",      default: true  },
  { key: "url",         label: "URL",         default: false },
  { key: "working_lang", label: "Working lang", default: false },
];

const LS_COL_KEY = "artdb_columns";

function loadActiveColumns() {
  try {
    const stored = localStorage.getItem(LS_COL_KEY);
    if (stored) return new Set(JSON.parse(stored));
  } catch {}
  return new Set(COLUMNS.filter(c => c.default).map(c => c.key));
}

let activeColumns = loadActiveColumns();

function saveActiveColumns() {
  localStorage.setItem(LS_COL_KEY, JSON.stringify([...activeColumns]));
}


// ── Startup ───────────────────────────────────────────────────────────────────

async function loadLanguages() {
  try {
    const langs = await q(
      "SELECT DISTINCT source_language FROM opportunities WHERE source_language IS NOT NULL ORDER BY source_language"
    );
    const sel = document.getElementById("f-source-language");
    langs.forEach(row => {
      const code = row.source_language;
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = langName(code) + " (" + code + ")";
      sel.appendChild(opt);
    });
  } catch {}
}

let _bound = false;

async function init() {
  if (!_bound) {
    _bound = true;
    bindFilters();
    bindNav();
    bindResearcherPanel();
  }
  loadLanguages();
  const startView = location.hash === "#researcher" ? "researcher" : "list";
  if (startView === "researcher") {
    showView("researcher");
    history.replaceState({ view: "researcher" }, "", "#researcher");
    loadResearcherRuns();
    loadJobQueue();
    loadPipelineRuns();
    loadAggregatorCandidatesTable();
  } else {
    showView("list");
    history.replaceState({ view: "list" }, "", "#opportunities");
  }
  await loadStats();
  await loadOpportunities(1);
}

function showView(name) {
  document.getElementById("list-view").classList.toggle("hidden", name !== "list");
  document.getElementById("detail-view").classList.toggle("hidden", name !== "detail");
  document.getElementById("researcher-view").classList.toggle("hidden", name !== "researcher");
  document.querySelectorAll("#main-nav button").forEach(b => b.classList.remove("active"));
  if (name === "list" || name === "detail") {
    document.getElementById("nav-list").classList.add("active");
  } else if (name === "researcher") {
    document.getElementById("nav-researcher").classList.add("active");
  }
}

function _navToResearcher() {
  showView("researcher");
  loadResearcherRuns();
  loadJobQueue();
  loadPipelineRuns();
  loadAggregatorCandidatesTable();
  history.pushState({ view: "researcher" }, "", "#researcher");
}

function _navToList() {
  showView("list");
  history.pushState({ view: "list" }, "", "#opportunities");
}

function bindNav() {
  document.getElementById("nav-list").addEventListener("click", _navToList);
  document.getElementById("nav-researcher").addEventListener("click", _navToResearcher);
  document.getElementById("btn-back-researcher").addEventListener("click", _navToList);
  window.addEventListener("popstate", e => {
    const view = e.state?.view ?? (location.hash === "#researcher" ? "researcher" : "list");
    if (view === "researcher") {
      showView("researcher");
      loadResearcherRuns();
      loadJobQueue();
      loadPipelineRuns();
      loadAggregatorCandidatesTable();
    } else {
      showView("list");
    }
  });
}


// ── Stats bar ─────────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const total = (await q("SELECT COUNT(*) AS n FROM opportunities WHERE status != 'archived'"))[0].n;
    const byTier = await q(
      "SELECT COALESCE(manual_tier, llm_tier) AS k, COUNT(*) AS n FROM opportunities WHERE status != 'archived' GROUP BY 1"
    );
    const unreviewed = (await q(
      "SELECT COUNT(*) AS n FROM opportunities WHERE manually_reviewed = 0 AND status != 'archived'"
    ))[0].n;
    const t = {};
    byTier.forEach(r => { t[r.k] = r.n; });
    document.getElementById("stats-bar").innerHTML =
      `Total: <strong>${total}</strong> &nbsp;|&nbsp; ` +
      `Tier 1: <strong>${t[1] || 0}</strong> &nbsp;|&nbsp; ` +
      `Tier 2: <strong>${t[2] || 0}</strong> &nbsp;|&nbsp; ` +
      `Unreviewed: <strong>${unreviewed}</strong>`;
  } catch {
    document.getElementById("stats-bar").textContent = "Stats unavailable";
  }
}


// ── Opportunities list — mirrors web/db.py::list_opportunities exactly ────────

const _EU_COUNTRIES = ["AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI","FR","GR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK"];
const _EUROPE_COUNTRIES = _EU_COUNTRIES.concat(["CH","NO","IS","GB","UA","RS","ME","MK","AL","BA","XK","MD","TR"]);

const _LIST_FIELDS = `
    o.id, o.title,
    i.canonical_name AS institution,
    o.country, o.city, o.deadline, o.deadline_confidence,
    o.llm_tier, o.manual_tier,
    COALESCE(o.manual_tier, o.llm_tier) AS effective_tier,
    o.llm_tier_confidence, o.eligibility_match,
    o.scope, o.url, o.status,
    o.is_recurring, o.stipend, o.duration_weeks,
    o.pay_amount_value, o.pay_currency, o.pay_basis, o.pay_qualifier,
    o.start_date, o.end_date, o.residency_period, o.duration_quote,
    o.has_application_fee, o.application_fee_amount,
    o.has_cost, o.cost_description, o.residency_cost_amount,
    o.has_obligations, o.obligations_description,
    o.flagged, o.flag_reason, o.manually_reviewed,
    o.hard_data_mismatch, o.mismatch_detail,
    o.summary, o.notes, o.opportunity_type,
    o.opportunity_class, o.class_note, o.deadline_type,
    o.cost_amount_value, o.cost_currency, o.cost_basis,
    o.low_quality_flags, o.discovery_context,
    o.created_at, o.extraction_model,
    o.ambiguities, o.llm_tier_note, o.competitiveness_note, o.notable, o.prestige_signals,
    o.source_language, o.working_language, o.discipline_note,
    o.scope_note,
    o.recurrence_interval, o.age_note, o.eligibility_note,
    o.llm_output_json,
    COALESCE(s.name, ql.mode) AS source_name
`;

const _SORT_COLS = {
  id: "o.id", tier: "COALESCE(o.manual_tier, o.llm_tier)", title: "o.title COLLATE NOCASE",
  institution: "i.canonical_name COLLATE NOCASE", country: "o.country", city: "o.city",
  deadline: "o.deadline", duration: "o.duration_weeks", stipend: "o.stipend",
  cost: "o.residency_cost_amount", eligibility: "o.eligibility_match", scope: "o.scope",
  status: "o.status", recurring: "o.is_recurring", added: "o.created_at", added_by: "o.created_at",
};

const _JOINS = `
  LEFT JOIN institutions i ON o.institution_id = i.id
  LEFT JOIN sources s ON o.source_id = s.id
  LEFT JOIN query_log ql ON o.found_via_query_id = ql.id`;

function _buildWhere(filters) {
  const conditions = ["1=1"];
  const params = [];

  if (filters.scope) { conditions.push("o.scope = ?"); params.push(filters.scope); }
  if (filters.tier) { conditions.push("COALESCE(o.manual_tier, o.llm_tier) = ?"); params.push(Number(filters.tier)); }
  if (filters.status && filters.status !== "all") { conditions.push("o.status = ?"); params.push(filters.status); }

  const eligibility = filters.eligibility || "not_ineligible";
  if (eligibility === "eligible") conditions.push("o.eligibility_match = 'eligible'");
  else if (eligibility === "not_ineligible") conditions.push("o.eligibility_match != 'ineligible'");

  if (filters.deadline_before) { conditions.push("o.deadline <= ?"); params.push(filters.deadline_before); }

  if (filters.country) {
    const code = countryCode(filters.country);
    if (code === "_EU") { conditions.push(`o.country IN (${_EU_COUNTRIES.map(() => "?").join(",")})`); params.push(..._EU_COUNTRIES); }
    else if (code === "_EUR") { conditions.push(`o.country IN (${_EUROPE_COUNTRIES.map(() => "?").join(",")})`); params.push(..._EUROPE_COUNTRIES); }
    else { conditions.push("o.country = ?"); params.push(code); }
  }

  if (filters.app_fee === "none") conditions.push("(o.has_application_fee = 0 OR o.has_application_fee IS NULL)");
  else if (filters.app_fee === "has") conditions.push("o.has_application_fee = 1");

  if (filters.cost === "none") conditions.push("(o.has_cost = 0 OR o.has_cost IS NULL) AND (o.has_application_fee = 0 OR o.has_application_fee IS NULL)");
  else if (filters.cost === "has") conditions.push("(o.has_cost = 1 OR o.has_application_fee = 1)");

  if (filters.max_cost) {
    const n = Number(filters.max_cost);
    if (!Number.isNaN(n)) {
      conditions.push("(o.has_cost = 0 OR (o.residency_cost_amount IS NOT NULL AND o.residency_cost_amount <= ?))");
      params.push(n);
    }
  }

  if (filters.search) {
    conditions.push("(o.title LIKE ? OR i.canonical_name LIKE ?)");
    const pat = `%${filters.search}%`;
    params.push(pat, pat);
  }

  if (filters.flagged === "only") conditions.push("o.flagged = 1");
  else if (filters.flagged === "hide") conditions.push("(o.flagged = 0 OR o.flagged IS NULL)");

  if (filters.mismatch === "only") conditions.push("o.hard_data_mismatch = 1");
  else if (filters.mismatch === "hide") conditions.push("(o.hard_data_mismatch = 0 OR o.hard_data_mismatch IS NULL)");

  if (filters.opp_class) { conditions.push("o.opportunity_class = ?"); params.push(filters.opp_class); }
  if (filters.source_language) { conditions.push("o.source_language = ?"); params.push(filters.source_language); }

  if (filters.source) {
    if (filters.source === "agg:all") {
      conditions.push("o.source_id IS NOT NULL AND EXISTS (SELECT 1 FROM sources s2 WHERE s2.id = o.source_id AND s2.source_type = 'aggregator')");
    } else if (filters.source.startsWith("agg:")) {
      conditions.push("o.source_id = (SELECT id FROM sources WHERE name = ? LIMIT 1)");
      params.push(filters.source.slice(4));
    } else if (filters.source === "res:all") {
      conditions.push("o.found_via_query_id IS NOT NULL");
    } else if (filters.source.startsWith("res:")) {
      conditions.push("o.found_via_query_id IN (SELECT id FROM query_log WHERE mode = ?)");
      params.push(filters.source.slice(4));
    }
  }

  return { where: conditions.join(" AND "), params };
}

async function fetchOpportunitiesList(filters, page, perPage) {
  const { where, params } = _buildWhere(filters);
  const sortKey = filters.sort_by || "";
  const sortCol = _SORT_COLS[sortKey] || "COALESCE(o.manual_tier, o.llm_tier)";
  const dir = filters.sort_dir === "desc" ? "DESC" : "ASC";
  const order = (sortKey && sortKey !== "tier")
    ? `${sortCol} ${dir}, COALESCE(o.manual_tier, o.llm_tier) ASC`
    : `COALESCE(o.manual_tier, o.llm_tier) ${dir}, o.deadline ASC`;

  const total = (await q(`SELECT COUNT(*) AS n FROM opportunities o ${_JOINS} WHERE ${where}`, params))[0].n;
  const offset = (page - 1) * perPage;
  const items = await q(
    `SELECT ${_LIST_FIELDS} FROM opportunities o ${_JOINS} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...params, perPage, offset]
  );
  for (const d of items) {
    if (d.llm_output_json && typeof d.llm_output_json === "string") {
      try { d.llm_output_json = JSON.parse(d.llm_output_json); } catch (_) {}
    }
  }
  return { total, page, per_page: perPage, items };
}

async function loadOpportunities(page = 1) {
  currentPage = 1; // always fetching everything — see GROUPED_PER_PAGE note above
  try {
    const filters = { ...currentFilters };
    if (sortBy) { filters.sort_by = sortBy; filters.sort_dir = sortDir; }
    lastResult = await fetchOpportunitiesList(filters, 1, GROUPED_PER_PAGE);
    renderTable(lastResult);
  } catch (e) {
    document.getElementById("opp-tbody").innerHTML =
      `<tr><td colspan="99">Error loading data: ${esc(e.message)}</td></tr>`;
  }
}

function visibleColumns() {
  return COLUMNS.filter(c => activeColumns.has(c.key));
}

function renderCell(key, opp) {
  const tier = opp.manual_tier || opp.llm_tier;
  switch (key) {
    case "id":          return String(opp.id);
    case "tier":        return `<span class="tier-badge tier-${tier}" title="${esc(tierTitle(tier))}">T${tier || "?"}</span>${opp.manual_tier ? ' <span class="edited">✎</span>' : ""}`;
    case "title":       return `<span class="title-cell-inner">${esc(opp.title)}</span>`;
    case "institution": return esc(opp.institution || "");
    case "country":     return esc(countryName(opp.country));
    case "city":        return esc(opp.city || "");
    case "deadline":    return fmtDate(opp.deadline);
    case "duration":    return opp.residency_period
      ? esc(opp.residency_period)
      : opp.duration_weeks
        ? `${opp.duration_weeks} wks <span class="cell-tag" title="calculated from program start/end dates">[calc]</span>`
        : "—";
    case "stipend": {
      if (!opp.stipend) return "—";
      const s = fmtStipend(opp);
      return s && s !== "None" && s !== "Unknown" ? esc(s) : "Yes";
    }
    case "cost": {
      const parts = [];
      if (opp.has_application_fee) parts.push(opp.application_fee_amount ? `App fee: ${esc(opp.application_fee_amount)}` : "App fee");
      if (opp.has_cost) {
        const c = fmtCost(opp);
        if (c && c !== "None" && c !== "Unknown") parts.push(esc(c));
      }
      if (parts.length) return parts.join(" + ");
      if (opp.has_cost == null && opp.has_application_fee == null) return "—";
      return "None";
    }
    case "obligations": return opp.has_obligations && opp.obligations_description
      ? esc(opp.obligations_description) : (opp.has_obligations ? "Yes" : "—");
    case "period": {
      if (opp.start_date && opp.end_date) return fmtDate(opp.start_date) + " – " + fmtDate(opp.end_date);
      if (opp.start_date) return "From " + fmtDate(opp.start_date);
      return opp.residency_period ? esc(opp.residency_period) : "—";
    }
    case "eligibility": return `<span class="eligib eligib-${opp.eligibility_match}">${esc(opp.eligibility_match || "")}</span>`;
    case "scope":       return esc((opp.scope || "").replace(/_/g, " "));
    case "class":       return opp.opportunity_class ? `<span class="opp-class opp-class-${opp.opportunity_class}">${esc(opp.opportunity_class.replace(/_/g, " "))}</span>` : "—";
    case "type":        return opp.opportunity_type ? `<span class="opp-type opp-type-${opp.opportunity_type}">${esc(opp.opportunity_type.replace(/_/g, " "))}</span>` : "—";
    case "source":      return opp.source_name ? esc(opp.source_name.replace(/_/g, " ")) : "—";
    case "recurring":   return opp.is_recurring ? "Yes" : "—";
    case "status":      return esc(opp.status || "");
    case "added":       return fmtDate(opp.created_at);
    case "added_by":    return fmtModel(opp.extraction_model) || "—";
    case "summary":     return opp.summary ? `<span title="${esc(opp.summary)}">${esc(opp.summary.slice(0, 80))}${opp.summary.length > 80 ? "…" : ""}</span>` : "—";
    case "notes":       return opp.notes ? `<span title="${esc(opp.notes)}">${esc(opp.notes.slice(0, 60))}${opp.notes.length > 60 ? "…" : ""}</span>` : "—";
    case "url":         return opp.url ? `<a href="${esc(opp.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(opp.url.replace(/^https?:\/\//, "").slice(0, 40))}…</a>` : "—";
    case "working_lang": return fmtLanguages(opp.working_language) || "—";
    default:            return "";
  }
}

// ── Similar-call sub-grouping ────────────────────────────────────────────────

const _SIMILARITY_THRESHOLD = 0.65;

function _lcsLen(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return 0;
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[m];
}

function titleSimilarity(a, b) {
  if (!a || !b) return 0;
  return (2 * _lcsLen(a, b)) / (a.length + b.length);
}

function normalizeTitleForMatch(title, institutionName) {
  let t = (title || "").replace(/\b(19|20)\d{2}(\/\d{2,4})?\b/g, "").trim();
  if (institutionName && t.toLowerCase().startsWith(institutionName.toLowerCase())) {
    const stripped = t.slice(institutionName.length).replace(/^[\s–—\-:,]+/, "");
    if (stripped) t = stripped;
  }
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}

function _normGate(v) {
  return (v || "").replace(/\(.*?\)/g, "").trim().toLowerCase();
}

function _normalizeDashes(s) {
  return (s || "").replace(/[‐-―−]/g, "-");
}

function clusterBySimilarTitle(items) {
  const buckets = new Map();
  items.forEach((opp, idx) => {
    const bucketKey = [_normGate(opp.institution), _normGate(opp.country), _normGate(opp.city), opp.opportunity_class || "", opp.opportunity_type || ""].join("|");
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey).push(idx);
  });

  const clusters = [];
  const ungrouped = [];

  for (const idxs of buckets.values()) {
    if (idxs.length === 1) { ungrouped.push(items[idxs[0]]); continue; }
    const norms = idxs.map(i => normalizeTitleForMatch(items[i].title, items[i].institution));
    const used = new Array(idxs.length).fill(false);
    for (let a = 0; a < idxs.length; a++) {
      if (used[a]) continue;
      const members = [a];
      used[a] = true;
      for (let b = a + 1; b < idxs.length; b++) {
        if (used[b]) continue;
        const isMatch = members.some(m => titleSimilarity(norms[m], norms[b]) >= _SIMILARITY_THRESHOLD);
        if (isMatch) { members.push(b); used[b] = true; }
      }
      if (members.length > 1) clusters.push(members.map(m => items[idxs[m]]));
      else ungrouped.push(items[idxs[a]]);
    }
  }
  return { clusters, ungrouped };
}

function clusterRowPlan(items) {
  if (items.length < 2) return items.map(opp => ({ type: "single", opp }));
  const { clusters } = clusterBySimilarTitle(items);
  const idToCluster = new Map();
  clusters.forEach((cl, ci) => cl.forEach(opp => idToCluster.set(opp.id, ci)));
  const renderedClusters = new Set();
  const plan = [];
  for (const opp of items) {
    const ci = idToCluster.get(opp.id);
    if (ci === undefined) { plan.push({ type: "single", opp }); continue; }
    if (renderedClusters.has(ci)) continue;
    renderedClusters.add(ci);
    const clusterItems = clusters[ci];
    const subKey = `sim::${Math.min(...clusterItems.map(o => o.id))}`;
    plan.push({ type: "cluster", items: clusterItems, key: subKey });
  }
  return plan;
}

function renderSubgroupCell(key, g, label, count, idVisible, instVisible) {
  switch (key) {
    case "id":          return idVisible ? `(${count})` : "";
    case "institution": return (!idVisible && instVisible) ? `(${count})` : "";
    case "title": {
      if (label === null) return "";
      const badge = (!idVisible && !instVisible) ? `(${count}) ` : "";
      return `${badge}${esc(label)}`;
    }
    default:            return renderGroupCell(key, g, "", count);
  }
}

// ── Group computation ─────────────────────────────────────────────────────────

function computeGroupData(items) {
  const tiers = items.map(i => i.manual_tier || i.llm_tier).filter(Boolean);
  const minTier = tiers.length ? Math.min(...tiers) : null;
  const maxTier = tiers.length ? Math.max(...tiers) : null;
  const tierStr = !tiers.length ? "" : minTier === maxTier ? `T${minTier}` : `T${minTier}–T${maxTier}`;

  const deadlines = items.map(i => i.deadline).filter(Boolean).sort();
  const deadline = deadlines[0] || null;
  const deadlineTooltip = deadlines.map(d => fmtDate(d)).join(", ");

  const classCounts = {};
  for (const i of items) { const c = i.opportunity_class || "unknown"; classCounts[c] = (classCounts[c] || 0) + 1; }
  const classSorted = Object.entries(classCounts).sort((a, b) => b[1] - a[1]);
  let classStr = "";
  if (classSorted.length === 1) classStr = classSorted[0][0].replace(/_/g, " ");
  else {
    const shown = classSorted.slice(0, 2).map(([c, n]) => `${n} ${c.replace(/_/g, " ")}`).join(" · ");
    const rest = classSorted.slice(2).reduce((s, [, n]) => s + n, 0);
    classStr = shown + (rest > 0 ? ` · ${rest} more` : "");
  }

  const uniform = fn => {
    const vals = items.map(fn).filter(v => v != null && v !== "");
    return vals.length && vals.every(v => v === vals[0]) ? vals[0] : null;
  };

  const starts = items.map(i => i.start_date).filter(Boolean).sort();
  const ends = items.map(i => i.end_date).filter(Boolean).sort();
  let periodStr = "";
  if (starts.length || ends.length) {
    const s = starts[0] ? fmtDate(starts[0]) : null;
    const e = ends.length ? fmtDate(ends[ends.length - 1]) : null;
    if (s && e && s !== e) periodStr = `${s} – ${e}`;
    else if (s || e) periodStr = s || e;
  }

  const periods = items.map(i => i.residency_period).filter(Boolean);
  const durations = items.map(i => i.duration_weeks).filter(Boolean);
  const periodsUniform = periods.length === items.length &&
    periods.every(p => _normalizeDashes(p) === _normalizeDashes(periods[0]));
  const durationsUniform = durations.length === items.length &&
    durations.every(d => d === durations[0]);
  const durStr = periodsUniform
    ? periods[0]
    : durationsUniform ? `${durations[0]} wks`
    : durations.length >= 2 ? `${Math.min(...durations)}–${Math.max(...durations)} wks`
    : null;

  const costs = items.map(i => fmtCost(i));
  const uniformCost = costs.every(c => c === costs[0]) ? costs[0] : null;

  return {
    minTier, maxTier, tierStr,
    deadline, deadlineTooltip,
    classStr, uniformClass: uniform(i => i.opportunity_class),
    periodStr, durStr, uniformCost,
    country:         uniform(i => i.country ? countryCode(i.country) : null),
    city:            uniform(i => i.city),
    scope:           uniform(i => i.scope),
    eligibility:     uniform(i => i.eligibility_match),
    stipend:         uniform(i => i.stipend ? "yes" : "no"),
    appFee:          uniform(i => i.has_application_fee != null ? (i.has_application_fee ? "yes" : "no") : null),
    recurring:       uniform(i => i.is_recurring != null ? (i.is_recurring ? "yes" : "no") : null),
    status:          uniform(i => i.status),
    uniformType:     uniform(i => i.opportunity_type),
    extractionModel: uniform(i => i.extraction_model),
    dateAdded:       uniform(i => i.created_at ? i.created_at.slice(0, 10) : null),
    sourceUniform:   uniform(i => i.source_name),
    workingLang:     uniform(i => fmtLanguages(i.working_language) || "—"),
  };
}

function renderGroupCell(key, g, groupKey, count, titleLabel) {
  const instVisible = visibleColumns().some(c => c.key === "institution");
  const titleVisible = visibleColumns().some(c => c.key === "title");
  const idVisible = visibleColumns().some(c => c.key === "id");
  const countPrefix = idVisible ? "" : `(${count}) `;
  const groupLabel = instVisible ? "" : `${countPrefix}${esc(groupKey)}`;
  switch (key) {
    case "id":          return `(${count})`;
    case "tier": {
      if (g.minTier === null) return "";
      if (g.minTier === g.maxTier)
        return `<span class="tier-badge tier-${g.minTier}" title="${esc(tierTitle(g.minTier))}">T${g.minTier}</span>`;
      return `<span class="tier-badge tier-${g.minTier}" title="${esc(tierTitle(g.minTier))}">T${g.minTier}</span>–<span class="tier-badge tier-${g.maxTier}" title="${esc(tierTitle(g.maxTier))}">T${g.maxTier}</span>`;
    }
    case "title": {
      if (titleLabel !== undefined) {
        if (titleLabel === null) return "";
        const badge = (!idVisible && !instVisible) ? `(${count}) ` : "";
        return `${badge}${esc(titleLabel)}`;
      }
      return instVisible ? "" : groupLabel;
    }
    case "institution": return `${countPrefix}${esc(groupKey)}`;
    case "country":     return g.country ? esc(countryName(g.country)) : "";
    case "city":        return g.city ? esc(g.city) : "";
    case "deadline":    return g.deadline
      ? `<span title="${esc(g.deadlineTooltip)}">${fmtDate(g.deadline)}</span>` : "";
    case "duration":    return g.durStr || "";
    case "period":      return g.periodStr || "";
    case "stipend":     return g.stipend === "yes" ? "Yes" : g.stipend === "no" ? "—" : "";
    case "cost":        return g.uniformCost != null ? esc(g.uniformCost) : "";
    case "eligibility": return g.eligibility
      ? `<span class="eligib eligib-${g.eligibility}">${esc(g.eligibility)}</span>` : "";
    case "scope":       return g.scope ? esc(g.scope.replace(/_/g, " ")) : "";
    case "class": {
      if (g.uniformClass)
        return `<span class="opp-class opp-class-${g.uniformClass}">${esc(g.uniformClass.replace(/_/g, " "))}</span>`;
      return g.classStr ? esc(g.classStr) : "";
    }
    case "type":
      if (!g.uniformType) return "";
      return `<span class="opp-type opp-type-${g.uniformType}">${esc(g.uniformType.replace(/_/g, " "))}</span>`;
    case "added_by":      return g.extractionModel ? (fmtModel(g.extractionModel) || "") : "";
    case "recurring":     return g.recurring === "yes" ? "Yes" : "";
    case "status":        return g.status ? esc(g.status) : "";
    case "added":         return g.dateAdded ? fmtDate(g.dateAdded) : "";
    case "source":        return g.sourceUniform ? esc(g.sourceUniform.replace(/_/g, " ")) : "";
    case "working_lang":  return g.workingLang ? esc(g.workingLang) : "";
    default:              return "";
  }
}

function renderTable(data) {
  const cols = visibleColumns();
  const colCount = cols.length;

  document.getElementById("opp-table").style.tableLayout = "";

  const hasGcol = groupByInstitution || groupBySimilar;
  const hasGcol2 = groupByInstitution && groupBySimilar;

  const gcolTh = hasGcol ? `<th class="gcol"></th>` : "";
  const gcol2Th = hasGcol2 ? `<th class="gcol2"></th>` : "";
  document.querySelector("#opp-table thead tr").innerHTML = gcolTh + gcol2Th +
    cols.map(c => {
      const isSorted = sortBy === c.key;
      const ind = isSorted ? (sortDir === "asc" ? " ▲" : " ▼") : "";
      return `<th class="sortable${isSorted ? " sorted" : ""}" data-col="${c.key}">${c.label}${ind}</th>`;
    }).join("");
  document.querySelectorAll("#opp-table thead th.sortable").forEach(th => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (sortBy === col) { sortDir = sortDir === "asc" ? "desc" : "asc"; }
      else { sortBy = col; sortDir = "asc"; }
      localStorage.setItem(LS_SORT_KEY, JSON.stringify({ by: sortBy, dir: sortDir }));
      loadOpportunities(1);
    });
  });

  const tbody = document.getElementById("opp-tbody");
  tbody.innerHTML = "";
  const total_pages = Math.ceil(data.total / data.per_page);
  document.getElementById("result-info").textContent =
    `${data.total} result${data.total !== 1 ? "s" : ""} — page ${data.page} of ${total_pages || 1}`;

  const totalCols = colCount + (hasGcol ? 1 : 0) + (hasGcol2 ? 1 : 0);

  if (data.items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${totalCols}" style="padding:16px;color:#666">No results.</td></tr>`;
    renderPagination(data);
    return;
  }

  function _normalizeForUniformCompare(s) {
    return _normalizeDashes(s).replace(/\s+/g, " ").trim();
  }

  function computeUniformColumnKeys(items) {
    if (items.length < 2) return new Set();
    const keys = new Set();
    for (const c of cols) {
      if (c.key === "id") continue;
      const first = _normalizeForUniformCompare(renderCell(c.key, items[0]));
      if (items.every(o => _normalizeForUniformCompare(renderCell(c.key, o)) === first)) keys.add(c.key);
    }
    return keys;
  }

  function clusterTitleOrNull(items) {
    const first = _normalizeForUniformCompare(renderCell("title", items[0]));
    return items.every(o => _normalizeForUniformCompare(renderCell("title", o)) === first)
      ? items[0].title : null;
  }

  function appendOppRow(opp, level, uniformKeys) {
    level = level || 0;
    uniformKeys = uniformKeys || new Set();
    const tier = opp.manual_tier || opp.llm_tier;
    const tr = document.createElement("tr");
    tr.className = `tier-row tier-${tier} scope-${(opp.scope || "").replace(/_/g, "-")}`;
    if (opp.flagged) tr.classList.add("flagged");
    if (opp.hard_data_mismatch) tr.classList.add("mismatch");
    if (level >= 1) tr.classList.add("group-child");
    if (level >= 2) tr.classList.add("sub-child");

    const gcolTd = hasGcol ? `<td class="gcol${level >= 1 ? "-indent" : ""}"></td>` : "";
    const gcol2Td = hasGcol2 ? `<td class="gcol2${level >= 1 ? "-indent" : ""}"></td>` : "";
    const firstColExtra = level === 0 ? "" : level === 1 ? " gc-first" : " gc-first gc-first-2";

    tr.innerHTML = gcolTd + gcol2Td + cols.map((c, i) =>
      `<td class="col-${c.key}${i === 0 ? firstColExtra : ""}"><div class="cell-content">${uniformKeys.has(c.key) ? "" : renderCell(c.key, opp)}</div></td>`
    ).join("");
    tr.style.cursor = "pointer";
    tr.addEventListener("click", () => openDetail(opp.id, true));
    tbody.appendChild(tr);
    tr.querySelectorAll("td").forEach(td => {
      const text = td.textContent.trim();
      if (text && text !== "—") td.title = text;
    });
    let llmTr = null;
    if (showLlmOutput) {
      llmTr = document.createElement("tr");
      llmTr.className = `llm-row tier-${tier}${level >= 1 ? " group-child" : ""}${level >= 2 ? " sub-child" : ""}`;
      llmTr.innerHTML = gcolTd + gcol2Td + `<td colspan="${colCount}" class="${firstColExtra.trim()}">${renderLlmRow(opp)}</td>`;
      tbody.appendChild(llmTr);
    }
    return { tr, llmTr };
  }

  function renderTopGroupHeader(key, items, label, titleLabel) {
    const expanded = _expandedGroups.has(key);
    const g = computeGroupData(items);
    const chevron = expanded ? "▼" : "▶";
    const minTier = items.reduce((m, i) => {
      const t = i.manual_tier || i.llm_tier; return t && t < m ? t : m;
    }, 9);
    const gcol2Td = hasGcol2 ? `<td class="gcol2"></td>` : "";
    const hdr = document.createElement("tr");
    hdr.className = `group-hdr tier-${minTier}${expanded ? " expanded" : ""}`;
    hdr.innerHTML = `<td class="gcol group-chevron">${chevron}</td>` + gcol2Td +
      cols.map(c =>
        `<td class="col-${c.key}"><div class="cell-content">${renderGroupCell(c.key, g, label, items.length, titleLabel)}</div></td>`
      ).join("");
    hdr.addEventListener("click", () => toggleGroup(key));
    tbody.appendChild(hdr);
    return expanded;
  }

  function setCollapseArrow(lastRows, cellClass, arrowClass, toggleFn, key) {
    if (!lastRows) return;
    const { tr: lastRow, llmTr: lastLlmTr } = lastRows;
    const cell = lastRow.querySelector(`td.${cellClass}`);
    if (cell) {
      cell.className = `${arrowClass} group-chevron collapse-arrow`;
      cell.textContent = "▲";
      cell.style.cursor = "pointer";
      cell.addEventListener("click", e => { e.stopPropagation(); toggleFn(key); });
    }
    (lastLlmTr || lastRow).classList.add("group-last");
  }

  if (!hasGcol) {
    data.items.forEach(opp => appendOppRow(opp, 0));
  } else if (groupByInstitution && !groupBySimilar) {
    const groupOrder = [];
    const groupItems = new Map();
    for (const opp of data.items) {
      const key = opp.institution || "—";
      if (!groupItems.has(key)) { groupItems.set(key, []); groupOrder.push(key); }
      groupItems.get(key).push(opp);
    }
    for (const key of groupOrder) {
      const items = groupItems.get(key);
      if (items.length === 1) { appendOppRow(items[0], 0); continue; }
      const expanded = renderTopGroupHeader(key, items, key);
      if (expanded) {
        const uniformKeys = computeUniformColumnKeys(items);
        let lastRows;
        items.forEach(opp => { lastRows = appendOppRow(opp, 1, uniformKeys); });
        setCollapseArrow(lastRows, "gcol-indent", "gcol", toggleGroup, key);
      }
    }
  } else if (!groupByInstitution && groupBySimilar) {
    const plan = clusterRowPlan(data.items);
    for (const entry of plan) {
      if (entry.type === "single") { appendOppRow(entry.opp, 0); continue; }
      const label = entry.items[0].institution || "—";
      const titleLabel = clusterTitleOrNull(entry.items);
      const expanded = renderTopGroupHeader(entry.key, entry.items, label, titleLabel);
      if (expanded) {
        const uniformKeys = computeUniformColumnKeys(entry.items);
        let lastRows;
        entry.items.forEach(opp => { lastRows = appendOppRow(opp, 1, uniformKeys); });
        setCollapseArrow(lastRows, "gcol-indent", "gcol", toggleGroup, entry.key);
      }
    }
  } else {
    const groupOrder = [];
    const groupItems = new Map();
    for (const opp of data.items) {
      const key = opp.institution || "—";
      if (!groupItems.has(key)) { groupItems.set(key, []); groupOrder.push(key); }
      groupItems.get(key).push(opp);
    }
    const idVisible = visibleColumns().some(c => c.key === "id");
    const instVisible = visibleColumns().some(c => c.key === "institution");

    for (const key of groupOrder) {
      const items = groupItems.get(key);
      if (items.length === 1) { appendOppRow(items[0], 0); continue; }
      const expanded = renderTopGroupHeader(key, items, key);
      if (!expanded) continue;

      const instUniformKeys = computeUniformColumnKeys(items);
      const plan = clusterRowPlan(items);
      let outerLastRows;
      for (const entry of plan) {
        if (entry.type === "single") {
          outerLastRows = appendOppRow(entry.opp, 1, instUniformKeys);
          continue;
        }
        const subKey = entry.key;
        if (plan.length === 1 && !_subDefaultApplied.has(subKey)) {
          _subDefaultApplied.add(subKey);
          saveSubDefaultApplied();
          _expandedSubgroups.add(subKey);
          saveExpandedSubgroups();
        }
        const subExpanded = _expandedSubgroups.has(subKey);
        const sg = computeGroupData(entry.items);
        const label = clusterTitleOrNull(entry.items);
        const subMinTier = entry.items.reduce((m, i) => {
          const t = i.manual_tier || i.llm_tier; return t && t < m ? t : m;
        }, 9);
        const subChevron = subExpanded ? "▼" : "▶";

        const subHdr = document.createElement("tr");
        subHdr.className = `group-hdr subgroup-hdr group-child tier-${subMinTier}${subExpanded ? " expanded" : ""}`;
        subHdr.innerHTML = `<td class="gcol-indent"></td>` +
          `<td class="gcol2 group-chevron">${subChevron}</td>` +
          cols.map((c, i) =>
            `<td class="col-${c.key}${i === 0 ? " gc-first" : ""}"><div class="cell-content">${renderSubgroupCell(c.key, sg, label, entry.items.length, idVisible, instVisible)}</div></td>`
          ).join("");
        subHdr.addEventListener("click", () => toggleSubgroup(subKey));
        tbody.appendChild(subHdr);
        outerLastRows = { tr: subHdr, llmTr: null };

        if (subExpanded) {
          const clusterUniformKeys = computeUniformColumnKeys(entry.items);
          let subLastRows;
          entry.items.forEach(o => { subLastRows = appendOppRow(o, 2, clusterUniformKeys); });
          setCollapseArrow(subLastRows, "gcol2-indent", "gcol2", toggleSubgroup, subKey);
          outerLastRows = subLastRows;
        }
      }
      setCollapseArrow(outerLastRows, "gcol-indent", "gcol", toggleGroup, key);
    }
  }

  renderPagination(data);
  initColumnResize();
  updateScrollMirror();
}

function renderLlmRow(opp) {
  const parts = [];

  if (opp.llm_tier_note) {
    parts.push(`<span class="llm-label">Tier note:</span> ${esc(opp.llm_tier_note)}`);
  }
  if (opp.competitiveness_note) {
    parts.push(`<span class="llm-label">Competitive note:</span> ${esc(opp.competitiveness_note)}`);
  }

  const ambs = parseJsonField(opp.ambiguities);
  if (ambs && ambs.length) {
    ambs.forEach(a => parts.push(`<span class="llm-label">Ambiguity:</span> ${esc(a)}`));
  }

  if (!parts.length) {
    return `<div class="llm-row-inner llm-row-empty">No LLM evidence stored — open record for details.</div>`;
  }
  return `<div class="llm-row-inner">${parts.map(p => `<div class="llm-seg">${p}</div>`).join("")}</div>`;
}

function parseJsonField(val) {
  if (!val) return null;
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch { return null; }
}

function renderPagination(data) {
  const total_pages = Math.ceil(data.total / data.per_page);
  const el = document.getElementById("pagination");
  if (total_pages <= 1) { el.innerHTML = ""; return; }
  let html = "";
  if (data.page > 1)
    html += `<button onclick="loadOpportunities(${data.page - 1})">&#8592; Prev</button> `;
  html += `Page ${data.page} / ${total_pages}`;
  if (data.page < total_pages)
    html += ` <button onclick="loadOpportunities(${data.page + 1})">Next &#8594;</button>`;
  el.innerHTML = html;
}


// ── Filters ───────────────────────────────────────────────────────────────────

function buildColumnPicker() {
  const panel = document.getElementById("col-picker-panel");
  panel.innerHTML = COLUMNS.map(c => `
    <label>
      <input type="checkbox" data-col="${c.key}" ${activeColumns.has(c.key) ? "checked" : ""}>
      ${c.label}
    </label>`).join("");

  panel.querySelectorAll("input[type=checkbox]").forEach(cb => {
    cb.addEventListener("change", () => {
      if (cb.checked) activeColumns.add(cb.dataset.col);
      else activeColumns.delete(cb.dataset.col);
      saveActiveColumns();
      if (lastResult) renderTable(lastResult);
    });
  });
}

function bindFilters() {
  document.getElementById("btn-apply").addEventListener("click", applyFilters);
  document.getElementById("btn-reset").addEventListener("click", resetFilters);
  document.getElementById("f-llm-output").checked = showLlmOutput;

  ["f-tier", "f-scope", "f-eligibility", "f-app-fee", "f-dl-before", "f-source", "f-opp-class", "f-flagged", "f-source-language"].forEach(id => {
    document.getElementById(id).addEventListener("change", applyFilters);
  });

  ["f-search", "f-country", "f-max-cost"].forEach(id => {
    document.getElementById(id).addEventListener("keydown", e => {
      if (e.key === "Enter") applyFilters();
    });
  });

  document.getElementById("f-llm-output").addEventListener("change", (e) => {
    showLlmOutput = e.target.checked;
    try { localStorage.setItem("artdb_llm_output", showLlmOutput ? "1" : "0"); } catch {}
    if (lastResult) renderTable(lastResult);
    if (_detailOpp) { renderDetail(_detailOpp); updateDetailNav(); }
  });

  const groupCb = document.getElementById("f-group");
  groupCb.checked = groupByInstitution;
  groupCb.addEventListener("change", (e) => {
    groupByInstitution = e.target.checked;
    saveGroupState();
    if (lastResult) renderTable(lastResult);
  });

  const groupSimilarCb = document.getElementById("f-group-similar");
  groupSimilarCb.checked = groupBySimilar;
  groupSimilarCb.addEventListener("change", (e) => {
    groupBySimilar = e.target.checked;
    saveGroupSimilarState();
    if (lastResult) renderTable(lastResult);
  });

  document.getElementById("btn-back").addEventListener("click", () => history.back());
  document.getElementById("btn-prev-opp").addEventListener("click", () => navDetail(-1));
  document.getElementById("btn-next-opp").addEventListener("click", () => navDetail(1));
  document.getElementById("nav-llm-output").addEventListener("change", (e) => toggleDetailLlm(e.target.checked));
  document.getElementById("nav-edit-fields").addEventListener("change", (e) => toggleEditFields(e.target.checked));
  document.addEventListener("keydown", e => {
    if (document.getElementById("detail-view").classList.contains("hidden")) return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
    if (e.key === "ArrowRight") { e.preventDefault(); navDetail(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); navDetail(-1); }
  });
  window.addEventListener("popstate", (e) => {
    if (!e.state || !e.state.detail) showList();
  });

  const btn = document.getElementById("btn-columns");
  const panel = document.getElementById("col-picker-panel");
  buildColumnPicker();
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = panel.classList.contains("hidden");
    panel.classList.toggle("hidden");
    if (isHidden) {
      const r = btn.getBoundingClientRect();
      panel.style.top  = (r.bottom + 4) + "px";
      panel.style.right = (window.innerWidth - r.right) + "px";
    }
  });
  document.addEventListener("click", () => panel.classList.add("hidden"));
  panel.addEventListener("click", (e) => e.stopPropagation());
}

function applyFilters() {
  currentFilters = {
    tier:           document.getElementById("f-tier").value,
    scope:          document.getElementById("f-scope").value,
    eligibility:    document.getElementById("f-eligibility").value || "not_ineligible",
    country:        countryCode(document.getElementById("f-country").value),
    deadline_before:document.getElementById("f-dl-before").value,
    search:         document.getElementById("f-search").value,
    app_fee:        document.getElementById("f-app-fee").value,
    cost:           document.getElementById("f-cost").value,
    max_cost:       document.getElementById("f-max-cost").value,
    source:         document.getElementById("f-source").value,
    opp_class:      document.getElementById("f-opp-class").value,
    flagged:        document.getElementById("f-flagged").value,
    mismatch:       document.getElementById("f-mismatch").value,
    source_language: document.getElementById("f-source-language").value,
  };
  loadOpportunities(1);
}

function resetFilters() {
  ["f-tier","f-scope","f-country","f-dl-before","f-search","f-max-cost","f-source","f-opp-class","f-flagged","f-mismatch","f-source-language"].forEach(id => {
    document.getElementById(id).value = "";
  });
  document.getElementById("f-eligibility").value = "not_ineligible";
  document.getElementById("f-app-fee").value = "";
  document.getElementById("f-cost").value = "";
  currentFilters = { eligibility: "not_ineligible" };
  sortBy = null;
  sortDir = "asc";
  localStorage.removeItem(LS_SORT_KEY);
  loadOpportunities(1);
}


// ── Detail view ───────────────────────────────────────────────────────────────

async function fetchOpportunity(id) {
  const rows = await q(`SELECT o.*, i.canonical_name AS institution_name FROM opportunities o LEFT JOIN institutions i ON o.institution_id = i.id WHERE o.id = ?`, [id]);
  if (!rows.length) return null;
  const d = rows[0];
  for (const field of ["discipline_tags", "eligibility_other", "prestige_signals", "ambiguities", "low_quality_flags", "llm_output_json"]) {
    if (d[field] && typeof d[field] === "string") {
      try { d[field] = JSON.parse(d[field]); } catch (_) {}
    }
  }
  return d;
}

async function fetchFilteredIds(filters) {
  const { where, params } = _buildWhere(filters);
  const sortKey = filters.sort_by || "";
  const sortCol = _SORT_COLS[sortKey] || "COALESCE(o.manual_tier, o.llm_tier)";
  const dir = filters.sort_dir === "desc" ? "DESC" : "ASC";
  const order = (sortKey && sortKey !== "tier")
    ? `${sortCol} ${dir}, COALESCE(o.manual_tier, o.llm_tier) ASC`
    : `COALESCE(o.manual_tier, o.llm_tier) ${dir}, o.deadline ASC`;
  const rows = await q(`SELECT o.id FROM opportunities o ${_JOINS} WHERE ${where} ORDER BY ${order}`, params);
  return rows.map(r => r.id);
}

async function openDetail(id, fromList) {
  try {
    const opp = await fetchOpportunity(id);
    if (!opp) throw new Error("not found");
    if (fromList) {
      _detailPanelMode = null;
    }
    if (fromList && lastResult) {
      _detailIdList = lastResult.items.map(o => o.id);
      _detailIndex = _detailIdList.indexOf(id);
      const filters = { ...currentFilters };
      if (sortBy) { filters.sort_by = sortBy; filters.sort_dir = sortDir; }
      fetchFilteredIds(filters).then(ids => {
        _detailIdList = ids;
        _detailIndex = _detailIdList.indexOf(id);
        updateDetailNav();
      }).catch(() => {});
    } else {
      const idx = _detailIdList.indexOf(id);
      if (idx !== -1) _detailIndex = idx;
    }
    history.pushState({ view: "detail", detail: id }, "", `#${id}`);
    showView("detail");
    renderDetail(opp);
    updateDetailNav();
    window.scrollTo(0, 0);
  } catch (e) {
    alert("Could not load opportunity: " + e.message);
  }
}

function updateDetailNav() {
  const pos = document.getElementById("detail-nav-pos");
  const prev = document.getElementById("btn-prev-opp");
  const next = document.getElementById("btn-next-opp");
  const llmCb = document.getElementById("nav-llm-output");
  if (llmCb) llmCb.checked = showLlmOutput;
  const editCb = document.getElementById("nav-edit-fields");
  if (editCb) editCb.checked = editFieldsMode;
  if (!pos || !prev || !next) return;
  if (_detailIdList.length && _detailIndex !== -1) {
    pos.textContent = `${_detailIndex + 1} / ${_detailIdList.length}`;
    prev.disabled = _detailIndex <= 0;
    next.disabled = _detailIndex >= _detailIdList.length - 1;
  } else {
    pos.textContent = "";
    prev.disabled = true;
    next.disabled = true;
  }
}

async function navDetail(delta) {
  const savedScroll = window.scrollY;
  const newIdx = _detailIndex + delta;
  if (newIdx < 0 || newIdx >= _detailIdList.length) return;
  _detailIndex = newIdx;
  await openDetail(_detailIdList[newIdx]);
  requestAnimationFrame(() => window.scrollTo(0, savedScroll));
}

function toggleDetailLlm(checked) {
  showLlmOutput = checked;
  try { localStorage.setItem("artdb_llm_output", checked ? "1" : "0"); } catch {}
  const tableCheckbox = document.getElementById("f-llm-output");
  if (tableCheckbox) tableCheckbox.checked = checked;
  if (!checked) _detailPanelMode = null;
  renderDetail(_detailOpp);
  updateDetailNav();
}

function toggleEditFields(checked) {
  editFieldsMode = checked;
  renderDetail(_detailOpp);
  updateDetailNav();
}

function showList() {
  showView("list");
  loadStats();
}

function renderProvenance(dc) {
  if (!dc) return "";
  const ctx = typeof dc === "string" ? (() => { try { return JSON.parse(dc); } catch { return null; } })() : dc;
  if (!ctx) return "";
  let text = "";
  if (ctx.facets && Object.keys(ctx.facets).length) {
    const parts = [];
    if (ctx.facets.foerderart) parts.push("Type: " + ctx.facets.foerderart.join(", "));
    if (ctx.facets.sparte) parts.push("Field: " + ctx.facets.sparte.join(", "));
    if (ctx.facets.wohnort) parts.push("Location: " + ctx.facets.wohnort.join(", "));
    if (ctx.source) parts.push("via " + ctx.source);
    text = parts.join(" · ");
  } else if (ctx.query) {
    const snippet = ctx.snippet ? ` — "${ctx.snippet.slice(0, 120)}"` : "";
    const mode = (ctx.mode || "researcher").replace(/_/g, " ");
    text = `${mode}: ${ctx.query}${snippet}`;
  }
  if (!text) return "";
  return `<section class="provenance-box"><div class="section-label">Found via</div><p>${esc(text)}</p></section>`;
}

function renderLowQualityFlags(flags) {
  if (!flags || !flags.length) return "";
  const badges = flags.map(f => `<span class="lqf-badge">${esc(f.replace(/_/g, " "))}</span>`).join(" ");
  return `<div class="lqf-row">${badges}</div>`;
}

let _detailOpp = null;

function openDetailPanel(mode) {
  _detailPanelMode = mode;
  renderRightPanel();
}

function closeDetailPanel() {
  _detailPanelMode = null;
  renderRightPanel();
}

function renderRightPanel() {
  const container = document.getElementById("detail-right-content");
  const handle = document.getElementById("detail-resize-handle");
  const right = document.querySelector(".detail-right");
  if (!container) return;

  const hasContent = _detailPanelMode && _detailOpp;
  const showPlaceholder = showLlmOutput && !hasContent;

  if (handle) handle.style.visibility = hasContent ? "visible" : "hidden";
  if (right) {
    right.style.borderLeft = hasContent ? "2px solid #e2e8f0" : "none";
    right.style.paddingLeft = hasContent ? "12px" : "0";
  }

  if (!hasContent) {
    container.innerHTML = showPlaceholder ? `
      <div class="right-panel-placeholder">
        <button class="panel-open-btn" onclick="openDetailPanel('source')">Source text</button>
        <button class="panel-open-btn" onclick="openDetailPanel('llm')">LLM output</button>
      </div>` : "";
    return;
  }
  const otherMode = _detailPanelMode === "source" ? "llm" : "source";
  const otherLabel = _detailPanelMode === "source" ? "LLM output" : "Source text";
  let body;
  if (_detailPanelMode === "source") {
    const txt = _detailOpp.raw_scraped_text;
    body = txt ? `<pre class="raw-text">${esc(txt)}</pre>` : `<p class="panel-empty">No scraped text stored.</p>`;
  } else {
    body = renderLlmPanel(_detailOpp);
  }
  container.innerHTML = `
    <div class="detail-right-header">
      <button class="panel-switch-btn" onclick="openDetailPanel('${otherMode}')">${otherLabel}</button>
      <button class="panel-switch-btn" onclick="closeDetailPanel()">close</button>
    </div>
    ${body}`;
}

function renderLlmPanel(opp) {
  const llm = opp.llm_output_json;
  if (!llm) {
    return `<p class="panel-note">Raw LLM output not stored for this record (ingested before v014).</p>`;
  }
  return `<pre class="raw-text">${esc(JSON.stringify(llm, null, 2))}</pre>`;
}

function initDetailResize() {
  const handle = document.getElementById("detail-resize-handle");
  const left = document.querySelector(".detail-left");
  if (!handle || !left) return;
  let startX, startW;
  handle.addEventListener("mousedown", e => {
    startX = e.clientX;
    startW = left.getBoundingClientRect().width;
    const onMove = e2 => {
      const w = Math.max(320, Math.min(900, startW + (e2.clientX - startX)));
      _detailLeftWidth = w;
      left.style.flex = `0 0 ${w}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  });
}

const _MONETARY_GET_KINDS = new Set(["stipend","prize_money","production_budget","travel_allowance"]);

function _costKindLabel(kind, oppClass) {
  if (kind === "participation_cost") return oppClass === "residency" ? "Residency fee" : "Participation fee";
  if (kind === "materials_cost") return "Materials cost";
  return (kind || "cost").replace(/_/g, " ");
}

const _OBLIGATION_KINDS = new Set([
  "deliverable_project", "deliverable_workshop", "deliverable_exhibition",
  "relocation", "other",
]);

function _obligationKindLabel(kind) {
  if (kind === "deliverable_project") return "Deliverable: project";
  if (kind === "deliverable_workshop") return "Deliverable: workshop";
  if (kind === "deliverable_exhibition") return "Deliverable: exhibition";
  if (kind === "relocation") return "Relocation";
  return "Other";
}

function fmtBenefits(opp) {
  const raw = opp.llm_output_json;
  if (!raw || !Array.isArray(raw.get)) return null;
  const items = raw.get.filter(it => it.kind && !_MONETARY_GET_KINDS.has(it.kind));
  if (!items.length) return null;
  return items.map(it => it.kind.replace(/_/g, " ")).join(", ");
}

function llmBenefitsHtml(llm) {
  if (!llm || !Array.isArray(llm.get) || !llm.get.length) return "";
  const entries = llm.get.filter(it => it.kind && !_MONETARY_GET_KINDS.has(it.kind));
  if (!entries.length) return "";
  return entries.map(it => {
    const label = (it.kind || "").replace(/_/g, " ");
    const q = it.quote ? `<em class="cell-ev-quote">"${esc(it.quote)}"</em>` : "";
    const cond = it.conditions ? ` <span class="cell-ev-cond">(${esc(it.conditions)})</span>` : "";
    return `<span class="cell-ev-item"><b>${esc(label)}</b>: ${q}${cond}</span>`;
  }).join("");
}

function fmtObligations(opp) {
  const raw = opp.llm_output_json;
  if (raw && Array.isArray(raw.give)) {
    const items = raw.give.filter(it => it.kind && _OBLIGATION_KINDS.has(it.kind));
    if (items.length) return items.map(it => _obligationKindLabel(it.kind)).join(", ");
  }
  return opp.obligations_description || null;
}

function llmObligationsHtml(llm) {
  if (!llm || !Array.isArray(llm.give) || !llm.give.length) return "";
  const entries = llm.give.filter(it => it.kind && _OBLIGATION_KINDS.has(it.kind));
  if (!entries.length) return "";
  return entries.map(it => {
    const label = _obligationKindLabel(it.kind);
    const amtPart = it.amount != null
      ? ` ${it.amount}${it.currency ? " " + it.currency : ""}${it.basis && it.basis !== "unstated" ? " / " + it.basis.replace(/_/g, " ") : ""}`
      : "";
    const q = it.quote ? `<em class="cell-ev-quote">"${esc(it.quote)}"</em>` : "";
    const cond = it.conditions ? ` <span class="cell-ev-cond">(${esc(it.conditions)})</span>` : "";
    return `<span class="cell-ev-item"><b>${esc(label)}${esc(amtPart)}</b>: ${q}${cond}</span>`;
  }).join("");
}

function llmGetHtml(llm) {
  if (!llm || !Array.isArray(llm.get) || !llm.get.length) return "";
  const entries = llm.get.filter(it => _MONETARY_GET_KINDS.has(it.kind));
  if (!entries.length) return "";
  return entries.map(it => {
    const label = (it.kind || "").replace(/_/g, " ");
    const amtPart = it.amount != null
      ? ` ${it.amount}${it.currency ? " " + it.currency : ""}${it.basis ? " / " + it.basis.replace(/_/g, " ") : ""}${it.qualifier && it.qualifier !== "exact" ? " (" + it.qualifier + ")" : ""}`
      : "";
    const q = it.quote ? `<em class="cell-ev-quote">"${esc(it.quote)}"</em>` : "";
    const cond = it.conditions ? ` <span class="cell-ev-cond">(${esc(it.conditions)})</span>` : "";
    return `<span class="cell-ev-item"><b>${esc(label)}${esc(amtPart)}</b>: ${q}${cond}</span>`;
  }).join("");
}

function llmFeeHtml(llm) {
  if (!llm || !Array.isArray(llm.give) || !llm.give.length) return "";
  const fees = llm.give.filter(it => it.kind === "application_fee");
  if (!fees.length) return "";
  return fees.map(it => {
    const amtPart = it.amount != null
      ? ` ${it.amount}${it.currency ? " " + it.currency : ""}`
      : "";
    const q = it.quote ? `<em class="cell-ev-quote">"${esc(it.quote)}"</em>` : "";
    return `<span class="cell-ev-item"><b>application fee${esc(amtPart)}</b>: ${q}</span>`;
  }).join("");
}

function llmCostHtml(llm, oppClass) {
  if (!llm || !Array.isArray(llm.give) || !llm.give.length) return "";
  const costs = llm.give.filter(it => it.kind === "participation_cost" || it.kind === "materials_cost");
  if (!costs.length) return "";
  return costs.map(it => {
    const label = _costKindLabel(it.kind, oppClass);
    const amtPart = it.amount != null
      ? ` ${it.amount}${it.currency ? " " + it.currency : ""}${it.basis ? " / " + it.basis.replace(/_/g, " ") : ""}`
      : "";
    const q = it.quote ? `<em class="cell-ev-quote">"${esc(it.quote)}"</em>` : "";
    const lvl = it.cost_level ? ` <span class="cell-ev-tag">${esc(it.cost_level)}</span>` : "";
    return `<span class="cell-ev-item"><b>${esc(label)}${esc(amtPart)}</b>${lvl}: ${q}</span>`;
  }).join("");
}

function fmtCostCalculated(opp) {
  const raw = opp.llm_output_json;
  if (!raw || !Array.isArray(raw.give)) return null;
  const costs = raw.give.filter(it =>
    (it.kind === "participation_cost" || it.kind === "materials_cost") && it.amount != null
  );
  if (!costs.length) return null;

  const monthly = [];
  for (const it of costs) {
    let m = null;
    if (it.basis === "per_month") m = it.amount;
    else if (it.basis === "per_week") m = it.amount * (52 / 12);
    else if (it.basis === "per_day") m = it.amount * 30;
    else if (it.basis === "total" && it.period_value && it.period_unit) {
      if (it.period_unit === "week")  m = (it.amount / it.period_value) * (52 / 12);
      else if (it.period_unit === "month") m = it.amount / it.period_value;
      else if (it.period_unit === "day")   m = (it.amount / it.period_value) * 30;
    }
    if (m != null) monthly.push({ amount: m, currency: it.currency || "" });
  }
  if (!monthly.length) return null;

  const byCur = {};
  monthly.forEach(({ amount, currency }) => (byCur[currency] = byCur[currency] || []).push(amount));
  return Object.entries(byCur).map(([cur, amounts]) => {
    const sorted = amounts.slice().sort((a, b) => a - b);
    const lo = Math.round(sorted[0]);
    const hi = Math.round(sorted[sorted.length - 1]);
    const s = cur ? ` ${cur}` : "";
    return lo === hi ? `~${lo}${s}/mo` : `~${lo}–${hi}${s}/mo`;
  }).join(", ");
}

const _DEADLINE_DATE_ROLES = new Set(["application_deadline", "notification"]);

function _dateMentionItemHtml(it) {
  const label = (it.role || "date").replace(/_/g, " ");
  const dateVal = it.date || it.date_start || it.date_end;
  const valPart = dateVal ? ` → ${esc(dateVal)}` : "";
  const conf = it.precision && it.precision !== "exact" ? ` [${esc(it.precision)}]` : "";
  const q = it.quote ? `<em class="cell-ev-quote">"${esc(it.quote)}"</em>` : "";
  return `<span class="cell-ev-item"><b>${esc(label)}</b>${valPart}${conf}: ${q}</span>`;
}

function llmDeadlineHtml(llm) {
  if (!llm || !Array.isArray(llm.date_mentions) || !llm.date_mentions.length) return "";
  return llm.date_mentions.filter(it => _DEADLINE_DATE_ROLES.has(it.role)).map(_dateMentionItemHtml).join("");
}

function llmPeriodHtml(llm) {
  if (!llm || !Array.isArray(llm.date_mentions) || !llm.date_mentions.length) return "";
  return llm.date_mentions.filter(it => !_DEADLINE_DATE_ROLES.has(it.role)).map(_dateMentionItemHtml).join("");
}

function llmTierHtml(opp) {
  const parts = [];
  if (opp.llm_tier_confidence)
    parts.push(`<span class="cell-ev-item"><b>confidence:</b> ${esc(opp.llm_tier_confidence)}</span>`);
  if (opp.llm_tier_note)
    parts.push(`<span class="cell-ev-item"><b>note:</b> ${esc(opp.llm_tier_note)}</span>`);
  return parts.join("");
}

function llmClassSignalsHtml(opp) {
  const parts = [];
  if (opp.requires_physical_presence != null)
    parts.push(`<span class="cell-ev-item"><b>physical presence:</b> ${esc(String(opp.requires_physical_presence))}</span>`);
  if (opp.provides_space_or_housing != null)
    parts.push(`<span class="cell-ev-item"><b>space/housing:</b> ${esc(String(opp.provides_space_or_housing))}</span>`);
  if (opp.applicant_proposes_own_project != null)
    parts.push(`<span class="cell-ev-item"><b>own project:</b> ${esc(String(opp.applicant_proposes_own_project))}</span>`);
  if (opp.primary_benefit)
    parts.push(`<span class="cell-ev-item"><b>primary benefit:</b> ${esc(opp.primary_benefit.replace(/_/g, " "))}</span>`);
  if (opp.class_guess)
    parts.push(`<span class="cell-ev-item"><b>class guess:</b> ${esc(opp.class_guess.replace(/_/g, " "))}</span>`);
  if (opp.class_note)
    parts.push(`<span class="cell-ev-item">${esc(opp.class_note)}</span>`);
  return parts.join("");
}

function splitTopLevelMismatches(detail) {
  const items = [];
  let depth = 0, cur = '';
  for (let i = 0; i < detail.length; i++) {
    const ch = detail[i];
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (depth === 0 && detail.slice(i, i + 2) === '; ') {
      items.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
  }
  if (cur) items.push(cur);
  return items;
}

const _MM_SOURCE_LABELS = {
  prefilter: 'prefilter', extract: 'extraction', llm_guess: 'LLM guess', derived: 'derived (rule-based)',
};

function formatOneMismatch(detail) {
  const bracketIdx = detail.indexOf('[');
  const header = bracketIdx >= 0 ? detail.slice(0, bracketIdx).trim() : detail;
  const signals = bracketIdx >= 0 ? detail.slice(bracketIdx + 1).replace(/\]$/, '') : '';
  const colonIdx = header.indexOf(':');
  const rawType = colonIdx >= 0 ? header.slice(0, colonIdx).trim() : header.trim();
  const mtype = rawType.replace(/_/g, ' ');
  const rest = colonIdx >= 0 ? header.slice(colonIdx + 1).trim() : '';
  const vsParts = rest.split(' vs ');
  const lhsKey = vsParts[0] ? (vsParts[0].match(/^(\w+)=/) || [])[1] : '';
  const rhsKey = vsParts[1] ? (vsParts[1].match(/^(\w+)=/) || [])[1] : '';
  const lhs = vsParts[0] ? vsParts[0].replace(/^\w+=/, '').replace(/'/g, '') : '';
  const rhs = vsParts[1] ? vsParts[1].replace(/^\w+=/, '').replace(/'/g, '') : '';
  const lhsLabel = _MM_SOURCE_LABELS[lhsKey] || lhsKey;
  const rhsLabel = _MM_SOURCE_LABELS[rhsKey] || rhsKey;
  const compHtml = lhs && rhs
    ? `<div class="mm-compare">
         <span class="mm-side">${lhsLabel ? `<span class="mm-side-label">${esc(lhsLabel)}</span>` : ''}<span class="mm-lhs">${esc(lhs)}</span></span>
         <span class="mm-arrow">→</span>
         <span class="mm-side">${rhsLabel ? `<span class="mm-side-label">${esc(rhsLabel)}</span>` : ''}<span class="mm-rhs">${esc(rhs)}</span></span>
       </div>`
    : rest ? `<div class="mm-compare">${esc(rest)}</div>` : '';
  let sigHtml = '';
  let sigCaption = '';
  if (signals) {
    const items = [];
    let depth = 0, cur = '';
    for (const ch of signals) {
      if (ch === '[') { depth++; cur += ch; }
      else if (ch === ']') { depth--; cur += ch; }
      else if (ch === ',' && depth === 0) { items.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) items.push(cur.trim());
    sigHtml = items.map(s => {
      const eq = s.indexOf('=');
      const k = eq >= 0 ? s.slice(0, eq) : s;
      const v = eq >= 0 ? s.slice(eq + 1).replace(/^'|'$/g, '').replace(/^\[|\]$/g, '').replace(/'/g, '') : '';
      return `<li><span class="mm-key">${esc(k)}</span>${v ? ` <span class="mm-val">${esc(v)}</span>` : ''}</li>`;
    }).join('');
    if (rawType === 'class_mismatch') {
      sigCaption = `<div class="mm-sig-caption">extraction signals used to derive the class (not from prefilter)</div>`;
    }
  }
  return `<div class="mm-type">${esc(mtype)}</div>${compHtml}${sigHtml ? `${sigCaption}<ul class="mm-signals">${sigHtml}</ul>` : ''}`;
}

function formatMismatch(detail) {
  return splitTopLevelMismatches(detail).map(formatOneMismatch).join('<hr class="mm-sep">');
}

function llmRecurrenceHtml(llm) {
  if (!llm || !llm.recurring) return "";
  const r = llm.recurring;
  const parts = [];
  if (r.observations) parts.push(`<span class="cell-ev-item"><b>observations:</b> ${esc(r.observations)}</span>`);
  return parts.join("");
}

function cellE(label, val, evidenceHtml) {
  const ev = evidenceHtml ? `<div class="cell-ev">${evidenceHtml}</div>` : "";
  return `<div><b>${esc(label)}</b>${esc(val != null ? val : "—")}${ev}</div>`;
}

// ── Manual field editing ─────────────────────────────────────────────────────

const EDITABLE_FIELDS = {
  opportunity_class:   { type: "select", options: ["residency", "funding", "project_call", "other"] },
  class_note:          { type: "text" },
  opportunity_type:    { type: "select", options: ["residency", "open_call", "grant", "prize", "commission", "fellowship", "other"] },
  scope:               { type: "select", options: ["in_scope", "borderline", "out_of_scope"] },
  scope_note:          { type: "text" },
  deadline:            { type: "date" },
  deadline_type:       { type: "select", options: ["fixed", "rolling", "recurring", "unknown"] },
  deadline_confidence: { type: "select", options: ["exact", "approximate", "unknown"] },
  start_date:          { type: "date" },
  end_date:            { type: "date" },
  residency_period:    { type: "text", label: "Duration (stated)" },
  duration_weeks:      { type: "number" },
  stipend:             { type: "bool" },
  stipend_amount:      { type: "text" },
  pay_amount_value:    { type: "number" },
  pay_currency:        { type: "text" },
  pay_basis:           { type: "select", options: ["per_month", "per_week", "per_day", "total", "one_time", "unstated"] },
  pay_qualifier:       { type: "select", options: ["exact", "up_to", "at_least", "approx"] },
  has_application_fee: { type: "bool" },
  application_fee_amount: { type: "text" },
  fee_amount_value:    { type: "number" },
  fee_currency:        { type: "text" },
  has_cost:            { type: "bool" },
  cost_description:    { type: "text" },
  residency_cost_amount: { type: "number" },
  cost_amount_value:   { type: "number" },
  cost_currency:       { type: "text" },
  cost_basis:          { type: "select", options: ["per_month", "per_week", "per_day", "total", "one_time", "unstated"] },
  has_obligations:     { type: "bool" },
  obligations_description: { type: "text" },
  open_to:             { type: "text" },
  is_recurring:        { type: "bool" },
  recurrence_interval: { type: "select", options: ["annual", "biennial", "irregular", "unknown"] },
  discipline_tags:     { type: "list" },
  discipline_note:     { type: "text" },
  age_limit_type:      { type: "select", options: ["under", "over", "range", "none", "unknown"] },
  age_limit_value:     { type: "number" },
  age_limit_value_max: { type: "number" },
  age_note:            { type: "text" },
  eligibility_other:   { type: "list" },
  eligibility_note:    { type: "text" },
  eligibility_match:   { type: "select", options: ["eligible", "ineligible", "unknown"] },
  topics:              { type: "text" },
  target_audience:     { type: "text" },
  language_of_work:    { type: "text" },
  competitiveness_est: { type: "select", options: ["very_low", "low", "medium", "high", "very_high", "unknown"] },
  competitiveness_note: { type: "text" },
  country:             { type: "text" },
  city:                { type: "text" },
  status:              { type: "select", options: ["active", "expired", "archived", "duplicate", "suspicious"] },
};

function humanizeFieldKey(key) {
  const override = EDITABLE_FIELDS[key] && EDITABLE_FIELDS[key].label;
  if (override) return override;
  return key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function autoResizeField(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

function fieldEditInputHtml(key, value) {
  const meta = EDITABLE_FIELDS[key];
  const id = `e-f-${key}`;
  if (meta.type === "select") {
    const opts = [`<option value="">—</option>`].concat(
      meta.options.map(o => `<option value="${esc(o)}" ${value === o ? "selected" : ""}>${esc(o.replace(/_/g, " "))}</option>`)
    );
    return `<select id="${id}" class="field-edit-input">${opts.join("")}</select>`;
  }
  if (meta.type === "bool") {
    const v = value == null ? "" : value ? "1" : "0";
    return `<select id="${id}" class="field-edit-input">
      <option value="" ${v === "" ? "selected" : ""}>Unknown</option>
      <option value="1" ${v === "1" ? "selected" : ""}>Yes</option>
      <option value="0" ${v === "0" ? "selected" : ""}>No</option>
    </select>`;
  }
  if (meta.type === "list") {
    const arr = Array.isArray(value) ? value : (parseJsonField(value) || []);
    return `<input type="text" id="${id}" class="field-edit-input" value="${esc(arr.join(", "))}" placeholder="comma-separated">`;
  }
  if (meta.type === "number") {
    return `<input type="number" id="${id}" class="field-edit-input" value="${value != null ? esc(String(value)) : ""}" step="any">`;
  }
  if (meta.type === "date") {
    return `<input type="date" id="${id}" class="field-edit-input" value="${value ? esc(String(value).slice(0, 10)) : ""}">`;
  }
  return `<textarea id="${id}" class="field-edit-input field-edit-textarea" rows="1" oninput="autoResizeField(this)">${esc(value != null ? value : "")}</textarea>`;
}

function renderEditableGrid(opp) {
  return Object.keys(EDITABLE_FIELDS).map(key =>
    `<div class="field-edit-cell"><b>${esc(humanizeFieldKey(key))}</b>${fieldEditInputHtml(key, opp[key])}</div>`
  ).join("");
}

function collectEditedFields() {
  const payload = {};
  for (const [key, meta] of Object.entries(EDITABLE_FIELDS)) {
    const el = document.getElementById(`e-f-${key}`);
    if (!el) continue;
    const v = el.value;
    if (meta.type === "bool") payload[key] = v === "" ? null : v === "1";
    else if (meta.type === "number") payload[key] = v === "" ? null : Number(v);
    else if (meta.type === "list") payload[key] = v.trim() ? v.split(",").map(s => s.trim()).filter(Boolean) : null;
    else payload[key] = v || null;
  }
  return payload;
}

function renderDetail(opp) {
  _detailOpp = opp;
  const tier = opp.manual_tier || opp.llm_tier;
  const tags = fmtList(opp.discipline_tags);
  const elig_other = fmtList(opp.eligibility_other);
  const lqfHtml = renderLowQualityFlags(opp.low_quality_flags);
  const llm = showLlmOutput ? (opp.llm_output_json || null) : null;
  const ambs = parseJsonField(opp.ambiguities);
  const prestige = parseJsonField(opp.prestige_signals);

  const payStr = opp.pay_amount_value != null
    ? `${opp.pay_amount_value} ${opp.pay_currency || ""}${opp.pay_basis ? " / " + opp.pay_basis.replace(/_/g, " ") : ""}${opp.pay_qualifier && opp.pay_qualifier !== "exact" ? " (" + opp.pay_qualifier + ")" : ""}`.trim()
    : (opp.stipend_amount || null);
  const feeStr = opp.fee_amount_value != null
    ? `${opp.fee_amount_value} ${opp.fee_currency || ""}`.trim()
    : (opp.application_fee_amount || null);

  document.getElementById("detail-inner").innerHTML = `
    <div id="detail-split" class="detail-split">
    <div class="detail-left">

    <h2>${esc(opp.title)}</h2>

    <div class="detail-meta">
      <span class="tier-badge tier-${tier}" title="${esc(tierTitle(tier))}">Tier ${tier || "?"}</span>
      ${opp.opportunity_class ? `<span class="opp-class opp-class-${opp.opportunity_class}">${esc(opp.opportunity_class.replace(/_/g, " "))}</span>` : ""}
      <span class="scope-badge">${esc((opp.scope || "").replace(/_/g, " "))}</span>
      <span class="eligib eligib-${opp.eligibility_match}">${esc(opp.eligibility_match || "unknown")}</span>
      ${opp.flagged ? `<span class="flag-badge">⚑ flagged</span>` : ""}
      ${opp.hard_data_mismatch ? `<span class="mismatch-badge">⚠ prefilter/extract mismatch</span>` : ""}
    </div>
    ${lqfHtml}

    ${opp.flagged && opp.flag_reason ? `
    <section class="flag-box">
      <div class="section-label">Flag reason</div>
      <p>${esc(opp.flag_reason)}</p>
      <button class="btn-dismiss-flag" onclick="dismissFlag(${opp.id})">Dismiss flag</button>
    </section>` : ""}

    ${opp.hard_data_mismatch && opp.mismatch_detail ? `
    <section class="mismatch-box">
      <div class="section-label">Prefilter / extraction mismatch</div>
      <div class="mm-detail">${formatMismatch(opp.mismatch_detail)}</div>
      <button class="btn-dismiss-flag" onclick="dismissMismatch(${opp.id})">Dismiss mismatch</button>
    </section>` : ""}

    <section class="summary-box">
      <div class="section-label">Summary</div>
      <p>${esc(opp.summary || "No summary available.")}</p>
    </section>

    <section class="eval-box">
      <div class="section-label">Evaluation</div>
      <p>${esc(opp.evaluation || "—")}</p>
    </section>

    <section class="detail-grid">
      ${editFieldsMode ? renderEditableGrid(opp) : `
      ${cell("ID", opp.id)}
      ${cell("Institution", opp.institution_name)}
      ${cell("Country", countryName(opp.country))}
      ${cell("City", opp.city)}
      ${cellE("Class",
          opp.opportunity_class ? opp.opportunity_class.replace(/_/g, " ") : null,
          showLlmOutput ? (llmClassSignalsHtml(opp) || `<span class="cell-ev-empty">—</span>`) : "")}
      ${cell("Type", opp.opportunity_type)}
      ${cellE("Deadline",
          opp.deadline ? fmtDate(opp.deadline) + (opp.deadline_type && opp.deadline_type !== "fixed" ? " (" + opp.deadline_type + ")" : "") + " [" + (opp.deadline_confidence || "?") + "]" : (opp.deadline_type || null),
          showLlmOutput ? (llmDeadlineHtml(llm) || `<span class="cell-ev-empty">—</span>`) : "")}
      ${cellE("Residency period",
          opp.start_date || opp.end_date ? [opp.start_date && fmtDate(opp.start_date), opp.end_date && fmtDate(opp.end_date)].filter(Boolean).join(" – ") : null,
          showLlmOutput ? (llmPeriodHtml(llm) || `<span class="cell-ev-empty">—</span>`) : "")}
      ${cellE("Duration",
          opp.residency_period ? opp.residency_period
            : opp.duration_weeks ? opp.duration_weeks + " weeks [calculated]" : null,
          showLlmOutput ? (opp.duration_quote ? `<em class="cell-ev-quote">"${esc(opp.duration_quote)}"</em>` : `<span class="cell-ev-empty">—</span>`) : "")}
      ${cellE("Stipend",
          opp.stipend ? "Yes" + (payStr ? " — " + payStr : "") : opp.stipend == null ? null : "No",
          showLlmOutput ? (llmGetHtml(llm) || `<span class="cell-ev-empty">—</span>`) : "")}
      ${cellE("Benefits provided", fmtBenefits(opp),
          showLlmOutput ? (llmBenefitsHtml(llm) || `<span class="cell-ev-empty">—</span>`) : "")}
      ${cellE("Application fee",
          opp.has_application_fee ? "Yes" + (feeStr ? " — " + feeStr : "") : opp.has_application_fee == null ? null : "No",
          showLlmOutput ? (llmFeeHtml(llm) || `<span class="cell-ev-empty">—</span>`) : "")}
      ${cellE("Cost", fmtCost(opp),
          showLlmOutput ? (llmCostHtml(llm, opp.opportunity_class) || `<span class="cell-ev-empty">—</span>`) : "")}
      ${cell("Cost (calculated)", fmtCostCalculated(opp))}
      ${cellE("Obligations", fmtObligations(opp),
          showLlmOutput ? (llmObligationsHtml(llm) || `<span class="cell-ev-empty">—</span>`) : "")}
      ${cell("Open to", opp.open_to)}
      ${cellE("Recurring",
          opp.is_recurring ? (opp.recurrence_interval || "yes") : opp.is_recurring == null ? null : "No",
          showLlmOutput ? (llmRecurrenceHtml(llm) || `<span class="cell-ev-empty">—</span>`) : "")}
      ${cellE("Disciplines", tags,
          showLlmOutput ? (opp.discipline_note ? `<span class="cell-ev-item">${esc(opp.discipline_note)}</span>` : `<span class="cell-ev-empty">—</span>`) : "")}
      ${cellE("Age limit", fmtAge(opp),
          showLlmOutput ? (opp.age_note ? `<span class="cell-ev-item">${esc(opp.age_note)}</span>` : `<span class="cell-ev-empty">—</span>`) : "")}
      ${cellE("Eligibility other", elig_other,
          showLlmOutput ? (opp.eligibility_note ? `<span class="cell-ev-item">${esc(opp.eligibility_note)}</span>` : `<span class="cell-ev-empty">—</span>`) : "")}
      ${cell("Topics", opp.topics)}
      ${cell("Target audience", opp.target_audience)}
      ${cell("Working language", fmtLanguages(opp.working_language) || "—")}
      ${cellE("Scope",
          (opp.scope || "").replace(/_/g, " ") || null,
          showLlmOutput ? (opp.scope_note ? `<span class="cell-ev-item">${esc(opp.scope_note)}</span>` : `<span class="cell-ev-empty">—</span>`) : "")}
      ${cellE("LLM tier",
          opp.llm_tier ? String(opp.llm_tier) : null,
          showLlmOutput ? (llmTierHtml(opp) || `<span class="cell-ev-empty">—</span>`) : "")}
      ${cellE("Competitiveness",
          opp.competitiveness_est,
          showLlmOutput ? (opp.competitiveness_note ? `<span class="cell-ev-item">${esc(opp.competitiveness_note)}</span>` : `<span class="cell-ev-empty">—</span>`) : "")}
      <div><b>Ambiguities</b>${ambs && ambs.length ? `<ul class="ambs-list-inline">${ambs.map(a => `<li>${esc(a)}</li>`).join("")}</ul>` : "—"}</div>
      ${showLlmOutput && prestige && prestige.length ? `<div class="detail-grid-full"><b>Prestige signals</b><ul class="ambs-list-inline">${prestige.map(p => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}
      ${cell("Status", opp.status)}
      `}
    </section>

    <div class="url-row">
      <a href="${esc(opp.url || "")}" target="_blank" rel="noopener">${esc(opp.url || "—")}</a>
    </div>

    ${renderProvenance(opp.discovery_context)}

    <section class="edit-section">
      <div class="section-label">Manual review</div>
      <div class="edit-row">
        <label>Manual tier
          <select id="e-manual-tier">
            <option value="">— (use LLM)</option>
            <option value="1" ${opp.manual_tier == 1 ? "selected" : ""}>Tier 1</option>
            <option value="2" ${opp.manual_tier == 2 ? "selected" : ""}>Tier 2</option>
            <option value="3" ${opp.manual_tier == 3 ? "selected" : ""}>Tier 3</option>
            <option value="4" ${opp.manual_tier == 4 ? "selected" : ""}>Tier 4</option>
          </select>
        </label>
        <label>Reason
          <input type="text" id="e-tier-reason" value="${esc(opp.manual_tier_reason || "")}" placeholder="Why?">
        </label>
      </div>
      <label>Notes
        <textarea id="e-notes" rows="3">${esc(opp.notes || "")}</textarea>
      </label>
      <div class="edit-row">
        <label class="inline-check">
          <input type="checkbox" id="e-reviewed" ${opp.manually_reviewed ? "checked" : ""}>
          Mark as reviewed
        </label>
        <button class="btn-save" onclick="saveDetail(${opp.id})">Save</button>
        <span id="save-status"></span>
      </div>
    </section>

    </div><!-- .detail-left -->

    <div id="detail-resize-handle" class="detail-resize-handle"></div>

    <div class="detail-right">
      <div id="detail-right-content" class="detail-right-content"></div>
    </div>
    </div><!-- #detail-split -->
  `;

  if (_detailLeftWidth) {
    const left = document.querySelector(".detail-left");
    if (left) left.style.flex = `0 0 ${_detailLeftWidth}px`;
  }
  initDetailResize();
  renderRightPanel();
  document.querySelectorAll(".field-edit-textarea").forEach(autoResizeField);
}

async function dismissMismatch(id) {
  try {
    await exec("UPDATE opportunities SET hard_data_mismatch = 0, manually_reviewed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
    const opp = await fetchOpportunity(id);
    renderDetail(opp);
  } catch (e) {
    alert("Could not dismiss mismatch: " + e.message);
  }
}

async function dismissFlag(id) {
  try {
    await exec("UPDATE opportunities SET flagged = 0, manually_reviewed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
    const opp = await fetchOpportunity(id);
    renderDetail(opp);
  } catch (e) {
    alert("Could not dismiss flag: " + e.message);
  }
}

async function saveDetail(id) {
  const mt = document.getElementById("e-manual-tier").value;
  const payload = {};
  if (mt) payload.manual_tier = parseInt(mt);
  const reason = document.getElementById("e-tier-reason").value;
  if (reason) payload.manual_tier_reason = reason;
  const notes = document.getElementById("e-notes").value;
  if (notes) payload.notes = notes;
  payload.manually_reviewed = document.getElementById("e-reviewed").checked;
  if (editFieldsMode) Object.assign(payload, collectEditedFields());

  const statusEl = document.getElementById("save-status");
  try {
    const keys = Object.keys(payload).filter(k => EDITABLE_FIELDS[k] || ["manual_tier", "manual_tier_reason", "notes", "manually_reviewed"].includes(k));
    const sets = keys.map(k => `${k} = ?`).join(", ");
    const args = keys.map(k => {
      const v = payload[k];
      return (Array.isArray(v)) ? JSON.stringify(v) : v;
    });
    await exec(`UPDATE opportunities SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [...args, id]);
    statusEl.textContent = "Saved.";
    statusEl.className = "save-ok";
    const updated = await fetchOpportunity(id);
    if (updated) renderDetail(updated);
  } catch (e) {
    statusEl.textContent = "Error: " + e.message;
    statusEl.className = "save-err";
  }
  setTimeout(() => { statusEl.textContent = ""; statusEl.className = ""; }, 3000);
}


// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(s) {
  if (!s) return "—";
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
}

function fmtDateTimeLocal(s) {
  if (!s) return "—";
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return s;
  const [, y, mo, d, h, mi, se] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se || 0)));
  const pad = n => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function fmtModel(m) {
  if (!m) return "";
  if (m.startsWith("claude-sonnet"))  return "Sonnet";
  if (m.startsWith("claude-opus"))    return "Opus";
  if (m.startsWith("claude-haiku"))   return "Haiku";
  if (m.includes("70b"))              return "Llama 70B";
  if (m.includes("8b"))               return "Llama 8B";
  if (m.includes("llama-4"))          return "Llama 4";
  return m.replace(/^(claude-|meta-llama\/)/, "").replace(/-\d{8}$/, "");
}

function fmtCostAmount(opp) {
  if (opp.cost_amount_value != null) {
    const basis = opp.cost_basis && opp.cost_basis !== "unstated" ? ` / ${opp.cost_basis.replace(/_/g, " ")}` : "";
    return `${opp.cost_amount_value}${opp.cost_currency ? " " + opp.cost_currency : ""}${basis}`;
  }
  return opp.cost_description || null;
}

function fmtCost(opp) {
  const raw = opp.llm_output_json;
  if (raw && Array.isArray(raw.give)) {
    const costs = raw.give.filter(it => it.kind === "participation_cost" || it.kind === "materials_cost");
    if (costs.length) {
      const byKind = {};
      costs.forEach(it => { (byKind[it.kind] = byKind[it.kind] || []).push(it); });
      const parts = Object.keys(byKind).map(kind => {
        const label = _costKindLabel(kind, opp.opportunity_class);
        const amounts = byKind[kind].filter(it => it.amount != null);
        if (!amounts.length) return label;
        const byBasis = {};
        amounts.forEach(it => {
          const b = it.basis || "unstated";
          (byBasis[b] = byBasis[b] || []).push(it);
        });
        const basisParts = Object.keys(byBasis).map(basis => {
          const group = byBasis[basis];
          const currency = group[0].currency || "";
          const vals = [...new Set(group.map(it => it.amount))].sort((a, b) => a - b);
          const amtStr = vals.length === 1
            ? `${vals[0]}${currency ? " " + currency : ""}`
            : `${vals[0]}–${vals[vals.length - 1]}${currency ? " " + currency : ""}`;
          const basisSuffix = basis !== "unstated" ? ` / ${basis.replace(/_/g, " ")}` : "";
          return `${amtStr}${basisSuffix}`;
        });
        return `${label}: ${basisParts.join(", ")}`;
      });
      return parts.join(" + ");
    }
  }
  if (opp.has_cost === true || opp.has_cost === 1) {
    const amt = fmtCostAmount(opp);
    return amt || "Yes";
  }
  if (opp.has_cost === false || opp.has_cost === 0) return "None";
  return "Unknown";
}

function fmtStipend(opp) {
  const raw = opp.llm_output_json;
  if (raw && Array.isArray(raw.get)) {
    const pays = raw.get.filter(it => _MONETARY_GET_KINDS.has(it.kind));
    if (pays.length) {
      const byKind = {};
      pays.forEach(it => { (byKind[it.kind] = byKind[it.kind] || []).push(it); });
      const parts = Object.keys(byKind).map(kind => {
        const label = kind.replace(/_/g, " ");
        const amounts = byKind[kind].filter(it => it.amount != null);
        if (!amounts.length) return label;
        const byBasis = {};
        amounts.forEach(it => {
          const b = it.basis || "unstated";
          (byBasis[b] = byBasis[b] || []).push(it);
        });
        const basisParts = Object.keys(byBasis).map(basis => {
          const group = byBasis[basis];
          const currency = group[0].currency || "";
          const vals = [...new Set(group.map(it => it.amount))].sort((a, b) => a - b);
          const amtStr = vals.length === 1
            ? `${vals[0]}${currency ? " " + currency : ""}`
            : `${vals[0]}–${vals[vals.length - 1]}${currency ? " " + currency : ""}`;
          const basisSuffix = basis !== "unstated" ? ` / ${basis.replace(/_/g, " ")}` : "";
          return `${amtStr}${basisSuffix}`;
        });
        return `${label}: ${basisParts.join(", ")}`;
      });
      return parts.join(" + ");
    }
    return "None";
  }
  if (opp.pay_amount_value != null) {
    const basis = opp.pay_basis && opp.pay_basis !== "unstated" ? ` / ${opp.pay_basis.replace(/_/g, " ")}` : "";
    const qualifier = opp.pay_qualifier && opp.pay_qualifier !== "exact" ? ` (${opp.pay_qualifier})` : "";
    return `${opp.pay_amount_value}${opp.pay_currency ? " " + opp.pay_currency : ""}${basis}${qualifier}`;
  }
  if (opp.stipend === true || opp.stipend === 1) return "Yes";
  if (opp.stipend === false || opp.stipend === 0) return "None";
  return "Unknown";
}

function fmtList(val) {
  if (!val) return "—";
  if (Array.isArray(val)) return val.join(", ") || "—";
  try { const p = JSON.parse(val); if (Array.isArray(p)) return p.join(", ") || "—"; } catch {}
  return String(val);
}

function fmtAge(opp) {
  const t = opp.age_limit_type;
  if (!t || t === "none" || t === "unknown") return "None";
  if (t === "under") return `Under ${opp.age_limit_value}`;
  if (t === "over") return `Over ${opp.age_limit_value}`;
  if (t === "range") return `${opp.age_limit_value}–${opp.age_limit_value_max}`;
  return t;
}

function cell(label, val) {
  return `<div><b>${esc(label)}</b>${esc(val != null ? val : "—")}</div>`;
}

// ── Column resize ────────────────────────────────────────────────────────────

const LS_COL_WIDTHS_KEY = "artdb_col_widths";
function loadColWidths() {
  try { const s = localStorage.getItem(LS_COL_WIDTHS_KEY); return s ? JSON.parse(s) : {}; } catch { return {}; }
}
let savedColWidths = loadColWidths();

function initColumnResize() {
  const table = document.getElementById("opp-table");
  const ths = Array.from(table.querySelectorAll("thead th"));

  const hasSaved = Object.keys(savedColWidths).length > 0;
  if (hasSaved) {
    ths.forEach(t => { if (savedColWidths[t.dataset.col]) t.style.width = savedColWidths[t.dataset.col]; });
    table.style.tableLayout = "fixed";
  }

  ths.forEach(th => {
    th.querySelectorAll(".col-resize-handle").forEach(h => h.remove());
    const handle = document.createElement("span");
    handle.className = "col-resize-handle";
    handle.addEventListener("mousedown", e => {
      e.preventDefault();
      e.stopPropagation();
      ths.forEach(t => { t.style.width = t.offsetWidth + "px"; });
      table.style.tableLayout = "fixed";
      const startX = e.clientX;
      const startW = th.offsetWidth;
      let moved = false;
      const onMove = e => {
        moved = true;
        th.style.width = Math.max(20, startW + e.clientX - startX) + "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        ths.forEach(t => { if (t.dataset.col) savedColWidths[t.dataset.col] = t.style.width; });
        localStorage.setItem(LS_COL_WIDTHS_KEY, JSON.stringify(savedColWidths));
        if (moved) document.addEventListener("click", e => e.stopPropagation(), { capture: true, once: true });
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    th.appendChild(handle);
  });
}

function initStickyScrollbar() {
  const wrap = document.getElementById("table-wrap");
  const mirror = document.getElementById("table-scroll-mirror");
  let syncing = false;
  wrap.addEventListener("scroll", () => {
    if (syncing) return; syncing = true; mirror.scrollLeft = wrap.scrollLeft; syncing = false;
  });
  mirror.addEventListener("scroll", () => {
    if (syncing) return; syncing = true; wrap.scrollLeft = mirror.scrollLeft; syncing = false;
  });
}

function updateScrollMirror() {
  const wrap = document.getElementById("table-wrap");
  const inner = document.getElementById("table-scroll-mirror-inner");
  if (wrap && inner) inner.style.width = wrap.scrollWidth + "px";
}

// ── Researcher / Pipeline / Aggregator panel ───────────────────────────────
// This whole section is the one place this port genuinely differs in kind,
// not just in plumbing: the local app's "Run" buttons execute a scrape/
// search/extraction cycle live on this machine, streaming progress over SSE.
// A static page cannot run Python/Playwright/LLM calls at all, so "Run"
// here inserts a command_queue row instead (see DECISIONS.md and
// docs/CLOUD_ROUTINE.md) — the cloud routine executes it on its next tick.
// Everything else below (history tables, candidate review, domain restore)
// is ordinary stored data and ports to direct SQL exactly like the rest of
// this file.

const MODE_DEFAULTS = {
  known_sources:    "all active sources",
  oriented_search:  "10 queries (7 EN + 3 DE)",
  independent:      "10 queries (7 EN + 3 DE)",
  relevance_guided: "10 queries (7 EN + 3 DE)",
  relevance_blind:  "10 queries (7 EN + 3 DE)",
};

function updateLimitPlaceholder() {
  const mode = document.getElementById("r-mode").value;
  document.getElementById("r-limit").placeholder = `default: ${MODE_DEFAULTS[mode] || ""}`;
}

function bindResearcherPanel() {
  document.getElementById("r-mode").addEventListener("change", updateLimitPlaceholder);
  updateLimitPlaceholder();

  document.getElementById("btn-run-researcher").addEventListener("click", async () => {
    const mode = document.getElementById("r-mode").value;
    const limitVal = document.getElementById("r-limit").value;
    const args = { mode };
    if (limitVal) args.limit = Number(limitVal);
    if (document.getElementById("r-full-scrape").checked) args.full_scrape = true;
    const statusEl = document.getElementById("researcher-status");
    try {
      await exec("INSERT INTO command_queue (command, args) VALUES (?, ?)", ["run_researcher", JSON.stringify(args)]);
      statusEl.innerHTML = `<span class="run-ok">Requested — queued for the next cloud routine run.</span>`;
      loadJobQueue();
    } catch (e) {
      statusEl.innerHTML = `<span class="run-err">Could not enqueue: ${esc(e.message)}</span>`;
    }
  });

  document.getElementById("btn-run-pipeline").addEventListener("click", async () => {
    try {
      await exec("INSERT INTO command_queue (command, args) VALUES ('run_pipeline', '{}')");
      loadJobQueue();
    } catch (e) { alert("Could not enqueue: " + e.message); }
  });

  document.getElementById("btn-request-scrape").addEventListener("click", async () => {
    try {
      await exec("INSERT INTO command_queue (command, args) VALUES ('run_scrape', '{}')");
      loadJobQueue();
    } catch (e) { alert("Could not enqueue: " + e.message); }
  });

  document.getElementById("btn-refresh-scrapers").addEventListener("click", loadAggregatorCandidatesTable);
  document.getElementById("btn-refresh-queue").addEventListener("click", loadJobQueue);
  document.getElementById("btn-refresh-pipeline-runs").addEventListener("click", () => loadPipelineRuns());
  document.getElementById("btn-toggle-excluded-domains").addEventListener("click", toggleExcludedDomainsPanel);
  document.getElementById("btn-close-excluded-domains").addEventListener("click", toggleExcludedDomainsPanel);
}

// ── Cloud Jobs queue (command_queue — Phase 7B.3) ──────────────────────────

async function loadJobQueue() {
  const tbody = document.getElementById("job-queue-tbody");
  if (!tbody) return;
  try {
    const rows = await q(
      "SELECT id, command, args, status, requested_at, finished_at, result_note FROM command_queue ORDER BY id DESC LIMIT 20"
    );
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${esc(r.id)}</td><td>${esc(r.command)}</td><td>${esc(r.args)}</td>
        <td>${esc(r.status)}</td><td>${esc(fmtDateTimeLocal(r.requested_at))}</td>
        <td>${esc(fmtDateTimeLocal(r.finished_at))}</td><td>${esc(r.result_note)}</td>
      </tr>`).join("") || `<tr><td colspan="7" style="color:#666;font-style:italic;">No jobs yet.</td></tr>`;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="run-err">Could not load queue (has migration 035 run?): ${esc(e.message)}</td></tr>`;
  }
}

// ── Researcher runs (history — real stored data, fully portable) ──────────

async function loadResearcherRuns() {
  const el = document.getElementById("researcher-runs");
  try {
    const runs = await q(`
      SELECT id, mode, status, started_at, finished_at, queries_tried, results_found,
             new_opportunities, error_message,
             CAST((JULIANDAY(COALESCE(finished_at, datetime('now'))) - JULIANDAY(started_at)) * 86400 AS INTEGER) AS duration_seconds
      FROM researcher_runs ORDER BY id DESC LIMIT 5
    `);
    if (!runs.length) { el.innerHTML = "<p style='color:#666;font-size:13px'>No runs yet.</p>"; return; }
    const rows = runs.map(r => {
      const dur = r.duration_seconds != null
        ? (r.duration_seconds < 60 ? `${r.duration_seconds}s` : `${Math.round(r.duration_seconds/60)}m`)
        : "—";
      const statusClass = r.status === "completed" ? "run-ok" : r.status === "failed" ? "run-err" : "run-running";
      let statusText = esc(r.status);
      if (r.status === "failed" && r.error_message) {
        statusText = `failed: ${esc(r.error_message.slice(0, 50))}`;
      }
      return `<tr class="run-row" data-run-id="${r.id}" title="Click to see queries">
        <td>${r.id}</td>
        <td>${esc(r.mode)}</td>
        <td class="${statusClass}">${statusText}</td>
        <td>${esc(fmtDateTimeLocal(r.started_at))}</td>
        <td>${r.queries_tried ?? "—"}</td>
        <td>${r.results_found ?? "—"}</td>
        <td>${r.new_opportunities ?? "—"}</td>
        <td>${dur}</td>
      </tr>`;
    }).join("");
    el.innerHTML = `<table>
      <thead><tr><th>#</th><th>Mode</th><th>Status</th><th>Started</th>
        <th>Queries</th><th>Results</th><th>New opps</th><th>Duration</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
    el.querySelectorAll(".run-row").forEach(tr => {
      tr.addEventListener("click", () => toggleRunDetail(parseInt(tr.dataset.runId)));
    });
  } catch (e) {
    el.innerHTML = `<p class="run-err">Could not load runs: ${esc(e.message)}</p>`;
  }
}

let _openResearcherRunId = null;

function toggleRunDetail(runId) {
  if (_openResearcherRunId === runId) hideRunDetail();
  else showRunDetail(runId);
}

async function showRunDetail(runId) {
  _openResearcherRunId = runId;
  const el = document.getElementById("run-detail");
  el.classList.remove("hidden");
  el.innerHTML = `<div class="run-detail-loading">Loading queries for run #${runId}…</div>`;
  try {
    const runRows = await q("SELECT * FROM researcher_runs WHERE id = ?", [runId]);
    const run = runRows[0];
    const queries = await q(
      "SELECT id, query_text, language, mode, results_count, outcome FROM query_log WHERE run_id = ? ORDER BY id ASC",
      [runId]
    );
    const errBlock = run.error_message ? `<div class="run-detail-error">Error: ${esc(run.error_message)}</div>` : "";
    if (!queries.length) {
      el.innerHTML = `<div class="run-detail-header">Run #${runId} — ${esc(run.mode)} — ${esc(run.status)}${errBlock}</div>
        <p style="color:#666;font-size:13px;padding:8px 0">No queries logged for this run.</p>
        <button class="run-detail-close" onclick="hideRunDetail()">Close</button>`;
      return;
    }
    const qRows = queries.map(qq => {
      const outcomeClass = qq.outcome === "success" ? "run-ok" : qq.outcome === "error" ? "run-err" : "";
      return `<tr>
        <td>${esc(qq.language || qq.mode || "—")}</td>
        <td class="run-detail-query">${esc(qq.query_text || "—")}</td>
        <td>${qq.results_count ?? "—"}</td>
        <td class="${outcomeClass}">${esc(qq.outcome || "—")}</td>
      </tr>`;
    }).join("");
    el.innerHTML = `
      <div class="run-detail-header">
        Run #${runId} — ${esc(run.mode)} — <span class="${run.status === "completed" ? "run-ok" : run.status === "failed" ? "run-err" : "run-running"}">${esc(run.status)}</span>
        &nbsp;·&nbsp; ${queries.length} quer${queries.length === 1 ? "y" : "ies"}
        ${errBlock}
      </div>
      <table class="run-detail-table">
        <thead><tr><th>Lang</th><th>Query</th><th>Results</th><th>Outcome</th></tr></thead>
        <tbody>${qRows}</tbody>
      </table>
      <button class="run-detail-close" onclick="hideRunDetail()">Close</button>`;
  } catch (e) {
    el.innerHTML = `<p class="run-err">Could not load detail: ${esc(e.message)}</p>
      <button class="run-detail-close" onclick="hideRunDetail()">Close</button>`;
  }
}

function hideRunDetail() {
  _openResearcherRunId = null;
  const el = document.getElementById("run-detail");
  el.classList.add("hidden");
  el.innerHTML = "";
}

// ── Pipeline runs (history, stored counters — see note in DECISIONS.md:
// the "live" per-cell drill-down breakdown in the local app depends on
// joining against in-flight raw_scrape rows for a run still executing on
// the same machine; not meaningful for a remote review of finished runs,
// so this shows the same columns from the stored counters only) ──────────

async function loadPipelineRuns() {
  const el = document.getElementById("pipeline-runs");
  if (!el) return;
  try {
    const runs = await q(`
      SELECT id, status, extract_mode, source_filter, triggered_by, batches,
             new_opportunities, rejected, eval_dropped, duplicates, errors,
             api_requests, api_tokens_in, api_tokens_out, started_at, finished_at,
             CAST((JULIANDAY(COALESCE(finished_at, datetime('now'))) - JULIANDAY(started_at)) * 86400 AS INTEGER) AS duration_seconds
      FROM pipeline_runs ORDER BY id DESC LIMIT 10
    `);
    if (!runs.length) { el.innerHTML = ""; return; }
    const rows = runs.map(r => {
      const dur = r.duration_seconds != null
        ? (r.duration_seconds < 60 ? `${r.duration_seconds}s` : `${Math.round(r.duration_seconds / 60)}m`)
        : "—";
      const statusClass = r.status === "completed" ? "run-ok" : (r.status === "failed" || r.status === "aborted") ? "run-err" : "run-running";
      const modeLabel = r.source_filter ? `${esc(r.extract_mode || "quality")} · ${esc(r.source_filter.slice(0, 30))}` : esc(r.extract_mode || "quality");
      return `<tr>
        <td class="ps-source">${modeLabel}<span class="cell-tag">${esc(r.triggered_by || "")}</span></td>
        <td class="${statusClass}">${esc(r.status)}</td>
        <td>${esc(fmtDateTimeLocal(r.started_at))}</td>
        <td class="ps-num">${r.batches || 0}</td>
        <td class="ps-num">${r.new_opportunities || 0}</td>
        <td class="ps-num">${r.rejected || 0}</td>
        <td class="ps-num">${r.eval_dropped || 0}</td>
        <td class="ps-num">${r.duplicates || 0}</td>
        <td class="ps-num">${r.errors || 0}</td>
        <td>${dur}</td>
        <td class="ps-num">${r.api_requests ?? "—"}</td>
        <td class="ps-num">${r.api_tokens_in ?? "—"}/${r.api_tokens_out ?? "—"}</td>
      </tr>`;
    }).join("");
    el.innerHTML = `<table class="pipeline-source-table" style="margin-top:8px">
      <thead><tr>
        <th>Mode</th><th>Status</th><th>Started</th>
        <th class="ps-num">Batches</th><th class="ps-num">New opps</th>
        <th class="ps-num">Pre-filter ✗</th><th class="ps-num">Eval ✗</th>
        <th class="ps-num">Dup</th><th class="ps-num">Errors</th><th>Duration</th>
        <th class="ps-num">API req</th><th class="ps-num">Tokens in/out</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } catch (_) {}
}

// ── Aggregator candidates ───────────────────────────────────────────────────

async function loadAggregatorCandidatesTable() {
  const tbody = document.getElementById("agg-candidates-table-body");
  const badge = document.getElementById("agg-cand-badge");
  if (!tbody) return;
  try {
    const candidates = await q(`
      SELECT id, url, name, aggregator_signals, aggregator_detected_at
      FROM sources WHERE aggregator_status = 'candidate' ORDER BY aggregator_detected_at DESC
    `);
    if (badge) {
      badge.textContent = candidates.length || "";
      badge.style.display = candidates.length ? "inline-block" : "none";
    }
    if (!candidates.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:#666;font-style:italic;padding:10px;">No candidates yet.</td></tr>';
      return;
    }
    tbody.innerHTML = candidates.map(c => {
      let sig = {};
      try { sig = c.aggregator_signals ? JSON.parse(c.aggregator_signals) : {}; } catch (_) {}
      const evidenceHtml = sig.aggregator_note ? esc(sig.aggregator_note) : "no note yet";
      const detected = c.aggregator_detected_at ? c.aggregator_detected_at.slice(0, 10) : "—";
      return `<tr data-id="${c.id}">
        <td><a href="${esc(c.url)}" target="_blank" style="font-weight:500">${esc(c.name || c.url)}</a></td>
        <td style="font-size:0.85em;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${evidenceHtml}</td>
        <td style="white-space:nowrap">${esc(detected)}</td>
        <td style="white-space:nowrap">
          <button class="btn-agg-confirm" style="padding:2px 8px;font-size:0.8em;" onclick="aggAction(${c.id},'confirm')" title="Confirm aggregator">✓</button>
          <button class="btn-agg-reject" style="padding:2px 8px;font-size:0.8em;margin-left:3px;" onclick="aggAction(${c.id},'reject')" title="Reject aggregator">✗</button>
        </td>
      </tr>`;
    }).join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="run-err">Error: ${esc(e.message)}</td></tr>`;
  }
}

async function aggAction(id, action) {
  const row = document.querySelector(`#agg-candidates-table-body tr[data-id="${id}"]`);
  if (row) row.style.opacity = "0.5";
  try {
    const status = action === "confirm" ? "confirmed" : "rejected";
    if (action === "confirm") {
      await exec("UPDATE sources SET aggregator_status='confirmed', source_type='aggregator' WHERE id=?", [id]);
    } else {
      await exec("UPDATE sources SET aggregator_status='rejected' WHERE id=?", [id]);
    }
    loadAggregatorCandidatesTable();
  } catch (e) {
    if (row) row.style.opacity = "1";
    alert(`Action failed: ${e.message}`);
  }
}

// ── Excluded domains ─────────────────────────────────────────────────────────
// Ports pipeline/domain_reputation.py::is_excluded/exclusion_reason verbatim
// (pure functions over a row dict — same constants as the backend).

const _MIN_STRUCTURAL_REJECTS = 5;
const _TTL_DAYS = 90;
const _REJECTED_PAGE_SIZE = 50;

function isExcluded(row) {
  if (row.manual_override === "include") return false;
  if (row.manual_override === "exclude") return true;
  if ((row.opportunity_count || 0) > 0 || (row.aggregator_count || 0) > 0) return false;
  if ((row.structural_reject_count || 0) < _MIN_STRUCTURAL_REJECTS) return false;
  if (row.last_rejected_at) {
    const ageMs = Date.now() - new Date(row.last_rejected_at + "Z").getTime();
    if (ageMs > _TTL_DAYS * 86400000) return false;
  }
  return true;
}

function toggleExcludedDomainsPanel() {
  const section = document.getElementById("excl-domains-section");
  if (!section) return;
  const show = section.classList.contains("hidden");
  section.classList.toggle("hidden", !show);
  if (show) loadExcludedDomainsTable();
}

let _exclDomainsRows = [];

async function loadExcludedDomainsTable() {
  const tbody = document.getElementById("excl-domains-table-body");
  if (!tbody) return;
  try {
    const rows = await q("SELECT * FROM domain_reputation ORDER BY structural_reject_count DESC");
    _exclDomainsRows = rows.filter(isExcluded);
    _renderExcludedDomainsPage(1);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="run-err">Error: ${esc(e.message)}</td></tr>`;
  }
}

function _renderExcludedDomainsPage(page) {
  const tbody = document.getElementById("excl-domains-table-body");
  if (!tbody) return;
  const rows = _exclDomainsRows;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:#666;font-style:italic;padding:10px;">No domains excluded yet.</td></tr>';
    return;
  }
  const totalPages = Math.ceil(rows.length / _REJECTED_PAGE_SIZE);
  const p = Math.max(1, Math.min(page, totalPages));
  const slice = rows.slice((p - 1) * _REJECTED_PAGE_SIZE, p * _REJECTED_PAGE_SIZE);
  tbody.innerHTML = slice.map(r => {
    const lastRejected = r.last_rejected_at ? r.last_rejected_at.slice(0, 10) : "—";
    return `<tr data-domain="${esc(r.domain)}">
      <td><a href="https://${esc(r.domain)}" target="_blank" style="font-weight:500">${esc(r.domain)}</a></td>
      <td class="st-num">${r.structural_reject_count || 0}</td>
      <td class="st-num">${r.total_processed || 0}</td>
      <td style="white-space:nowrap">${esc(lastRejected)}</td>
      <td style="white-space:nowrap">
        <button class="btn-secondary" style="padding:2px 8px;font-size:0.8em;" onclick="restoreExcludedDomain('${esc(r.domain)}')">Restore</button>
      </td>
    </tr>`;
  }).join("");
}

async function restoreExcludedDomain(domain) {
  const row = document.querySelector(`tr[data-domain="${domain}"]`);
  if (row) row.style.opacity = "0.5";
  try {
    await exec("UPDATE domain_reputation SET manual_override='include', updated_at=datetime('now') WHERE domain=?", [domain]);
    loadExcludedDomainsTable();
  } catch (e) {
    if (row) row.style.opacity = "1";
    alert(`Restore failed: ${e.message}`);
  }
}

// ── Global exports ──────────────────────────────────────────────────────────
// Functions referenced via inline onclick="..."/oninput="..." in HTML strings
// built by renderDetail()/renderTable() etc. A type="module" script's
// top-level functions are NOT implicitly on window (unlike a classic
// script, which is what web/static/index.html relies on) — without these,
// every such handler would fail with "X is not defined".
window.autoResizeField = autoResizeField;
window.closeDetailPanel = closeDetailPanel;
window.dismissFlag = dismissFlag;
window.dismissMismatch = dismissMismatch;
window.loadOpportunities = loadOpportunities;
window.openDetailPanel = openDetailPanel;
window.saveDetail = saveDetail;
window.hideRunDetail = hideRunDetail;
window.aggAction = aggAction;
window.restoreExcludedDomain = restoreExcludedDomain;
window._renderExcludedDomainsPage = _renderExcludedDomainsPage;

// ── Boot ──────────────────────────────────────────────────────────────────
const _stored = getStoredToken();
if (_stored) {
  tryConnect(_stored).then(() => { showApp(); return init(); }).catch(() => {
    localStorage.removeItem(TOKEN_KEY);
    showLogin();
  });
} else {
  showLogin();
}



