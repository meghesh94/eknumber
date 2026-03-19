const path = require('path');
const Fuse = require('fuse.js');
const { google } = require('googleapis');

const FUSE_THRESHOLD = 0.4;
const FUSE_TOP_N = 2;
const STRONG_MATCH_THRESHOLD = 0.8;
const CACHE_REFRESH_MS = 10 * 60 * 1000; // 10 minutes

let cachedCompanies = [];
let lastFetch = 0;
let sheetsClient = null;

function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath) return null;
  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(process.cwd(), credPath),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

function normalizeAliases(aliases) {
  if (Array.isArray(aliases)) return aliases.map((a) => String(a).trim().toLowerCase()).filter(Boolean);
  if (typeof aliases === 'string') return aliases.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
  return [];
}

function loadLocalFallback() {
  try {
    const dataPath = path.join(process.cwd(), 'data', 'companies.json');
    const data = require(dataPath);
    const list = Array.isArray(data) ? data : (data.companies || []);
    return list.map((c) => ({
      ...c,
      aliases: [c.name.toLowerCase(), ...normalizeAliases(c.aliases || [])],
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Fetch companies from Google Sheets. Sheet must have columns: name, aliases, support_number, category, active
 */
async function fetchFromSheets() {
  const sheetId = process.env.GOOGLE_SHEETS_ID;
  if (!sheetId) return loadLocalFallback();

  const sheets = getSheetsClient();
  if (!sheets) return loadLocalFallback();

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Sheet1!A:E',
    });

    const rows = res.data.values || [];
    if (rows.length < 2) return loadLocalFallback();

    const headers = rows[0].map((h) => String(h).trim().toLowerCase());
    const nameIdx = headers.indexOf('name');
    const aliasesIdx = headers.indexOf('aliases');
    const supportNumberIdx = headers.indexOf('support_number');
    const categoryIdx = headers.indexOf('category');
    const activeIdx = headers.indexOf('active');

    if (nameIdx < 0 || supportNumberIdx < 0) return loadLocalFallback();

    const companies = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const name = row[nameIdx] ? String(row[nameIdx]).trim() : '';
      const supportNumber = row[supportNumberIdx] ? String(row[supportNumberIdx]).trim() : '';
      if (!name || !supportNumber) continue;

      const activeVal = activeIdx >= 0 && row[activeIdx] != null ? String(row[activeIdx]).toUpperCase() : 'TRUE';
      if (activeVal === 'FALSE') continue;

      const aliases = aliasesIdx >= 0 && row[aliasesIdx]
        ? String(row[aliasesIdx])
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean)
        : [];
      const category = categoryIdx >= 0 && row[categoryIdx] ? String(row[categoryIdx]).trim() : '';

      companies.push({
        name,
        aliases: [name.toLowerCase(), ...aliases.map((a) => a.toLowerCase())],
        support_number: supportNumber,
        category,
        active: true,
      });
    }

    return companies;
  } catch (e) {
    console.error('Google Sheets fetch error:', e.message);
    return loadLocalFallback();
  }
}

async function getCompanies(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedCompanies.length > 0 && now - lastFetch < CACHE_REFRESH_MS) {
    return cachedCompanies;
  }
  cachedCompanies = await fetchFromSheets();
  lastFetch = now;
  return cachedCompanies;
}

function buildSearchList(companies) {
  const list = [];
  for (const c of companies) {
    list.push({ id: c.name, support_number: c.support_number, searchText: c.name });
    for (const a of c.aliases || []) {
      if (a !== c.name.toLowerCase()) list.push({ id: c.name, support_number: c.support_number, searchText: a });
    }
  }
  return list;
}

/**
 * Fuzzy match user input against company names and aliases.
 * Returns { type: 'strong'|'ambiguous'|'none', company, companies, transcript }
 */
async function matchCompany(transcript) {
  if (!transcript || !transcript.trim()) {
    return { type: 'none', transcript: transcript || '', company: null, companies: [] };
  }

  const companies = await getCompanies();
  const searchList = buildSearchList(companies);

  const fuse = new Fuse(searchList, {
    keys: ['searchText'],
    threshold: FUSE_THRESHOLD,
    includeScore: true,
  });

  const raw = fuse.search(transcript.trim());
  const top = raw.slice(0, FUSE_TOP_N).filter((r) => r.score != null && r.score <= 1);

  if (top.length === 0) {
    return { type: 'none', transcript, company: null, companies: [] };
  }

  const best = top[0];
  const bestScore = 1 - best.score;

  if (bestScore >= STRONG_MATCH_THRESHOLD && (top.length === 1 || 1 - top[1].score < STRONG_MATCH_THRESHOLD)) {
    const company = companies.find((c) => c.name === best.item.id);
    return {
      type: 'strong',
      transcript,
      company: company ? { name: company.name, support_number: company.support_number } : { name: best.item.id, support_number: best.item.support_number },
      companies: [],
    };
  }

  if (top.length >= 2 && Math.abs((1 - top[0].score) - (1 - top[1].score)) < 0.15) {
    const names = [...new Set(top.map((t) => t.item.id))];
    const companiesMatch = names.map((name) => {
      const c = companies.find((x) => x.name === name);
      return c ? { name: c.name, support_number: c.support_number } : { name, support_number: top.find((t) => t.item.id === name).item.support_number };
    });
    return { type: 'ambiguous', transcript, company: null, companies: companiesMatch };
  }

  const company = companies.find((c) => c.name === best.item.id);
  return {
    type: 'strong',
    transcript,
    company: company ? { name: company.name, support_number: company.support_number } : { name: best.item.id, support_number: best.item.support_number },
    companies: [],
  };
}

async function refreshCache() {
  lastFetch = 0;
  await getCompanies(true);
}

module.exports = {
  getCompanies,
  matchCompany,
  refreshCache,
  STRONG_MATCH_THRESHOLD,
};
