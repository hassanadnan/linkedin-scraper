const crypto = require('crypto');

function buildHeaders(liAt) {
  const cookieManager = require('./cookieManager');
  const csrf = `ajax:${crypto.randomBytes(8).toString('hex')}`;
  
  // Build comprehensive cookie string
  const cookieParts = [`JSESSIONID="${csrf}"`];
  
  // Add li_at (primary)
  if (liAt) {
    cookieParts.push(`li_at=${liAt}`);
  }
  
  // Add additional cookies from environment
  const additionalCookies = {
    'bcookie': process.env.LI_BCOOKIE,
    'bscookie': process.env.LI_BSCOOKIE,
    'liap': process.env.LI_LIAP,
    'li_rm': process.env.LI_RM,
    'lidc': process.env.LI_LIDC,
    'li_mc': process.env.LI_MC,
    'li_sugr': process.env.LI_SUGR
  };
  
  Object.entries(additionalCookies).forEach(([name, value]) => {
    if (value) {
      cookieParts.push(`${name}=${value}`);
    }
  });
  
  const cookie = cookieParts.join('; ');
  
  return {
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
    'accept-language': 'en-US,en;q=0.9',
    'csrf-token': csrf,
    'cookie': cookie,
    'x-restli-protocol-version': '2.0.0',
    'user-agent': process.env.PLAYWRIGHT_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'referer': 'https://www.linkedin.com/',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin'
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
  // Add delay to avoid rate limiting
  await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000)); // 1-3 second delay
  
  const base = new AbortController();
  const { signal, cancel } = withTimeout(base.signal, timeoutMs);
  const res = await fetch(url, { headers, signal }).finally(cancel);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson(url, headers, timeoutMs) {
  // Add delay to avoid rate limiting
  await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000)); // 1-3 second delay
  
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

  // 1) Try company-specific people API (most accurate)
  try {
    const companyPeopleUrl = `https://www.linkedin.com/voyager/api/organization/companies/${encodeURIComponent(orgId)}/people?count=0`;
    const companyPeopleJson = await fetchJson(companyPeopleUrl, headers, timeout);
    if (companyPeopleJson) {
      const totals = deepFindTotals(companyPeopleJson);
      if (totals.length) {
        const maxTotal = Math.max(...totals);
        console.log(`Found employee count via company people API: ${maxTotal}`);
        return maxTotal;
      }
    }
  } catch (err) {
    console.log('Company people API failed:', err.message);
  }

  // 2) People-only blended search
  const blendedPeople = `https://www.linkedin.com/voyager/api/search/blended?count=1&filters=List(resultType-%3EPEOPLE,currentCompany-%3E${encodeURIComponent(orgId)})&origin=COMPANY_PAGE_CANNED_SEARCH&q=all`;
  const j1 = await fetchJson(blendedPeople, headers, timeout).catch(() => null);
  if (j1) {
    const t = deepFindTotals(j1);
    if (t.length) {
      const maxTotal = Math.max(...t);
      console.log(`Found employee count via blended search: ${maxTotal}`);
      return maxTotal;
    }
  }

  // 3) Guided people cluster (often returns exact totals)
  const guided = `https://www.linkedin.com/voyager/api/search/cluster?count=0&guides=List(currentCompany-%3E${encodeURIComponent(orgId)})&origin=COMPANY_PAGE_CANNED_SEARCH&q=guided`;
  const j2 = await fetchJson(guided, headers, timeout).catch(() => null);
  if (j2) {
    const t = deepFindTotals(j2);
    if (t.length) {
      const maxTotal = Math.max(...t);
      console.log(`Found employee count via guided search: ${maxTotal}`);
      return maxTotal;
    }
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

async function voyagerAssociatedMembers(companyUrl, liAt, orgId) {
  const headers = buildHeaders(liAt);
  const timeout = Number(process.env.VOYAGER_TIMEOUT_MS || 12000);
  const vanity = extractVanity(companyUrl);
  if (!vanity) return null;

  // Strategy 1: Try multiple Voyager API endpoints for company people data
  if (orgId) {
    const apiEndpoints = [
      `https://www.linkedin.com/voyager/api/organization/companies/${encodeURIComponent(orgId)}/people`,
      `https://www.linkedin.com/voyager/api/organization/companies/${encodeURIComponent(orgId)}`,
      `https://www.linkedin.com/voyager/api/organization/companies?vanityName=${encodeURIComponent(vanity)}`,
      `https://www.linkedin.com/voyager/api/search/blended?count=0&filters=List(currentCompany-%3E${encodeURIComponent(orgId)})&origin=COMPANY_PAGE_CANNED_SEARCH&q=all`
    ];
    
    for (const apiUrl of apiEndpoints) {
      try {
        const json = await fetchJson(apiUrl, headers, timeout);
        if (json) {
          const jsonStr = JSON.stringify(json);
          // Look for total count in API response with more patterns
          const patterns = [
            /"total":\s*(\d+)/i,
            /"totalResults":\s*(\d+)/i,
            /"count":\s*(\d+)/i,
            /"numResults":\s*(\d+)/i,
            /"associatedMemberCount":\s*(\d+)/i,
            /"staffCount":\s*(\d+)/i,
            /"employeeCount":\s*(\d+)/i,
            /"memberCount":\s*(\d+)/i,
            /"totalCount":\s*(\d+)/i,
            /"peopleCount":\s*(\d+)/i
          ];
          
          for (const pattern of patterns) {
            const match = jsonStr.match(pattern);
            if (match && match[1]) {
              const count = Number(match[1]);
              if (Number.isFinite(count) && count > 100) { // Reasonable minimum for companies
                console.log(`Found associated members via API (${apiUrl}): ${count}`);
                return count;
              }
            }
          }
        }
      } catch (err) {
        console.log(`Voyager API endpoint failed (${apiUrl}):`, err.message);
      }
    }
  }

  // Strategy 2: Enhanced HTML parsing with multiple URLs and patterns
  const peopleUrls = [
    `https://www.linkedin.com/company/${encodeURIComponent(vanity)}/people/`,
    `https://www.linkedin.com/company/${encodeURIComponent(vanity)}/`,
    `https://www.linkedin.com/company/${encodeURIComponent(vanity)}/about/`
  ];
  
  for (const peopleUrl of peopleUrls) {
    try {
      const html = await fetchText(peopleUrl, headers, timeout);
      if (!html) continue;

      // Multiple regex patterns for associated members (more comprehensive)
      const patterns = [
        // Direct patterns
        /([\d,.]+)\s+associated\s+members/i,
        /([\d,.]+)\s+members?\s+on\s+linkedin/i,
        /([\d,.]+)\s+people\s+work\s+here/i,
        /([\d,.]+)\s+employees?\s+on\s+linkedin/i,
        /([\d,.]+)\s+current\s+employees/i,
        /([\d,.]+)\s+team\s+members/i,
        
        // Link patterns
        /see\s+all\s+([\d,.]+)\s+employees/i,
        /view\s+all\s+([\d,.]+)\s+employees/i,
        /browse\s+([\d,.]+)\s+employees/i,
        /explore\s+([\d,.]+)\s+employees/i,
        
        // JSON patterns in HTML
        /"associatedMemberCount":\s*([\d,.]+)/i,
        /"totalCount":\s*([\d,.]+)/i,
        /"memberCount":\s*([\d,.]+)/i,
        /"employeeCount":\s*([\d,.]+)/i,
        /"staffCount":\s*([\d,.]+)/i,
        
        // Alternative formats
        /(\d{1,3}(?:,\d{3})*)\s+(?:associated\s+)?members/i,
        /(\d{1,3}(?:,\d{3})*)\s+(?:current\s+)?employees/i,
        /(\d{1,3}(?:,\d{3})*)\s+people\s+(?:work|working)/i
      ];

      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match && match[1]) {
          const cleanNumber = match[1].replace(/[,]/g, '');
          const num = Number(cleanNumber);
          if (Number.isFinite(num) && num > 100) { // Reasonable minimum
            console.log(`Found associated members via HTML pattern (${peopleUrl}): ${num}`);
            return num;
          }
        }
      }
    } catch (err) {
      console.log(`HTML parsing failed for ${peopleUrl}:`, err.message);
    }
  }

  // Strategy 3: Look for JSON data embedded in HTML (from any successful HTML fetch)
  for (const peopleUrl of peopleUrls) {
    try {
      const html = await fetchText(peopleUrl, headers, timeout);
      if (!html) continue;
      
      // Look for embedded JSON data
      const scriptMatches = html.match(/<script[^>]*>.*?<\/script>/gi) || [];
      for (const script of scriptMatches) {
        const jsonPatterns = [
          /"associatedMemberCount":\s*(\d+)/i,
          /"totalCount":\s*(\d+)/i,
          /"memberCount":\s*(\d+)/i,
          /"employeeCount":\s*(\d+)/i,
          /"staffCount":\s*(\d+)/i,
          /"peopleCount":\s*(\d+)/i
        ];
        
        for (const pattern of jsonPatterns) {
          const match = script.match(pattern);
          if (match && match[1]) {
            const count = Number(match[1]);
            if (Number.isFinite(count) && count > 100) {
              console.log(`Found associated members via embedded JSON (${peopleUrl}): ${count}`);
              return count;
            }
          }
        }
      }
    } catch (err) {
      console.log(`JSON extraction failed for ${peopleUrl}:`, err.message);
    }
  }

  // Strategy 4: Try alternative company info endpoints
  if (orgId) {
    try {
      const infoUrl = `https://www.linkedin.com/voyager/api/organization/companies/${encodeURIComponent(orgId)}/companyInsights`;
      const json = await fetchJson(infoUrl, headers, timeout);
      if (json) {
        const jsonStr = JSON.stringify(json);
        const patterns = [
          /"staffCount":\s*(\d+)/i,
          /"employeeCount":\s*(\d+)/i,
          /"memberCount":\s*(\d+)/i
        ];
        
        for (const pattern of patterns) {
          const match = jsonStr.match(pattern);
          if (match && match[1]) {
            const count = Number(match[1]);
            if (Number.isFinite(count) && count > 100) {
              console.log(`Found associated members via company insights: ${count}`);
              return count;
            }
          }
        }
      }
    } catch (err) {
      console.log('Company insights API failed:', err.message);
    }
  }

  console.log('All associated members extraction strategies failed');
  return null;
}

async function voyagerScrape(companyUrl) {
  const liAt = process.env.LI_AT || process.env.LINKEDIN_LI_AT;
  if (!liAt) throw new Error('LI_AT cookie required for Voyager mode');
  
  try {
    const orgId = await resolveOrgId(companyUrl, liAt);
    
    // Sequential execution to avoid rate limiting
    console.log('Starting Voyager scrape with rate limiting protection...');
    
    // Try associated members first (most precise)
    let associatedMembers = null;
    try {
      associatedMembers = await voyagerAssociatedMembers(companyUrl, liAt, orgId);
    } catch (err) {
      console.log('Associated members extraction failed:', err.message);
    }
    
    // Add delay before next request
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Try employee count fallback
    let employeeCountFallback = null;
    try {
      employeeCountFallback = await voyagerEmployeesTotal(orgId, liAt);
    } catch (err) {
      console.log('Employee count fallback failed:', err.message);
    }
    
    // Add delay before next request
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Try jobs count
    let jobsPostedCount = null;
    try {
      jobsPostedCount = await voyagerJobsTotal(orgId, liAt);
    } catch (err) {
      console.log('Jobs count extraction failed:', err.message);
    }
    
    // Prioritize associated members count, but provide both for comparison
    const employeeCount = associatedMembers ?? employeeCountFallback ?? null;
    
    return { 
      orgId, 
      employeeCount, 
      associatedMembers, // Exact count from people tab
      employeeCountRange: associatedMembers ? null : (employeeCountFallback ? `${employeeCountFallback}+` : null),
      jobsPostedCount,
      dataSource: associatedMembers ? 'associated_members' : (employeeCountFallback ? 'employee_search' : 'none'),
      rateLimited: false
    };
  } catch (err) {
    if (err.message.includes('429') || err.message.includes('rate limit')) {
      return {
        orgId: null,
        employeeCount: null,
        associatedMembers: null,
        employeeCountRange: null,
        jobsPostedCount: null,
        dataSource: 'rate_limited',
        rateLimited: true,
        error: 'LinkedIn rate limiting detected. Please try again later.'
      };
    }
    throw err;
  }
}

// Browser-based fallback for associated members (last resort)
async function browserAssociatedMembersFallback(companyUrl) {
  // This would require importing browser context from scrape.js
  // For now, return null - can be implemented if needed
  console.log('Browser fallback not implemented yet');
  return null;
}

module.exports = { voyagerScrape };


