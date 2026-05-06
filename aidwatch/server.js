'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const START_TIME = Date.now();

// ── security middleware ────────────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://api.gdeltproject.org', 'https://api.opensanctions.org',
        'https://en.wikipedia.org', 'https://api.openalex.org', 'https://apigwext.worldbank.org'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));

// general API rate limit
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX || '120'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests — please slow down.' },
});

// stricter limit for external-fetch endpoints
const externalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_EXTERNAL || '20'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many external search requests.' },
});

app.use('/api', apiLimiter);
app.use('/api/external', externalLimiter);
app.use('/api/everything', externalLimiter);

// request ID middleware — UUID per request
app.use((req, _res, next) => {
  req.id = crypto.randomUUID();
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// robots.txt
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(
    'User-agent: *\nDisallow: /api/cases\nDisallow: /api/search\nAllow: /\n',
  );
});

// ── load database ──────────────────────────────────────────────────────────────

const DB = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'cases.json'), 'utf8'));

// ── input helpers ─────────────────────────────────────────────────────────────

function sanitizeStr(v, maxLen = 200) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, maxLen);
}

function sanitizeInt(v, fallback, min = 1, max = 100) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parsePage(query) {
  const page = sanitizeInt(query.page, 1, 1, 1000);
  const limit = sanitizeInt(query.limit, 20, 1, 100);
  return { page, limit, offset: (page - 1) * limit };
}

// ── scoring ───────────────────────────────────────────────────────────────────

function scoreMatch(c, q) {
  if (!q) return 1;
  const ql = q.toLowerCase();
  let score = 0;
  if ((c.org || '').toLowerCase().includes(ql)) score += 10;
  if ((c.title || '').toLowerCase().includes(ql)) score += 6;
  if ((c.country || '').toLowerCase().includes(ql)) score += 5;
  if ((c.summary || '').toLowerCase().includes(ql)) score += 3;
  if ((c.source || '').toLowerCase().includes(ql)) score += 3;
  if ((c.tags || []).some(t => t.toLowerCase().includes(ql))) score += 4;
  if ((c.type || '').toLowerCase().includes(ql)) score += 2;
  if ((c.region || '').toLowerCase().includes(ql)) score += 2;
  return score;
}

function getSeverity(c) {
  const t = (c.type || '').toLowerCase();
  if (t.includes('sexual') || t.includes('sea')) return 'critical';
  if (c.amountNum >= 50_000_000) return 'critical';
  if (t.includes('financial fraud') || t.includes('fraud')) {
    return c.amountNum >= 5_000_000 ? 'critical' : 'high';
  }
  if (t.includes('corruption')) return 'high';
  if (t.includes('diversion') || t.includes('procurement')) {
    return c.amountNum >= 10_000_000 ? 'critical' : 'high';
  }
  if (t.includes('sanction')) return 'high';
  if (c.amountNum >= 1_000_000) return 'high';
  return 'medium';
}

function enrichCase(c) {
  return { ...c, severity: getSeverity(c) };
}

// ── org risk score 0-100 ──────────────────────────────────────────────────────

function calcRiskScore(org) {
  const sevWeights = { critical: 20, high: 10, medium: 5 };
  let score = 0;
  const cases = DB.cases.filter(c => org.caseIds.includes(c.id));
  score += cases.length * 10;
  for (const c of cases) {
    const sev = getSeverity(c);
    score += sevWeights[sev] || 0;
    if (c.year >= 2020) score = Math.floor(score * 1.2);
    if (c.amountNum > 0) score += Math.min(20, Math.floor(Math.log10(c.amountNum + 1) * 2));
  }
  return Math.min(100, score);
}

// ── fuzzy suggest ─────────────────────────────────────────────────────────────

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function getSuggest(q) {
  if (!q || q.length < 3) return [];
  const ql = q.toLowerCase();
  const tokens = new Set();
  for (const c of DB.cases) {
    for (const word of [c.org, c.title, c.country, c.type, c.region, ...(c.tags || [])]) {
      if (typeof word === 'string') {
        for (const w of word.toLowerCase().split(/[\s,/()-]+/)) {
          if (w.length >= 4) tokens.add(w);
        }
      }
    }
  }
  const scored = [];
  for (const t of tokens) {
    const dist = levenshtein(ql, t);
    if (dist > 0 && dist <= 2 && !t.startsWith(ql)) scored.push({ t, dist });
  }
  scored.sort((a, b) => a.dist - b.dist);
  return scored.slice(0, 5).map(s => s.t);
}

// ── health ─────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
      cases: DB.cases.length,
      organizations: DB.organizations.length,
      timestamp: new Date().toISOString(),
    },
  });
});

// ── search ─────────────────────────────────────────────────────────────────────

app.get('/api/search', (req, res) => {
  const q = sanitizeStr(req.query.q, 200);
  const type = sanitizeStr(req.query.type, 100);
  const region = sanitizeStr(req.query.region, 100);
  const sourceType = sanitizeStr(req.query.sourceType, 100);
  const status = sanitizeStr(req.query.status, 50);
  const severity = sanitizeStr(req.query.severity, 20);
  const yearFrom = req.query.yearFrom ? sanitizeInt(req.query.yearFrom, null, 1990, 2099) : null;
  const yearTo = req.query.yearTo ? sanitizeInt(req.query.yearTo, null, 1990, 2099) : null;
  const sort = sanitizeStr(req.query.sort, 20) || 'relevance';
  const { page, limit, offset } = parsePage(req.query);

  let results = DB.cases.map(c => ({ ...enrichCase(c), _score: scoreMatch(c, q) }));

  if (q) results = results.filter(c => c._score > 0);
  if (type) results = results.filter(c => c.type === type);
  if (region) results = results.filter(c => c.region === region);
  if (sourceType) results = results.filter(c => c.sourceType === sourceType);
  if (status) results = results.filter(c => c.status === status);
  if (severity) results = results.filter(c => c.severity === severity);
  if (yearFrom !== null) results = results.filter(c => c.year >= yearFrom);
  if (yearTo !== null) results = results.filter(c => c.year <= yearTo);

  const sortFns = {
    relevance: (a, b) => b._score - a._score,
    newest: (a, b) => b.year - a.year || b.id - a.id,
    oldest: (a, b) => a.year - b.year || a.id - b.id,
    amount: (a, b) => b.amountNum - a.amountNum,
    severity: (a, b) => {
      const order = { critical: 3, high: 2, medium: 1 };
      return (order[b.severity] || 0) - (order[a.severity] || 0);
    },
  };
  results.sort(sortFns[sort] || sortFns.relevance);

  const total = results.length;
  const paged = results.slice(offset, offset + limit).map(({ _score, ...c }) => c);

  const suggestions = total === 0 && q ? getSuggest(q) : [];

  res.json({
    success: true,
    data: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      results: paged,
      didYouMean: suggestions.length > 0 ? suggestions[0] : null,
      suggestions,
    },
    source: 'local',
  });
});

// ── related cases (must precede /api/cases/:id) ───────────────────────────────

app.get('/api/cases/related/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid case ID' });

  const c = DB.cases.find(x => x.id === id);
  if (!c) return res.status(404).json({ success: false, error: 'Case not found' });

  const related = DB.cases
    .filter(r => r.id !== id && (r.orgId === c.orgId || r.type === c.type || (c.relatedCases || []).includes(r.id)))
    .sort((a, b) => b.year - a.year)
    .slice(0, 6)
    .map(enrichCase);

  res.json({ success: true, data: { caseId: id, total: related.length, results: related } });
});

// ── case by id ─────────────────────────────────────────────────────────────────

app.get('/api/cases/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid case ID' });

  const c = DB.cases.find(x => x.id === id);
  if (!c) return res.status(404).json({ success: false, error: 'Case not found' });

  const enriched = enrichCase(c);
  const org = DB.organizations.find(o => o.id === c.orgId) || null;

  // related: same org or same type, exclude self, limit 4
  const related = DB.cases
    .filter(r => r.id !== id && (r.orgId === c.orgId || r.type === c.type))
    .sort((a, b) => b.year - a.year)
    .slice(0, 4)
    .map(enrichCase);

  res.json({ success: true, data: { case: enriched, org, related } });
});

// ── org profile ───────────────────────────────────────────────────────────────

app.get('/api/org/:id', (req, res) => {
  const idParam = sanitizeStr(req.params.id, 100);
  const org = DB.organizations.find(
    o => o.id === parseInt(idParam, 10) || o.slug === idParam,
  );
  if (!org) return res.status(404).json({ success: false, error: 'Organization not found' });

  const cases = DB.cases
    .filter(c => org.caseIds.includes(c.id))
    .map(enrichCase)
    .sort((a, b) => b.year - a.year);

  res.json({ success: true, data: { org, cases } });
});

app.get('/api/org', (req, res) => {
  const q = sanitizeStr(req.query.q, 200).toLowerCase();
  const results = q
    ? DB.organizations.filter(
        o => o.name.toLowerCase().includes(q) || (o.type || '').toLowerCase().includes(q),
      )
    : DB.organizations;

  res.json({ success: true, data: { total: results.length, results } });
});

// ── stats ─────────────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  const cases = DB.cases;
  const byType = {};
  const byRegion = {};
  const byYear = {};
  const bySource = {};
  const bySeverity = {};
  const byStatus = {};
  let totalAmount = 0;

  for (const c of cases) {
    const sev = getSeverity(c);
    byType[c.type] = (byType[c.type] || 0) + 1;
    byRegion[c.region] = (byRegion[c.region] || 0) + 1;
    byYear[c.year] = (byYear[c.year] || 0) + 1;
    bySource[c.sourceType] = (bySource[c.sourceType] || 0) + 1;
    bySeverity[sev] = (bySeverity[sev] || 0) + 1;
    byStatus[c.status || 'unknown'] = (byStatus[c.status || 'unknown'] || 0) + 1;
    totalAmount += c.amountNum || 0;
  }

  res.json({
    success: true,
    data: {
      totalCases: cases.length,
      totalOrgs: DB.organizations.length,
      totalAmount,
      byType,
      byRegion,
      byYear,
      bySource,
      bySeverity,
      byStatus,
    },
  });
});

// ── recent ─────────────────────────────────────────────────────────────────────

app.get('/api/recent', (req, res) => {
  const n = sanitizeInt(req.query.n, 8, 1, 50);
  const recent = [...DB.cases]
    .sort((a, b) => b.year - a.year || b.id - a.id)
    .slice(0, n)
    .map(enrichCase);
  res.json({ success: true, data: { results: recent } });
});

// ── external: World Bank debarment ───────────────────────────────────────────

app.get('/api/external/worldbank', async (req, res) => {
  const q = sanitizeStr(req.query.q, 200);
  if (!q) return res.json({ success: true, data: { results: [] } });

  const url = `https://apigwext.worldbank.org/dvsvc/v1.0/json/APPLICATION/ADOBE_EXPRNCE_MGR/FIRM/debarred?FORMAT=JSON`;
  const data = await httpsGet(url);

  if (!data || !data.debarredFirms) {
    return res.json({ success: true, data: { results: [], source: 'worldbank', error: 'unavailable' } });
  }

  const ql = q.toLowerCase();
  const results = (data.debarredFirms || [])
    .filter(f => (f.firmName || '').toLowerCase().includes(ql) || (f.country || '').toLowerCase().includes(ql))
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

  res.json({ success: true, data: { results, source: 'worldbank' } });
});

// ── external: OpenSanctions ───────────────────────────────────────────────────

app.get('/api/external/opensanctions', async (req, res) => {
  const q = sanitizeStr(req.query.q, 200);
  if (!q) return res.json({ success: true, data: { results: [] } });

  const url = `https://api.opensanctions.org/search/default?q=${encodeURIComponent(q)}&limit=8&schema=Organization`;
  const data = await httpsGet(url);

  if (!data || !data.results) {
    return res.json({ success: true, data: { results: [], source: 'opensanctions', error: 'unavailable' } });
  }

  const results = (data.results || []).map(r => ({
    source: 'OpenSanctions',
    name: r.caption,
    country: r.properties?.country?.[0] || 'Unknown',
    datasets: r.datasets?.join(', '),
    score: r.score,
    url: `https://www.opensanctions.org/entities/${r.id}/`,
  }));

  res.json({ success: true, data: { results, source: 'opensanctions' } });
});

// ── external: GDELT ──────────────────────────────────────────────────────────

app.get('/api/external/gdelt', async (req, res) => {
  const q = sanitizeStr(req.query.q, 200);
  const mode = sanitizeStr(req.query.mode, 20) || 'accountability';
  if (!q) return res.json({ success: true, data: { results: [] } });

  const accountabilityTerms = '(fraud OR corruption OR misconduct OR investigation OR audit OR scandal OR abuse OR "sexual exploitation" OR whistleblower OR debarred OR sanctioned OR mismanagement OR "aid diversion")';
  const fullQuery = mode === 'all' ? `"${q}"` : `"${q}" AND ${accountabilityTerms}`;
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(fullQuery)}&mode=ArtList&maxrecords=40&sort=DateDesc&format=json&timespan=10y`;
  const data = await httpsGet(url);

  if (!data || !data.articles) {
    return res.json({ success: true, data: { results: [], source: 'gdelt', error: 'unavailable' } });
  }

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

  res.json({ success: true, data: { results, source: 'gdelt', total: data.articles.length } });
});

// ── external: Wikipedia ───────────────────────────────────────────────────────

app.get('/api/external/wikipedia', async (req, res) => {
  const q = sanitizeStr(req.query.q, 200);
  if (!q) return res.json({ success: true, data: { result: null } });

  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=1&format=json&origin=*`;
  const search = await httpsGet(searchUrl);
  const title = search?.query?.search?.[0]?.title;
  if (!title) return res.json({ success: true, data: { result: null } });

  const summary = await httpsGet(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
  if (!summary) return res.json({ success: true, data: { result: null } });

  res.json({
    success: true,
    data: {
      result: {
        title: summary.title,
        description: summary.description,
        extract: summary.extract,
        thumbnail: summary.thumbnail?.source || null,
        url: summary.content_urls?.desktop?.page,
        source: 'Wikipedia',
      },
    },
  });
});

// ── external: OpenAlex ────────────────────────────────────────────────────────

app.get('/api/external/openalex', async (req, res) => {
  const q = sanitizeStr(req.query.q, 200);
  if (!q) return res.json({ success: true, data: { results: [] } });

  const url = `https://api.openalex.org/works?search=${encodeURIComponent(q + ' (corruption OR fraud OR accountability OR governance OR misconduct)')}&per-page=8&sort=publication_date:desc`;
  const data = await httpsGet(url);

  if (!data || !data.results) return res.json({ success: true, data: { results: [], source: 'openalex' } });

  const results = data.results.map(w => ({
    source: 'OpenAlex',
    title: w.title,
    authors: (w.authorships || []).slice(0, 3).map(a => a.author?.display_name).filter(Boolean).join(', '),
    year: w.publication_year,
    venue: w.host_venue?.display_name || w.primary_location?.source?.display_name || null,
    url: w.doi ? `https://doi.org/${w.doi.replace('https://doi.org/', '')}` : w.id,
    citations: w.cited_by_count || 0,
  }));

  res.json({ success: true, data: { results, source: 'openalex' } });
});

// ── meta-search: everything in parallel ──────────────────────────────────────

app.get('/api/everything', async (req, res) => {
  const q = sanitizeStr(req.query.q, 200);
  if (!q) return res.json({ success: true, data: { query: '', sections: {} } });

  const localResults = DB.cases
    .map(c => ({ ...enrichCase(c), _score: scoreMatch(c, q) }))
    .filter(c => c._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 12)
    .map(({ _score, ...c }) => c);

  const matchedOrgs = DB.organizations.filter(o =>
    o.name.toLowerCase().includes(q.toLowerCase()) ||
    o.slug.toLowerCase().includes(q.toLowerCase()),
  );

  const [wb, os, gdelt, wiki, oa] = await Promise.all([
    httpsGet(`https://apigwext.worldbank.org/dvsvc/v1.0/json/APPLICATION/ADOBE_EXPRNCE_MGR/FIRM/debarred?FORMAT=JSON`),
    httpsGet(`https://api.opensanctions.org/search/default?q=${encodeURIComponent(q)}&limit=6&schema=Organization`),
    httpsGet(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${q}" AND (fraud OR corruption OR misconduct OR investigation OR audit OR scandal OR abuse OR whistleblower OR debarred OR sanctioned OR mismanagement OR "aid diversion")`)}&mode=ArtList&maxrecords=40&sort=DateDesc&format=json&timespan=10y`),
    (async () => {
      const s = await httpsGet(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=1&format=json&origin=*`);
      const t = s?.query?.search?.[0]?.title;
      if (!t) return null;
      return httpsGet(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t)}`);
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
    title: a.title, url: a.url, domain: a.domain,
    outlet: prettyOutlet(a.domain),
    country: a.sourcecountry || 'International',
    language: a.language || 'English',
    date: a.seendate ? formatGdeltDate(a.seendate) : null,
    image: a.socialimage || null,
  }));

  const knowledge = wiki ? {
    title: wiki.title, description: wiki.description, extract: wiki.extract,
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

  const outlets = new Set(mediaResults.map(m => m.outlet));
  const countries = new Set(mediaResults.map(m => m.country));

  res.json({
    success: true,
    data: {
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
    },
  });
});

// ── sources list ──────────────────────────────────────────────────────────────

app.get('/api/sources', (req, res) => {
  res.json({ success: true, data: { sources: SOURCES } });
});

// ── orgs list with risk scores ────────────────────────────────────────────────

app.get('/api/orgs', (req, res) => {
  const results = DB.organizations.map(org => ({
    ...org,
    riskScore: calcRiskScore(org),
    caseCount: org.caseIds.length,
  })).sort((a, b) => b.riskScore - a.riskScore);

  res.json({ success: true, data: { total: results.length, results } });
});

// ── org profile by name/slug ──────────────────────────────────────────────────

app.get('/api/orgs/:name', (req, res) => {
  const name = sanitizeStr(req.params.name, 200).toLowerCase();
  const org = DB.organizations.find(
    o => o.slug === name || o.name.toLowerCase() === name,
  );
  if (!org) return res.status(404).json({ success: false, error: 'Organization not found' });

  const cases = DB.cases
    .filter(c => org.caseIds.includes(c.id))
    .map(enrichCase)
    .sort((a, b) => b.year - a.year);

  res.json({ success: true, data: { org: { ...org, riskScore: calcRiskScore(org) }, cases } });
});

// ── autocomplete suggest ──────────────────────────────────────────────────────

app.get('/api/search/suggest', (req, res) => {
  const q = sanitizeStr(req.query.q, 100).toLowerCase();
  if (!q || q.length < 2) return res.json({ success: true, data: { suggestions: [] } });

  const seen = new Set();
  const suggestions = [];
  for (const c of DB.cases) {
    for (const field of [c.org, c.title, c.country, c.type, ...(c.tags || [])]) {
      if (typeof field === 'string' && field.toLowerCase().startsWith(q) && !seen.has(field)) {
        seen.add(field);
        suggestions.push(field);
        if (suggestions.length >= 8) break;
      }
    }
    if (suggestions.length >= 8) break;
  }

  // also add partial matches
  if (suggestions.length < 8) {
    for (const c of DB.cases) {
      for (const field of [c.org, c.title, c.country, c.type, ...(c.tags || [])]) {
        if (typeof field === 'string' && field.toLowerCase().includes(q) && !seen.has(field)) {
          seen.add(field);
          suggestions.push(field);
          if (suggestions.length >= 8) break;
        }
      }
      if (suggestions.length >= 8) break;
    }
  }

  res.json({ success: true, data: { query: q, suggestions } });
});

// ── CSV export ────────────────────────────────────────────────────────────────

app.get('/api/export/csv', (req, res) => {
  const headers = ['id', 'title', 'org', 'type', 'region', 'country', 'year', 'amount', 'amountNum', 'status', 'severity', 'source', 'sourceUrl'];
  const rows = DB.cases.map(c => {
    const enriched = enrichCase(c);
    return headers.map(h => {
      const v = enriched[h] === undefined ? '' : String(enriched[h]);
      return v.includes(',') || v.includes('"') || v.includes('\n') ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(',');
  });
  const csv = [headers.join(','), ...rows].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="aidwatch-cases.csv"');
  res.send(csv);
});

// ── trends ────────────────────────────────────────────────────────────────────

app.get('/api/trends', (req, res) => {
  const typeByYear = {};
  const regionByYear = {};
  const typeCounts = {};
  const regionCounts = {};

  for (const c of DB.cases) {
    const y = String(c.year);
    if (!typeByYear[y]) typeByYear[y] = {};
    typeByYear[y][c.type] = (typeByYear[y][c.type] || 0) + 1;
    if (!regionByYear[y]) regionByYear[y] = {};
    regionByYear[y][c.region] = (regionByYear[y][c.region] || 0) + 1;
    typeCounts[c.type] = (typeCounts[c.type] || 0) + 1;
    regionCounts[c.region] = (regionCounts[c.region] || 0) + 1;
  }

  const topTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
  const topRegions = Object.entries(regionCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);

  res.json({
    success: true,
    data: { typeByYear, regionByYear, topTypes, topRegions, typeCounts, regionCounts },
  });
});

// ── fallback to SPA ───────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── error handler ─────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[AidWatch] Unhandled error:', err.message);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// Only start the HTTP server when run directly (not during tests)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  ⚖️  AidWatch running at http://localhost:${PORT}\n`);
  });
}

module.exports = app;

// ── helpers ───────────────────────────────────────────────────────────────────

function httpsGet(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'AidWatch/1.0 (public-interest accountability tool)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpsGet(res.headers.location, timeoutMs));
      }
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

function formatGdeltDate(s) {
  if (!s || s.length < 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function prettyOutlet(domain) {
  if (!domain) return 'Unknown';
  const map = {
    'theguardian.com': 'The Guardian', 'nytimes.com': 'The New York Times',
    'washingtonpost.com': 'The Washington Post', 'reuters.com': 'Reuters',
    'apnews.com': 'Associated Press', 'bbc.com': 'BBC News', 'bbc.co.uk': 'BBC News',
    'aljazeera.com': 'Al Jazeera', 'devex.com': 'Devex',
    'thenewhumanitarian.org': 'The New Humanitarian', 'irinnews.org': 'IRIN News',
    'occrp.org': 'OCCRP', 'ft.com': 'Financial Times', 'economist.com': 'The Economist',
    'lemonde.fr': 'Le Monde', 'spiegel.de': 'Der Spiegel',
    'thehindu.com': 'The Hindu', 'scmp.com': 'South China Morning Post',
    'abc.net.au': 'ABC News (Australia)', 'cbc.ca': 'CBC News',
    'allafrica.com': 'AllAfrica', 'mg.co.za': 'Mail & Guardian',
    'premiumtimesng.com': 'Premium Times Nigeria',
    'globalwitness.org': 'Global Witness', 'transparency.org': 'Transparency International',
    'hrw.org': 'Human Rights Watch', 'oregonlive.com': 'The Oregonian',
    'thedailybeast.com': 'The Daily Beast', 'foreignpolicy.com': 'Foreign Policy',
  };
  return map[domain] || domain.replace(/^www\./, '').split('.')[0]
    .replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

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
  { category: 'UN Oversight', name: 'UN Conduct & Discipline', description: 'SEA case database across all UN missions', url: 'https://conduct.unmissions.org' },
  { category: 'Donor Governments', name: 'USAID OIG', description: 'US Agency for International Development Office of Inspector General', url: 'https://oig.usaid.gov' },
  { category: 'Donor Governments', name: 'SIGAR', description: 'Special Inspector General for Afghanistan Reconstruction', url: 'https://www.sigar.mil' },
  { category: 'Donor Governments', name: 'FCDO / DFID', description: 'UK Foreign Commonwealth & Development Office audit reports and annual reviews', url: 'https://www.gov.uk/fcdo' },
  { category: 'Donor Governments', name: 'EU OLAF', description: 'European Anti-Fraud Office — covers all EU-funded aid and development', url: 'https://anti-fraud.ec.europa.eu' },
  { category: 'Donor Governments', name: 'GIZ Internal Audit', description: 'German development agency compliance and audit', url: 'https://www.giz.de/en/aboutgiz/compliance.html' },
  { category: 'Donor Governments', name: 'Norad Evaluation', description: 'Norwegian Agency for Development Cooperation evaluations', url: 'https://www.norad.no/en' },
  { category: 'Development Banks', name: 'World Bank INT', description: 'World Bank Integrity Vice Presidency — debarment and investigation reports', url: 'https://www.worldbank.org/en/projects-operations/procurement/debarred-firms' },
  { category: 'Development Banks', name: 'AfDB Integrity', description: 'African Development Bank integrity investigations and debarment', url: 'https://www.afdb.org' },
  { category: 'Development Banks', name: 'ADB Integrity', description: 'Asian Development Bank Office of Anticorruption and Integrity', url: 'https://www.adb.org/site/integrity/main' },
  { category: 'Development Banks', name: 'IADB OII', description: 'Inter-American Development Bank Office of Institutional Integrity', url: 'https://www.iadb.org/en/who-we-are/topics/integrity' },
  { category: 'Sanctions & Debarment', name: 'OpenSanctions', description: 'Aggregated global sanctions lists from 100+ sources', url: 'https://www.opensanctions.org' },
  { category: 'Sanctions & Debarment', name: 'SAM.gov Exclusions', description: 'US federal excluded parties list', url: 'https://sam.gov' },
  { category: 'Sanctions & Debarment', name: 'UN Security Council', description: 'UN SC sanctions for terrorism financing and arms embargo violations', url: 'https://www.un.org/securitycouncil/sanctions' },
  { category: 'Investigative Journalism', name: 'OCCRP', description: 'Organized Crime and Corruption Reporting Project', url: 'https://www.occrp.org' },
  { category: 'Investigative Journalism', name: 'The New Humanitarian', description: 'Aid sector accountability journalism', url: 'https://www.thenewhumanitarian.org' },
  { category: 'Investigative Journalism', name: 'Global Witness', description: 'Resource corruption and aid diversion investigations', url: 'https://www.globalwitness.org' },
  { category: 'Investigative Journalism', name: 'The Sentry', description: 'Africa-focused warlord economy and aid diversion investigations', url: 'https://thesentry.org' },
  { category: 'Watchdogs & Civil Society', name: 'Transparency International', description: 'Corruption perception data and documented cases', url: 'https://www.transparency.org' },
  { category: 'Watchdogs & Civil Society', name: 'PSEA Network', description: 'Protection from Sexual Exploitation and Abuse inter-agency tracking', url: 'https://www.un.org/en/spotlight-initiative' },
  { category: 'Watchdogs & Civil Society', name: 'Human Rights Watch', description: 'Documented abuse by humanitarian actors', url: 'https://www.hrw.org' },
  { category: 'Watchdogs & Civil Society', name: 'UK Charity Commission', description: 'UK regulatory body; published inquiry reports on Oxfam, Save the Children, and others', url: 'https://www.gov.uk/government/organisations/charity-commission' },
];
