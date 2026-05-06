'use strict';

const express = require('express');
const cors = require('cors');
const https = require('https');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load local database
const DB = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'cases.json'), 'utf8'));

// ── helpers ──────────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'AidWatch/1.0 (public-interest accountability tool)' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(6000, () => { req.destroy(); resolve(null); });
  });
}

function scoreMatch(c, q) {
  if (!q) return 1;
  const ql = q.toLowerCase();
  let score = 0;
  if (c.org.toLowerCase().includes(ql)) score += 10;
  if (c.title.toLowerCase().includes(ql)) score += 6;
  if (c.country.toLowerCase().includes(ql)) score += 5;
  if (c.summary.toLowerCase().includes(ql)) score += 3;
  if (c.source.toLowerCase().includes(ql)) score += 3;
  if (c.tags.some(t => t.toLowerCase().includes(ql))) score += 4;
  if (c.type.toLowerCase().includes(ql)) score += 2;
  return score;
}

// ── local search ──────────────────────────────────────────────────────────────

app.get('/api/search', (req, res) => {
  const { q = '', type, region, sourceType, year, sort = 'relevance' } = req.query;

  let results = DB.cases.map(c => ({ ...c, _score: scoreMatch(c, q) }));

  if (q) results = results.filter(c => c._score > 0);
  if (type) results = results.filter(c => c.type === type);
  if (region) results = results.filter(c => c.region === region);
  if (sourceType) results = results.filter(c => c.sourceType === sourceType);
  if (year) results = results.filter(c => c.year === parseInt(year));

  if (sort === 'relevance') results.sort((a, b) => b._score - a._score);
  else if (sort === 'recent') results.sort((a, b) => b.year - a.year);
  else if (sort === 'amount') results.sort((a, b) => b.amountNum - a.amountNum);

  res.json({
    total: results.length,
    results: results.map(({ _score, ...c }) => c),
    source: 'local',
  });
});

// ── org profile ───────────────────────────────────────────────────────────────

app.get('/api/org/:id', (req, res) => {
  const org = DB.organizations.find(o => o.id === parseInt(req.params.id) || o.slug === req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  const cases = DB.cases.filter(c => org.caseIds.includes(c.id));
  res.json({ org, cases });
});

app.get('/api/org', (req, res) => {
  const { q = '' } = req.query;
  const ql = q.toLowerCase();
  const results = q
    ? DB.organizations.filter(o => o.name.toLowerCase().includes(ql) || o.type.toLowerCase().includes(ql))
    : DB.organizations;
  res.json({ total: results.length, results });
});

// ── stats ─────────────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  const cases = DB.cases;
  const byType = {};
  const byRegion = {};
  const byYear = {};
  const bySource = {};
  let totalAmount = 0;

  for (const c of cases) {
    byType[c.type] = (byType[c.type] || 0) + 1;
    byRegion[c.region] = (byRegion[c.region] || 0) + 1;
    byYear[c.year] = (byYear[c.year] || 0) + 1;
    bySource[c.sourceType] = (bySource[c.sourceType] || 0) + 1;
    totalAmount += c.amountNum || 0;
  }

  res.json({
    totalCases: cases.length,
    totalOrgs: DB.organizations.length,
    totalAmount,
    byType,
    byRegion,
    byYear,
    bySource,
  });
});

// ── recent ────────────────────────────────────────────────────────────────────

app.get('/api/recent', (req, res) => {
  const n = parseInt(req.query.n) || 8;
  const recent = [...DB.cases].sort((a, b) => b.year - a.year || b.id - a.id).slice(0, n);
  res.json({ results: recent });
});

// ── external: World Bank debarment ───────────────────────────────────────────

app.get('/api/external/worldbank', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ results: [] });

  const url = `https://apigwext.worldbank.org/dvsvc/v1.0/json/APPLICATION/ADOBE_EXPRNCE_MGR/FIRM/debarred?FORMAT=JSON`;
  const data = await httpsGet(url);

  if (!data || !data.debarredFirms) {
    return res.json({ results: [], source: 'worldbank', error: 'unavailable' });
  }

  const ql = q.toLowerCase();
  const matches = (data.debarredFirms || [])
    .filter(f =>
      (f.firmName || '').toLowerCase().includes(ql) ||
      (f.country || '').toLowerCase().includes(ql)
    )
    .slice(0, 10)
    .map(f => ({
      source: 'World Bank Debarment',
      name: f.firmName,
      country: f.country,
      grounds: f.grounds,
      fromDate: f.fromDate,
      toDate: f.toDate || 'Indefinite',
      url: 'https://www.worldbank.org/en/projects-operations/procurement/debarred-firms',
    }));

  res.json({ results: matches, source: 'worldbank' });
});

// ── external: OpenSanctions ───────────────────────────────────────────────────

app.get('/api/external/opensanctions', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ results: [] });

  const url = `https://api.opensanctions.org/search/default?q=${encodeURIComponent(q)}&limit=8&schema=Organization`;
  const data = await httpsGet(url);

  if (!data || !data.results) {
    return res.json({ results: [], source: 'opensanctions', error: 'unavailable' });
  }

  const results = (data.results || []).map(r => ({
    source: 'OpenSanctions',
    name: r.caption,
    country: r.properties?.country?.[0] || 'Unknown',
    datasets: r.datasets?.join(', '),
    score: r.score,
    url: `https://www.opensanctions.org/entities/${r.id}/`,
  }));

  res.json({ results, source: 'opensanctions' });
});

// ── sources list ──────────────────────────────────────────────────────────────

app.get('/api/sources', (req, res) => {
  res.json({ sources: SOURCES });
});

// ── fallback to SPA ───────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  ⚖️  AidWatch running at http://localhost:${PORT}\n`);
});

// ── sources reference ─────────────────────────────────────────────────────────

const SOURCES = [
  { category: 'UN Oversight', name: 'UN OIOS', description: 'UN Office of Internal Oversight Services — investigations across all UN entities', url: 'https://oios.un.org' },
  { category: 'UN Oversight', name: 'UNDP Internal Audit', description: 'UNDP audit and investigation reports', url: 'https://audit.undp.org' },
  { category: 'UN Oversight', name: 'UNICEF Internal Audit', description: 'UNICEF audit reports and investigation summaries', url: 'https://www.unicef.org/about/audit' },
  { category: 'UN Oversight', name: 'WFP Inspector General', description: 'WFP Office of Inspector General reports', url: 'https://www.wfp.org/inspector-general' },
  { category: 'UN Oversight', name: 'UNHCR Inspector General', description: 'UNHCR Inspector General investigations', url: 'https://www.unhcr.org/inspector-general' },
  { category: 'UN Oversight', name: 'WHO Internal Audit', description: 'WHO Office of Internal Oversight Services', url: 'https://www.who.int/about/accountability/audit' },
  { category: 'UN Oversight', name: 'UNFPA Internal Audit', description: 'UNFPA audit and oversight reports', url: 'https://www.unfpa.org/resources/internal-audit-reports' },
  { category: 'UN Oversight', name: 'UN Ethics Office', description: 'Whistleblower and retaliation cases', url: 'https://www.un.org/en/ethics' },
  { category: 'Donor Governments', name: 'USAID OIG', description: 'US Agency for International Development Office of Inspector General', url: 'https://oig.usaid.gov' },
  { category: 'Donor Governments', name: 'FCDO / DFID', description: 'UK Foreign Commonwealth & Development Office audit reports and annual reviews', url: 'https://www.gov.uk/fcdo' },
  { category: 'Donor Governments', name: 'EU OLAF', description: 'European Anti-Fraud Office — covers all EU-funded aid and development', url: 'https://anti-fraud.ec.europa.eu' },
  { category: 'Donor Governments', name: 'GIZ Internal Audit', description: 'German development agency compliance and audit', url: 'https://www.giz.de/en/aboutgiz/compliance.html' },
  { category: 'Donor Governments', name: 'DFAT (Australia)', description: 'Australian Department of Foreign Affairs and Trade audits', url: 'https://www.dfat.gov.au' },
  { category: 'Donor Governments', name: 'Norad Evaluation', description: 'Norwegian Agency for Development Cooperation evaluations', url: 'https://www.norad.no/en' },
  { category: 'Donor Governments', name: 'Sida Audit', description: 'Swedish International Development Cooperation Agency audits', url: 'https://www.sida.se/en' },
  { category: 'Development Banks', name: 'World Bank INT', description: 'World Bank Integrity Vice Presidency — debarment and investigation reports', url: 'https://www.worldbank.org/en/projects-operations/procurement/debarred-firms' },
  { category: 'Development Banks', name: 'AfDB Integrity', description: 'African Development Bank integrity investigations and debarment', url: 'https://www.afdb.org/en/topics-and-sectors/topics/fiduciary-services-and-inspection' },
  { category: 'Development Banks', name: 'ADB Integrity', description: 'Asian Development Bank Office of Anticorruption and Integrity', url: 'https://www.adb.org/site/integrity/main' },
  { category: 'Development Banks', name: 'IADB OII', description: 'Inter-American Development Bank Office of Institutional Integrity', url: 'https://www.iadb.org/en/who-we-are/topics/integrity' },
  { category: 'Development Banks', name: 'EBRD', description: 'European Bank for Reconstruction and Development debarment', url: 'https://www.ebrd.com/integrity-and-compliance' },
  { category: 'Sanctions & Debarment', name: 'OpenSanctions', description: 'Aggregated global sanctions lists from 100+ sources', url: 'https://www.opensanctions.org' },
  { category: 'Sanctions & Debarment', name: 'SAM.gov Exclusions', description: 'US federal excluded parties list', url: 'https://sam.gov' },
  { category: 'Sanctions & Debarment', name: 'UN Security Council', description: 'UN SC sanctions for terrorism financing and arms embargo violations', url: 'https://www.un.org/securitycouncil/sanctions' },
  { category: 'Sanctions & Debarment', name: 'EU Sanctions Map', description: 'Full EU consolidated sanctions list', url: 'https://www.sanctionsmap.eu' },
  { category: 'Investigative Journalism', name: 'OCCRP', description: 'Organized Crime and Corruption Reporting Project', url: 'https://www.occrp.org' },
  { category: 'Investigative Journalism', name: 'The New Humanitarian', description: 'Aid sector accountability journalism', url: 'https://www.thenewhumanitarian.org' },
  { category: 'Investigative Journalism', name: 'Finance Uncovered', description: 'Financial flows in international development', url: 'https://financeuncovered.org' },
  { category: 'Investigative Journalism', name: 'Global Witness', description: 'Resource corruption and aid diversion investigations', url: 'https://www.globalwitness.org' },
  { category: 'Investigative Journalism', name: 'The Sentry', description: 'Africa-focused warlord economy and aid diversion investigations', url: 'https://thesentry.org' },
  { category: 'Watchdogs & Civil Society', name: 'Transparency International', description: 'Corruption perception data and documented cases', url: 'https://www.transparency.org' },
  { category: 'Watchdogs & Civil Society', name: 'Aidspan', description: 'Global Fund watchdog — funding and accountability', url: 'https://www.aidspan.org' },
  { category: 'Watchdogs & Civil Society', name: 'PSEA Network', description: 'Protection from Sexual Exploitation and Abuse inter-agency tracking', url: 'https://www.un.org/en/spotlight-initiative' },
  { category: 'Watchdogs & Civil Society', name: 'Human Rights Watch', description: 'Documented abuse by humanitarian actors', url: 'https://www.hrw.org' },
];
