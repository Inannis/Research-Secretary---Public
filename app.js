// Canonical review UI. GitHub Pages/Turso is the primary everyday interface;
// the local FastAPI server serves this same module with a local data adapter
// and additionally enables its operational controls.
import { createClient } from "https://esm.sh/@libsql/client@0.17.4/web";

const TURSO_URL = "libsql://artdb-inannis.aws-eu-west-1.turso.io";
const TOKEN_KEY = "turso_auth_token";
const LOCAL_MODE = window.__DATA_SOURCE__ === "local";
let client = null;

function getStoredToken() { return localStorage.getItem(TOKEN_KEY); }
function connect(token) { client = createClient({ url: TURSO_URL, authToken: token }); }
async function tryConnect(token) {
  connect(token);
  await client.execute({ sql: "SELECT 1", args: [] });
}

async function apiFetch(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let detail = response.statusText;
    try { detail = (await response.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return response.status === 204 ? null : response.json();
}

// Read adapter: Turso uses the browser client; local mode uses a restricted
// FastAPI endpoint backed by the checked-out SQLite database.
async function q(sql, args = []) {
  if (LOCAL_MODE) {
    return apiFetch("/ui/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql, args }),
    });
  }
  const res = await client.execute({ sql, args });
  return res.rows.map((row) => {
    const obj = {};
    res.columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

// Pages writes through Turso directly. Local mode uses the existing semantic
// FastAPI endpoints so the local query adapter never needs write access.
async function exec(sql, args = []) {
  if (LOCAL_MODE) throw new Error("Local UI writes must use a FastAPI endpoint");
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

if (!LOCAL_MODE) document.getElementById("login-form").addEventListener("submit", async (e) => {
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

if (!LOCAL_MODE) document.getElementById("logout-btn").addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  client = null;
  showLogin();
});

// ───────────────────────────────────────────────────────────────────────────
// Rendering and review behavior lives here once. The runtime adapter above
// selects Turso for Pages or local SQLite/REST for FastAPI.
// ───────────────────────────────────────────────────────────────────────────

const GROUPED_PER_PAGE = 100000; // retain every row once background loading completes
const INITIAL_LIST_ITEMS = 50;
let currentFilters = { eligibility: "not_ineligible" };
let currentPage = 1;
let lastResult = null;
let _opportunitiesLoadVersion = 0;
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
    bindLocalOperations();
  }
  loadLanguages();
  const startView = location.hash === "#researcher" ? "researcher" : "list";
  if (startView === "researcher") {
    showView("researcher");
    history.replaceState({ view: "researcher" }, "", "#researcher");
    loadResearcherRuns();
    loadResearcherBudget();
    loadPipelineStatus();
    loadPipelineRuns();
    loadScraperTable();
    loadAggregatorCandidatesTable();
    loadScraperRuns();
  } else {
    showView("list");
    history.replaceState({ view: "list" }, "", "#opportunities");
  }
  // Header metadata must not hold up the first usable list render.
  void loadStats();
  void loadOpportunities(1);
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
  loadResearcherBudget();
  loadPipelineStatus();
  loadPipelineRuns();
  loadScraperTable();
  loadAggregatorCandidatesTable();
  loadScraperRuns();
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
      loadResearcherBudget();
      loadPipelineStatus();
      loadPipelineRuns();
      loadScraperTable();
      loadAggregatorCandidatesTable();
      loadScraperRuns();
    } else {
      showView("list");
    }
  });
}


// ── Stats bar ─────────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const [totalRows, byTier, unreviewedRows] = await Promise.all([
      q("SELECT COUNT(*) AS n FROM opportunities WHERE status != 'archived'"),
      q("SELECT COALESCE(manual_tier, llm_tier) AS k, COUNT(*) AS n FROM opportunities WHERE status != 'archived' GROUP BY 1"),
      q("SELECT COUNT(*) AS n FROM opportunities WHERE manually_reviewed = 0 AND status != 'archived'"),
    ]);
    const total = totalRows[0].n;
    const unreviewed = unreviewedRows[0].n;
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

function opportunityListQuery(filters) {
  const { where, params } = _buildWhere(filters);
  const sortKey = filters.sort_by || "";
  const sortCol = _SORT_COLS[sortKey] || "COALESCE(o.manual_tier, o.llm_tier)";
  const dir = filters.sort_dir === "desc" ? "DESC" : "ASC";
  const order = (sortKey && sortKey !== "tier")
    ? `${sortCol} ${dir} NULLS LAST, COALESCE(o.manual_tier, o.llm_tier) ASC NULLS LAST, o.id ASC`
    : `COALESCE(o.manual_tier, o.llm_tier) ${dir} NULLS LAST, o.deadline ASC NULLS LAST, o.id ASC`;

  return { where, params, order };
}

async function fetchOpportunitiesCount(filters) {
  const { where, params } = opportunityListQuery(filters);
  return (await q(`SELECT COUNT(*) AS n FROM opportunities o ${_JOINS} WHERE ${where}`, params))[0].n;
}

async function fetchOpportunityItems(filters, offset, limit) {
  const { where, params, order } = opportunityListQuery(filters);
  return q(
    `SELECT ${_LIST_FIELDS} FROM opportunities o ${_JOINS} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
}

async function loadOpportunities(page = 1) {
  const loadVersion = ++_opportunitiesLoadVersion;
  currentPage = 1; // always fetching everything — see GROUPED_PER_PAGE note above
  try {
    const filters = { ...currentFilters };
    if (sortBy) { filters.sort_by = sortBy; filters.sort_dir = sortDir; }
    const initialItems = await fetchOpportunityItems(filters, 0, INITIAL_LIST_ITEMS);
    if (loadVersion !== _opportunitiesLoadVersion) return;
    lastResult = { total: null, page: 1, per_page: GROUPED_PER_PAGE, items: initialItems, loading: true };
    renderTable(lastResult);

    const [total, remainingItems] = await Promise.all([
      fetchOpportunitiesCount(filters),
      fetchOpportunityItems(filters, INITIAL_LIST_ITEMS, GROUPED_PER_PAGE - INITIAL_LIST_ITEMS),
    ]);
    if (loadVersion !== _opportunitiesLoadVersion) return;
    lastResult = { total, page: 1, per_page: GROUPED_PER_PAGE, items: initialItems.concat(remainingItems), loading: false };
    renderTable(lastResult);
  } catch (e) {
    if (loadVersion !== _opportunitiesLoadVersion) return;
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
    case "url":         return opp.url ? `<a href="${safeUrl(opp.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(opp.url.replace(/^https?:\/\//, "").slice(0, 40))}…</a>` : "—";
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
  const total_pages = Number.isFinite(data.total) ? Math.ceil(data.total / data.per_page) : null;
  if (data.loading) {
    document.getElementById("result-info").textContent = `Showing first ${data.items.length} results while grouped view completes…`;
  } else document.getElementById("result-info").textContent =
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
  if (data.loading || !Number.isFinite(data.total)) {
    document.getElementById("pagination").innerHTML = "";
    return;
  }
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
    ? `${sortCol} ${dir} NULLS LAST, COALESCE(o.manual_tier, o.llm_tier) ASC NULLS LAST`
    : `COALESCE(o.manual_tier, o.llm_tier) ${dir} NULLS LAST, o.deadline ASC NULLS LAST`;
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
      <a href="${safeUrl(opp.url)}" target="_blank" rel="noopener">${esc(opp.url || "—")}</a>
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
    if (LOCAL_MODE) {
      await apiFetch(`/opportunities/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mismatch_acknowledged: true }) });
    } else {
      await exec("UPDATE opportunities SET hard_data_mismatch = 0, manually_reviewed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
    }
    const opp = await fetchOpportunity(id);
    renderDetail(opp);
  } catch (e) {
    alert("Could not dismiss mismatch: " + e.message);
  }
}

async function dismissFlag(id) {
  try {
    if (LOCAL_MODE) {
      await apiFetch(`/opportunities/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flag_acknowledged: true }) });
    } else {
      await exec("UPDATE opportunities SET flagged = 0, manually_reviewed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
    }
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
    if (LOCAL_MODE) {
      await apiFetch(`/opportunities/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(keys.map(key => [key, payload[key]]))) });
    } else {
      await exec(`UPDATE opportunities SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [...args, id]);
    }
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
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Serialize a value to JSON then escape single-quotes so the result can be
// safely embedded inside a single-quoted HTML attribute (onclick='…').
// JSON.stringify does not escape ' — this does.
function escJs(v) {
  return JSON.stringify(v).replace(/'/g, "&#39;");
}

// Allow only http(s) URLs in href attributes; anything else (javascript:, data:,
// blob:, …) is replaced with "#" so a crafted url field cannot execute code.
function safeUrl(url) {
  if (!url) return "";
  const u = String(url).trim();
  return /^https?:\/\//i.test(u) ? esc(u) : "#";
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
  return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
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
// The local app's "Run" buttons execute a scrape/search/extraction cycle
// live on this machine, streaming progress over SSE. A static page cannot
// run Python/Playwright/LLM calls at all, so here every such button is
// simply `disabled` in HTML with an explanatory tooltip — there is no
// substitute action (no queue; see docs/WEB_APP.md's "What went wrong").
// Everything below (history tables, candidate review, domain restore,
// budget/status display) is ordinary stored data and ports to direct SQL
// exactly like the rest of this file.

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

  document.getElementById("btn-refresh-scrapers").addEventListener("click", () => {
    loadScraperTable();
    loadAggregatorCandidatesTable();
  });
  document.getElementById("btn-refresh-pipeline").addEventListener("click", loadPipelineStatus);
  document.getElementById("btn-refresh-pipeline-runs").addEventListener("click", () => loadPipelineRuns(_pipelineRunsCurrentPage));
  document.getElementById("btn-toggle-excluded-domains").addEventListener("click", toggleExcludedDomainsPanel);
  document.getElementById("btn-close-excluded-domains").addEventListener("click", toggleExcludedDomainsPanel);
}

// ── Researcher budget (ports llm.budget._get_used against llm_usage; the
// model/tpd ceilings come from config.MODEL_LIMITS, which a static page
// can't import — both Groq models currently configured there are mirrored
// here as constants) ─────────────────────────────────────────────────────

const _MODEL_LIMITS = [
  { provider: "groq", model: "llama-3.1-8b-instant",    tpd: 500000 },
  { provider: "groq", model: "llama-3.3-70b-versatile", tpd: 100000 },
];

async function loadResearcherBudget() {
  const budgetEl = document.getElementById("researcher-budget");
  if (!budgetEl) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const parts = [];
    for (const { provider, model, tpd } of _MODEL_LIMITS) {
      const rows = await q(
        "SELECT tokens_in_used, tokens_out_used, requests_used FROM llm_usage WHERE date_utc = ? AND provider = ? AND model = ?",
        [today, provider, model]
      );
      const used = rows[0] || { tokens_in_used: 0, tokens_out_used: 0, requests_used: 0 };
      const label = model.replace(/:free$/, "");
      const remaining = Math.max(0, tpd - used.tokens_in_used - used.tokens_out_used);
      const pct = Math.round(100 * (tpd - remaining) / tpd);
      parts.push(`<span class="budget-chip">${esc(label)} ${(remaining / 1000).toFixed(1)}K left (${pct}% used)</span>`);
    }
    budgetEl.innerHTML = parts.length ? `<span class="budget-label">Budget:</span> ${parts.join(" ")}` : "";
  } catch (_) {}
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
    const runIds = runs.map(r => r.id);
    const digestRows = await q(
      `SELECT run_id FROM digests WHERE run_id IN (${runIds.map(() => "?").join(",")})`,
      runIds
    );
    const hasDigest = new Set(digestRows.map(d => d.run_id));
    const rows = runs.map(r => {
      const dur = r.duration_seconds != null
        ? (r.duration_seconds < 60 ? `${r.duration_seconds}s` : `${Math.round(r.duration_seconds/60)}m`)
        : "—";
      const statusClass = r.status === "completed" ? "run-ok" : r.status === "failed" ? "run-err" : "run-running";
      let statusText = esc(r.status);
      if (r.status === "failed" && r.error_message) {
        statusText = `failed: ${esc(r.error_message.slice(0, 50))}`;
      }
      const digestCell = hasDigest.has(r.id)
        ? `<a class="digest-link" href="#" onclick="event.stopPropagation();showDigest(${r.id});return false;">digest</a>`
        : "—";
      return `<tr class="run-row" data-run-id="${r.id}" title="Click to see queries">
        <td>${r.id}</td>
        <td>${esc(r.mode)}</td>
        <td class="${statusClass}">${statusText}</td>
        <td>${esc(fmtDateTimeLocal(r.started_at))}</td>
        <td>${r.queries_tried ?? "—"}</td>
        <td>${r.results_found ?? "—"}</td>
        <td>${r.new_opportunities ?? "—"}</td>
        <td>${dur}</td>
        <td>${digestCell}</td>
      </tr>`;
    }).join("");
    el.innerHTML = `<table>
      <thead><tr><th>#</th><th>Mode</th><th>Status</th><th>Started</th>
        <th>Queries</th><th>Results</th><th>New opps</th><th>Duration</th><th>Digest</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div id="digest-panel" style="display:none;margin-top:8px"></div>`;
    el.querySelectorAll(".run-row").forEach(tr => {
      tr.addEventListener("click", () => toggleRunDetail(parseInt(tr.dataset.runId)));
    });
  } catch (e) {
    el.innerHTML = `<p class="run-err">Could not load runs: ${esc(e.message)}</p>`;
  }
}

async function showDigest(runId) {
  const panel = document.getElementById("digest-panel");
  if (!panel) return;
  if (panel.dataset.runId === String(runId) && panel.style.display !== "none") {
    panel.style.display = "none";
    return;
  }
  panel.dataset.runId = String(runId);
  panel.style.display = "block";
  panel.innerHTML = "<p style='color:#666;font-size:13px'>Loading digest…</p>";
  try {
    const rows = await q("SELECT markdown FROM digests WHERE run_id = ? ORDER BY id DESC LIMIT 1", [runId]);
    if (!rows.length) { panel.innerHTML = "<p class='run-err'>Digest not found.</p>"; return; }
    panel.innerHTML = `<pre style="white-space:pre-wrap;background:#f8f8f8;border:1px solid #ddd;border-radius:4px;padding:10px;font-size:13px;max-height:400px;overflow:auto">${esc(rows[0].markdown)}</pre>`;
  } catch (e) {
    panel.innerHTML = `<p class="run-err">Could not load digest: ${esc(e.message)}</p>`;
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

// ── Pipeline run/source drill-down (ports web/app.py's /pipeline/rejected/llm,
// /pipeline/extracted, /pipeline/aggregators, /pipeline/runs/{id}/aggregators —
// raw_scrape.pipeline_run_id is a permanent tag written once when each row is
// processed (pipeline/batch.py, extract.py, prefilter.py), not an in-flight-only
// marker, so these drill-downs work the same for a finished historical run as
// for one watched live. ───────────────────────────────────────────────────────

function _sourceFilterClause(source) {
  if (!source || source === "__all__") return { clause: "", params: [] };
  if (source.startsWith("Researcher: ")) {
    const mode = source.slice("Researcher: ".length);
    if (mode === "unknown") {
      return {
        clause: ` AND rs.query_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM query_log ql
                  JOIN researcher_runs rr ON ql.run_id=rr.id WHERE ql.id=rs.query_id AND rr.mode IS NOT NULL)`,
        params: [],
      };
    }
    return {
      clause: ` AND rs.query_id IS NOT NULL AND EXISTS(SELECT 1 FROM query_log ql
                JOIN researcher_runs rr ON ql.run_id=rr.id WHERE ql.id=rs.query_id AND rr.mode=?)`,
      params: [mode],
    };
  }
  return { clause: " AND s.name = ?", params: [source] };
}

function _normalizeError(msg) {
  if (!msg) return "unknown";
  let m = msg.match(/^((?:Client|Server) error '[^']+') for url/);
  if (m) return m[1];
  if (msg.includes("Connection closed while reading from the driver")) return "Browser crash: connection closed";
  if (msg.includes("TargetClosedError")) return "Browser crash: target closed";
  if (msg.includes("Timeout") && msg.includes("exceeded")) return "Page load timeout";
  if (msg.toLowerCase().includes("timed out")) return "Request timed out";
  if (msg.includes("forcibly closed")) return "Connection reset by remote host";
  if (msg.includes("UNIQUE constraint") || msg.includes("IntegrityError")) return "DB constraint / integrity error";
  if (msg.includes("JSONDecodeError") || msg.includes("json.decoder")) return "LLM response: JSON parse error";
  if (msg.startsWith("http_")) return msg.trim();
  return msg.split("\n")[0].slice(0, 120);
}

const _SOURCE_SQL_EXPR = `COALESCE(s.name,
  CASE WHEN rs.query_id IS NOT NULL
       THEN 'Researcher: ' || COALESCE(
           (SELECT rr.mode FROM query_log ql JOIN researcher_runs rr ON ql.run_id = rr.id WHERE ql.id = rs.query_id),
           'unknown')
       ELSE 'unknown'
  END)`;

let _psVisible = null; // "source::type" key, or null
let _psExtractedKey = null;
let _rejectedRows = [];
let _plRunPanelKey = null;
let _lastAggRunPanelArgs = null;
let _runPanelRows = [];

// No-arg close handlers for the drill-down panels. Using a no-arg call in the
// inline onclick avoids ever embedding JSON.stringify (double quotes) in the
// attribute — the quoting bug that kept silently truncating the close button.
// They just hide the panel and reset its toggle key so the number reopens it.
function closeRunPanel() {
  const p = document.getElementById("pl-run-rej-panel");
  if (p) { p.style.display = "none"; p.innerHTML = ""; }
  _plRunPanelKey = null;
}
function closeBreakdownPanel() {
  const p = document.getElementById("ps-breakdown-panel");
  if (p) { p.style.display = "none"; p.innerHTML = ""; }
  _psVisible = null;
  _psExtractedKey = null;
}
let _runPanelMeta = null;

function _psBtn(count, source, type, cls) {
  if (!count) return "";
  return `<button class="ps-breakdown-btn ${cls}" onclick='showPipelineBreakdown(${escJs(source)},${escJs(type)})'>${count}</button>`;
}

async function showPipelineBreakdown(source, type) {
  const panel = document.getElementById("ps-breakdown-panel");
  if (!panel) return;
  const key = `${source}::${type}`;
  if (_psVisible === key) { panel.style.display = "none"; _psVisible = null; return; }
  _psVisible = key;
  const isAll = source === "__all__";
  const sourceLabel = isAll ? "All sources" : source;
  panel.innerHTML = `<div class="psb-title">Errors — ${esc(sourceLabel)} <em>loading…</em></div>`;
  panel.style.display = "block";
  try {
    const { clause, params } = _sourceFilterClause(source);
    const rows = await q(`
      SELECT
        CASE WHEN rs.processed = 0 THEN 'scrape' ELSE 'pipeline' END AS err_type,
        rs.error AS error_msg,
        COUNT(*) AS cnt,
        MAX(rs.scraped_at) AS last_seen,
        MAX(rs.pipeline_run_id) AS last_run_id
      FROM raw_scrape rs
      LEFT JOIN sources s ON rs.source_id = s.id
      WHERE rs.error IS NOT NULL${clause}
      GROUP BY 1, rs.error
    `, params);
    if (_psVisible !== key) return;
    if (!rows.length) { panel.innerHTML = `<em>No errors.</em>`; return; }
    const TYPE_LABEL = { scrape: "Scrape error", pipeline: "Pipeline error" };
    const grouped = {};
    for (const r of rows) {
      const snippet = _normalizeError(r.error_msg);
      const k = `${r.err_type}::${snippet}`;
      if (!grouped[k]) grouped[k] = { type: r.err_type, snippet, count: 0, last_seen: null, last_run_id: null };
      grouped[k].count += r.cnt;
      if (!grouped[k].last_run_id || (r.last_run_id && r.last_run_id > grouped[k].last_run_id)) {
        grouped[k].last_run_id = r.last_run_id;
        grouped[k].last_seen = r.last_seen;
      }
    }
    const items = Object.values(grouped).sort((a, b) => b.count - a.count);
    const clearBtn = `<button class="psb-clear-btn" onclick='clearPipelineErrors(${escJs(source)})'>Clear errors</button>`;
    const html = items.map(e => {
      const datePart = e.last_seen ? `<span class="psb-meta">${esc(fmtDateTimeLocal(e.last_seen))}</span>` : "";
      const runPart = e.last_run_id ? `<span class="psb-meta">run #${e.last_run_id}</span>` : "";
      return `<div class="psb-group">
        <div class="psb-group-header">
          <span class="psb-count">${e.count}</span>
          <span class="psb-label psb-err-type">${esc(TYPE_LABEL[e.type])}</span>
          ${datePart}${runPart}
        </div>
        <div class="psb-detail psb-snippet">${esc(e.snippet)}</div>
      </div>`;
    }).join("") + `<div class="psb-actions">${clearBtn}</div>`;
    panel.innerHTML =
      `<div class="psb-title">${esc(`Errors — ${sourceLabel}`)} ` +
      `<button class="run-detail-close" onclick='showPipelineBreakdown(${escJs(source)},${escJs(type)})'>close</button></div>` +
      html;
  } catch (e) {
    if (_psVisible === key) panel.innerHTML = `<em>Error: ${esc(e.message)}</em>`;
  }
}

async function clearPipelineErrors(source) {
  if (!confirm(`Delete all error rows for "${source === "__all__" ? "all sources" : source}"? They will be re-scraped on the next scraper run.`)) return;
  try {
    if (LOCAL_MODE) {
      const qs = source !== "__all__" ? `?source=${encodeURIComponent(source)}` : "";
      await apiFetch(`/pipeline/errors/clear${qs}`, { method: "POST" });
    } else if (source !== "__all__") {
      if (source.startsWith("Researcher: ")) {
        const mode = source.slice("Researcher: ".length);
        await exec(`DELETE FROM raw_scrape WHERE error IS NOT NULL AND query_id IS NOT NULL
          AND EXISTS(SELECT 1 FROM query_log ql JOIN researcher_runs rr ON ql.run_id=rr.id WHERE ql.id=raw_scrape.query_id AND rr.mode=?)`, [mode]);
      } else {
        await exec(`DELETE FROM raw_scrape WHERE error IS NOT NULL AND source_id=(SELECT id FROM sources WHERE name=?)`, [source]);
      }
    } else {
      await exec("DELETE FROM raw_scrape WHERE error IS NOT NULL", []);
    }
    _psVisible = null;
    await loadPipelineStatus();
  } catch (e) {
    alert(`Clear errors failed: ${e.message || e}`);
  }
}

function _rejectedListHtml(rows, label, source, group, page = 1) {
  const closeBtn = `<button class="run-detail-close" onclick='showRejectedList(${escJs(source)},${escJs(group)})'>close</button>`;
  if (!rows.length) return `<div class="psb-title">${esc(label)} ${closeBtn}</div><em>None found.</em>`;
  const totalPages = Math.ceil(rows.length / _REJECTED_PAGE_SIZE);
  const p = Math.max(1, Math.min(page, totalPages));
  const slice = rows.slice((p - 1) * _REJECTED_PAGE_SIZE, p * _REJECTED_PAGE_SIZE);
  const hasQuery = rows.some(r => r.query_text);
  const hasSnippet = rows.some(r => r.snippet);
  const hasReason = rows.some(r => r.rejection_reason);
  const hasType = rows.some(r => r.rejection_kind);
  const thQuery = hasQuery ? "<th>Query</th>" : "";
  const thSnip = hasSnippet ? "<th>Snippet</th>" : "";
  const thReason = hasReason ? "<th>Reason</th>" : "";
  const thType = hasType ? "<th>Type</th>" : "";
  const trs = slice.map(r => {
    const urlShort = r.url.replace(/^https?:\/\//, "").slice(0, 55);
    const tdDate = `<td class="psbt-date">${esc((r.scraped_at || "").slice(0, 10))}</td>`;
    const tdQuery = hasQuery ? `<td class="psbt-query">${esc((r.query_text || "").slice(0, 60))}</td>` : "";
    const tdSnip = hasSnippet ? `<td class="psbt-snip">${esc((r.snippet || "").slice(0, 100))}</td>` : "";
    const tdReason = hasReason ? `<td class="psbt-reason">${esc(r.rejection_reason || "")}</td>` : "";
    const tdType = hasType ? `<td class="psbt-kind">${esc(r.rejection_kind || "")}</td>` : "";
    return `<tr>
      <td class="psbt-url"><a href="${safeUrl(r.url)}" target="_blank" title="${esc(r.url)}">${esc(urlShort)}</a></td>
      ${tdDate}${tdQuery}${tdSnip}${tdReason}${tdType}
    </tr>`;
  }).join("");
  const srcJ = escJs(source), grpJ = escJs(group);
  const pageInfo = totalPages > 1 ? ` — page ${p}/${totalPages}` : "";
  const pageNav = totalPages > 1
    ? `<span class="psb-page-nav">
        <button class="run-detail-close" ${p <= 1 ? "disabled" : `onclick='_rejectedListPage(${srcJ},${grpJ},${p - 1})'`}>Prev</button>
        <button class="run-detail-close" ${p >= totalPages ? "disabled" : `onclick='_rejectedListPage(${srcJ},${grpJ},${p + 1})'`}>Next</button>
      </span>`
    : "";
  return `<div class="psb-title">${esc(label)} (${rows.length})${pageInfo}${pageNav}${closeBtn}</div>
    <table class="psb-table"><thead><tr><th>URL</th><th>Scraped</th>${thQuery}${thSnip}${thReason}${thType}</tr></thead>
    <tbody>${trs}</tbody></table>`;
}

function _rejectedListPage(source, group, page) {
  const panel = document.getElementById("ps-breakdown-panel");
  if (!panel) return;
  const srcLabel = source === "__all__" ? "All sources" : source;
  const typeLabel = group === "prefilter" ? "Pre-filter rejected" : group === "dedup" ? "Dedup (known/duplicate)" : group === "prefilter_passed" ? "Pre-filter passed (awaiting eval)" : "Evaluation rejected";
  panel.innerHTML = _rejectedListHtml(_rejectedRows, `${typeLabel} — ${srcLabel}`, source, group, page);
}

const _REJECT_GROUP_CLAUSE = {
  llm_rejected: ` AND rs.llm_batch_id IS NOT NULL AND rs.aggregator_note IS NULL
                  AND COALESCE(rs.rejection_reason, '') NOT LIKE 'cross_listing:%'
                  AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.url = rs.url)`,
  prefilter: " AND rs.skip_reason = 'prefilter_not_opportunity' AND rs.aggregator_note IS NULL",
  prefilter_passed: ` AND rs.skip_reason IS NULL AND rs.error IS NULL AND rs.prefilter_signals IS NOT NULL
                       AND rs.aggregator_note IS NULL AND rs.llm_batch_id IS NULL`,
  cross_listing: " AND rs.rejection_reason LIKE 'cross_listing:%'",
  dedup: " AND rs.skip_reason IN ('duplicate_pending_url', 'known_url_unchanged')",
};

async function _fetchRejectedList(source, group, runId) {
  const groupClause = _REJECT_GROUP_CLAUSE[group] || _REJECT_GROUP_CLAUSE.llm_rejected;
  const { clause: srcClause, params: srcParams } = _sourceFilterClause(source);
  const params = [...srcParams];
  let runClause = "";
  if (runId != null) { runClause = " AND rs.pipeline_run_id = ?"; params.push(runId); }
  const rows = await q(`
    SELECT rs.url, rs.raw_text, rs.scraped_at, rs.rejection_reason, rs.rejection_kind,
           ${_SOURCE_SQL_EXPR} AS source, ql.query_text, rr.mode AS researcher_mode
    FROM raw_scrape rs
    LEFT JOIN sources s ON rs.source_id = s.id
    LEFT JOIN query_log ql ON rs.query_id = ql.id
    LEFT JOIN researcher_runs rr ON ql.run_id = rr.id
    WHERE rs.processed = 1 AND rs.error IS NULL${groupClause}${srcClause}${runClause}
    ORDER BY rs.processed_at DESC LIMIT 2000
  `, params);
  return rows.map(r => ({
    url: r.url, source: r.source, query_text: r.query_text, researcher_mode: r.researcher_mode,
    scraped_at: r.scraped_at, rejection_reason: r.rejection_reason, rejection_kind: r.rejection_kind,
    snippet: r.raw_text ? r.raw_text.slice(0, 400).trim() : null,
  }));
}

async function showRejectedList(source, group) {
  const panel = document.getElementById("ps-breakdown-panel");
  if (!panel) return;
  const key = `${source}::${group}`;
  if (_psVisible === key) { panel.style.display = "none"; _psVisible = null; return; }
  _psVisible = key;
  const srcLabel = source === "__all__" ? "All sources" : source;
  const typeLabel = group === "prefilter" ? "Pre-filter rejected" : group === "dedup" ? "Dedup (known/duplicate)" : group === "prefilter_passed" ? "Pre-filter passed (awaiting eval)" : "Evaluation rejected";
  const label = `${typeLabel} — ${srcLabel}`;
  panel.innerHTML = `<div class="psb-title">${esc(label)} <em>loading…</em></div>`;
  panel.style.display = "block";
  try {
    const rows = await _fetchRejectedList(source, group, null);
    if (_psVisible !== key) return;
    _rejectedRows = rows;
    panel.innerHTML = _rejectedListHtml(rows, label, source, group, 1);
  } catch (e) {
    if (_psVisible === key) panel.innerHTML = `<em>Error: ${esc(e.message)}</em>`;
  }
}

function _aggregatorListHtml(rows, label, closeJs) {
  // esc() so JSON.stringify's double quotes in closeJs don't terminate the
  // double-quoted onclick attribute; the browser decodes &quot; back to " .
  const closeBtn = `<button class="run-detail-close" onclick="${esc(closeJs)}">close</button>`;
  if (!rows.length) return `<div class="psb-title">${esc(label)} ${closeBtn}</div><em>None found.</em>`;
  const statusClass = { candidate: "st-agg-candidate", confirmed: "st-agg-confirmed", rejected: "st-agg-rejected" };
  let html = `<div class="psb-title">${esc(label)} (${rows.length}) ${closeBtn}</div>`;
  html += `<table class="psb-table"><tbody>`;
  for (const r of rows) {
    const urlShort = r.url.replace(/^https?:\/\//, "").slice(0, 55);
    const badge = r.aggregator_status && r.aggregator_status !== "none"
      ? `<span class="st-agg-badge ${statusClass[r.aggregator_status] || ""}">${esc(r.aggregator_status)}</span>`
      : "";
    const note = (r.aggregator_note || "").slice(0, 100);
    const actions = (r.aggregator_status === "candidate" && r.source_id)
      ? `<button class="btn-agg-confirm" style="padding:1px 6px;font-size:0.78em;" onclick="event.stopPropagation();aggAction(${r.source_id},'confirm')">✓</button>
         <button class="btn-agg-reject" style="padding:1px 6px;font-size:0.78em;margin-left:2px;" onclick="event.stopPropagation();aggAction(${r.source_id},'reject')">✗</button>`
      : "";
    html += `<tr${r.source_id ? ` data-id="${r.source_id}"` : ""}>
                 <td class="psbt-url"><a href="${safeUrl(r.url)}" target="_blank" title="${esc(r.url)}">${esc(urlShort)}</a> ${badge}</td>
                 <td class="psbt-date">${esc((r.scraped_at || "").slice(0, 10))}</td>
                 <td class="psbt-snip">${esc(note)}</td>
                 <td style="white-space:nowrap">${actions}</td>
               </tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

async function _fetchAggregatorRows(whereSql, params) {
  const rows = await q(`
    SELECT rs.url, rs.scraped_at, rs.aggregator_note, ${_SOURCE_SQL_EXPR} AS source
    FROM raw_scrape rs
    LEFT JOIN sources s ON rs.source_id = s.id
    LEFT JOIN query_log ql ON rs.query_id = ql.id
    LEFT JOIN researcher_runs rr ON ql.run_id = rr.id
    WHERE rs.aggregator_note IS NOT NULL${whereSql}
    ORDER BY rs.scraped_at DESC
  `, params);
  const result = [];
  for (const r of rows) {
    let domainUrl = null, status = "none", sourceId = null;
    try {
      const u = new URL(r.url);
      domainUrl = `${u.protocol}//${u.host}`;
    } catch (_) {}
    if (domainUrl) {
      const srcRows = await q("SELECT id, aggregator_status FROM sources WHERE url=?", [domainUrl]);
      if (srcRows[0]) { status = srcRows[0].aggregator_status || "none"; sourceId = srcRows[0].id; }
    }
    result.push({
      url: r.url, domain: domainUrl, source_id: sourceId, scraped_at: r.scraped_at,
      source: r.source, aggregator_note: r.aggregator_note, aggregator_status: status,
    });
  }
  return result;
}

async function showAggregatorList(source) {
  const panel = document.getElementById("ps-breakdown-panel");
  if (!panel) return;
  const key = `${source}::aggregators`;
  if (_psVisible === key) { panel.style.display = "none"; _psVisible = null; return; }
  _psVisible = key;
  const srcLabel = source === "__all__" ? "All sources" : source;
  const label = `Aggregator candidates — ${srcLabel}`;
  panel.innerHTML = `<div class="psb-title">${esc(label)} <em>loading…</em></div>`;
  panel.style.display = "block";
  try {
    const { clause, params } = _sourceFilterClause(source);
    const rows = await _fetchAggregatorRows(clause, params);
    if (_psVisible !== key) return;
    panel.innerHTML = _aggregatorListHtml(rows, label, "closeBreakdownPanel()");
  } catch (e) {
    if (_psVisible === key) panel.innerHTML = `<em>Error: ${esc(e.message)}</em>`;
  }
}

async function showExtractedList(source) {
  const panel = document.getElementById("ps-breakdown-panel");
  if (!panel) return;
  const key = `${source}::extracted`;
  if (_psExtractedKey === key) { panel.style.display = "none"; _psExtractedKey = null; return; }
  _psExtractedKey = key;
  _psVisible = null;
  const srcLabel = source === "__all__" ? "All sources" : source;
  const label = `Extracted ✓ — ${srcLabel}`;
  panel.innerHTML = `<div class="psb-title">${esc(label)} <em>loading…</em></div>`;
  panel.style.display = "block";
  try {
    const { clause, params } = _sourceFilterClause(source);
    const rows = await q(`
      SELECT o.id, o.title, o.url, o.deadline, COALESCE(o.manual_tier, o.llm_tier) AS tier,
             rs.scraped_at, ${_SOURCE_SQL_EXPR} AS source
      FROM raw_scrape rs
      JOIN opportunities o ON o.url = rs.url
      LEFT JOIN sources s ON rs.source_id = s.id
      LEFT JOIN query_log ql ON rs.query_id = ql.id
      LEFT JOIN researcher_runs rr ON ql.run_id = rr.id
      WHERE rs.processed = 1 AND rs.error IS NULL${clause}
      ORDER BY rs.processed_at DESC LIMIT 2000
    `, params);
    if (_psExtractedKey !== key) return;
    const closeJs = "closeBreakdownPanel()";
    panel.innerHTML = _groupedUrlListHtml(rows, label, closeJs, true, 1);
    _runPanelRows = rows;
    _runPanelMeta = { label, closeJs, isExtracted: true, panelId: "ps-breakdown-panel" };
  } catch (e) {
    if (_psExtractedKey === key) panel.innerHTML = `<em>Error: ${esc(e.message)}</em>`;
  }
}

function _groupedUrlListHtml(rows, label, closeJs, isExtracted, page = 1) {
  // esc() so JSON.stringify's double quotes in closeJs don't terminate the
  // double-quoted onclick attribute; the browser decodes &quot; back to " .
  const closeBtn = `<button class="run-detail-close" onclick="${esc(closeJs)}">close</button>`;
  if (!rows.length) return `<div class="psb-title">${esc(label)} ${closeBtn}</div><em>None found.</em>`;
  const totalPages = Math.ceil(rows.length / _REJECTED_PAGE_SIZE);
  const p = Math.max(1, Math.min(page, totalPages));
  const slice = rows.slice((p - 1) * _REJECTED_PAGE_SIZE, p * _REJECTED_PAGE_SIZE);
  const groups = {};
  for (const r of slice) {
    const src = r.source || "Unknown";
    if (!groups[src]) groups[src] = [];
    groups[src].push(r);
  }
  const pageInfo = totalPages > 1 ? ` — page ${p}/${totalPages}` : "";
  const pageNav = totalPages > 1
    ? `<span class="psb-page-nav">
        <button class="run-detail-close" ${p <= 1 ? "disabled" : `onclick='_runPanelPage(${p - 1})'`}>Prev</button>
        <button class="run-detail-close" ${p >= totalPages ? "disabled" : `onclick='_runPanelPage(${p + 1})'`}>Next</button>
      </span>`
    : "";
  let html = `<div class="psb-title">${esc(label)} (${rows.length})${pageInfo}${pageNav} ${closeBtn}</div>`;
  for (const [src, items] of Object.entries(groups)) {
    html += `<div class="psb-source-group">${esc(src)} <span class="psb-group-count">(${items.length})</span></div>`;
    if (isExtracted) {
      html += `<table class="psb-table"><thead><tr><th>Title</th><th>Scraped</th></tr></thead><tbody>`;
      for (const r of items) {
        const title = esc((r.title || r.url.replace(/^https?:\/\//, "")).slice(0, 65));
        const tier = r.tier ? `<span class="tier-badge tier-${r.tier}" title="${esc(tierTitle(r.tier))}">T${r.tier}</span> ` : "";
        const link = r.id
          ? `<a href="#${r.id}" onclick="openDetail(${r.id});return false;">${title}</a>`
          : `<a href="${safeUrl(r.url)}" target="_blank" title="${esc(r.url)}">${title}</a>`;
        html += `<tr><td class="psbt-url">${tier}${link}</td>
                     <td class="psbt-date">${esc((r.scraped_at || "").slice(0, 10))}</td></tr>`;
      }
      html += `</tbody></table>`;
    } else {
      const hasSnippet = items.some(r => r.snippet);
      const hasReason = items.some(r => r.rejection_reason);
      const hasType = items.some(r => r.rejection_kind);
      const thSnip = hasSnippet ? "<th>Snippet</th>" : "";
      const thReason = hasReason ? "<th>Reason</th>" : "";
      const thType = hasType ? "<th>Type</th>" : "";
      html += `<table class="psb-table"><thead><tr><th>URL</th><th>Scraped</th>${thSnip}${thReason}${thType}</tr></thead><tbody>`;
      for (const r of items) {
        const urlShort = r.url.replace(/^https?:\/\//, "").slice(0, 55);
        const tdSnip = hasSnippet ? `<td class="psbt-snip">${esc((r.snippet || "").slice(0, 100))}</td>` : "";
        const tdReason = hasReason ? `<td class="psbt-reason">${esc(r.rejection_reason || "")}</td>` : "";
        const tdType = hasType ? `<td class="psbt-kind">${esc(r.rejection_kind || "")}</td>` : "";
        html += `<tr><td class="psbt-url"><a href="${safeUrl(r.url)}" target="_blank" title="${esc(r.url)}">${esc(urlShort)}</a></td>
                     <td class="psbt-date">${esc((r.scraped_at || "").slice(0, 10))}</td>
                     ${tdSnip}${tdReason}${tdType}</tr>`;
      }
      html += `</tbody></table>`;
    }
  }
  return html;
}

function _runPanelPage(page) {
  const panel = document.getElementById(_runPanelMeta?.panelId || "pl-run-rej-panel");
  if (!panel || !_runPanelMeta) return;
  panel.innerHTML = _groupedUrlListHtml(_runPanelRows, _runPanelMeta.label, _runPanelMeta.closeJs, _runPanelMeta.isExtracted, page);
}

async function showRunCountPanel(runId, group, after, before) {
  const panel = document.getElementById("pl-run-rej-panel");
  if (!panel) return;
  const key = `${runId}::${group}`;
  if (_plRunPanelKey === key) { panel.style.display = "none"; _plRunPanelKey = null; return; }
  _plRunPanelKey = key;
  if (group === "aggregators") _lastAggRunPanelArgs = { runId, after, before };
  const typeLabel = group === "extracted" ? "Extracted ✓" : group === "prefilter_passed" ? "Pre-filter ✓" : group === "prefilter" ? "Pre-filter ✗" : group === "dedup" ? "Dedup ✗" : group === "cross_listing" ? "Cross-listings ✗" : group === "aggregators" ? "Aggregator candidates" : "Evaluation ✗";
  panel.innerHTML = `<div class="psb-title">Run #${runId} — ${esc(typeLabel)} <em>loading…</em></div>`;
  panel.style.display = "block";
  const closeJs = "closeRunPanel()";
  try {
    if (group === "aggregators") {
      const rows = await _fetchAggregatorRows(" AND rs.pipeline_run_id = ?", [runId]);
      if (_plRunPanelKey !== key) return;
      panel.innerHTML = _aggregatorListHtml(rows, `Run #${runId} — ${esc(typeLabel)}`, closeJs);
      return;
    }
    let rows, isExtracted = false;
    if (group === "extracted") {
      isExtracted = true;
      rows = await q(`
        SELECT o.id, o.title, o.url, o.deadline, COALESCE(o.manual_tier, o.llm_tier) AS tier,
               rs.scraped_at, ${_SOURCE_SQL_EXPR} AS source
        FROM raw_scrape rs
        JOIN opportunities o ON o.url = rs.url
        LEFT JOIN sources s ON rs.source_id = s.id
        LEFT JOIN query_log ql ON rs.query_id = ql.id
        LEFT JOIN researcher_runs rr ON ql.run_id = rr.id
        WHERE rs.processed = 1 AND rs.error IS NULL AND rs.pipeline_run_id = ?
        ORDER BY rs.processed_at DESC LIMIT 2000
      `, [runId]);
    } else if (group === "cross_listing") {
      isExtracted = true;
      rows = await q(`
        SELECT DISTINCT o.id, o.title, o.url, o.deadline, COALESCE(o.manual_tier, o.llm_tier) AS tier,
               rs.scraped_at, ${_SOURCE_SQL_EXPR} AS source
        FROM raw_scrape rs
        JOIN opportunities o ON o.id = CAST(SUBSTR(rs.rejection_reason, 15) AS INTEGER)
        LEFT JOIN sources s ON rs.source_id = s.id
        LEFT JOIN query_log ql ON rs.query_id = ql.id
        LEFT JOIN researcher_runs rr ON ql.run_id = rr.id
        WHERE rs.processed = 1 AND rs.error IS NULL AND rs.rejection_reason LIKE 'cross_listing:%'
              AND rs.pipeline_run_id = ?
        UNION
        SELECT DISTINCT COALESCE(o.id, 0) AS id,
               COALESCE(o.title, rs.rejection_reason, '(URL already in DB)') AS title,
               rs.url, o.deadline, COALESCE(o.manual_tier, o.llm_tier) AS tier,
               rs.scraped_at, ${_SOURCE_SQL_EXPR} AS source
        FROM raw_scrape rs
        LEFT JOIN opportunities o ON o.url = rs.url
        LEFT JOIN sources s ON rs.source_id = s.id
        LEFT JOIN query_log ql ON rs.query_id = ql.id
        LEFT JOIN researcher_runs rr ON ql.run_id = rr.id
        WHERE rs.processed = 1 AND rs.error IS NULL AND rs.skip_reason = 'url_hash_conflict'
              AND rs.pipeline_run_id = ?
        ORDER BY scraped_at DESC LIMIT 2000
      `, [runId, runId]);
    } else {
      const g = group === "prefilter" ? "prefilter" : group === "prefilter_passed" ? "prefilter_passed" : group === "dedup" ? "dedup" : "llm_rejected";
      rows = await _fetchRejectedList("__all__", g, runId);
    }
    if (_plRunPanelKey !== key) return;
    _runPanelRows = rows;
    _runPanelMeta = { label: `Run #${runId} — ${esc(typeLabel)}`, closeJs, isExtracted, panelId: "pl-run-rej-panel" };
    panel.innerHTML = _groupedUrlListHtml(rows, _runPanelMeta.label, closeJs, isExtracted, 1);
  } catch (e) {
    if (_plRunPanelKey === key) panel.innerHTML = `<em>Error: ${esc(e.message)}</em>`;
  }
}

let _pipelineRunsCurrentPage = 1;
const _PIPELINE_RUNS_PAGE_SIZE = 5;

async function loadPipelineRuns(page = 1) {
  const el = document.getElementById("pipeline-runs");
  if (!el) return;
  _pipelineRunsCurrentPage = page;
  try {
    const totalRuns = (await q("SELECT COUNT(*) AS n FROM pipeline_runs"))[0].n;
    const pagerEl = document.getElementById("pipeline-runs-pager");
    const offset = (page - 1) * _PIPELINE_RUNS_PAGE_SIZE;
    const runs = await q(`
      SELECT id, status, extract_mode, source_filter, triggered_by, batches,
             gate_retries, cot_max_context_tokens, cot_output_tokens,
             api_tokens_in, api_tokens_out,
             new_opportunities, rejected, eval_dropped, duplicates, errors, aggregators,
             started_at, finished_at,
             CAST((JULIANDAY(COALESCE(finished_at, datetime('now'))) - JULIANDAY(started_at)) * 86400 AS INTEGER) AS duration_seconds
      FROM pipeline_runs ORDER BY id DESC LIMIT ? OFFSET ?
    `, [_PIPELINE_RUNS_PAGE_SIZE, offset]);
    if (!runs.length) {
      if (page === 1) { el.innerHTML = ""; if (pagerEl) pagerEl.innerHTML = ""; }
      return;
    }
    const runIds = runs.map(r => r.id);
    const liveRows = await q(`
      SELECT
        rs.pipeline_run_id AS run_id,
        COUNT(*) AS live_total,
        SUM(CASE WHEN rs.processed = 1 AND rs.error IS NULL AND EXISTS(SELECT 1 FROM opportunities o WHERE o.url = rs.url) THEN 1 ELSE 0 END) AS live_extracted,
        SUM(CASE WHEN rs.skip_reason = 'prefilter_not_opportunity' AND rs.aggregator_note IS NULL THEN 1 ELSE 0 END) AS live_prefilter,
        SUM(CASE WHEN rs.skip_reason IS NULL AND rs.error IS NULL AND rs.processed = 1
                  AND rs.prefilter_signals IS NOT NULL AND rs.aggregator_note IS NULL AND rs.llm_batch_id IS NULL
                  AND NOT EXISTS(SELECT 1 FROM opportunities o WHERE o.url = rs.url) THEN 1 ELSE 0 END) AS live_prefilter_passed,
        SUM(CASE WHEN rs.llm_batch_id IS NOT NULL AND rs.skip_reason IS NULL AND rs.aggregator_note IS NULL
                  AND COALESCE(rs.rejection_reason, '') NOT LIKE 'cross_listing:%'
                  AND NOT EXISTS(SELECT 1 FROM opportunities o WHERE o.url = rs.url) THEN 1 ELSE 0 END) AS live_eval,
        SUM(CASE WHEN rs.skip_reason IN ('duplicate_pending_url','known_url_unchanged','url_hash_conflict')
                  OR rs.rejection_reason LIKE 'cross_listing:%' THEN 1 ELSE 0 END) AS live_dedup,
        SUM(CASE WHEN rs.error IS NOT NULL THEN 1 ELSE 0 END) AS live_errors,
        SUM(CASE WHEN rs.aggregator_note IS NOT NULL THEN 1 ELSE 0 END) AS live_aggregators
      FROM raw_scrape rs
      WHERE rs.pipeline_run_id IN (${runIds.map(() => "?").join(",")})
      GROUP BY 1
    `, runIds);
    const liveByRun = {};
    for (const lr of liveRows) liveByRun[lr.run_id] = lr;

    const rows = runs.map(r => {
      const dur = r.duration_seconds != null
        ? (r.duration_seconds < 60 ? `${r.duration_seconds}s` : `${Math.round(r.duration_seconds / 60)}m`)
        : "—";
      const statusClass = r.status === "completed" ? "run-ok"
        : (r.status === "failed" || r.status === "aborted") ? "run-err"
        : r.status === "token_limit" ? "run-warn"
        : "run-running";
      const statusLabel = r.status === "token_limit" ? "token limit" : r.status;
      let statusText = (r.status === "failed" || r.status === "aborted" || r.status === "token_limit") && r.error_message
        ? `${esc(statusLabel)}: ${esc(r.error_message.split(" — ")[0].slice(0, 40))}`
        : esc(statusLabel);
      if (r.gate_retries > 0 && r.status === "completed") {
        statusText += ` <span class="run-gate-note" title="Proof-of-read gate rejected and retried this many times before passing">(${r.gate_retries} gate retr${r.gate_retries === 1 ? "y" : "ies"})</span>`;
      }
      const scheduledBadge = r.triggered_by === "scheduled"
        ? ` <span class="run-scheduled-badge" title="Triggered by a Claude scheduled task">⏰</span>`
        : "";
      const modeLabel = (r.source_filter
        ? `${esc(r.extract_mode || "quality")} · ${esc(r.source_filter.slice(0, 30))}`
        : esc(r.extract_mode || "quality")) + scheduledBadge;
      const id = r.id;
      const live = liveByRun[r.id];
      const hasLive = !!live && (live.live_total || 0) > 0;
      const ext    = hasLive ? (live.live_extracted || 0)        : (r.new_opportunities || 0);
      const pfPass = hasLive ? (live.live_prefilter_passed || 0) : 0;
      const pf     = hasLive ? (live.live_prefilter || 0)        : (r.rejected || 0);
      const ev     = hasLive ? (live.live_eval || 0)             : (r.eval_dropped || 0);
      const dup    = hasLive ? (live.live_dedup || 0)            : (r.duplicates || 0);
      const err    = hasLive ? (live.live_errors || 0)           : (r.errors || 0);
      const agg    = hasLive ? (live.live_aggregators || 0)      : (r.aggregators || 0);
      const total = hasLive ? (live.live_total || 0) : (ext + pf + ev + dup + err);
      const t0 = r.started_at || "";
      const t1 = r.finished_at || "";
      const canDrill = hasLive || !!r.finished_at;
      const isClaudeRun = r.extract_mode && (r.extract_mode === "claude" || r.extract_mode === "claude_prefilter");
      const dupGroup = isClaudeRun ? "cross_listing" : "dedup";
      const mkBtn = (n, group, cls) => {
        const drillable = n > 0 && (group === "dedup" ? hasLive : canDrill);
        return drillable
          ? `<button class="ps-breakdown-btn ${cls}" onclick="event.stopPropagation();showRunCountPanel(${id},'${group}','${t0}','${t1}')">${n}</button>`
          : (n > 0 ? `<span class="ps-num">${n}</span>` : "");
      };
      const canDelete = r.status !== "running";
      const deleteBtn = canDelete
        ? `<button class="ps-delete-btn" title="Delete run and reset rows for reprocessing" onclick="event.stopPropagation();deletePipelineRun(${id})">✕</button>`
        : "";
      const fmtTok = n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
      const tokens = r.cot_max_context_tokens != null
        ? `<span title="Peak single-call context size">${fmtTok(r.cot_max_context_tokens)}</span> / <span title="Total output tokens generated">${fmtTok(r.cot_output_tokens || 0)}</span>`
        : r.api_tokens_in != null
        ? `<span title="Total input tokens">${fmtTok(r.api_tokens_in)}</span>in / <span title="Total output tokens">${fmtTok(r.api_tokens_out || 0)}</span>out`
        : "—";
      return `<tr>
        <td class="ps-source">${modeLabel}</td>
        <td class="${statusClass}">${statusText}</td>
        <td style="white-space:nowrap">${esc(fmtDateTimeLocal(r.started_at))}</td>
        <td class="ps-num">${total || "—"}</td>
        <td class="ps-num">${r.extract_mode === "per_item" ? "—" : (r.batches || 0)}</td>
        <td class="ps-num">${mkBtn(ext, "extracted", "ps-done")}</td>
        <td class="ps-num">${mkBtn(pfPass, "prefilter_passed", "ps-done")}</td>
        <td class="ps-num">${mkBtn(pf, "prefilter", "ps-err-inline")}</td>
        <td class="ps-num">${mkBtn(ev, "eval", "ps-err-inline")}</td>
        <td class="ps-num">${mkBtn(dup, dupGroup, "ps-err-inline")}</td>
        <td class="ps-num">${agg > 0 ? `<button class="ps-breakdown-btn ps-agg" onclick="event.stopPropagation();showRunCountPanel(${id},'aggregators','${t0}','${t1}')">${agg}</button>` : ""}</td>
        <td class="ps-num">${err > 0 ? `<span class="ps-err">${err}</span>` : ""}</td>
        <td>${dur}</td>
        <td class="ps-num">${tokens}</td>
        <td>${deleteBtn}</td>
      </tr>`;
    }).join("");
    el.innerHTML = `<table class="pipeline-source-table" style="margin-top:8px">
      <thead><tr>
        <th>Mode</th><th>Status</th><th>Started</th>
        <th class="ps-num">Total</th><th class="ps-num">Batches</th>
        <th class="ps-num">Extracted ✓</th>
        <th class="ps-num" title="Pages that passed the pre-filter stage">Pre-filter ✓</th>
        <th class="ps-num" title="Pages found not to be opportunities by 8B pre-filter">Pre-filter ✗</th>
        <th class="ps-num" title="Pages found not to be opportunities by full LLM evaluation">Evaluation ✗</th>
        <th class="ps-num">Dedup ✗</th>
        <th class="ps-num" title="Aggregator candidates found and queued for review">Agg</th>
        <th class="ps-num">Errors</th>
        <th>Duration</th>
        <th class="ps-num" title="Claude Code token usage for this run: peak single-call context size, then total output tokens generated">Tokens</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div id="pl-run-rej-panel" class="psb-panel" style="display:none;margin-top:8px"></div>`;

    const totalPages = Math.ceil(totalRuns / _PIPELINE_RUNS_PAGE_SIZE) || 1;
    if (pagerEl) {
      pagerEl.innerHTML = totalPages > 1
        ? `<span class="psb-page-info">page ${page}/${totalPages}</span> ` +
          `<button class="run-detail-close" ${page <= 1 ? "disabled" : `onclick="loadPipelineRuns(${page - 1})"`}>Prev</button> ` +
          `<button class="run-detail-close" ${page >= totalPages ? "disabled" : `onclick="loadPipelineRuns(${page + 1})"`}>Next</button>`
        : "";
    }
  } catch (_) {}
}

async function deletePipelineRun(runId) {
  if (!confirm(`Delete pipeline run #${runId} and reset all its rows for reprocessing?`)) return;
  try {
    const run = (await q("SELECT id, status FROM pipeline_runs WHERE id=?", [runId]))[0];
    if (!run) { alert("Run not found"); return; }
    if (run.status === "running") { alert("Cannot delete a running pipeline run"); return; }
    if (LOCAL_MODE) {
      await apiFetch(`/pipeline/runs/${runId}`, { method: "DELETE" });
    } else {
      await exec(`UPDATE raw_scrape SET processed=0, processed_at=NULL, skip_reason=NULL,
        prefilter_signals=NULL, pipeline_run_id=NULL WHERE pipeline_run_id=?`, [runId]);
      await exec("DELETE FROM pipeline_runs WHERE id=?", [runId]);
    }
    loadPipelineRuns();
    alert(`Run #${runId} deleted — rows reset for reprocessing.`);
  } catch (e) {
    alert(`Delete failed: ${e.message || e}`);
  }
}

// ── Pipeline status (headline counts + by-source breakdown — ports
// web/app.py's /pipeline/status query verbatim, including the clickable
// per-cell drill-down: see the note above loadPipelineRuns on why this is
// valid for historical, finished runs too) ────────────────────────────────

async function loadPipelineStatus() {
  try {
    const [[{ unprocessed }], [{ errored }], [{ total }], [{ processed }], [{ extracted }]] = await Promise.all([
      q("SELECT COUNT(*) AS unprocessed FROM raw_scrape WHERE processed = 0 AND error IS NULL"),
      q("SELECT COUNT(*) AS errored FROM raw_scrape WHERE error IS NOT NULL"),
      q("SELECT COUNT(*) AS total FROM raw_scrape"),
      q("SELECT COUNT(*) AS processed FROM raw_scrape WHERE processed = 1"),
      q(`SELECT COUNT(DISTINCT rs.url) AS extracted FROM raw_scrape rs
         WHERE rs.processed = 1 AND rs.error IS NULL
           AND EXISTS (SELECT 1 FROM opportunities o WHERE o.url = rs.url)`),
    ]);
    const scopeRows = await q("SELECT COALESCE(scope, 'unknown') AS scope, COUNT(*) AS n FROM opportunities GROUP BY 1");
    const opportunitiesByScope = {};
    for (const r of scopeRows) opportunitiesByScope[r.scope] = r.n;
    const opportunitiesTotal = Object.values(opportunitiesByScope).reduce((a, b) => a + b, 0);

    const bySource = await q(`
      SELECT
        COALESCE(s.name,
          CASE WHEN rs.query_id IS NOT NULL
               THEN 'Researcher: ' || COALESCE(
                   (SELECT rr.mode FROM query_log ql JOIN researcher_runs rr ON ql.run_id = rr.id WHERE ql.id = rs.query_id),
                   'unknown')
               ELSE 'unknown'
          END) AS source,
        COUNT(*) AS total,
        SUM(CASE WHEN rs.processed = 0 AND rs.error IS NULL THEN 1 ELSE 0 END) AS unprocessed,
        SUM(CASE WHEN rs.processed = 1 THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN rs.error IS NOT NULL THEN 1 ELSE 0 END) AS errored,
        SUM(CASE WHEN rs.processed = 1 AND rs.error IS NULL
                  AND EXISTS (SELECT 1 FROM opportunities o WHERE o.url = rs.url)
             THEN 1 ELSE 0 END) AS extracted,
        SUM(CASE WHEN rs.skip_reason = 'prefilter_not_opportunity' AND rs.aggregator_note IS NULL THEN 1 ELSE 0 END) AS prefilter_dropped,
        SUM(CASE WHEN rs.processed = 1 AND rs.error IS NULL AND rs.skip_reason IS NULL AND rs.llm_batch_id IS NULL
                  AND rs.prefilter_signals IS NOT NULL AND rs.aggregator_note IS NULL
                  AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.url = rs.url)
             THEN 1 ELSE 0 END) AS prefilter_passed,
        SUM(CASE WHEN rs.processed = 1 AND rs.error IS NULL AND rs.skip_reason IS NULL AND rs.llm_batch_id IS NOT NULL
                  AND rs.aggregator_note IS NULL AND COALESCE(rs.rejection_reason, '') NOT LIKE 'cross_listing:%'
                  AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.url = rs.url)
             THEN 1 ELSE 0 END) AS eval_dropped,
        SUM(CASE WHEN rs.skip_reason IN ('duplicate_pending_url', 'known_url_unchanged') OR rs.rejection_reason LIKE 'cross_listing:%'
             THEN 1 ELSE 0 END) AS duplicates,
        SUM(CASE WHEN rs.aggregator_note IS NOT NULL THEN 1 ELSE 0 END) AS aggregators
      FROM raw_scrape rs
      LEFT JOIN sources s ON rs.source_id = s.id
      GROUP BY 1
      ORDER BY total DESC
    `);

    let bySourceHtml = "";
    if (bySource.length) {
      const tot = bySource.reduce((acc, r) => {
        acc.total += r.total || 0; acc.extracted += r.extracted || 0;
        acc.prefilterPassed += r.prefilter_passed || 0; acc.prefilterDropped += r.prefilter_dropped || 0;
        acc.evalDropped += r.eval_dropped || 0; acc.dups += r.duplicates || 0;
        acc.aggregators += r.aggregators || 0; acc.errored += r.errored || 0;
        return acc;
      }, { total: 0, extracted: 0, prefilterPassed: 0, prefilterDropped: 0, evalDropped: 0, dups: 0, aggregators: 0, errored: 0 });
      const num = n => n > 0 ? n.toLocaleString() : "";
      function _rejBtn(count, src, group) {
        if (!count) return "";
        return `<button class="ps-breakdown-btn ps-err-inline" onclick='showRejectedList(${escJs(src)},${escJs(group)})'>${count}</button>`;
      }
      function _aggBtn(count, src) {
        if (!count) return "";
        return `<button class="ps-breakdown-btn ps-agg" onclick='showAggregatorList(${escJs(src)})'>${count}</button>`;
      }
      const dataRows = bySource.map(r => {
        const src = r.source;
        const runBtn = LOCAL_MODE ? ` <button class="ps-run-src-btn" title="Run this source through the pipeline" onclick='runPipelineForSource(${escJs(src)})'>▶</button>` : "";
        return `<tr>
        <td class="ps-source">${esc(src)}${runBtn}</td>
        <td class="ps-num">${(r.total || 0).toLocaleString()}</td>
        <td class="ps-num">${r.extracted > 0 ? `<button class="ps-breakdown-btn ps-done" onclick='showExtractedList(${escJs(src)})'>${r.extracted}</button>` : ""}</td>
        <td class="ps-num">${r.prefilter_passed > 0 ? `<button class="ps-breakdown-btn ps-done" onclick='showRejectedList(${escJs(src)},"prefilter_passed")'>${r.prefilter_passed}</button>` : ""}</td>
        <td class="ps-num">${_rejBtn(r.prefilter_dropped, src, "prefilter")}</td>
        <td class="ps-num">${_rejBtn(r.eval_dropped, src, "llm_rejected")}</td>
        <td class="ps-num">${r.duplicates > 0 ? `<button class="ps-breakdown-btn ps-err-inline" onclick='showRejectedList(${escJs(src)},"dedup")'>${r.duplicates}</button>` : ""}</td>
        <td class="ps-num">${_aggBtn(r.aggregators, src)}</td>
        <td class="ps-num">${_psBtn(r.errored, src, "error", "ps-err")}</td>
      </tr>`;
      }).join("");
      const totRow = `<tr class="ps-totals-row">
        <td class="ps-source">All sources</td>
        <td class="ps-num">${tot.total.toLocaleString()}</td>
        <td class="ps-num">${tot.extracted > 0 ? `<button class="ps-breakdown-btn ps-done" onclick='showExtractedList("__all__")'>${tot.extracted}</button>` : ""}</td>
        <td class="ps-num">${tot.prefilterPassed > 0 ? `<button class="ps-breakdown-btn ps-done" onclick='showRejectedList("__all__","prefilter_passed")'>${tot.prefilterPassed}</button>` : ""}</td>
        <td class="ps-num">${_rejBtn(tot.prefilterDropped, "__all__", "prefilter")}</td>
        <td class="ps-num">${_rejBtn(tot.evalDropped, "__all__", "llm_rejected")}</td>
        <td class="ps-num">${tot.dups > 0 ? `<button class="ps-breakdown-btn ps-err-inline" onclick='showRejectedList("__all__","dedup")'>${tot.dups}</button>` : ""}</td>
        <td class="ps-num">${_aggBtn(tot.aggregators, "__all__")}</td>
        <td class="ps-num">${_psBtn(tot.errored, "__all__", "error", "ps-err")}</td>
      </tr>`;
      bySourceHtml = `<table class="pipeline-source-table">
        <thead><tr>
          <th>Source</th><th class="ps-num">Total</th>
          <th class="ps-num">Extracted ✓</th>
          <th class="ps-num" title="Passed pre-filter but not yet evaluated by full LLM (economy/prefilter-only runs)">Pre-filter ✓</th>
          <th class="ps-num" title="Pages found not to be opportunities by 8B pre-filter">Pre-filter ✗</th>
          <th class="ps-num" title="Pages found not to be opportunities by full LLM evaluation">Evaluation ✗</th>
          <th class="ps-num">Dedup ✗</th>
          <th class="ps-num" title="Pages flagged as index/listing aggregators by the pre-filter or full evaluation">Agg</th>
          <th class="ps-num">Errors</th>
        </tr></thead>
        <tbody>${dataRows}${totRow}</tbody>
      </table>
      <div id="ps-breakdown-panel" class="ps-breakdown-panel" style="display:none"></div>`;
    }

    const scopeParts = [];
    if (opportunitiesByScope.in_scope) scopeParts.push(`${opportunitiesByScope.in_scope} in-scope`);
    if (opportunitiesByScope.borderline) scopeParts.push(`${opportunitiesByScope.borderline} borderline`);
    if (opportunitiesByScope.out_of_scope) scopeParts.push(`${opportunitiesByScope.out_of_scope} out-of-scope`);
    const scopeStr = scopeParts.length ? ` (${scopeParts.join(", ")})` : "";

    const infoEl = document.getElementById("pipeline-info");
    if (infoEl) {
      infoEl.innerHTML =
        `Unprocessed: <strong>${unprocessed}</strong> &nbsp;|&nbsp; ` +
        `Processed: <strong>${processed}</strong> → <span class="ps-done">${extracted} extracted</span> &nbsp;|&nbsp; ` +
        `Errors: ${_psBtn(errored, "__all__", "error", "ps-err") || `<strong>${errored}</strong>`} &nbsp;|&nbsp; ` +
        `Opportunities: <strong>${opportunitiesTotal}</strong>${scopeStr}`;
    }
    const breakdownEl = document.getElementById("pipeline-breakdown");
    if (breakdownEl) breakdownEl.innerHTML = bySourceHtml;

    const badge = document.getElementById("pipeline-badge");
    if (badge) {
      if (unprocessed > 0) { badge.textContent = `${unprocessed} pending`; badge.style.display = "inline-block"; }
      else badge.style.display = "none";
    }
  } catch (e) {
    const infoEl = document.getElementById("pipeline-info");
    if (infoEl) infoEl.textContent = "Status unavailable";
  }
}

// ── Scraper table / runs (per-source status — read-only here; "Run"
// buttons are disabled in HTML, no live execution exists) ─────────────────

// Mirrors web/app.py's _SCRAPER_REGISTRY — custom scrapers aren't flagged by
// any sources column, the registry (key -> sources.name) is Python-side, so
// it's duplicated here since webapp/ can't import web/app.py.
const _SCRAPER_REGISTRY = {
  resartis: "Res Artis",
  transartists: "TransArtists",
  eflux: "e-flux Announcements",
  touring_artists_info: "touring artists — Residenzen",
  touring_artists_foerder: "touring artists — Förderdatenbank",
  kunstfonds: "Stiftung Kunstfonds",
  igbk: "IGBK — Internationale Gesellschaft der Bildenden Künste",
  igbildendekunst: "IG Bildende Kunst",
};

async function loadScraperTable() {
  const tbody = document.getElementById("scraper-table-body");
  if (!tbody) return;
  try {
    const sourceRows = await q(
      "SELECT id, name, url, aggregator_status, aggregator_signals, listing_order, newest_safe, fail_count, blocked FROM sources"
    );
    const byName = {};
    for (const s of sourceRows) byName[s.name] = s;

    // Link-directory classification lives in aggregator_signals.directory.status
    // (see architecture.md "Link directories") — a directory lists other domains'
    // calls as blurb + outbound link, unlike a hosting aggregator.
    const dirStatus = (s) => {
      if (!s || !s.aggregator_signals) return "none";
      try {
        const d = JSON.parse(s.aggregator_signals).directory;
        return (d && d.status) || "none";
      } catch (_) { return "none"; }
    };

    const rows = [];
    for (const [key, dbName] of Object.entries(_SCRAPER_REGISTRY)) {
      const source = byName[dbName];
      const lastRunRows = await q(
        "SELECT finished_at, mode, fetched, status FROM scraper_runs WHERE target=? ORDER BY id DESC LIMIT 1",
        [key]
      );
      const lastRun = lastRunRows[0] || null;
      const scrapeCount = source
        ? (await q("SELECT COUNT(*) AS n FROM raw_scrape WHERE source_id=?", [source.id]))[0].n
        : 0;
      rows.push({
        key, name: dbName, url: source ? source.url : null,
        scraper_type: "custom", scrape_count: scrapeCount,
        last_run: lastRun ? lastRun.finished_at : null,
        last_mode: lastRun ? lastRun.mode : null,
        last_fetched: lastRun ? lastRun.fetched : null,
        listing_order: source ? source.listing_order : null,
        newest_safe: source ? !!source.newest_safe : false,
        fail_count: source ? source.fail_count : 0,
        blocked: source ? !!source.blocked : false,
        aggregator_status: source ? source.aggregator_status : "none",
        directory_status: dirStatus(source),
      });
    }
    const customSourceNames = new Set(Object.values(_SCRAPER_REGISTRY));
    const customDomains = new Set(sourceRows
      .filter(source => customSourceNames.has(source.name))
      .map(source => {
        try { return new URL(source.url).hostname.toLowerCase().replace(/^www\./, ""); }
        catch (_) { return ""; }
      })
      .filter(Boolean));
    for (const s of sourceRows) {
      let domain = "";
      try { domain = new URL(s.url).hostname.toLowerCase().replace(/^www\./, ""); } catch (_) {}
      if (s.aggregator_status !== "confirmed" || customDomains.has(domain)) continue;
      const scrapeCount = (await q("SELECT COUNT(*) AS n FROM raw_scrape WHERE source_id=?", [s.id]))[0].n;
      rows.push({
        key: null, name: s.name, url: s.url,
        scraper_type: "generic", scrape_count: scrapeCount,
        last_run: null, last_mode: null, last_fetched: null,
        listing_order: s.listing_order, newest_safe: !!s.newest_safe,
        fail_count: s.fail_count, blocked: !!s.blocked,
        aggregator_status: "confirmed",
        directory_status: dirStatus(s),
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    const modeLabels = { full: "Full", newest: "Newest" };
    const orderLabels = {
      reverse_chronological: "rev. chron.", chronological: "chron.", alphabetical: "alpha.",
      deadline_ascending: "deadline ↑", deadline_descending: "deadline ↓", other: "other", unknown: "unknown",
    };
    tbody.innerHTML = rows.map(row => {
      const nameHtml = row.url
        ? `<a href="${safeUrl(row.url)}" target="_blank" style="font-weight:500">${esc(row.name)}</a>`
        : `<span style="font-weight:500">${esc(row.name)}</span>`;
      const pages = row.scrape_count > 0
        ? `<span style="font-variant-numeric:tabular-nums">${row.scrape_count.toLocaleString()}</span>`
        : '<span style="color:var(--text-muted)">—</span>';
      const lastRun = row.last_run
        ? `<span style="white-space:nowrap">${esc(fmtDate(row.last_run))}</span>`
        : '<span style="color:var(--text-muted)">never</span>';
      const mode = row.last_mode ? (modeLabels[row.last_mode] || row.last_mode) : '<span style="color:var(--text-muted)">—</span>';
      const fetched = row.last_fetched != null ? row.last_fetched : '<span style="color:var(--text-muted)">—</span>';
      let scraperHtml = '<span style="color:var(--text-muted)">—</span>';
      if (row.scraper_type === "custom") scraperHtml = '<span class="st-type-badge st-type-custom">Custom</span>';
      if (row.scraper_type === "generic") scraperHtml = '<span class="st-type-badge st-type-generic">Generic</span>';
      // A directory lists other domains' calls as blurb + outbound link, so its
      // rows need a second fetch to get real content — worth distinguishing from
      // a hosting aggregator at a glance.
      if (row.directory_status && row.directory_status !== "none" && row.directory_status !== "rejected") {
        const pending = row.directory_status === "candidate";
        scraperHtml += ` <span class="st-type-badge st-type-directory${pending ? " st-type-directory-pending" : ""}"`
          + ` title="Link directory${pending ? " (candidate — needs confirmation)" : ""}:`
          + ` lists other domains' calls as blurb + outbound link; targets are fetched separately">`
          + `Directory${pending ? "?" : ""}</span>`;
      }
      let orderHtml = '<span style="color:var(--text-muted)">—</span>';
      if (row.listing_order) {
        const label = orderLabels[row.listing_order] || row.listing_order.replace(/_/g, " ");
        const safe = row.newest_safe ? ' <span class="scraper-safe-badge" style="font-size:0.74em;padding:0 4px;">✓ safe</span>' : "";
        orderHtml = `<span style="font-size:0.84em">${esc(label)}</span>${safe}`;
      }
      let aggHtml = "";
      const aggClass = { candidate: "st-agg-candidate", confirmed: "st-agg-confirmed", rejected: "st-agg-rejected" };
      if (row.aggregator_status && row.aggregator_status !== "none") {
        aggHtml = `<span class="st-agg-badge ${aggClass[row.aggregator_status] || ""}">${esc(row.aggregator_status)}</span>`;
      }
      const actionsHtml = row.blocked
        ? (LOCAL_MODE && row.key
          ? `<button class="scraper-blocked-badge" style="font-size:0.8em;" title="${row.fail_count || 0} errors — click to unblock" onclick='scraperTableUnblock(${escJs(row.key)}, this)'>⚠ blocked</button>`
          : `<span class="scraper-blocked-badge" style="font-size:0.8em;cursor:default;" title="${row.fail_count || 0} errors">⚠ blocked</span>`)
        : (LOCAL_MODE
          ? `<button class="st-run-btn btn-scrape" data-target="${esc(row.key || "generic_agg")}" onclick='runScraper(${escJs(row.key || "generic_agg")})'>▶ Run</button>`
          : `<button class="st-run-btn btn-scrape" disabled title="Operational runs are available from the local FastAPI console">▶ Run</button>`);
      return `<tr>
        <td>${nameHtml}</td><td class="st-num">${pages}</td><td>${lastRun}</td>
        <td style="font-size:0.85em">${mode}</td><td class="st-num">${fetched}</td>
        <td>${scraperHtml}</td><td>${orderHtml}</td><td>${aggHtml}</td>
        <td style="white-space:nowrap">${actionsHtml}</td>
      </tr>`;
    }).join("") || '<tr><td colspan="9" style="color:var(--text-muted);font-style:italic;padding:10px;">No scrapers configured.</td></tr>';
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="9" class="run-err">Error loading scraper table: ${esc(e.message)}</td></tr>`;
  }
}

async function loadScraperRuns() {
  const el = document.getElementById("scraper-runs");
  if (!el) return;
  try {
    const runs = await q(`
      SELECT target, status, error_message, started_at, fetched, skipped, errors,
             CAST((JULIANDAY(COALESCE(finished_at, datetime('now'))) - JULIANDAY(started_at)) * 86400 AS INTEGER) AS duration_seconds
      FROM scraper_runs ORDER BY id DESC LIMIT 5
    `);
    if (!runs.length) { el.innerHTML = ""; return; }
    const rows = runs.map(r => {
      const dur = r.duration_seconds != null
        ? (r.duration_seconds < 60 ? `${r.duration_seconds}s` : `${Math.round(r.duration_seconds / 60)}m`)
        : "—";
      const statusClass = r.status === "completed" ? "run-ok" : r.status === "failed" ? "run-err" : "run-running";
      const statusText = r.status === "failed" && r.error_message
        ? `failed: ${esc(r.error_message.slice(0, 40))}`
        : esc(r.status);
      return `<tr>
        <td class="ps-source">${esc(r.target)}</td>
        <td class="${statusClass}">${statusText}</td>
        <td>${esc(fmtDateTimeLocal(r.started_at))}</td>
        <td class="ps-num">${r.fetched}</td>
        <td class="ps-num">${r.skipped}</td>
        <td class="ps-num ${r.errors > 0 ? "ps-err" : ""}">${r.errors || ""}</td>
        <td>${dur}</td>
      </tr>`;
    }).join("");
    el.innerHTML = `<table class="pipeline-source-table" style="margin-top:8px">
      <thead><tr>
        <th>Target</th><th>Status</th><th>Started</th>
        <th class="ps-num">Fetched</th><th class="ps-num">Skipped</th><th class="ps-num">Errors</th><th>Duration</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } catch (_) {}
}

// ── Aggregator candidates ───────────────────────────────────────────────────

function _candidateEntries(root, stored, examples) {
  let values = [];
  for (const raw of [stored, examples]) {
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;
      if (Array.isArray(parsed) && parsed.length) { values = parsed; break; }
    } catch (_) {}
  }
  let rootUrl;
  try { rootUrl = new URL(root); } catch (_) { return values.filter(v => typeof v === "string"); }
  const domain = rootUrl.hostname.toLowerCase().replace(/^www\./, "");
  const result = [], seen = new Set();
  for (const value of [...values, root]) {
    try {
      const url = new URL(value);
      if (url.hostname.toLowerCase().replace(/^www\./, "") !== domain) continue;
      url.hash = "";
      const key = `${domain}|${url.pathname.replace(/\/$/, "") || "/"}|${url.search}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(url.toString());
    } catch (_) {}
  }
  return result;
}

function _entryInputHtml(value = "") {
  return `<div class="agg-entry-row" style="display:flex;gap:4px;margin-top:3px;">
    <input class="agg-entry-url" type="url" value="${esc(value)}" style="min-width:260px;flex:1;font-size:0.8em;">
    <button class="run-detail-close" type="button" onclick="this.parentElement.remove()" title="Remove entry URL">&times;</button>
  </div>`;
}

function addAggregatorEntry(id, value = "") {
  const editor = document.getElementById(`agg-entries-${id}`);
  if (editor) editor.insertAdjacentHTML("beforeend", _entryInputHtml(value));
}

function _collectAggregatorEntries(id) {
  const editor = document.getElementById(`agg-entries-${id}`);
  if (!editor) return [];
  const values = [...editor.querySelectorAll(".agg-entry-url")].map(el => el.value.trim()).filter(Boolean);
  return _candidateEntries(editor.dataset.root, values, []);
}

function _probeHtml(report, id) {
  if (!report || !Array.isArray(report.entries)) return "";
  const rows = report.entries.map(entry => {
    const state = entry.fetch_ok ? `${entry.links_found || 0} links` : `fetch failed${entry.http_status ? ` (${entry.http_status})` : ""}`;
    const flags = [entry.pagination_style, entry.thin_page ? "thin page" : ""].filter(Boolean).join(", ");
    return `<li><a href="${safeUrl(entry.entry_url)}" target="_blank">${esc(entry.entry_url)}</a>: ${esc(state)}${flags ? ` â€” ${esc(flags)}` : ""}</li>`;
  }).join("");
  const suggestions = (report.suggested_entry_urls || []).map(url => LOCAL_MODE
    ? `<button class="run-detail-close" type="button" onclick='addAggregatorEntry(${id},${escJs(url)})'>+ ${esc(url)}</button>`
    : `<span>${esc(url)}</span>`).join(" ");
  return `<div style="margin-top:6px;font-size:0.78em;"><strong>Last probe${report.probed_at ? ` (${esc(report.probed_at.slice(0, 16).replace("T", " "))})` : ""}</strong><ul style="margin:3px 0;padding-left:18px;">${rows}</ul>${suggestions ? `<div>Suggested: ${suggestions}</div>` : ""}</div>`;
}

async function loadAggregatorCandidatesTable() {
  const tbody = document.getElementById("agg-candidates-table-body");
  const badge = document.getElementById("agg-cand-badge");
  if (!tbody) return;
  try {
    const candidates = await q(`
      SELECT id, url, name, aggregator_signals, listing_urls, aggregator_detected_at
      FROM sources WHERE aggregator_status = 'candidate' ORDER BY aggregator_detected_at DESC
    `);
    if (badge) {
      badge.textContent = candidates.length || "";
      badge.style.display = candidates.length ? "inline-block" : "none";
    }
    if (!candidates.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:#666;font-style:italic;padding:10px;">No candidates yet.</td></tr>';
      return;
    }
    tbody.innerHTML = candidates.map(c => {
      let sig = {};
      try { sig = c.aggregator_signals ? JSON.parse(c.aggregator_signals) : {}; } catch (_) {}
      const evidenceHtml = sig.aggregator_note ? esc(sig.aggregator_note) : "no note yet";
      const flagCount = sig.llm_flag_count || 0;
      const detected = c.aggregator_detected_at ? c.aggregator_detected_at.slice(0, 10) : "—";
      const entries = _candidateEntries(c.url, c.listing_urls, sig.example_urls || []);
      const entryEditor = entries.map(value => _entryInputHtml(value)).join("");
      const probeButton = LOCAL_MODE
        ? `<button class="btn-secondary" style="padding:2px 8px;font-size:0.8em;" onclick="probeAggregator(${c.id})" title="Fetch listing pages without scraping details">Probe</button>`
        : `<span style="font-size:0.75em;color:var(--text-muted);" title="Run probes from the local FastAPI console">Probe: local only</span>`;
      return `<tr data-id="${c.id}">
        <td><a href="${safeUrl(c.url)}" target="_blank" style="font-weight:500">${esc(c.name || c.url)}</a></td>
        <td style="font-size:0.85em;min-width:360px;">${evidenceHtml}
          <div id="agg-entries-${c.id}" data-root="${esc(c.url)}" style="margin-top:6px;"><strong style="font-size:0.85em;">Entry URLs</strong>${entryEditor}</div>
          <button class="run-detail-close" type="button" style="margin-top:3px;" onclick="addAggregatorEntry(${c.id})">+ add URL</button>
          <div id="agg-probe-${c.id}">${_probeHtml(sig.last_probe, c.id)}</div>
        </td>
        <td class="st-num">${flagCount || ""}</td>
        <td style="white-space:nowrap">${esc(detected)}</td>
        <td style="white-space:nowrap">
          ${probeButton}
          <button class="btn-agg-confirm" style="padding:2px 8px;font-size:0.8em;" onclick="aggAction(${c.id},'confirm')" title="Confirm aggregator">✓</button>
          <button class="btn-agg-reject" style="padding:2px 8px;font-size:0.8em;margin-left:3px;" onclick="aggAction(${c.id},'reject')" title="Reject aggregator">✗</button>
        </td>
      </tr>`;
    }).join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="run-err">Error: ${esc(e.message)}</td></tr>`;
  }
}

async function probeAggregator(id) {
  const output = document.getElementById(`agg-probe-${id}`);
  if (output) output.innerHTML = '<span style="color:var(--text-muted);">Probing…</span>';
  try {
    const report = await apiFetch(`/aggregators/${id}/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listing_urls: _collectAggregatorEntries(id) }),
    });
    if (output) output.innerHTML = _probeHtml(report, id);
  } catch (e) {
    if (output) output.innerHTML = `<span class="run-err">Probe failed: ${esc(e.message)}</span>`;
  }
}

async function aggAction(id, action) {
  const row = document.querySelector(`#agg-candidates-table-body tr[data-id="${id}"]`);
  if (row) row.style.opacity = "0.5";
  try {
    const listingUrls = _collectAggregatorEntries(id);
    if (LOCAL_MODE) {
      await apiFetch(`/aggregators/${id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "confirm" ? { listing_urls: listingUrls } : {}),
      });
    } else if (action === "confirm") {
      await exec("UPDATE sources SET aggregator_status='confirmed', source_type='aggregator', listing_urls=? WHERE id=?", [JSON.stringify(listingUrls), id]);
    } else {
      await exec("UPDATE sources SET aggregator_status='rejected' WHERE id=?", [id]);
    }
    loadAggregatorCandidatesTable();
    if (_psVisible && _psVisible.endsWith("::aggregators")) {
      const src = _psVisible.split("::")[0];
      _psVisible = null;
      showAggregatorList(src);
    }
    if (_plRunPanelKey && _plRunPanelKey.endsWith("::aggregators") && _lastAggRunPanelArgs) {
      const { runId, after, before } = _lastAggRunPanelArgs;
      _plRunPanelKey = null;
      showRunCountPanel(runId, "aggregators", after, before);
    }
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
  const pager = document.getElementById("excl-domains-pager");
  if (!tbody) return;
  const rows = _exclDomainsRows;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:#666;font-style:italic;padding:10px;">No domains excluded yet.</td></tr>';
    if (pager) pager.innerHTML = "";
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
        <button class="btn-secondary" style="padding:2px 8px;font-size:0.8em;" onclick="restoreExcludedDomain('${esc(r.domain)}')" title="Un-exclude — let future searches consider this domain again">Restore</button>
      </td>
    </tr>`;
  }).join("");
  if (pager) {
    pager.innerHTML = totalPages > 1
      ? `Page ${p}/${totalPages}
         <button class="run-detail-close" ${p <= 1 ? "disabled" : `onclick='_renderExcludedDomainsPage(${p - 1})'`}>Prev</button>
         <button class="run-detail-close" ${p >= totalPages ? "disabled" : `onclick='_renderExcludedDomainsPage(${p + 1})'`}>Next</button>`
      : "";
  }
}

async function restoreExcludedDomain(domain) {
  const row = document.querySelector(`tr[data-domain="${domain}"]`);
  if (row) row.style.opacity = "0.5";
  try {
    if (LOCAL_MODE) {
      await apiFetch(`/domains/excluded/${encodeURIComponent(domain)}/restore`, { method: "POST" });
    } else {
      await exec("UPDATE domain_reputation SET manual_override='include', updated_at=datetime('now') WHERE domain=?", [domain]);
    }
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
// script) — without these,
// every such handler would fail with "X is not defined".
// Local operational adapter. These stream transient progress only; durable
// logs remain backend files and database records rather than browser state.
function appendLogTo(logEl, html) {
  if (!logEl) return;
  const line = document.createElement("div");
  line.innerHTML = html;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function localModeParams(prefilterId, evalId) {
  const prefilter = document.getElementById(prefilterId)?.value || "default";
  const evaluate = document.getElementById(evalId)?.value || "default";
  return {
    extractMode: evaluate === "off" ? "prefilter" : prefilter === "off" ? "max" : "quality",
    prefilterProvider: prefilter === "default" || prefilter === "off" ? null : prefilter,
    extractProvider: evaluate === "default" || evaluate === "off" || evaluate === "claude" ? null : evaluate,
  };
}

function localEventLog(log, event) {
  const data = event.data || {};
  const message = data.message || data.query || data.source || data.name ||
    (data.url ? data.url.replace(/^https?:\/\//, "").slice(0, 90) : "");
  const summary = message || Object.entries(data).filter(([, value]) => typeof value !== "object").map(([key, value]) => `${key}: ${value}`).join(" · ");
  const cls = event.type.includes("error") ? "run-err" : event.type === "done" ? "run-ok" : "log-info";
  appendLogTo(log, `<span class="${cls}">${esc(event.type.replace(/_/g, " "))}${summary ? ` — ${esc(summary)}` : ""}</span>`);
}

function listenToStream(path, { log, onDone, onError }) {
  const stream = new EventSource(path);
  stream.onmessage = event => {
    let parsed;
    try { parsed = JSON.parse(event.data); } catch { return; }
    localEventLog(log, parsed);
    if (parsed.type === "done") { stream.close(); onDone(parsed.data || {}); }
    if (parsed.type === "error") { stream.close(); onError(parsed.data || {}); }
  };
  stream.onerror = () => { stream.close(); onError({ message: "Connection lost — check server logs" }); };
  return stream;
}

function runResearcher() {
  const button = document.getElementById("btn-run-researcher"), status = document.getElementById("researcher-status"), log = document.getElementById("researcher-log");
  const { extractMode, prefilterProvider, extractProvider } = localModeParams("r-prefilter", "r-eval-model");
  const params = new URLSearchParams({ mode: document.getElementById("r-mode").value, extract_mode: extractMode });
  const limit = document.getElementById("r-limit").value;
  if (limit) params.set("limit", limit);
  if (document.getElementById("r-deep").checked) params.set("deep", "true");
  if (prefilterProvider) params.set("prefilter_provider", prefilterProvider);
  if (extractProvider) params.set("extract_provider", extractProvider);
  button.disabled = true; log.innerHTML = ""; status.innerHTML = '<span class="run-running">Researcher running…</span>';
  listenToStream(`/researcher/run/stream?${params}`, {
    log,
    onDone: data => {
      button.disabled = false;
      status.innerHTML = data.mode_status === "no_relevance_profile"
        ? `<span class="run-warn">Not run: ${esc(data.mode_message || "No active relevance profile.")}</span>`
        : `<span class="run-ok">Completed: ${data.new_opportunities ?? 0} new opportunities.</span>`;
      loadResearcherRuns(); loadResearcherBudget(); loadStats();
    },
    onError: data => { button.disabled = false; status.innerHTML = `<span class="run-err">Failed: ${esc(data.message || "unknown error")}</span>`; },
  });
}

let _localPipelineStream = null;
function runPipeline() {
  const button = document.getElementById("btn-run-pipeline"), status = document.getElementById("pipeline-status"), log = document.getElementById("pipeline-log");
  const { extractMode, prefilterProvider, extractProvider } = localModeParams("p-prefilter", "p-eval-model");
  const params = new URLSearchParams({ extract_mode: extractMode });
  if (prefilterProvider) params.set("prefilter_provider", prefilterProvider);
  if (extractProvider) params.set("extract_provider", extractProvider);
  log.innerHTML = ""; button.textContent = "Stop"; button.onclick = stopPipeline; status.innerHTML = '<span class="run-running">Pipeline running…</span>';
  _localPipelineStream = listenToStream(`/pipeline/run/stream?${params}`, {
    log,
    onDone: data => { _localPipelineStream = null; button.textContent = "Run"; button.onclick = runPipeline; status.innerHTML = `<span class="run-ok">Done: ${data.total_new ?? 0} new/updated.</span>`; refreshPipelineViews(); },
    onError: data => { _localPipelineStream = null; button.textContent = "Run"; button.onclick = runPipeline; status.innerHTML = `<span class="run-err">Failed: ${esc(data.message || "unknown error")}</span>`; loadPipelineRuns(); },
  });
}

function stopPipeline() {
  _localPipelineStream?.close(); _localPipelineStream = null; fetch("/pipeline/abort", { method: "POST" });
  const button = document.getElementById("btn-run-pipeline");
  button.textContent = "Run"; button.onclick = runPipeline;
  document.getElementById("pipeline-status").innerHTML = '<span class="run-err">Stopped.</span>';
}

function runPipelineForSource(source) {
  const status = document.getElementById("pipeline-status"), log = document.getElementById("pipeline-log");
  const { extractMode, prefilterProvider, extractProvider } = localModeParams("p-prefilter", "p-eval-model");
  const params = new URLSearchParams({ source, extract_mode: extractMode });
  if (prefilterProvider) params.set("prefilter_provider", prefilterProvider);
  if (extractProvider) params.set("extract_provider", extractProvider);
  log.innerHTML = ""; status.innerHTML = `<span class="run-running">Running ${esc(source)}…</span>`;
  listenToStream(`/pipeline/run/stream?${params}`, {
    log,
    onDone: data => { status.innerHTML = `<span class="run-ok">Done: ${data.total_new ?? 0} new/updated.</span>`; refreshPipelineViews(); },
    onError: data => { status.innerHTML = `<span class="run-err">Failed: ${esc(data.message || "unknown error")}</span>`; },
  });
}

function refreshPipelineViews() { loadPipelineStatus(); loadPipelineRuns(); loadScraperTable(); loadAggregatorCandidatesTable(); loadScraperRuns(); loadStats(); }

function runScraper(target) {
  const buttons = document.querySelectorAll(".btn-scrape"), status = document.getElementById("scraper-status"), log = document.getElementById("scraper-log");
  const mode = document.getElementById("scraper-mode-toggle").checked ? "newest" : "all";
  const params = new URLSearchParams({ target, mode });
  if (document.getElementById("scraper-skip-safe-toggle").checked) params.set("skip_newest_safe", "true");
  buttons.forEach(button => { button.disabled = true; }); log.innerHTML = ""; status.innerHTML = '<span class="run-running">Scrapers running…</span>';
  listenToStream(`/scraper/run/stream?${params}`, {
    log,
    onDone: data => { buttons.forEach(button => { button.disabled = false; }); status.innerHTML = `<span class="run-ok">Done — fetched: ${data.fetched ?? 0}, skipped: ${data.skipped ?? 0}, errors: ${data.errors ?? 0}</span>`; refreshPipelineViews(); },
    onError: data => { buttons.forEach(button => { button.disabled = false; }); status.innerHTML = `<span class="run-err">Failed: ${esc(data.message || "unknown error")}</span>`; },
  });
}

async function scraperTableUnblock(target, button) {
  button.textContent = "unblocking…";
  try { await apiFetch(`/scraper/unblock/${target}`, { method: "POST" }); loadScraperTable(); }
  catch (error) { button.textContent = "⚠ blocked"; alert(`Unblock failed: ${error.message}`); }
}

function bindLocalOperations() {
  if (!LOCAL_MODE) return;
  document.getElementById("login-screen").hidden = true; document.getElementById("app").hidden = false;
  document.getElementById("logout-btn").hidden = true;
  const researcher = document.getElementById("btn-run-researcher"), pipeline = document.getElementById("btn-run-pipeline");
  researcher.disabled = false; researcher.removeAttribute("title"); researcher.onclick = runResearcher;
  pipeline.disabled = false; pipeline.removeAttribute("title"); pipeline.onclick = runPipeline;
  document.querySelectorAll(".btn-scrape").forEach(button => { button.disabled = false; button.removeAttribute("title"); });
  document.getElementById("btn-scrape-all").onclick = () => runScraper("all");
  document.getElementById("btn-scrape-generic").onclick = () => runScraper("generic_agg");
}

window.autoResizeField = autoResizeField;
window.closeDetailPanel = closeDetailPanel;
window.dismissFlag = dismissFlag;
window.dismissMismatch = dismissMismatch;
window.loadOpportunities = loadOpportunities;
window.openDetailPanel = openDetailPanel;
window.saveDetail = saveDetail;
window.hideRunDetail = hideRunDetail;
window.aggAction = aggAction;
window.addAggregatorEntry = addAggregatorEntry;
window.probeAggregator = probeAggregator;
window.restoreExcludedDomain = restoreExcludedDomain;
window._renderExcludedDomainsPage = _renderExcludedDomainsPage;
window.openDetail = openDetail;
window.showPipelineBreakdown = showPipelineBreakdown;
window.showRejectedList = showRejectedList;
window._rejectedListPage = _rejectedListPage;
window.showAggregatorList = showAggregatorList;
window.showExtractedList = showExtractedList;
window.showRunCountPanel = showRunCountPanel;
window.closeRunPanel = closeRunPanel;
window.closeBreakdownPanel = closeBreakdownPanel;
window._runPanelPage = _runPanelPage;
window.showDigest = showDigest;
window.loadPipelineRuns = loadPipelineRuns;
window.deletePipelineRun = deletePipelineRun;
window.clearPipelineErrors = clearPipelineErrors;
window.runPipelineForSource = runPipelineForSource;
window.runScraper = runScraper;
window.scraperTableUnblock = scraperTableUnblock;

// ── Boot ──────────────────────────────────────────────────────────────────
const _stored = getStoredToken();
if (LOCAL_MODE) {
  showApp();
  init();
} else if (_stored) {
  tryConnect(_stored).then(() => { showApp(); return init(); }).catch(() => {
    localStorage.removeItem(TOKEN_KEY);
    showLogin();
  });
} else {
  showLogin();
}



