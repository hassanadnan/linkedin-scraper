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
  // Handle simple company slugs (e.g., "microsoft" -> "https://www.linkedin.com/company/microsoft/")
  if (!/^https?:\/\//i.test(rawUrl) && !rawUrl.includes('.')) {
    rawUrl = `https://www.linkedin.com/company/${rawUrl}/`;
  } else if (!/^https?:\/\//i.test(rawUrl)) {
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
  logDebug('Navigating to:', url);
  
  // Multiple retry strategy
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      logDebug(`Navigation attempt ${attempt}/3`);
      await page.goto(url, { 
        waitUntil: 'domcontentloaded', 
        timeout: 30000 
      });
      break;
    } catch (err) {
      lastError = err;
      logDebug(`Navigation attempt ${attempt} failed:`, err.message);
      if (attempt < 3) {
        await page.waitForTimeout(2000 * attempt); // Progressive backoff
      }
    }
  }
  
  // Wait for page to stabilize
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
  } catch (_) { 
    logDebug('DOMContentLoaded timeout, continuing...');
  }
  
  // Best-effort network idle wait
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 });
  } catch (_) { 
    logDebug('NetworkIdle timeout, continuing...');
  }
  
  // Check if we're blocked or redirected
  const currentUrl = page.url();
  if (currentUrl.includes('/login') || currentUrl.includes('/challenge')) {
    logDebug('Detected login/challenge redirect:', currentUrl);
    throw new Error('LinkedIn authentication required or challenge detected');
  }
  
  await dismissBanners(page);
  logDebug('Successfully navigated to:', currentUrl);
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
        await el.click({ timeout: 1000 }).catch(() => { });
        await page.waitForTimeout(200).catch(() => { });
      }
    } catch (_) { }
  }
}

async function getJobsCount(context, baseUrl) {
  logDebug('Getting jobs count for:', baseUrl);
  
  // 1) Jobs page: target the banner phrase "has X job openings/posted jobs"
  const jobsUrl = new URL('jobs/', baseUrl).toString();
  let page = await context.newPage();
  try {
    await safeGoto(page, jobsUrl);
    
    // Wait for content to load with multiple strategies
    try { 
      await page.waitForSelector('main, #main-content, .jobs-search', { timeout: 15000 }); 
    } catch (_) { 
      logDebug('Main content selector not found, continuing...');
    }
    
    // Look for job count indicators
    try { 
      await page.waitForSelector('text=/job/i', { timeout: 8000 }); 
    } catch (_) { 
      logDebug('No job text found, continuing...');
    }
    
    await page.waitForTimeout(2000); // Allow dynamic content to load

    // Enhanced pattern matching
    const phraseCount = await extractCountByPatterns(page, [
      /has\s+(\d[\d,.]*[km]?\+?)\s+(?:job\s+openings?|posted\s+jobs?|open\s+positions?)/i,
      /(\d[\d,.]*[km]?\+?)\s+(?:job\s+openings?|posted\s+jobs?|open\s+positions?|jobs?\s+available)/i,
      /(\d[\d,.]*[km]?\+?)\s+results?\s+for/i,
      /showing\s+(\d[\d,.]*[km]?\+?)\s+jobs?/i
    ]);
    if (phraseCount) {
      logDebug('Found jobs count from patterns:', phraseCount);
      return phraseCount;
    }

    // Enhanced DOM search with more selectors
    const fromProminent = await page.evaluate(() => {
      const selectors = [
        'h1', 'h2', 'h3', 'header', 
        '[aria-live]', '[data-test*="count" i]', '[class*="count" i]',
        '[class*="result" i]', '[class*="job" i]', 
        '.jobs-search-results-list__text',
        '.jobs-search-no-results__image + div',
        '[data-test-id*="job"]'
      ];
      
      const candidates = [];
      selectors.forEach(sel => {
        try {
          candidates.push(...Array.from(document.querySelectorAll(sel)));
        } catch (_) {}
      });
      
      const texts = candidates.map(el => el.textContent?.replace(/\s+/g, ' ').trim() || '').filter(Boolean);
      
      for (const t of texts) {
        const patterns = [
          /(\d[\d,.]*\s*[km]?\+?)\s+(?:jobs?|job openings?|positions?|results?)/i,
          /\b(?:jobs?|job openings?|positions?|results?)\b\s*[()\-:]?\s*(\d[\d,.]*\s*[km]?\+?)/i,
          /(\d[\d,.]*\s*[km]?\+?)\s+open/i
        ];
        
        for (const pattern of patterns) {
          const m = t.match(pattern);
          if (m && (m[1] || m[2])) {
            return (m[1] || m[2]);
          }
        }
      }
      return null;
    });
    
    const fromProminentParsed = parseHumanNumber(fromProminent);
    if (fromProminentParsed) {
      logDebug('Found jobs count from DOM:', fromProminentParsed);
      return fromProminentParsed;
    }
    
    logDebug('No jobs count found on jobs page');
  } finally {
    try { await page.close(); } catch (_) { }
  }

  // 2) Company root nav: strictly "Jobs (X)" or "Jobs X"
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
    try { await page.close(); } catch (_) { }
  }

  // 3) Final fallback: Use Jobs Search filtered by company ID
  const orgId = await getCompanyId(context, baseUrl).catch(() => null);
  if (orgId) {
    const viaSearch = await getJobsCountViaSearch(context, orgId).catch(() => null);
    if (viaSearch) return viaSearch;
  }

  return null;
}

async function getEmployeeCount(context, baseUrl) {
  logDebug('Getting employee count for:', baseUrl);
  
  // Primary: /people page shows total employees on LinkedIn
  const peopleUrl = new URL('people/', baseUrl).toString();
  let page = await context.newPage();
  try {
    await safeGoto(page, peopleUrl);
    
    // Wait for content to load
    try { 
      await page.waitForSelector('main, #main-content', { timeout: 15000 }); 
    } catch (_) { 
      logDebug('Main content not found on people page');
    }
    
    await page.waitForTimeout(2000);

    // Enhanced patterns for associated members
    const associatedMembers = await extractCountByPatterns(page, [
      /(\d[\d,.]*[km]?\+?)\s+associated\s+members\b/i,
      /(\d[\d,.]*[km]?\+?)\s+members?\s+on\s+linkedin/i,
      /(\d[\d,.]*[km]?\+?)\s+people\s+work\s+here/i
    ]);
    if (associatedMembers) {
      logDebug('Found associated members:', associatedMembers);
      return { employeeCount: associatedMembers, employeeCountRange: null };
    }

    // Enhanced link text search
    const linkText = await page.evaluate(() => {
      const selectors = ['a', 'button', 'span', 'div'];
      const nodes = [];
      selectors.forEach(sel => {
        try {
          nodes.push(...Array.from(document.querySelectorAll(sel)));
        } catch (_) {}
      });
      
      for (const n of nodes) {
        const t = n.textContent?.replace(/\s+/g, ' ').trim() || '';
        const patterns = [
          /see all\s+(\d[\d,.]*[km]?\+?)\s+employees\s+on\s+linkedin/i,
          /see all\s+(\d[\d,.]*[km]?\+?)\s+employees/i,
          /(\d[\d,.]*[km]?\+?)\s+employees\s+on\s+linkedin/i,
          /view all\s+(\d[\d,.]*[km]?\+?)\s+employees/i
        ];
        
        for (const pattern of patterns) {
          const m = t.match(pattern);
          if (m && m[1]) return { text: t, match: m[1] };
        }
      }
      return null;
    });
    
    if (linkText) {
      const numeric = parseHumanNumber(linkText.match);
      if (numeric) {
        const range = linkText.match && /\+$/.test(linkText.match) ? linkText.match : null;
        logDebug('Found employee count from link:', numeric, range);
        return { employeeCount: numeric, employeeCountRange: range };
      }
    }

    // Enhanced fallback patterns
    const patterns = [
      /see all\s+(\d[\d,.]*[km]?\+?)\s+employees/i,
      /(\d[\d,.]*[km]?\+?)\s+employees\s+on\s+linkedin/i,
      /(\d[\d,.]*[km]?\+?)\s+employees\b/i,
      /(\d[\d,.]*[km]?\+?)\s+people\s+work/i,
      /(\d[\d,.]*[km]?\+?)\s+team\s+members/i
    ];
    const employees = await extractCountByPatterns(page, patterns);
    if (employees) {
      logDebug('Found employee count from patterns:', employees);
      return { employeeCount: employees, employeeCountRange: null };
    }
    
    logDebug('No employee count found on people page');
  } finally {
    try { await page.close(); } catch (_) { }
  }

  // Fallback: /about page may show a size range (e.g., 51-200 employees)
  const aboutUrl = new URL('about/', baseUrl).toString();
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
    try { await page.close(); } catch (_) { }
  }

  // Final fallback: people search totals
  const orgId = await getCompanyId(context, baseUrl).catch(() => null);
  if (orgId) {
    const viaPeopleSearch = await getEmployeeCountViaSearch(context, orgId).catch(() => null);
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

async function getCompanyId(context, baseUrl) {
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
    try { await page.close(); } catch (_) { }
  }
}

async function getJobsCountViaSearch(context, orgId) {
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
      } catch (_) { }
    });

    await safeGoto(page, searchUrl);

    // Wait for main content to appear
    try { await page.waitForSelector('main, #main-content, .jobs-search-two-pane__results', { timeout: 20000 }); } catch (_) { }
    try { await page.waitForTimeout(2000); } catch (_) { }

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
    try { await page.close(); } catch (_) { }
  }
}

async function getEmployeeCountViaSearch(context, orgId) {
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
      } catch (_) { }
    });

    await safeGoto(page, searchUrl);
    try { await page.waitForSelector('main, #main-content', { timeout: 15000 }); } catch (_) { }
    try { await page.waitForTimeout(2000); } catch (_) { }

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
    try { await page.close(); } catch (_) { }
  }
}

// Fresh incognito context with authentication
async function getIncognitoContext(headless) {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    colorScheme: 'light',
    timezoneId: process.env.PLAYWRIGHT_TZ || 'UTC',
    locale: process.env.PLAYWRIGHT_LOCALE || 'en-US',
    userAgent: process.env.PLAYWRIGHT_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  });

  // Try to add LI_AT cookie if available
  const liAt = process.env.LI_AT || process.env.LINKEDIN_LI_AT;
  if (liAt) {
    const thirtyDaysFromNowSeconds = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    await context.addCookies([{
      name: 'li_at', value: liAt, domain: '.linkedin.com', path: '/',
      expires: thirtyDaysFromNowSeconds, httpOnly: true, secure: true, sameSite: 'Lax'
    }]);
  } else {
    // If no LI_AT cookie, perform fresh login
    const email = process.env.LINKEDIN_EMAIL;
    const password = process.env.LINKEDIN_PASSWORD;

    if (!email || !password) {
      throw new Error('Incognito mode requires either LI_AT cookie or LINKEDIN_EMAIL/LINKEDIN_PASSWORD in environment');
    }

    const page = await context.newPage();
    try {
      console.log('Performing fresh login for incognito mode...');
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
      await page.fill('#username', email, { timeout: 15000 });
      await page.fill('#password', password, { timeout: 15000 });
      await Promise.all([
        page.click('button[type="submit"]'),
        page.waitForLoadState('networkidle')
      ]);

      // Wait for successful login
      try {
        await page.waitForURL(/https:\/\/www\.linkedin\.com\/feed\//, { timeout: 20000 });
      } catch (_) {
        await page.waitForSelector('header.global-nav', { timeout: 20000 });
      }
      console.log('Fresh login successful');
    } finally {
      await page.close();
    }
  }

  return context;
}

// Persistent context (user data dir) to keep session stable across runs
let persistentContextPromise = null;
async function getPersistentContext(headless) {
  if (persistentContextPromise) return persistentContextPromise;
  const userDataDir = process.env.PLAYWRIGHT_USER_DATA_DIR || path.resolve(__dirname, '..', 'user-data');
  const consistentUserAgent = process.env.PLAYWRIGHT_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const contextOptions = {
    headless: headless ?? parseBoolean(process.env.HEADLESS, true),
    viewport: { width: 1366, height: 768 },
    colorScheme: 'light',
    timezoneId: process.env.PLAYWRIGHT_TZ || 'America/New_York',
    locale: process.env.PLAYWRIGHT_LOCALE || 'en-US',
    userAgent: consistentUserAgent,
    // Enhanced stealth options
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'max-age=0',
      'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
    // Disable automation indicators
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=VizDisplayCompositor',
    ],
  };
  persistentContextPromise = chromium.launchPersistentContext(userDataDir, contextOptions)
    .then(async (ctx) => {
      // Add stealth scripts to avoid detection
      await ctx.addInitScript(() => {
        // Remove webdriver property
        delete navigator.__proto__.webdriver;
        
        // Mock plugins
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5]
        });
        
        // Mock languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en']
        });
        
        // Mock permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
          parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission }) :
            originalQuery(parameters)
        );
      });
      
      // Inject LI_AT cookie if provided and not present
      const liAt = process.env.LI_AT || process.env.LINKEDIN_LI_AT;
      if (liAt) {
        const existing = await ctx.cookies('https://www.linkedin.com');
        const hasCookie = existing?.some(c => c.name === 'li_at');
        if (!hasCookie) {
          const thirtyDaysFromNowSeconds = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
          await ctx.addCookies([{
            name: 'li_at', value: liAt, domain: '.linkedin.com', path: '/',
            expires: thirtyDaysFromNowSeconds, httpOnly: true, secure: true, sameSite: 'Lax'
          }]);
        }
      }
      // Save storage state for external use (best-effort)
      try {
        await persistStorageState(ctx);
      } catch (_) { }
      return ctx;
    });
  return persistentContextPromise;
}

async function persistStorageState(context) {
  const storageStatePath = path.resolve(__dirname, '..', 'storageState.json');
  try { await context.storageState({ path: storageStatePath }); } catch (_) { }
}

async function scrapeCompany(urlOrSlug, options = {}) {
  const headless = options.headless ?? parseBoolean(process.env.HEADLESS, true);
  const incognito = options.incognito ?? false;
  const rawUrl = String(urlOrSlug || '').trim();
  if (!rawUrl) throw new Error('Missing LinkedIn company URL');

  const companyUrl = ensureCompanyUrl(rawUrl);

  let context;
  if (incognito) {
    // Use fresh incognito context with authentication
    context = await getIncognitoContext(headless);
  } else {
    context = await getPersistentContext(headless);
  }

  const [jobsPostedCount, employee] = await Promise.all([
    getJobsCount(context, companyUrl),
    getEmployeeCount(context, companyUrl)
  ]);

  // Save latest state after scrape
  try { await persistStorageState(context); } catch (_) { }

  return {
    companyUrl,
    jobsPostedCount: jobsPostedCount ?? null,
    employeeCount: employee?.employeeCount ?? null,
    employeeCountRange: employee?.employeeCountRange ?? null,
    fetchedAt: new Date().toISOString()
  };
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
