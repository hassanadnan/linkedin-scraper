const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
require('dotenv').config();

const DEBUG = String(process.env.DEBUG_SCRAPER || '').toLowerCase() === 'true';
function logDebug(...args) {
  if (DEBUG) console.log('[debug]', ...args);
}

function parseBoolean(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  return !(normalized === 'false' || normalized === '0' || normalized === 'no');
}

function ensureCompanyUrl(rawUrl) {
  if (!/^https?:\/\//i.test(rawUrl)) {
    rawUrl = `https://${rawUrl}`;
  }
  let url = new URL(rawUrl);
  if (!/linkedin\.com$/i.test(url.hostname) && !/linkedin\.com$/i.test(url.hostname.replace(/^www\./, ''))) {
    throw new Error('URL must be a LinkedIn URL');
  }
  // Force to /company/ path if user passed homepage or other path
  if (!/\/company\//i.test(url.pathname)) {
    // Try to coerce to company route if they gave a slug
    // e.g., linkedin.com/microsoft -> linkedin.com/company/microsoft/
    const parts = url.pathname.split('/').filter(Boolean);
    const slug = parts[0] || '';
    if (!slug) throw new Error('Provide a LinkedIn company URL or company slug path.');
    url = new URL(`/company/${slug}/`, `${url.protocol}//${url.hostname}`);
  }
  // Normalize trailing slash
  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }
  // Enforce www host for consistency
  url.hostname = 'www.linkedin.com';
  return url.toString();
}

function parseHumanNumber(input) {
  if (!input) return null;
  const cleaned = String(input).trim().toLowerCase().replace(/[,\s]/g, '').replace(/\+$/, '');
  const match = cleaned.match(/^(\d+(?:\.\d+)?)([km])?$/i);
  if (!match) {
    const digits = cleaned.replace(/[^0-9]/g, '');
    return digits ? Number(digits) : null;
  }
  const value = parseFloat(match[1]);
  const suffix = match[2];
  if (!suffix) return Math.round(value);
  if (suffix === 'k') return Math.round(value * 1_000);
  if (suffix === 'm') return Math.round(value * 1_000_000);
  return Math.round(value);
}

function extractFirstNumericToken(text) {
  if (!text) return null;
  const m = String(text)
    .replace(/\s+/g, ' ')
    .match(/(\d[\d,.]*\s*[km]?\+?)/i);
  return m ? m[1].replace(/\s+/g, '') : null;
}

async function extractCountByPatterns(page, regexList) {
  const bodyText = await page.evaluate(() => document.body?.innerText || '');
  for (const rx of regexList) {
    const m = bodyText.match(rx);
    if (m && m[1]) {
      const parsed = parseHumanNumber(m[1]);
      if (typeof parsed === 'number' && !Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

async function safeGoto(page, url) {
  // Relax wait condition; retry with incremental waits
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (_) {
    // ignore first error, try again
  }
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
  } catch (_) {}
  // Best-effort network idle wait without failing
  try {
    await page.waitForLoadState('networkidle', { timeout: 10000 });
  } catch (_) {}
  await dismissBanners(page);
  logDebug('navigated', url);
}

async function dismissBanners(page) {
  // Best efforts to close cookie/GDPR banners
  const selectors = [
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button:has-text("Agree")',
    'button:has-text("Allow all")',
    'button:has-text("Got it")',
    'button:has-text("OK")',
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ timeout: 1000 }).catch(() => {});
        await page.waitForTimeout(200).catch(() => {});
      }
    } catch (_) {}
  }
}

async function getJobsCount(browser, baseUrl) {
  // 1) Jobs page: target the banner phrase "has X job openings/posted jobs"
  const jobsUrl = new URL('jobs/', baseUrl).toString();
  let context = await browser.newContext(await maybeStorageState());
  let page = await context.newPage();
  try {
    await safeGoto(page, jobsUrl);
    try { await page.waitForSelector('text=/job openings/i', { timeout: 12000 }); } catch(_) {}
    try { await page.waitForSelector('text=/posted jobs/i', { timeout: 12000 }); } catch(_) {}
    try { await page.waitForTimeout(1000); } catch(_) {}

    const phraseCount = await extractCountByPatterns(page, [
      /has\s+(\d[\d,.]*[km]?\+?)\s+(?:job\s+openings?|posted\s+jobs?)/i,
      /(\d[\d,.]*[km]?\+?)\s+(?:job\s+openings?|posted\s+jobs?)/i
    ]);
    if (phraseCount) return phraseCount;

    const fromProminent = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('h1, h2, h3, header, [aria-live], [data-test*="count" i], [class*="count" i]'));
      const texts = candidates.map(el => el.textContent?.replace(/\s+/g, ' ').trim() || '').filter(Boolean);
      for (const t of texts) {
        const m = t.match(/(\d[\d,.]*\s*[km]?\+?)\s+(?:jobs|job openings)/i) || t.match(/\b(?:jobs|job openings)\b\s*[()\-:]?\s*(\d[\d,.]*\s*[km]?\+?)/i);
        if (m && (m[1] || m[2])) return (m[1] || m[2]);
      }
      return null;
    });
    const fromProminentParsed = parseHumanNumber(fromProminent);
    if (fromProminentParsed) return fromProminentParsed;
  } finally {
    await context.close();
  }

  // 2) Company root nav: strictly "Jobs (X)" or "Jobs X"
  context = await browser.newContext(await maybeStorageState());
  page = await context.newPage();
  try {
    await safeGoto(page, baseUrl);
    const navJobsText = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/jobs/"]'));
      for (const a of anchors) {
        const text = a.textContent?.replace(/\s+/g, ' ').trim() || '';
        const m = text.match(/\bjobs\b\s*[()\-:]?\s*(\d[\d,.]*[km]?\+?)/i);
        if (m && m[1]) return m[1];
      }
      return null;
    });
    const fromNav = parseHumanNumber(navJobsText);
    if (fromNav) return fromNav;
  } finally {
    await context.close();
  }

  // 3) Final fallback: Use Jobs Search filtered by company ID
  const orgId = await getCompanyId(browser, baseUrl).catch(() => null);
  if (orgId) {
    const viaSearch = await getJobsCountViaSearch(browser, orgId).catch(() => null);
    if (viaSearch) return viaSearch;
  }

  return null;
}

async function getEmployeeCount(browser, baseUrl) {
  // Primary: /people page shows total employees on LinkedIn
  const peopleUrl = new URL('people/', baseUrl).toString();
  let context = await browser.newContext(await maybeStorageState());
  let page = await context.newPage();
  try {
    await safeGoto(page, peopleUrl);

    // New UI pattern: "754,196 associated members"
    const associatedMembers = await extractCountByPatterns(page, [
      /(\d[\d,.]*[km]?\+?)\s+associated\s+members\b/i
    ]);
    if (associatedMembers) return { employeeCount: associatedMembers, employeeCountRange: null };

    // Prefer the explicit "See all X employees on LinkedIn" link
    const linkText = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('a, button'));
      for (const n of nodes) {
        const t = n.textContent?.replace(/\s+/g, ' ').trim() || '';
        if (/see all\s+\d[\d,.]*[km]?\+?\s+employees\s+on\s+linkedin/i.test(t)) return t;
        if (/see all\s+\d[\d,.]*[km]?\+?\s+employees/i.test(t) && /linkedin/i.test(t)) return t;
      }
      return null;
    });
    if (linkText) {
      const m = linkText.match(/see all\s+(\d[\d,.]*[km]?\+?)\s+employees/i);
      const raw = m?.[1] || null;
      const numeric = parseHumanNumber(raw);
      if (numeric) {
        const range = raw && /\+$/.test(raw) ? `${raw}` : null;
        return { employeeCount: numeric, employeeCountRange: range };
      }
    }

    // Fallback: text search anywhere on the page
    const patterns = [
      /see all\s+(\d[\d,.]*[km]?\+?)\s+employees/i,
      /(\d[\d,.]*[km]?\+?)\s+employees\b/i
    ];
    const employees = await extractCountByPatterns(page, patterns);
    if (employees) return { employeeCount: employees, employeeCountRange: null };
  } finally {
    await context.close();
  }

  // Fallback: /about page may show a size range (e.g., 51-200 employees)
  const aboutUrl = new URL('about/', baseUrl).toString();
  context = await browser.newContext(await maybeStorageState());
  page = await context.newPage();
  try {
    await safeGoto(page, aboutUrl);

    const range = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const m1 = text.match(/company size\s*([\d,]+)\s*[–-]\s*([\d,]+)/i);
      if (m1) return `${m1[1]}-${m1[2]}`;
      const m2 = text.match(/(\d[\d,.]*)\s*-\s*(\d[\d,.]*)\s+employees/i);
      if (m2) return `${m2[1]}-${m2[2]}`;
      const m3 = text.match(/company size[^\n]*?(\d[\d,]+\+)\s+employees/i) || text.match(/(\d[\d,]+\+)\s+employees/i);
      if (m3) return m3[1];
      return null;
    });

    if (range) return { employeeCount: null, employeeCountRange: range };
  } finally {
    await context.close();
  }

  // Final fallback: people search totals
  const orgId = await getCompanyId(browser, baseUrl).catch(() => null);
  if (orgId) {
    const viaPeopleSearch = await getEmployeeCountViaSearch(browser, orgId).catch(() => null);
    if (viaPeopleSearch) return viaPeopleSearch;
  }

  return { employeeCount: null, employeeCountRange: null };
}

async function maybeStorageState() {
  const storageStatePath = path.resolve(__dirname, '..', 'storageState.json');
  // Prefer saved storage state file if present
  if (fs.existsSync(storageStatePath)) {
    return { storageState: storageStatePath };
  }
  // Fallback: build storage state from LI_AT cookie if provided via env
  const liAt = process.env.LI_AT || process.env.LINKEDIN_LI_AT;
  if (liAt) {
    const thirtyDaysFromNowSeconds = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    return {
      storageState: {
        cookies: [
          {
            name: 'li_at',
            value: liAt,
            domain: '.linkedin.com',
            path: '/',
            expires: thirtyDaysFromNowSeconds,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax'
          }
        ],
        origins: []
      }
    };
  }
  return {};
}

async function getCompanyId(browser, baseUrl) {
  const context = await browser.newContext(await maybeStorageState());
  const page = await context.newPage();
  try {
    await safeGoto(page, baseUrl);
    const ids = await page.evaluate(() => {
      const html = document.documentElement?.innerHTML || '';
      const m1 = html.match(/urn:li:organization:(\d+)/);
      const m2 = html.match(/urn:li:fs_miniCompany:(\d+)/);
      const m3 = html.match(/"entityUrn":"urn:li:organization:(\d+)"/);
      const out = [];
      if (m1) out.push(m1[1]);
      if (m2) out.push(m2[1]);
      if (m3) out.push(m3[1]);
      return Array.from(new Set(out));
    });
    return ids?.[0] || null;
  } finally {
    await context.close();
  }
}

async function getJobsCountViaSearch(browser, orgId) {
  const context = await browser.newContext(await maybeStorageState());
  const page = await context.newPage();
  try {
    const searchUrl = `https://www.linkedin.com/jobs/search/?f_C=${encodeURIComponent(orgId)}&refresh=true`;

    // Observe network responses for totals
    let foundTotal = null;
    function findTotalsDeep(obj, results = []) {
      if (!obj || typeof obj !== 'object') return results;
      for (const [k, v] of Object.entries(obj)) {
        if (k.toLowerCase() === 'total' && typeof v === 'number') results.push(v);
        if ((k.toLowerCase() === 'totalresults' || k.toLowerCase() === 'totalhits' || k.toLowerCase() === 'numresults') && typeof v === 'number') results.push(v);
        if (v && typeof v === 'object') findTotalsDeep(v, results);
      }
      return results;
    }
    page.on('response', async (resp) => {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (!/json|vnd\.linkedin/i.test(ct) && !/voyager\/api/i.test(resp.url())) return;
        const url = resp.url();
        if (!/voyager|graphql|jobs\/search|jobsSearch/i.test(url)) return;
        const json = await resp.json().catch(() => null);
        if (!json) return;
        const totals = findTotalsDeep(json).filter((n) => Number.isFinite(n));
        if (totals.length) {
          const max = Math.max(...totals);
          if (!foundTotal || max > foundTotal) foundTotal = max;
          logDebug('jobs total from network', url, max);
        }
      } catch (_) {}
    });

    await safeGoto(page, searchUrl);

    // Wait for main content to appear
    try { await page.waitForSelector('main, #main-content, .jobs-search-two-pane__results', { timeout: 20000 }); } catch(_) {}
    try { await page.waitForTimeout(2000); } catch(_) {}

    // If network parsing found a total, prefer it
    if (foundTotal) return foundTotal;

    // 1) Try common results count containers
    const domCount = await page.evaluate(() => {
      const getText = (sel) => Array.from(document.querySelectorAll(sel)).map(n => n.textContent?.replace(/\s+/g, ' ').trim() || '');
      const texts = [
        ...getText('h1'),
        ...getText('h2'),
        ...getText('h3'),
        ...getText('header'),
        ...getText('span[aria-live], [aria-live] span'),
        ...getText('[class*="result" i]'),
        ...getText('[data-test*="result" i]'),
      ];
      for (const t of texts) {
        const m = t.match(/^(\d[\d,.]*[km]?\+?)\s+(?:job|jobs|result|results)\b/i)
              || t.match(/(?:job|jobs|result|results)\s*[()\-:]?\s*(\d[\d,.]*[km]?\+?)/i);
        if (m && (m[1] || m[2])) return (m[1] || m[2]);
      }
      return null;
    });
    if (domCount) {
      const parsed = parseHumanNumber(domCount);
      if (parsed) return parsed;
    }

    // 2) Fallback: scan body text
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const rx = /(\d[\d,.]*[km]?\+?)\s+results\b/i;
    const m = bodyText.match(rx);
    if (m && m[1]) return parseHumanNumber(m[1]);

    // 3) Last resort: count visible cards (page-limited)
    const cardCount = await page.evaluate(() => document.querySelectorAll('ul.scaffold-layout__list-container li').length || null);
    if (cardCount && cardCount > 0) return cardCount;
    return null;
  } finally {
    await context.close();
  }
}

async function getEmployeeCountViaSearch(browser, orgId) {
  const context = await browser.newContext(await maybeStorageState());
  const page = await context.newPage();
  try {
    const searchUrl = `https://www.linkedin.com/search/results/people/?currentCompany=${encodeURIComponent(orgId)}&origin=COMPANY_PAGE_CANNED_SEARCH`;

    // Observe network responses for totals
    let foundTotal = null;
    function findTotalsDeep(obj, results = []) {
      if (!obj || typeof obj !== 'object') return results;
      for (const [k, v] of Object.entries(obj)) {
        if (k.toLowerCase() === 'total' && typeof v === 'number') results.push(v);
        if ((k.toLowerCase() === 'totalresults' || k.toLowerCase() === 'totalhits' || k.toLowerCase() === 'numresults') && typeof v === 'number') results.push(v);
        if (v && typeof v === 'object') findTotalsDeep(v, results);
      }
      return results;
    }
    page.on('response', async (resp) => {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (!/json|vnd\.linkedin/i.test(ct) && !/voyager\/api/i.test(resp.url())) return;
        const url = resp.url();
        if (!/voyager|graphql|search\/cluster|search\/blended/i.test(url)) return;
        const json = await resp.json().catch(() => null);
        if (!json) return;
        const totals = findTotalsDeep(json).filter((n) => Number.isFinite(n));
        if (totals.length) {
          const max = Math.max(...totals);
          if (!foundTotal || max > foundTotal) foundTotal = max;
          logDebug('employees total from network', url, max);
        }
      } catch (_) {}
    });

    await safeGoto(page, searchUrl);
    try { await page.waitForSelector('main, #main-content', { timeout: 15000 }); } catch(_) {}
    try { await page.waitForTimeout(2000); } catch(_) {}

    if (foundTotal) {
      return { employeeCount: foundTotal, employeeCountRange: null };
    }

    // DOM heuristics as fallback
    const headerCount = await page.evaluate(() => {
      const texts = Array.from(document.querySelectorAll('h1, h2, h3, header'))
        .map(n => n.textContent?.replace(/\s+/g, ' ').trim() || '');
      for (const t of texts) {
        const m = t.match(/about\s+(\d[\d,.]*[km]?\+?)\s+results/i) || t.match(/(\d[\d,.]*[km]?\+?)\s+results/i);
        if (m && (m[1] || m[2])) return (m[1] || m[2]);
      }
      return null;
    });
    if (headerCount) {
      const parsed = parseHumanNumber(headerCount);
      if (parsed) return { employeeCount: parsed, employeeCountRange: null };
    }

    // Body text fallback
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const m = bodyText.match(/about\s+(\d[\d,.]*[km]?\+?)\s+results/i) || bodyText.match(/(\d[\d,.]*[km]?\+?)\s+results/i);
    if (m && (m[1] || m[2])) {
      const parsed = parseHumanNumber(m[1] || m[2]);
      if (parsed) return { employeeCount: parsed, employeeCountRange: null };
    }

    return { employeeCount: null, employeeCountRange: null };
  } finally {
    await context.close();
  }
}

async function scrapeCompany(urlOrSlug, options = {}) {
  const headless = options.headless ?? parseBoolean(process.env.HEADLESS, true);
  const rawUrl = String(urlOrSlug || '').trim();
  if (!rawUrl) throw new Error('Missing LinkedIn company URL');

  let companyUrl;
  companyUrl = ensureCompanyUrl(rawUrl);

  const browser = await chromium.launch({ headless });
  try {
    const [jobsPostedCount, employee] = await Promise.all([
      getJobsCount(browser, companyUrl),
      getEmployeeCount(browser, companyUrl)
    ]);

    return {
      companyUrl,
      jobsPostedCount: jobsPostedCount ?? null,
      employeeCount: employee?.employeeCount ?? null,
      employeeCountRange: employee?.employeeCountRange ?? null,
      fetchedAt: new Date().toISOString()
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const headless = parseBoolean(process.env.HEADLESS, true);
  const rawUrl = process.argv.slice(2).join(' ').trim();
  if (!rawUrl) {
    console.error('Usage: node src/scrape.js "<linkedin-company-url>"');
    process.exit(1);
  }

  try {
    const result = await scrapeCompany(rawUrl, { headless });
    // Print JSON to stdout for easy piping/consumption
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Scrape failed:', err?.message || err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { scrapeCompany };
