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

function httpsGet(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'AidWatch/1.0 (public-interest accountability tool)' } }, (res) => {
      // follow one redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpsGet(res.headers.location, timeoutMs));
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
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

// ── external: GDELT (global news, 100+ countries, thousands of outlets) ──────

app.get('/api/external/gdelt', async (req, res) => {
  const { q, mode = 'accountability' } = req.query;
  if (!q) return res.json({ results: [] });

  // accountability-biased query: org name + accountability-relevant terms
  const accountabilityTerms = '(fraud OR corruption OR misconduct OR investigation OR audit OR scandal OR abuse OR "sexual exploitation" OR whistleblower OR debarred OR sanctioned OR mismanagement OR "aid diversion")';
  const fullQuery = mode === 'all'
    ? `"${q}"`
    : `"${q}" AND ${accountabilityTerms}`;

  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(fullQuery)}&mode=ArtList&maxrecords=40&sort=DateDesc&format=json&timespan=10y`;
  const data = await httpsGet(url);

  if (!data || !data.articles) {
    return res.json({ results: [], source: 'gdelt', error: 'unavailable' });
  }

  // dedupe by domain — keep most recent per outlet, max 25 total
  const seen = new Map();
  for (const a of data.articles) {
    const dom = a.domain || 'unknown';
    if (!seen.has(dom)) seen.set(dom, a);
  }

  const results = [...seen.values()].slice(0, 25).map(a => ({
    source: 'Media',
    title: a.title,
    url: a.url,
    domain: a.domain,
    outlet: prettyOutlet(a.domain),
    country: a.sourcecountry || 'International',
    language: a.language || 'English',
    date: a.seendate ? formatGdeltDate(a.seendate) : null,
    image: a.socialimage || null,
  }));

  res.json({ results, source: 'gdelt', total: data.articles.length });
});

function formatGdeltDate(s) {
  // GDELT date format: 20250115T120000Z
  if (!s || s.length < 8) return null;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}

function prettyOutlet(domain) {
  if (!domain) return 'Unknown';
  const map = {
    'theguardian.com': 'The Guardian',
    'nytimes.com': 'The New York Times',
    'washingtonpost.com': 'The Washington Post',
    'reuters.com': 'Reuters',
    'apnews.com': 'Associated Press',
    'bbc.com': 'BBC News',
    'bbc.co.uk': 'BBC News',
    'aljazeera.com': 'Al Jazeera',
    'devex.com': 'Devex',
    'thenewhumanitarian.org': 'The New Humanitarian',
    'irinnews.org': 'IRIN News',
    'occrp.org': 'OCCRP',
    'ft.com': 'Financial Times',
    'economist.com': 'The Economist',
    'lemonde.fr': 'Le Monde',
    'liberation.fr': 'Libération',
    'spiegel.de': 'Der Spiegel',
    'sueddeutsche.de': 'Süddeutsche Zeitung',
    'elpais.com': 'El País',
    'corriere.it': 'Corriere della Sera',
    'thehindu.com': 'The Hindu',
    'timesofindia.indiatimes.com': 'Times of India',
    'scmp.com': 'South China Morning Post',
    'japantimes.co.jp': 'The Japan Times',
    'abc.net.au': 'ABC News (Australia)',
    'cbc.ca': 'CBC News',
    'globeandmail.com': 'The Globe and Mail',
    'allafrica.com': 'AllAfrica',
    'mg.co.za': 'Mail & Guardian',
    'dailynation.africa': 'Daily Nation',
    'standardmedia.co.ke': 'The Standard',
    'premiumtimesng.com': 'Premium Times Nigeria',
    'globalwitness.org': 'Global Witness',
    'transparency.org': 'Transparency International',
    'hrw.org': 'Human Rights Watch',
  };
  return map[domain] || domain.replace(/^www\./, '').split('.')[0]
    .replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── external: Wikipedia (knowledge panel) ────────────────────────────────────

app.get('/api/external/wikipedia', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ result: null });

  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=1&format=json&origin=*`;
  const search = await httpsGet(searchUrl);
  const title = search?.query?.search?.[0]?.title;
  if (!title) return res.json({ result: null });

  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const summary = await httpsGet(summaryUrl);

  if (!summary) return res.json({ result: null });

  res.json({
    result: {
      title: summary.title,
      description: summary.description,
      extract: summary.extract,
      thumbnail: summary.thumbnail?.source || null,
      url: summary.content_urls?.desktop?.page,
      source: 'Wikipedia',
    },
  });
});

// ── external: OpenAlex (academic) ────────────────────────────────────────────

app.get('/api/external/openalex', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ results: [] });

  const url = `https://api.openalex.org/works?search=${encodeURIComponent(q + ' (corruption OR fraud OR accountability OR governance OR misconduct)')}&per-page=8&sort=publication_date:desc`;
  const data = await httpsGet(url);

  if (!data || !data.results) return res.json({ results: [], source: 'openalex' });

  const results = data.results.map(w => ({
    source: 'OpenAlex',
    title: w.title,
    authors: (w.authorships || []).slice(0, 3).map(a => a.author?.display_name).filter(Boolean).join(', '),
    year: w.publication_year,
    venue: w.host_venue?.display_name || w.primary_location?.source?.display_name || null,
    url: w.doi ? `https://doi.org/${w.doi.replace('https://doi.org/', '')}` : w.id,
    citations: w.cited_by_count || 0,
  }));

  res.json({ results, source: 'openalex' });
});

// ── meta-search: everything in parallel ──────────────────────────────────────

app.get('/api/everything', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ query: '', sections: {} });

  const localResults = DB.cases
    .map(c => ({ ...c, _score: scoreMatch(c, q) }))
    .filter(c => c._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 12)
    .map(({ _score, ...c }) => c);

  const matchedOrgs = DB.organizations.filter(o =>
    o.name.toLowerCase().includes(q.toLowerCase()) ||
    o.slug.toLowerCase().includes(q.toLowerCase())
  );

  // fan out external requests in parallel
  const [wb, os, gdelt, wiki, oa] = await Promise.all([
    httpsGet(`https://apigwext.worldbank.org/dvsvc/v1.0/json/APPLICATION/ADOBE_EXPRNCE_MGR/FIRM/debarred?FORMAT=JSON`),
    httpsGet(`https://api.opensanctions.org/search/default?q=${encodeURIComponent(q)}&limit=6&schema=Organization`),
    httpsGet(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${q}" AND (fraud OR corruption OR misconduct OR investigation OR audit OR scandal OR abuse OR whistleblower OR debarred OR sanctioned OR mismanagement OR "aid diversion")`)}&mode=ArtList&maxrecords=40&sort=DateDesc&format=json&timespan=10y`),
    (async () => {
      const s = await httpsGet(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=1&format=json&origin=*`);
      const t = s?.query?.search?.[0]?.title;
      if (!t) return null;
      return await httpsGet(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t)}`);
    })(),
    httpsGet(`https://api.openalex.org/works?search=${encodeURIComponent(q + ' (corruption OR fraud OR accountability OR governance OR misconduct)')}&per-page=8&sort=publication_date:desc`),
  ]);

  const ql = q.toLowerCase();

  const wbResults = (wb?.debarredFirms || [])
    .filter(f => (f.firmName || '').toLowerCase().includes(ql) || (f.country || '').toLowerCase().includes(ql))
    .slice(0, 8)
    .map(f => ({
      name: f.firmName, country: f.country, grounds: f.grounds,
      fromDate: f.fromDate, toDate: f.toDate || 'Indefinite',
      url: 'https://www.worldbank.org/en/projects-operations/procurement/debarred-firms',
    }));

  const osResults = (os?.results || []).map(r => ({
    name: r.caption,
    country: r.properties?.country?.[0] || 'Unknown',
    datasets: r.datasets?.join(', '),
    url: `https://www.opensanctions.org/entities/${r.id}/`,
  }));

  const seenDomains = new Map();
  for (const a of (gdelt?.articles || [])) {
    const dom = a.domain || 'unknown';
    if (!seenDomains.has(dom)) seenDomains.set(dom, a);
  }
  const mediaResults = [...seenDomains.values()].slice(0, 25).map(a => ({
    title: a.title,
    url: a.url,
    domain: a.domain,
    outlet: prettyOutlet(a.domain),
    country: a.sourcecountry || 'International',
    language: a.language || 'English',
    date: a.seendate ? formatGdeltDate(a.seendate) : null,
    image: a.socialimage || null,
  }));

  const knowledge = wiki ? {
    title: wiki.title,
    description: wiki.description,
    extract: wiki.extract,
    thumbnail: wiki.thumbnail?.source || null,
    url: wiki.content_urls?.desktop?.page,
  } : null;

  const academicResults = (oa?.results || []).map(w => ({
    title: w.title,
    authors: (w.authorships || []).slice(0, 3).map(a => a.author?.display_name).filter(Boolean).join(', '),
    year: w.publication_year,
    venue: w.host_venue?.display_name || w.primary_location?.source?.display_name || null,
    url: w.doi ? `https://doi.org/${w.doi.replace('https://doi.org/', '')}` : w.id,
    citations: w.cited_by_count || 0,
  }));

  // outlet diversity stats
  const outlets = new Set(mediaResults.map(m => m.outlet));
  const countries = new Set(mediaResults.map(m => m.country));

  res.json({
    query: q,
    knowledge,
    organization: matchedOrgs[0] || null,
    matchedOrgs,
    sections: {
      cases: { total: localResults.length, results: localResults },
      sanctions: {
        total: wbResults.length + osResults.length,
        worldBank: wbResults,
        openSanctions: osResults,
      },
      media: {
        total: mediaResults.length,
        outlets: outlets.size,
        countries: countries.size,
        results: mediaResults,
      },
      academic: { total: academicResults.length, results: academicResults },
    },
  });
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
