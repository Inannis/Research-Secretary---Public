// Phase 7C — secret-free static review SPA. Talks to Turso directly from
// the browser via @libsql/client/web. No secret lives in this file: the
// Turso URL below is not sensitive on its own (the database requires a
// valid auth token for every query), and the token is entered at login and
// kept only in localStorage.
import { createClient } from "https://esm.sh/@libsql/client@0.17.4/web";

const TURSO_URL = "libsql://artdb-inannis.aws-eu-west-1.turso.io";
const TOKEN_KEY = "turso_auth_token";

let client = null;
let state = {
  page: 1,
  perPage: 50,
  sortBy: "",
  sortDir: "asc",
  total: 0,
};

// ── Country handling ──────────────────────────────────────────────────────
// opportunities.country now stores an ISO2 code (pipeline/ingest.py
// normalizes it at insert time via normalize_country() — see DECISIONS.md,
// the country-filter fix). Matches web/db.py's _EU_COUNTRIES/_EUROPE_COUNTRIES
// semantics exactly, now that both sides agree on the stored shape.
const EU_CODES = [
  "AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI",
  "FR","GR","HR","HU","IE","IT","LT","LU","LV","MT",
  "NL","PL","PT","RO","SE","SI","SK",
];
const EUROPE_CODES = EU_CODES.concat([
  "CH","NO","IS","GB","UA","RS","ME","MK","AL","BA","XK","MD","TR",
]);

// Full ISO 3166-1 alpha-2 -> common name table (generated via pycountry;
// regenerate with: python -c "import pycountry,json; [print(json.dumps(c.alpha_2)+':'+json.dumps(getattr(c,'common_name',None) or c.name)+',') for c in sorted(pycountry.countries, key=lambda c: c.alpha_2)]"
// Duplicated in web/static/app.js (this file can't import from there — the
// deployed webapp/ must stay exactly 3 self-contained files).
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
function countryName(code) { return code ? (ISO_COUNTRIES[code] || code) : ""; }
const COUNTRY_FROM_NAME = Object.fromEntries(
  Object.entries(ISO_COUNTRIES).map(([k, v]) => [v.toLowerCase(), k])
);
function countryCode(input) {
  if (!input) return "";
  const s = input.trim().toLowerCase();
  if (s === "eu" || s === "european union") return "_EU";
  if (s === "europe" || s === "european" || s === "eur") return "_EUR";
  if (s.length === 2) return s.toUpperCase();
  return COUNTRY_FROM_NAME[s] || input.trim().toUpperCase();
}

// ── Auth / connection ──────────────────────────────────────────────────────

function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function connect(token) {
  client = createClient({ url: TURSO_URL, authToken: token });
}

async function tryConnect(token) {
  connect(token);
  // Smallest possible query to validate the token actually works.
  await client.execute({ sql: "SELECT 1", args: [] });
}

async function q(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows.map((row) => {
    const obj = {};
    res.columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

function showApp() {
  document.getElementById("login-screen").hidden = true;
  document.getElementById("app").hidden = false;
}

function showLogin(errorMsg) {
  document.getElementById("login-screen").hidden = false;
  document.getElementById("app").hidden = true;
  const err = document.getElementById("login-error");
  if (errorMsg) {
    err.textContent = errorMsg;
    err.hidden = false;
  } else {
    err.hidden = true;
  }
}

let _tabsBound = false;
function bindTabs() {
  if (_tabsBound) return;
  _tabsBound = true;
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
      btn.classList.add("active");
      const panel = document.getElementById(`tab-${btn.dataset.tab}`);
      panel.classList.remove("hidden");
      if (btn.dataset.tab === "cloud-jobs") refreshJobQueue();
      else if (btn.dataset.tab === "run-history") { refreshRuns(); refreshDigests(); }
      else if (btn.dataset.tab === "aggregator-candidates") refreshAggregatorCandidates();
      else if (btn.dataset.tab === "excluded-domains") refreshExcludedDomains();
    });
  });
}

async function init() {
  const stored = getStoredToken();
  if (stored) {
    try {
      await tryConnect(stored);
      showApp();
      bindTabs();
      await refreshAll();
      return;
    } catch (e) {
      localStorage.removeItem(TOKEN_KEY);
    }
  }
  showLogin();
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = document.getElementById("login-token").value.trim();
  if (!token) return;
  try {
    await tryConnect(token);
    localStorage.setItem(TOKEN_KEY, token);
    showApp();
    bindTabs();
    await refreshAll();
  } catch (err) {
    showLogin("Connection failed — check the token and try again.");
  }
});

document.getElementById("logout-btn").addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  client = null;
  showLogin();
});

// ── Filter state ───────────────────────────────────────────────────────────

function readFilters() {
  return {
    tier: document.getElementById("f-tier").value,
    scope: document.getElementById("f-scope").value,
    status: document.getElementById("f-status").value,
    eligibility: document.getElementById("f-eligibility").value,
    country: document.getElementById("f-country").value.trim(),
    deadline_before: document.getElementById("f-dl-before").value,
    app_fee: document.getElementById("f-app-fee").value,
    cost: document.getElementById("f-cost").value,
    max_cost: document.getElementById("f-max-cost").value,
    opp_class: document.getElementById("f-opp-class").value,
    flagged: document.getElementById("f-flagged").value,
    mismatch: document.getElementById("f-mismatch").value,
    source_language: document.getElementById("f-source-language").value.trim(),
    source: document.getElementById("f-source").value.trim(),
    search: document.getElementById("f-search").value.trim(),
    group: document.getElementById("f-group").checked,
    group_similar: document.getElementById("f-group-similar").checked,
  };
}

const SORT_COLS = {
  id: "o.id",
  tier: "COALESCE(o.manual_tier, o.llm_tier)",
  title: "o.title COLLATE NOCASE",
  institution: "i.canonical_name COLLATE NOCASE",
  country: "o.country",
  deadline: "o.deadline",
  duration: "o.duration_weeks",
  stipend: "o.stipend",
  cost: "o.residency_cost_amount",
  recurring: "o.is_recurring",
  eligibility: "o.eligibility_match",
  status: "o.status",
  added: "o.created_at",
  added_by: "o.created_at",
};

// Mirrors web/db.py::list_opportunities's WHERE-clause construction, adapted
// for the real (name-based) country storage — see the note above.
function buildWhere(filters) {
  const conditions = ["1=1"];
  const params = [];

  if (filters.scope) {
    conditions.push("o.scope = ?");
    params.push(filters.scope);
  }
  if (filters.tier) {
    conditions.push("COALESCE(o.manual_tier, o.llm_tier) = ?");
    params.push(Number(filters.tier));
  }
  if (filters.status && filters.status !== "all") {
    conditions.push("o.status = ?");
    params.push(filters.status);
  }
  if (filters.eligibility === "eligible") {
    conditions.push("o.eligibility_match = 'eligible'");
  } else if (filters.eligibility === "not_ineligible") {
    conditions.push("o.eligibility_match != 'ineligible'");
  }
  if (filters.country) {
    const code = countryCode(filters.country);
    if (code === "_EU") {
      conditions.push(`o.country IN (${EU_CODES.map(() => "?").join(",")})`);
      params.push(...EU_CODES);
    } else if (code === "_EUR") {
      conditions.push(`o.country IN (${EUROPE_CODES.map(() => "?").join(",")})`);
      params.push(...EUROPE_CODES);
    } else {
      conditions.push("o.country = ?");
      params.push(code);
    }
  }
  if (filters.app_fee === "none") {
    conditions.push("(o.has_application_fee = 0 OR o.has_application_fee IS NULL)");
  } else if (filters.app_fee === "has") {
    conditions.push("o.has_application_fee = 1");
  }
  if (filters.cost === "none") {
    conditions.push(
      "(o.has_cost = 0 OR o.has_cost IS NULL) AND (o.has_application_fee = 0 OR o.has_application_fee IS NULL)"
    );
  } else if (filters.cost === "has") {
    conditions.push("(o.has_cost = 1 OR o.has_application_fee = 1)");
  }
  if (filters.opp_class) {
    conditions.push("o.opportunity_class = ?");
    params.push(filters.opp_class);
  }
  if (filters.flagged === "only") {
    conditions.push("o.flagged = 1");
  } else if (filters.flagged === "hide") {
    conditions.push("(o.flagged = 0 OR o.flagged IS NULL)");
  }
  if (filters.mismatch === "only") {
    conditions.push("o.hard_data_mismatch = 1");
  } else if (filters.mismatch === "hide") {
    conditions.push("(o.hard_data_mismatch = 0 OR o.hard_data_mismatch IS NULL)");
  }
  if (filters.deadline_before) {
    conditions.push("o.deadline <= ?");
    params.push(filters.deadline_before);
  }
  if (filters.max_cost) {
    const n = Number(filters.max_cost);
    if (!Number.isNaN(n)) {
      conditions.push(
        "(o.has_cost = 0 OR (o.residency_cost_amount IS NOT NULL AND o.residency_cost_amount <= ?))"
      );
      params.push(n);
    }
  }
  if (filters.source_language) {
    conditions.push("o.source_language = ?");
    params.push(filters.source_language);
  }
  if (filters.source) {
    if (filters.source === "agg:all") {
      conditions.push(
        "o.source_id IS NOT NULL AND EXISTS (SELECT 1 FROM sources s2 WHERE s2.id = o.source_id AND s2.source_type = 'aggregator')"
      );
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
  if (filters.search) {
    conditions.push("(o.title LIKE ? OR i.canonical_name LIKE ?)");
    const pat = `%${filters.search}%`;
    params.push(pat, pat);
  }

  return { where: conditions.join(" AND "), params };
}

const JOINS = `
  LEFT JOIN institutions i ON o.institution_id = i.id
`;

async function fetchList(filters, page, perPage, sortBy, sortDir) {
  const { where, params } = buildWhere(filters);
  const sortCol = SORT_COLS[sortBy] || "COALESCE(o.manual_tier, o.llm_tier)";
  const dir = sortDir === "desc" ? "DESC" : "ASC";
  const order = sortBy && sortBy !== "tier"
    ? `${sortCol} ${dir}, COALESCE(o.manual_tier, o.llm_tier) ASC`
    : `COALESCE(o.manual_tier, o.llm_tier) ${dir}, o.deadline ASC`;

  const totalRows = await q(
    `SELECT COUNT(*) AS n FROM opportunities o ${JOINS} WHERE ${where}`,
    params
  );
  const total = totalRows[0].n;

  const offset = (page - 1) * perPage;
  const rows = await q(
    `SELECT o.id, o.title, o.institution_id, i.canonical_name AS institution, o.country, o.city,
            o.deadline, COALESCE(o.manual_tier, o.llm_tier) AS effective_tier,
            o.eligibility_match, o.status, o.scope, o.url,
            o.duration_weeks, o.stipend, o.stipend_amount,
            o.pay_amount_value, o.pay_currency, o.pay_basis,
            o.has_cost, o.cost_description, o.residency_cost_amount,
            o.is_recurring, o.hard_data_mismatch, o.flagged,
            o.opportunity_class, o.opportunity_type, o.created_at
     FROM opportunities o ${JOINS}
     WHERE ${where}
     ORDER BY ${order}
     LIMIT ? OFFSET ?`,
    [...params, perPage, offset]
  );

  return { total, rows };
}

// ── Display formatters for the new table columns ──────────────────────────

function fmtDuration(r) {
  return r.duration_weeks != null ? `${r.duration_weeks}w` : "—";
}

function fmtStipendCell(r) {
  if (r.pay_amount_value != null) {
    const basis = r.pay_basis && r.pay_basis !== "unstated" ? ` /${r.pay_basis.replace(/_/g, " ")}` : "";
    return `${r.pay_amount_value}${r.pay_currency ? " " + r.pay_currency : ""}${basis}`;
  }
  if (r.stipend_amount) return r.stipend_amount;
  if (r.stipend === 1) return "Yes";
  if (r.stipend === 0) return "—";
  return "—";
}

function fmtCostCell(r) {
  if (r.residency_cost_amount != null) return `${r.residency_cost_amount}`;
  if (r.cost_description) return r.cost_description;
  if (r.has_cost === 1) return "Yes";
  if (r.has_cost === 0) return "—";
  return "—";
}

// ── Similar-call clustering (display aid only — see web/static/app.js for the
// original; same algorithm, same LCS-based ratio matching rapidfuzz fuzz.ratio) ──

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

// Hard-gates on institution/country/city/class/type, then single-linkage
// clusters the remainder by fuzzy title similarity.
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

function groupByInstitution(items) {
  const groups = new Map();
  for (const opp of items) {
    const key = opp.institution || "Unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(opp);
  }
  return groups;
}

async function fetchOpportunity(id) {
  const rows = await q(
    `SELECT o.*, i.canonical_name AS institution_name, i.website AS institution_website,
            i.trust_score AS institution_trust_score
     FROM opportunities o
     LEFT JOIN institutions i ON o.institution_id = i.id
     WHERE o.id = ?`,
    [id]
  );
  if (!rows.length) return null;
  const d = rows[0];
  for (const field of ["discipline_tags", "eligibility_other", "prestige_signals", "ambiguities", "llm_output_json"]) {
    if (d[field] && typeof d[field] === "string") {
      try { d[field] = JSON.parse(d[field]); } catch (_) { /* leave as string */ }
    }
  }
  return d;
}

async function fetchStats() {
  const total = (await q("SELECT COUNT(*) AS n FROM opportunities WHERE status != 'archived'"))[0].n;
  const byTier = await q(
    "SELECT COALESCE(manual_tier, llm_tier) AS k, COUNT(*) AS n FROM opportunities WHERE status != 'archived' GROUP BY 1"
  );
  const unreviewed = (await q(
    "SELECT COUNT(*) AS n FROM opportunities WHERE manually_reviewed = 0 AND status != 'archived'"
  ))[0].n;
  return { total, byTier, unreviewed };
}

// Hand-correctable extraction fields — mirrors web/db.py's
// _EDITABLE_OPP_FIELDS. type drives fieldEditInputHtml()'s input rendering.
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
  country:             { type: "text", label: "Country (ISO2, e.g. DE)" },
  city:                { type: "text" },
  status:              { type: "select", options: ["active", "expired", "archived", "duplicate", "suspicious"] },
};

// manual-review fields + EDITABLE_FIELDS + the two dismiss-shortcut fields
// (flagged, hard_data_mismatch — set by dismissFlag()/dismissMismatch(), not
// the generic edit grid). Mirrors web/db.py::patch_opportunity's allowed set.
const WRITABLE_FIELDS = new Set([
  "manual_tier", "manual_tier_reason", "notes", "manually_reviewed",
  "flagged", "hard_data_mismatch",
  ...Object.keys(EDITABLE_FIELDS),
]);

async function patchOpportunity(id, updates) {
  const valid = Object.entries(updates).filter(([k]) => WRITABLE_FIELDS.has(k));
  if (!valid.length) return;
  const sets = valid.map(([k]) => `${k} = ?`).join(", ");
  const params = valid.map(([k, v]) =>
    (k === "discipline_tags" || k === "eligibility_other") && Array.isArray(v) ? JSON.stringify(v) : v
  );
  await client.execute({
    sql: `UPDATE opportunities SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    args: [...params, id],
  });
}

function humanizeFieldKey(key) {
  const override = EDITABLE_FIELDS[key] && EDITABLE_FIELDS[key].label;
  if (override) return override;
  return key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
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
    const arr = Array.isArray(value) ? value : [];
    return `<input type="text" id="${id}" class="field-edit-input" value="${esc(arr.join(", "))}" placeholder="comma-separated">`;
  }
  if (meta.type === "number") {
    return `<input type="number" id="${id}" class="field-edit-input" value="${value != null ? esc(String(value)) : ""}" step="any">`;
  }
  if (meta.type === "date") {
    return `<input type="date" id="${id}" class="field-edit-input" value="${value ? esc(String(value).slice(0, 10)) : ""}">`;
  }
  return `<textarea id="${id}" class="field-edit-input field-edit-textarea" rows="1">${esc(value != null ? value : "")}</textarea>`;
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

async function dismissFlag(id) {
  await patchOpportunity(id, { flagged: 0, manually_reviewed: 1 });
  await openDetail(id);
  await refreshList();
}

async function dismissMismatch(id) {
  await patchOpportunity(id, { hard_data_mismatch: 0, manually_reviewed: 1 });
  await openDetail(id);
  await refreshList();
}

// ── Rendering ────────────────────────────────────────────────────────────

function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderStats(stats) {
  const tierStr = stats.byTier.map((r) => `T${r.k ?? "?"}: ${r.n}`).join("  ");
  document.getElementById("stats").textContent =
    `${stats.total} active · ${stats.unreviewed} unreviewed · ${tierStr}`;
}

function _rowHtml(r, indent) {
  const pad = indent ? ` style="padding-left:${indent}px"` : "";
  return `
    <td>${esc(r.effective_tier)}</td>
    <td${pad}>${r.flagged ? "&#9873; " : ""}${esc(r.title)}</td>
    <td>${esc(r.institution)}</td>
    <td>${esc(countryName(r.country))}</td>
    <td>${esc(r.deadline) || "open"}</td>
    <td>${fmtDuration(r)}</td>
    <td>${esc(fmtStipendCell(r))}</td>
    <td>${esc(fmtCostCell(r))}</td>
    <td>${r.is_recurring ? "Yes" : "—"}</td>
    <td>${esc(r.eligibility_match)}</td>
    <td>${esc(r.status)}${r.hard_data_mismatch ? " &#9888;" : ""}</td>
  `;
}

function _makeRow(r, indent) {
  const tr = document.createElement("tr");
  tr.className = "opp-row";
  tr.dataset.id = r.id;
  tr.innerHTML = _rowHtml(r, indent);
  tr.addEventListener("click", () => openDetail(r.id));
  return tr;
}

function _groupHeaderRow(label, count) {
  const tr = document.createElement("tr");
  tr.className = "group-header-row";
  tr.innerHTML = `<td colspan="11"><strong>${esc(label)}</strong> <span class="group-count">(${count})</span></td>`;
  return tr;
}

function renderRows(rows, filters) {
  const tbody = document.getElementById("opp-tbody");
  tbody.innerHTML = "";

  const appendFlat = (items, indent) => {
    if (filters.group_similar) {
      const { clusters, ungrouped } = clusterBySimilarTitle(items);
      const idToCluster = new Map();
      clusters.forEach((cl, ci) => cl.forEach(o => idToCluster.set(o.id, ci)));
      const rendered = new Set();
      for (const opp of items) {
        const ci = idToCluster.get(opp.id);
        if (ci === undefined) { tbody.appendChild(_makeRow(opp, indent)); continue; }
        if (rendered.has(ci)) continue;
        rendered.add(ci);
        const clusterItems = clusters[ci];
        tbody.appendChild(_groupHeaderRow(`↳ ${clusterItems.length} similar listings`, clusterItems.length));
        clusterItems.forEach(o => tbody.appendChild(_makeRow(o, indent + 20)));
      }
    } else {
      items.forEach(opp => tbody.appendChild(_makeRow(opp, indent)));
    }
  };

  if (filters.group) {
    const groups = groupByInstitution(rows);
    for (const [name, items] of groups) {
      tbody.appendChild(_groupHeaderRow(name, items.length));
      appendFlat(items, 20);
    }
  } else {
    appendFlat(rows, 0);
  }
}

function renderPagination(filters) {
  const totalPages = Math.max(1, Math.ceil(state.total / state.perPage));
  const el = document.getElementById("pagination");
  el.innerHTML = "";
  if (filters.group || filters.group_similar) {
    el.textContent = `${state.total} total (grouped view shows up to ${state.perPage} at once)`;
    return;
  }
  const prev = document.createElement("button");
  prev.textContent = "< Prev";
  prev.disabled = state.page <= 1;
  prev.addEventListener("click", () => { state.page--; refreshList(); });
  const next = document.createElement("button");
  next.textContent = "Next >";
  next.disabled = state.page >= totalPages;
  next.addEventListener("click", () => { state.page++; refreshList(); });
  const label = document.createElement("span");
  label.textContent = ` Page ${state.page} / ${totalPages} (${state.total} total) `;
  el.append(prev, label, next);
}

async function refreshList() {
  const filters = readFilters();
  // Grouping needs a coherent set to group, not one pagination slice — use a
  // larger page size and skip normal pagination while either toggle is on.
  const perPage = (filters.group || filters.group_similar) ? 500 : state.perPage;
  const page = (filters.group || filters.group_similar) ? 1 : state.page;
  const { total, rows } = await fetchList(filters, page, perPage, state.sortBy, state.sortDir);
  state.total = total;
  renderRows(rows, filters);
  renderPagination(filters);
}

async function refreshAll() {
  await refreshList();
  renderStats(await fetchStats());
}

document.getElementById("f-apply").addEventListener("click", () => {
  state.page = 1;
  refreshList();
});

document.querySelectorAll("#opp-table thead th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (state.sortBy === key) {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    } else {
      state.sortBy = key;
      state.sortDir = "asc";
    }
    refreshList();
  });
});

// ── Detail panel ────────────────────────────────────────────────────────

let _showLlmOutput = false;

async function openDetail(id) {
  const opp = await fetchOpportunity(id);
  if (!opp) return;
  const panel = document.getElementById("detail-panel");
  const content = document.getElementById("detail-content");

  const flagBanner = opp.flagged
    ? `<div class="banner banner-flag">&#9873; Flagged${opp.flag_reason ? ": " + esc(opp.flag_reason) : ""}
        <button type="button" id="d-dismiss-flag">Dismiss</button></div>`
    : "";
  const mismatchBanner = opp.hard_data_mismatch
    ? `<div class="banner banner-mismatch">&#9888; Prefilter/extraction hard-data mismatch
        <button type="button" id="d-dismiss-mismatch">Dismiss</button></div>`
    : "";
  const llmJson = typeof opp.llm_output_json === "object" ? opp.llm_output_json : null;

  content.innerHTML = `
    <h2>${esc(opp.title)}</h2>
    <p>
      <button type="button" class="link-button" id="d-open-institution">${esc(opp.institution_name) || "Unknown institution"}</button>
      · ${esc(countryName(opp.country)) || "?"} · Deadline: ${esc(opp.deadline) || "open"}
    </p>
    <p>LLM tier: ${esc(opp.llm_tier)} (manual: ${esc(opp.manual_tier) || "—"}) ·
       Eligibility: ${esc(opp.eligibility_match)} · Scope: ${esc(opp.scope)} ·
       Class: ${esc(opp.opportunity_class) || "—"}</p>
    ${flagBanner}
    ${mismatchBanner}
    ${opp.summary ? `<p>${esc(opp.summary)}</p>` : ""}
    ${opp.evaluation ? `<p><em>${esc(opp.evaluation)}</em></p>` : ""}
    ${opp.url ? `<p><a href="${esc(opp.url)}" target="_blank" rel="noopener">Apply / Info</a></p>` : ""}
    <hr>
    <form id="detail-form">
      <label>Manual tier
        <select id="d-manual-tier">
          <option value="">— unset —</option>
          <option value="1">1</option><option value="2">2</option>
          <option value="3">3</option><option value="4">4</option>
        </select>
      </label>
      <label>Manual tier reason
        <input id="d-manual-tier-reason" type="text">
      </label>
      <label>Notes
        <textarea id="d-notes" rows="3"></textarea>
      </label>
      <label><input type="checkbox" id="d-reviewed"> Mark reviewed</label>
      <button type="submit">Save</button>
      <span id="d-save-status"></span>
    </form>

    <hr>
    <button type="button" id="d-toggle-edit">Edit extraction fields</button>
    <button type="button" id="d-toggle-llm">${_showLlmOutput ? "Hide" : "Show"} LLM output</button>
    <div id="d-edit-grid" class="field-edit-grid" hidden>
      ${renderEditableGrid(opp)}
      <div class="field-edit-actions">
        <button type="button" id="d-save-edit">Save extraction fields</button>
        <span id="d-edit-status"></span>
      </div>
    </div>
    <pre id="d-llm-output" class="llm-output" ${_showLlmOutput ? "" : "hidden"}>${llmJson ? esc(JSON.stringify(llmJson, null, 2)) : "(no llm_output_json on this row)"}</pre>
  `;
  document.getElementById("d-manual-tier").value = opp.manual_tier ?? "";
  document.getElementById("d-manual-tier-reason").value = opp.manual_tier_reason ?? "";
  document.getElementById("d-notes").value = opp.notes ?? "";
  document.getElementById("d-reviewed").checked = !!opp.manually_reviewed;

  document.getElementById("detail-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const updates = {
      manual_tier: document.getElementById("d-manual-tier").value
        ? Number(document.getElementById("d-manual-tier").value) : null,
      manual_tier_reason: document.getElementById("d-manual-tier-reason").value || null,
      notes: document.getElementById("d-notes").value || null,
      manually_reviewed: document.getElementById("d-reviewed").checked ? 1 : 0,
    };
    const status = document.getElementById("d-save-status");
    try {
      await patchOpportunity(id, updates);
      status.textContent = "Saved.";
      await refreshList();
    } catch (err) {
      status.textContent = "Save failed.";
    }
  });

  document.getElementById("d-toggle-edit").addEventListener("click", () => {
    const grid = document.getElementById("d-edit-grid");
    grid.hidden = !grid.hidden;
  });
  document.getElementById("d-toggle-llm").addEventListener("click", (e) => {
    _showLlmOutput = !_showLlmOutput;
    document.getElementById("d-llm-output").hidden = !_showLlmOutput;
    e.target.textContent = `${_showLlmOutput ? "Hide" : "Show"} LLM output`;
  });
  document.getElementById("d-save-edit").addEventListener("click", async () => {
    const status = document.getElementById("d-edit-status");
    try {
      await patchOpportunity(id, collectEditedFields());
      status.textContent = "Saved.";
      await refreshList();
    } catch (err) {
      status.textContent = "Save failed.";
    }
  });
  const dismissFlagBtn = document.getElementById("d-dismiss-flag");
  if (dismissFlagBtn) dismissFlagBtn.addEventListener("click", () => dismissFlag(id));
  const dismissMismatchBtn = document.getElementById("d-dismiss-mismatch");
  if (dismissMismatchBtn) dismissMismatchBtn.addEventListener("click", () => dismissMismatch(id));
  document.getElementById("d-open-institution").addEventListener("click", () => {
    if (opp.institution_id) openInstitution(opp.institution_id);
  });

  panel.hidden = false;
}

document.getElementById("detail-close").addEventListener("click", () => {
  document.getElementById("detail-panel").hidden = true;
});

// ── Institution detail panel ──────────────────────────────────────────────

async function fetchInstitution(id) {
  const rows = await q("SELECT * FROM institutions WHERE id = ?", [id]);
  if (!rows.length) return null;
  const inst = rows[0];
  inst.opportunities = await q(
    `SELECT id, title, deadline, llm_tier, manual_tier, status
     FROM opportunities WHERE institution_id = ? ORDER BY deadline DESC`,
    [id]
  );
  return inst;
}

async function openInstitution(id) {
  const inst = await fetchInstitution(id);
  if (!inst) return;
  const panel = document.getElementById("institution-panel");
  const content = document.getElementById("institution-content");
  const callRows = inst.opportunities.map(o => `
    <tr class="opp-row" data-id="${o.id}">
      <td>${esc(o.manual_tier || o.llm_tier)}</td>
      <td>${esc(o.title)}</td>
      <td>${esc(o.deadline) || "open"}</td>
      <td>${esc(o.status)}</td>
    </tr>`).join("");
  content.innerHTML = `
    <h2>${esc(inst.canonical_name)}</h2>
    <p>${esc(inst.city) || "?"}, ${esc(countryName(inst.country)) || "?"} ·
       Trust score: ${inst.trust_score != null ? Number(inst.trust_score).toFixed(2) : "—"} ·
       Type: ${esc(inst.institution_type) || "—"}</p>
    ${inst.website ? `<p><a href="${esc(inst.website)}" target="_blank" rel="noopener">${esc(inst.website)}</a></p>` : ""}
    ${inst.description ? `<p>${esc(inst.description)}</p>` : ""}
    <p>Total calls posted: ${esc(inst.total_calls_posted) || 0}</p>
    <hr>
    <h3>Calls from this institution (${inst.opportunities.length})</h3>
    <table class="admin-table">
      <thead><tr><th>Tier</th><th>Title</th><th>Deadline</th><th>Status</th></tr></thead>
      <tbody>${callRows}</tbody>
    </table>
  `;
  content.querySelectorAll("tr.opp-row").forEach(tr => {
    tr.addEventListener("click", () => {
      panel.hidden = true;
      openDetail(Number(tr.dataset.id));
    });
  });
  panel.hidden = false;
}

document.getElementById("institution-close").addEventListener("click", () => {
  document.getElementById("institution-panel").hidden = true;
});

// ── Cloud Jobs tab (Phase 7B.3 command_queue) ──────────────────────────────

const _JOB_FIELD_VISIBILITY = {
  run_researcher: ["job-mode-field", "job-limit-field", "job-full-scrape-field"],
  run_scrape: ["job-limit-field", "job-full-scrape-field"],
  run_pipeline: [],
};

document.getElementById("job-command").addEventListener("change", (e) => {
  const visible = new Set(_JOB_FIELD_VISIBILITY[e.target.value] || []);
  ["job-mode-field", "job-limit-field", "job-full-scrape-field"].forEach(id => {
    document.getElementById(id).style.display = visible.has(id) ? "" : "none";
  });
});

document.getElementById("job-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const command = document.getElementById("job-command").value;
  const args = {};
  if (command !== "run_pipeline") {
    args.limit = Number(document.getElementById("job-limit").value) || undefined;
    args.full_scrape = document.getElementById("job-full-scrape").checked || undefined;
  }
  if (command === "run_researcher") {
    args.mode = document.getElementById("job-mode").value;
  }
  const status = document.getElementById("job-submit-status");
  try {
    await client.execute({
      sql: "INSERT INTO command_queue (command, args) VALUES (?, ?)",
      args: [command, JSON.stringify(args)],
    });
    status.textContent = "Enqueued.";
    await refreshJobQueue();
  } catch (err) {
    status.textContent = "Failed: " + err.message;
  }
});

async function refreshJobQueue() {
  const rows = await q(
    "SELECT id, command, args, status, requested_at, finished_at, result_note FROM command_queue ORDER BY id DESC LIMIT 50"
  );
  const tbody = document.getElementById("job-queue-tbody");
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${esc(r.id)}</td>
      <td>${esc(r.command)}</td>
      <td>${esc(r.args)}</td>
      <td>${esc(r.status)}</td>
      <td>${esc(r.requested_at)}</td>
      <td>${esc(r.finished_at)}</td>
      <td>${esc(r.result_note)}</td>
    </tr>`).join("") || `<tr><td colspan="7"><em>No jobs yet.</em></td></tr>`;
}

document.getElementById("job-refresh").addEventListener("click", refreshJobQueue);

// ── Run History tab ────────────────────────────────────────────────────────

async function refreshRuns() {
  const rows = await q(
    `SELECT id, status, extract_mode, triggered_by, new_opportunities,
            api_requests, api_tokens_in, api_tokens_out, started_at, finished_at
     FROM pipeline_runs ORDER BY id DESC LIMIT 30`
  );
  const tbody = document.getElementById("runs-tbody");
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${esc(r.id)}</td>
      <td>${esc(r.status)}</td>
      <td>${esc(r.extract_mode)}</td>
      <td>${esc(r.triggered_by)}</td>
      <td>${esc(r.new_opportunities)}</td>
      <td>${esc(r.api_requests)}</td>
      <td>${esc(r.api_tokens_in)}/${esc(r.api_tokens_out)}</td>
      <td>${esc(r.started_at)}</td>
      <td>${esc(r.finished_at)}</td>
    </tr>`).join("") || `<tr><td colspan="9"><em>No runs yet.</em></td></tr>`;
}

async function refreshDigests() {
  const rows = await q(
    "SELECT id, run_id, kind, created_at, summary, markdown FROM digests ORDER BY id DESC LIMIT 10"
  );
  const el = document.getElementById("digests-list");
  el.innerHTML = rows.map(r => `
    <details class="digest-entry">
      <summary>#${esc(r.id)} (run ${esc(r.run_id)}, ${esc(r.kind)}) — ${esc(r.created_at)} — ${esc(r.summary)}</summary>
      <pre class="digest-markdown">${esc(r.markdown)}</pre>
    </details>`).join("") || "<em>No digests yet.</em>";
}

document.getElementById("runs-refresh").addEventListener("click", refreshRuns);
document.getElementById("digests-refresh").addEventListener("click", refreshDigests);

// ── Aggregator Candidates tab ──────────────────────────────────────────────

async function refreshAggregatorCandidates() {
  const rows = await q(
    `SELECT id, url, name, aggregator_signals, aggregator_detected_at
     FROM sources WHERE aggregator_status = 'candidate' ORDER BY aggregator_detected_at DESC`
  );
  const tbody = document.getElementById("agg-tbody");
  tbody.innerHTML = rows.map(r => `
    <tr data-id="${r.id}">
      <td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a></td>
      <td>${esc(r.name)}</td>
      <td>${esc(r.aggregator_signals)}</td>
      <td>${esc(r.aggregator_detected_at)}</td>
      <td>
        <button type="button" class="agg-confirm">Confirm</button>
        <button type="button" class="agg-reject">Reject</button>
      </td>
    </tr>`).join("") || `<tr><td colspan="5"><em>No candidates pending.</em></td></tr>`;

  tbody.querySelectorAll(".agg-confirm").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      await client.execute({
        sql: "UPDATE sources SET aggregator_status='confirmed', source_type='aggregator' WHERE id=?",
        args: [id],
      });
      await refreshAggregatorCandidates();
    });
  });
  tbody.querySelectorAll(".agg-reject").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      await client.execute({ sql: "UPDATE sources SET aggregator_status='rejected' WHERE id=?", args: [id] });
      await refreshAggregatorCandidates();
    });
  });
}

document.getElementById("agg-refresh").addEventListener("click", refreshAggregatorCandidates);

// ── Excluded Domains tab ───────────────────────────────────────────────────
// Ports pipeline/domain_reputation.py::is_excluded/exclusion_reason — pure
// functions over a domain_reputation row, same constants as the backend.

const _MIN_STRUCTURAL_REJECTS = 5;
const _TTL_DAYS = 90;

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

function exclusionReason(row) {
  return `learned exclusion: ${row.structural_reject_count || 0} structural non-call rejection(s), 0 successes`;
}

async function refreshExcludedDomains() {
  const rows = await q("SELECT * FROM domain_reputation ORDER BY structural_reject_count DESC LIMIT 200");
  const excluded = rows.filter(isExcluded);
  const tbody = document.getElementById("dom-tbody");
  tbody.innerHTML = excluded.map(r => `
    <tr data-domain="${esc(r.domain)}">
      <td>${esc(r.domain)}</td>
      <td>${esc(r.structural_reject_count)}</td>
      <td>${esc(r.total_processed)}</td>
      <td>${esc(r.last_rejected_at)}</td>
      <td>${esc(exclusionReason(r))}</td>
      <td><button type="button" class="dom-restore">Restore</button></td>
    </tr>`).join("") || `<tr><td colspan="6"><em>No excluded domains.</em></td></tr>`;

  tbody.querySelectorAll(".dom-restore").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const domain = e.target.closest("tr").dataset.domain;
      await client.execute({
        sql: "UPDATE domain_reputation SET manual_override='include', updated_at=datetime('now') WHERE domain=?",
        args: [domain],
      });
      await refreshExcludedDomains();
    });
  });
}

document.getElementById("dom-refresh").addEventListener("click", refreshExcludedDomains);

init();
