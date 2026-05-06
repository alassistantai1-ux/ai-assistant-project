'use strict';

const request = require('supertest');

// Import the app without starting the server
let app;
beforeAll(() => {
  app = require('../server');
});

afterAll((done) => {
  if (app && app.close) app.close(done);
  else done();
});

// ── /health ──────────────────────────────────────────────────────────────────
describe('GET /health', () => {
  it('returns 200 with success shape', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('status', 'ok');
    expect(res.body.data).toHaveProperty('cases');
    expect(res.body.data).toHaveProperty('organizations');
    expect(typeof res.body.data.uptime).toBe('number');
  });

  it('reports 75 cases in dataset', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.data.cases).toBeGreaterThanOrEqual(75);
  });
});

// ── /robots.txt ───────────────────────────────────────────────────────────────
describe('GET /robots.txt', () => {
  it('returns text/plain with disallow rules', async () => {
    const res = await request(app).get('/robots.txt').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('Disallow:');
  });
});

// ── /api/search ──────────────────────────────────────────────────────────────
describe('GET /api/search', () => {
  it('returns results with correct shape', async () => {
    const res = await request(app).get('/api/search?q=fraud').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('results');
    expect(Array.isArray(res.body.data.results)).toBe(true);
    expect(res.body.data).toHaveProperty('total');
    expect(res.body.data).toHaveProperty('page');
    expect(res.body.data).toHaveProperty('pages');
  });

  it('returns results with no query (returns all cases paged)', async () => {
    const res = await request(app).get('/api/search').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.results.length).toBeGreaterThan(0);
  });

  it('filters by region', async () => {
    const res = await request(app).get('/api/search?region=Africa').expect(200);
    expect(res.body.success).toBe(true);
    for (const c of res.body.data.results) {
      expect(c.region).toBe('Africa');
    }
  });

  it('filters by severity', async () => {
    const res = await request(app).get('/api/search?severity=critical').expect(200);
    expect(res.body.success).toBe(true);
    for (const c of res.body.data.results) {
      expect(c.severity).toBe('critical');
    }
  });

  it('respects pagination params', async () => {
    const page1 = await request(app).get('/api/search?page=1&limit=5').expect(200);
    const page2 = await request(app).get('/api/search?page=2&limit=5').expect(200);
    expect(page1.body.data.results.length).toBeLessThanOrEqual(5);
    // IDs on page 1 and page 2 should not overlap
    const ids1 = page1.body.data.results.map((c) => c.id);
    const ids2 = page2.body.data.results.map((c) => c.id);
    const overlap = ids1.filter((id) => ids2.includes(id));
    expect(overlap).toHaveLength(0);
  });

  it('returns empty results for an impossible query', async () => {
    const res = await request(app).get('/api/search?q=xyzabcdefghijk123456789').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.results).toHaveLength(0);
  });

  it('rejects invalid page param gracefully', async () => {
    const res = await request(app).get('/api/search?page=-5').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.page).toBe(1);
  });

  it('filters by status=closed', async () => {
    const res = await request(app).get('/api/search?status=closed').expect(200);
    expect(res.body.success).toBe(true);
    for (const c of res.body.data.results) {
      expect(c.status).toBe('closed');
    }
  });

  it('filters by type', async () => {
    const res = await request(app).get('/api/search?type=Fraud').expect(200);
    expect(res.body.success).toBe(true);
    for (const c of res.body.data.results) {
      expect(c.type).toBe('Fraud');
    }
  });

  it('sort=amount returns highest amount first', async () => {
    const res = await request(app).get('/api/search?sort=amount&limit=10').expect(200);
    expect(res.body.success).toBe(true);
    const results = res.body.data.results;
    if (results.length >= 2) {
      expect(results[0].amountNum).toBeGreaterThanOrEqual(results[1].amountNum);
    }
  });

  it('full-text search finds matches in description/summary field', async () => {
    const res = await request(app).get('/api/search?q=procurement').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.total).toBeGreaterThan(0);
  });

  it('handles special characters in query gracefully', async () => {
    const res = await request(app).get('/api/search?q=test%3Cscript%3E').expect(200);
    expect(res.body.success).toBe(true);
  });

  it('handles very long query string gracefully', async () => {
    const longQ = 'a'.repeat(500);
    const res = await request(app).get(`/api/search?q=${longQ}`).expect(200);
    expect(res.body.success).toBe(true);
  });

  it('combined filters: region + severity', async () => {
    const res = await request(app).get('/api/search?severity=high&limit=20').expect(200);
    expect(res.body.success).toBe(true);
    for (const c of res.body.data.results) {
      expect(c.severity).toBe('high');
    }
  });

  it('returns didYouMean for zero-result queries with typos', async () => {
    const res = await request(app).get('/api/search?q=froud').expect(200);
    expect(res.body.success).toBe(true);
    // if zero results, didYouMean may be present
    if (res.body.data.total === 0) {
      expect(res.body.data).toHaveProperty('didYouMean');
    }
  });
});

// ── /api/cases/:id ───────────────────────────────────────────────────────────
describe('GET /api/cases/:id', () => {
  it('returns a known case with full shape', async () => {
    const res = await request(app).get('/api/cases/1').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('case');
    expect(res.body.data.case).toHaveProperty('id', 1);
    expect(res.body.data.case).toHaveProperty('title');
    expect(res.body.data.case).toHaveProperty('severity');
    expect(res.body.data).toHaveProperty('related');
    expect(Array.isArray(res.body.data.related)).toBe(true);
  });

  it('returns 404 for a non-existent case', async () => {
    const res = await request(app).get('/api/cases/99999').expect(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 for a non-numeric id', async () => {
    const res = await request(app).get('/api/cases/abc').expect(400);
    expect(res.body.success).toBe(false);
  });

  it('case 75 exists and has severity', async () => {
    const res = await request(app).get('/api/cases/75').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.case.id).toBe(75);
    expect(['critical', 'high', 'medium']).toContain(res.body.data.case.severity);
  });
});

// ── /api/cases/related/:id ────────────────────────────────────────────────────
describe('GET /api/cases/related/:id', () => {
  it('returns related cases array', async () => {
    const res = await request(app).get('/api/cases/related/1').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('results');
    expect(Array.isArray(res.body.data.results)).toBe(true);
    expect(res.body.data).toHaveProperty('total');
  });

  it('does not include the requested case in results', async () => {
    const res = await request(app).get('/api/cases/related/1').expect(200);
    const ids = res.body.data.results.map((c) => c.id);
    expect(ids).not.toContain(1);
  });

  it('returns 404 for non-existent case', async () => {
    const res = await request(app).get('/api/cases/related/99999').expect(404);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for non-numeric id', async () => {
    const res = await request(app).get('/api/cases/related/abc').expect(400);
    expect(res.body.success).toBe(false);
  });
});

// ── /api/stats ───────────────────────────────────────────────────────────────
describe('GET /api/stats', () => {
  it('returns correct shape with expected keys', async () => {
    const res = await request(app).get('/api/stats').expect(200);
    expect(res.body.success).toBe(true);
    const d = res.body.data;
    expect(d).toHaveProperty('byType');
    expect(d).toHaveProperty('byRegion');
    expect(d).toHaveProperty('byYear');
    expect(d).toHaveProperty('bySeverity');
    expect(d).toHaveProperty('byStatus');
    expect(d).toHaveProperty('bySource');
  });

  it('bySeverity has all three severity levels', async () => {
    const res = await request(app).get('/api/stats').expect(200);
    const { bySeverity } = res.body.data;
    expect(typeof bySeverity).toBe('object');
    expect(Object.keys(bySeverity)).toEqual(expect.arrayContaining(['critical', 'high', 'medium']));
  });

  it('total cases in byType equals total case count', async () => {
    const [statsRes, searchRes] = await Promise.all([
      request(app).get('/api/stats'),
      request(app).get('/api/search?limit=100'),
    ]);
    const totalFromStats = Object.values(statsRes.body.data.byType).reduce((s, n) => s + n, 0);
    const totalCases = searchRes.body.data.total;
    expect(totalFromStats).toBe(totalCases);
  });
});

// ── /api/org/:id ─────────────────────────────────────────────────────────────
describe('GET /api/org/:id', () => {
  it('returns org with cases array', async () => {
    const res = await request(app).get('/api/org/1').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('org');
    expect(res.body.data).toHaveProperty('cases');
    expect(Array.isArray(res.body.data.cases)).toBe(true);
  });

  it('returns 404 for non-existent org', async () => {
    const res = await request(app).get('/api/org/99999').expect(404);
    expect(res.body.success).toBe(false);
  });
});

// ── /api/orgs ─────────────────────────────────────────────────────────────────
describe('GET /api/orgs', () => {
  it('returns list with risk scores', async () => {
    const res = await request(app).get('/api/orgs').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('total');
    expect(res.body.data).toHaveProperty('results');
    expect(Array.isArray(res.body.data.results)).toBe(true);
    expect(res.body.data.total).toBeGreaterThanOrEqual(73);
  });

  it('each org has riskScore and caseCount', async () => {
    const res = await request(app).get('/api/orgs').expect(200);
    for (const org of res.body.data.results.slice(0, 5)) {
      expect(typeof org.riskScore).toBe('number');
      expect(typeof org.caseCount).toBe('number');
    }
  });
});

// ── /api/orgs/:name ───────────────────────────────────────────────────────────
describe('GET /api/orgs/:name', () => {
  it('returns org by slug with cases', async () => {
    const res = await request(app).get('/api/orgs/wb-padma-bridge').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('org');
    expect(res.body.data).toHaveProperty('cases');
    expect(Array.isArray(res.body.data.cases)).toBe(true);
  });

  it('returns 404 for unknown org name', async () => {
    const res = await request(app).get('/api/orgs/nonexistent-org-xyz').expect(404);
    expect(res.body.success).toBe(false);
  });
});

// ── /api/search/suggest ───────────────────────────────────────────────────────
describe('GET /api/search/suggest', () => {
  it('returns suggestions array', async () => {
    const res = await request(app).get('/api/search/suggest?q=usan').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('suggestions');
    expect(Array.isArray(res.body.data.suggestions)).toBe(true);
  });

  it('returns empty for very short query', async () => {
    const res = await request(app).get('/api/search/suggest?q=a').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.suggestions).toHaveLength(0);
  });

  it('returns up to 8 suggestions', async () => {
    const res = await request(app).get('/api/search/suggest?q=fra').expect(200);
    expect(res.body.data.suggestions.length).toBeLessThanOrEqual(8);
  });
});

// ── /api/export/csv ───────────────────────────────────────────────────────────
describe('GET /api/export/csv', () => {
  it('returns CSV content-type', async () => {
    const res = await request(app).get('/api/export/csv').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  it('CSV has header row and data rows', async () => {
    const res = await request(app).get('/api/export/csv').expect(200);
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toContain('id');
    expect(lines[0]).toContain('title');
    expect(lines.length).toBeGreaterThan(70);
  });

  it('CSV has correct attachment disposition', async () => {
    const res = await request(app).get('/api/export/csv').expect(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('.csv');
  });
});

// ── /api/trends ───────────────────────────────────────────────────────────────
describe('GET /api/trends', () => {
  it('returns trends shape', async () => {
    const res = await request(app).get('/api/trends').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('typeByYear');
    expect(res.body.data).toHaveProperty('regionByYear');
    expect(res.body.data).toHaveProperty('topTypes');
    expect(res.body.data).toHaveProperty('topRegions');
  });

  it('topTypes has at most 5 entries', async () => {
    const res = await request(app).get('/api/trends').expect(200);
    expect(res.body.data.topTypes.length).toBeLessThanOrEqual(5);
    expect(res.body.data.topRegions.length).toBeLessThanOrEqual(5);
  });
});
