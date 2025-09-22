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

function extractVanity(inputUrl) {
  try {
    // Handle simple company slugs (e.g., "microsoft")
    if (!/^https?:\/\//i.test(inputUrl) && !inputUrl.includes('/') && !inputUrl.includes('.')) {
      return inputUrl.trim().replace(/\/$/, '');
    }
    
    // Handle full URLs
    if (!/^https?:\/\//i.test(inputUrl)) {
      inputUrl = `https://www.linkedin.com/company/${inputUrl}/`;
    }
    
    const u = new URL(inputUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex(p => p.toLowerCase() === 'company');
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1].replace(/\/$/, '');
    if (parts[0]) return parts[0].replace(/\/$/, '');
  } catch (_) {}
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
  const timeout = Number(process.env.VOYAGER_TIMEOUT_MS || 12000);
  const errors = [];
  
  // Ensure we have a proper company URL
  let normalizedUrl = companyUrl;
  if (!/^https?:\/\//i.test(companyUrl)) {
    normalizedUrl = `https://www.linkedin.com/company/${companyUrl}/`;
  }
  
  // 1) Try Voyager vanityName lookup using slug first (most reliable)
  const vanity = extractVanity(companyUrl);
  if (vanity) {
    try {
      const url = `https://www.linkedin.com/voyager/api/organization/companies?vanityName=${encodeURIComponent(vanity)}`;
      const json = await fetchJson(url, headers, timeout);
      if (json) {
        const asString = JSON.stringify(json);
        const v = findFirstOrgIdInHtml(asString);
        if (v) return v;
        errors.push('Voyager API method: No org ID found in API response');
      } else {
        errors.push('Voyager API method: Empty response');
      }
    } catch (err) {
      errors.push(`Voyager API method: ${err.message}`);
    }
  } else {
    errors.push('Voyager API method: Could not extract vanity name from URL');
  }
  
  // 2) Try public HTML
  try {
    const html = await fetchText(normalizedUrl, headers, timeout);
    const orgId = findFirstOrgIdInHtml(html);
    if (orgId) return orgId;
    errors.push('HTML method: No org ID found in page content');
  } catch (err) {
    errors.push(`HTML method: ${err.message}`);
  }

  // 3) Try /about page HTML
  try {
    const aboutUrl = normalizedUrl.endsWith('/') ? `${normalizedUrl}about/` : `${normalizedUrl}/about/`;
    const html = await fetchText(aboutUrl, headers, timeout);
    const orgId = findFirstOrgIdInHtml(html);
    if (orgId) return orgId;
    errors.push('About page method: No org ID found in about page');
  } catch (err) {
    errors.push(`About page method: ${err.message}`);
  }

  throw new Error(`Could not resolve organization ID from company page. Attempts: ${errors.join('; ')}`);
}

async function voyagerEmployeesTotal(orgId, liAt) {
  const headers = buildHeaders(liAt);
  const timeout = Number(process.env.VOYAGER_TIMEOUT_MS || 12000);

  // 1) People-only blended search
  const blendedPeople = `https://www.linkedin.com/voyager/api/search/blended?count=1&filters=List(resultType-%3EPEOPLE,currentCompany-%3E${encodeURIComponent(orgId)})&origin=COMPANY_PAGE_CANNED_SEARCH&q=all`;
  const j1 = await fetchJson(blendedPeople, headers, timeout).catch(() => null);
  if (j1) {
    const t = deepFindTotals(j1);
    if (t.length) return Math.max(...t);
  }

  // 2) Guided people cluster (often returns exact totals)
  const guided = `https://www.linkedin.com/voyager/api/search/cluster?count=0&guides=List(currentCompany-%3E${encodeURIComponent(orgId)})&origin=COMPANY_PAGE_CANNED_SEARCH&q=guided`;
  const j2 = await fetchJson(guided, headers, timeout).catch(() => null);
  if (j2) {
    const t = deepFindTotals(j2);
    if (t.length) return Math.max(...t);
  }

  // 3) Organization company record may include staff ranges
  // Try vanity path: we don't have vanity here; many large orgs expose range only
  // This is a soft attempt via organization URN
  const companyApiCandidates = [
    `https://www.linkedin.com/voyager/api/organization/companies/${encodeURIComponent(orgId)}`
  ];
  for (const url of companyApiCandidates) {
    const j = await fetchJson(url, headers, timeout).catch(() => null);
    if (!j) continue;
    const txt = JSON.stringify(j);
    // Extract ranges like "staffCountRange":{"start":10001}
    const mStart = txt.match(/staffCountRange\":\{\"start\":(\d+)/);
    if (mStart) {
      const n = Number(mStart[1]);
      if (Number.isFinite(n)) return n;
    }
    const t = deepFindTotals(j);
    if (t.length) return Math.max(...t);
  }

  return null;
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

async function voyagerAssociatedMembers(companyUrl, liAt) {
  const headers = buildHeaders(liAt);
  const timeout = Number(process.env.VOYAGER_TIMEOUT_MS || 12000);
  const vanity = extractVanity(companyUrl);
  if (!vanity) return null;
  const peopleUrl = `https://www.linkedin.com/company/${encodeURIComponent(vanity)}/people/`;
  const html = await fetchText(peopleUrl, headers, timeout).catch(() => null);
  if (!html) return null;
  const m = html.match(/([\d,.]+)\s+associated\s+members/i);
  if (m && m[1]) {
    const num = Number(m[1].replace(/[,]/g, ''));
    if (Number.isFinite(num)) return num;
  }
  return null;
}

async function voyagerScrape(companyUrl) {
  const liAt = process.env.LI_AT || process.env.LINKEDIN_LI_AT;
  if (!liAt) throw new Error('LI_AT cookie required for Voyager mode');
  const orgId = await resolveOrgId(companyUrl, liAt);
  const [associatedMembers, employeeCountFallback, jobsPostedCount] = await Promise.all([
    voyagerAssociatedMembers(companyUrl, liAt),
    voyagerEmployeesTotal(orgId, liAt),
    voyagerJobsTotal(orgId, liAt)
  ]);
  const employeeCount = associatedMembers ?? employeeCountFallback ?? null;
  return { orgId, employeeCount, jobsPostedCount };
}

module.exports = { voyagerScrape };


