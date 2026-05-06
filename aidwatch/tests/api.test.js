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

  it('returns 404 for a non-numeric id', async () => {
    const res = await request(app).get('/api/cases/abc').expect(404);
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
    const levels = bySeverity.map((s) => s.severity || s.label || s.key || s[0]);
    expect(levels).toEqual(expect.arrayContaining(['critical', 'high', 'medium']));
  });

  it('total cases in byType equals total case count', async () => {
    const [statsRes, searchRes] = await Promise.all([
      request(app).get('/api/stats'),
      request(app).get('/api/search?limit=100'),
    ]);
    const totalFromStats = statsRes.body.data.byType.reduce((s, t) => s + (t.count || t.value || 0), 0);
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
