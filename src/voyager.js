const crypto = require('crypto');

function buildHeaders(liAt) {
  const csrf = `ajax:${crypto.randomBytes(8).toString('hex')}`;
  const cookie = [`li_at=${liAt}`, `JSESSIONID="${csrf}"`].join('; ');
  return {
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
    'accept-language': 'en-US,en;q=0.9',
    'csrf-token': csrf,
    'cookie': cookie,
    'x-restli-protocol-version': '2.0.0',
    'user-agent': process.env.PLAYWRIGHT_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
  };
}

function withTimeout(signal, ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(new Error(`Timeout ${ms}ms`)), ms);
  const composite = new AbortController();
  signal?.addEventListener('abort', () => composite.abort(signal.reason));
  ctrl.signal.addEventListener('abort', () => composite.abort(ctrl.signal.reason));
  return { signal: composite.signal, cancel: () => clearTimeout(id) };
}

async function fetchText(url, headers, timeoutMs) {
  const base = new AbortController();
  const { signal, cancel } = withTimeout(base.signal, timeoutMs);
  const res = await fetch(url, { headers, signal }).finally(cancel);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson(url, headers, timeoutMs) {
  const base = new AbortController();
  const { signal, cancel } = withTimeout(base.signal, timeoutMs);
  const res = await fetch(url, { headers, signal }).finally(cancel);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function findFirstOrgIdInHtml(html) {
  const m1 = html.match(/urn:li:organization:(\d+)/);
  if (m1) return m1[1];
  const m2 = html.match(/urn:li:fs_miniCompany:(\d+)/);
  if (m2) return m2[1];
  const m3 = html.match(/"entityUrn":"urn:li:organization:(\d+)"/);
  if (m3) return m3[1];
  return null;
}

function deepFindTotals(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    if ((lk === 'total' || lk === 'totalresults' || lk === 'totalhits' || lk === 'numresults') && Number.isFinite(v)) {
      out.push(v);
    }
    if (v && typeof v === 'object') deepFindTotals(v, out);
  }
  return out;
}

async function resolveOrgId(companyUrl, liAt) {
  const headers = buildHeaders(liAt);
  // Fetch the public HTML to extract orgId reliably
  const html = await fetchText(companyUrl, headers, Number(process.env.VOYAGER_TIMEOUT_MS || 12000));
  const orgId = findFirstOrgIdInHtml(html);
  if (!orgId) throw new Error('Could not resolve organization ID from company page');
  return orgId;
}

async function voyagerEmployeesTotal(orgId, liAt) {
  const headers = buildHeaders(liAt);
  const url = `https://www.linkedin.com/voyager/api/search/blended?count=1&filters=List(currentCompany-%3E${encodeURIComponent(orgId)})&origin=COMPANY_PAGE_CANNED_SEARCH&q=all`;
  const json = await fetchJson(url, headers, Number(process.env.VOYAGER_TIMEOUT_MS || 12000)).catch(() => null);
  if (!json) return null;
  const totals = deepFindTotals(json);
  return totals.length ? Math.max(...totals) : null;
}

async function voyagerJobsTotal(orgId, liAt) {
  const headers = buildHeaders(liAt);
  // Try jobs search API — parameters vary; we collect totals heuristically
  const candidates = [
    `https://www.linkedin.com/voyager/api/jobs/search?count=1&filters=List(companyIds-%3E${encodeURIComponent(orgId)})&q=jobsSearch`,
    `https://www.linkedin.com/voyager/api/jobs/search?count=1&companyIds=List(${encodeURIComponent(orgId)})&q=jobSearch`,
  ];
  for (const url of candidates) {
    const json = await fetchJson(url, headers, Number(process.env.VOYAGER_TIMEOUT_MS || 12000)).catch(() => null);
    if (!json) continue;
    const totals = deepFindTotals(json);
    if (totals.length) return Math.max(...totals);
  }
  // Fallback: use the public jobs page and scan text quickly
  const jobsHtmlUrl = `https://www.linkedin.com/company/${orgId}/jobs/`;
  const html = await fetchText(jobsHtmlUrl, headers, Number(process.env.VOYAGER_TIMEOUT_MS || 12000)).catch(() => null);
  if (html) {
    const m = html.match(/(\d[\d,.]*[km]?\+?)\s+results/i) || html.match(/has\s+(\d[\d,.]*[km]?\+?)\s+(?:job\s+openings?|posted\s+jobs?)/i);
    if (m && m[1]) {
      const digits = m[1].replace(/[,]/g, '');
      const num = Number(digits);
      if (!Number.isNaN(num)) return num;
    }
  }
  return null;
}

async function voyagerScrape(companyUrl) {
  const liAt = process.env.LI_AT || process.env.LINKEDIN_LI_AT;
  if (!liAt) throw new Error('LI_AT cookie required for Voyager mode');
  const orgId = await resolveOrgId(companyUrl, liAt);
  const [employeeCount, jobsPostedCount] = await Promise.all([
    voyagerEmployeesTotal(orgId, liAt),
    voyagerJobsTotal(orgId, liAt)
  ]);
  return { orgId, employeeCount, jobsPostedCount };
}

module.exports = { voyagerScrape };


