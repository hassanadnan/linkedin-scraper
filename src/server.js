const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config();

const { scrapeCompany } = require('./scrape');
const { voyagerScrape } = require('./voyager');

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('tiny'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Simple landing page with usage instructions
app.get('/', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    message: 'LinkedIn Company Scraper API',
    status: 'ready',
    methods: {
      graphql: `${baseUrl}/scrape-graphql?url=COMPANY_URL`,
      enhanced: `${baseUrl}/scrape-enhanced?url=COMPANY_URL`,
      voyager: `${baseUrl}/scrape?url=COMPANY_URL`,
      browser: `${baseUrl}/scrape?url=COMPANY_URL&voyager=false`
    },
    examples: {
      graphql: `${baseUrl}/scrape-graphql?url=microsoft`,
      enhanced: `${baseUrl}/scrape-enhanced?url=microsoft`,
      traditional: `${baseUrl}/scrape?url=microsoft`
    },
    monitoring: {
      health: `${baseUrl}/health`,
      cookieHealth: `${baseUrl}/cookie-health`,
      sessionStability: `${baseUrl}/session-stability`,
      debug: `${baseUrl}/debug`
    },
    guides: {
      sessionExport: `${baseUrl}/session-export-guide`,
      multiCookie: 'See MULTI-COOKIE-SETUP.md',
      graphql: 'See GRAPHQL-IMPLEMENTATION-GUIDE.md'
    },
    documentation: 'See README.md and implementation guides for full documentation'
  });
});

// Test authentication endpoint with cookie refresh
app.get('/test-auth', async (req, res) => {
  const liAt = process.env.LI_AT || process.env.LINKEDIN_LI_AT;
  if (!liAt) {
    return res.json({ authenticated: false, error: 'No LI_AT cookie configured' });
  }
  
  try {
    const response = await fetch('https://www.linkedin.com/feed/', {
      headers: {
        'Cookie': `li_at=${liAt}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
      }
    });
    
    const isAuthenticated = response.status === 200 && !response.url.includes('/login');
    
    // Extract cookie expiration info if available
    let cookieInfo = null;
    try {
      const setCookieHeader = response.headers.get('set-cookie');
      if (setCookieHeader && setCookieHeader.includes('li_at=')) {
        cookieInfo = 'Cookie refreshed by LinkedIn';
      }
    } catch (_) {}
    
    res.json({
      authenticated: isAuthenticated,
      status: response.status,
      redirected: response.url !== 'https://www.linkedin.com/feed/',
      finalUrl: response.url,
      cookieInfo,
      cookieLength: liAt.length,
      cookiePrefix: liAt.substring(0, 8) + '...'
    });
  } catch (err) {
    res.json({ authenticated: false, error: err.message });
  }
});

// Minimal debug (no secrets)
app.get('/debug', (req, res) => {
  const liAt = process.env.LI_AT || process.env.LINKEDIN_LI_AT;
  res.json({
    hasLiAt: !!liAt,
    liAtLength: liAt ? liAt.length : 0,
    liAtPrefix: liAt ? liAt.substring(0, 8) + '...' : null,
    hasCreds: !!(process.env.LINKEDIN_EMAIL && process.env.LINKEDIN_PASSWORD),
    autoLogin: String(process.env.AUTO_LOGIN || '').toLowerCase() === 'true',
    port: Number(process.env.PORT || 3000),
    voyagerTimeout: Number(process.env.VOYAGER_TIMEOUT_MS || 12000)
  });
});

app.get('/scrape', async (req, res) => {
  const url = req.query.url || req.query.u;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });
  
  // Enable debug mode if requested
  const debugMode = String(req.query.debug || '').toLowerCase() === 'true';
  if (debugMode) {
    process.env.DEBUG_SCRAPER = 'true';
  }
  
  try {
    // Default to Voyager if LI_AT present (fast), unless ?voyager=false
    const liAtPresent = !!(process.env.LI_AT || process.env.LINKEDIN_LI_AT);
    const q = String(req.query.voyager || '').toLowerCase();
    const wantVoyager = (q === 'true') || (q === '' && liAtPresent);

    if (wantVoyager) {
      try {
        const v = await voyagerScrape(url);
        return res.json({ companyUrl: url, ...v, method: 'voyager', fetchedAt: new Date().toISOString() });
      } catch (voyagerErr) {
        console.log('Voyager method failed, falling back to browser scraping:', voyagerErr.message);
        // Fall back to browser scraping if Voyager fails
        const data = await scrapeCompany(url, { headless: true });
        return res.json({ ...data, method: 'browser-fallback', voyagerError: voyagerErr.message });
      }
    }
    
    // Check for incognito mode parameter
    const incognito = String(req.query.incognito || '').toLowerCase() === 'true';
    const data = await scrapeCompany(url, { headless: true, incognito });
    res.json({ ...data, method: 'browser' });
  } catch (err) {
    const msg = err?.message || String(err);
    res.status(500).json({ error: msg });
  } finally {
    // Reset debug mode
    if (debugMode) {
      delete process.env.DEBUG_SCRAPER;
    }
  }
});

// Cookie refresh endpoint
app.post('/refresh-cookies', async (req, res) => {
  try {
    const { refreshCookies } = require('./scrape');
    // This would need to be implemented to work with the persistent context
    res.json({ message: 'Cookie refresh initiated', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Session export instructions
app.get('/session-export-guide', (req, res) => {
  const cookieManager = require('./cookieManager');
  const instructions = cookieManager.getSessionExportInstructions();
  
  res.json({
    title: 'LinkedIn Session Export Guide',
    description: 'Export your complete LinkedIn session for maximum stability',
    ...instructions,
    benefits: [
      'Much more stable than single li_at cookie',
      'Survives device and IP changes better',
      'Includes session storage and local storage data',
      'Provides redundancy with multiple authentication tokens'
    ],
    currentStatus: {
      availableCookies: Object.keys(process.env).filter(key => key.startsWith('LI_')).length,
      recommendedCookies: Object.keys(cookieManager.linkedinCookies).length
    }
  });
});

// Debug endpoint for employee count extraction
app.get('/debug-employee-count', async (req, res) => {
  const url = req.query.url || req.query.u;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });
  
  try {
    const { voyagerScrape } = require('./voyager');
    const result = await voyagerScrape(url);
    
    res.json({
      url,
      debug: true,
      ...result,
      explanation: {
        associatedMembers: 'Exact count from company people page',
        employeeCount: 'Final count used (prioritizes associated members)',
        dataSource: 'Which method provided the employee count',
        employeeCountRange: 'Range if exact count not available'
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message, debug: true });
  }
});

// Session stability analysis
app.get('/session-stability', async (req, res) => {
  const cookieManager = require('./cookieManager');
  
  try {
    const [stability, health] = await Promise.all([
      cookieManager.getSessionStability(),
      cookieManager.validateSessionHealth()
    ]);
    
    res.json({
      stability,
      health,
      timestamp: new Date().toISOString(),
      recommendations: {
        immediate: stability.score < 30 ? ['Get fresh LinkedIn session immediately'] : [],
        longTerm: [
          'Use dedicated browser profile for LinkedIn',
          'Export complete session state regularly',
          'Monitor session health before heavy usage',
          'Implement request queuing with delays'
        ]
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GraphQL-specific endpoint
app.get('/scrape-graphql', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    const GraphQLScraper = require('./graphqlScraper');
    const graphqlScraper = new GraphQLScraper();
    
    const result = await graphqlScraper.scrapeCompanyData(url);
    res.json(result);
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      method: 'graphql',
      timestamp: new Date().toISOString()
    });
  }
});

// Enhanced hybrid endpoint with GraphQL priority
app.get('/scrape-enhanced', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  const results = {
    companyUrl: url,
    attempts: [],
    finalData: null,
    fetchedAt: new Date().toISOString()
  };

  // Method 1: Try GraphQL first
  try {
    const GraphQLScraper = require('./graphqlScraper');
    const graphqlScraper = new GraphQLScraper();
    const graphqlData = await graphqlScraper.scrapeCompanyData(url);
    
    results.attempts.push({ method: 'graphql', success: true });
    results.finalData = graphqlData;
    return res.json(results);
  } catch (error) {
    results.attempts.push({ method: 'graphql', success: false, error: error.message });
  }

  // Method 2: Fallback to Voyager API
  try {
    const { voyagerScrape } = require('./voyager');
    const voyagerData = await voyagerScrape(url);
    
    results.attempts.push({ method: 'voyager', success: true });
    results.finalData = voyagerData;
    return res.json(results);
  } catch (error) {
    results.attempts.push({ method: 'voyager', success: false, error: error.message });
  }

  // Method 3: Fallback to browser scraping
  try {
    const { scrapeCompany } = require('./scrape');
    const browserData = await scrapeCompany(url, { headless: true });
    
    results.attempts.push({ method: 'browser', success: true });
    results.finalData = browserData;
    return res.json(results);
  } catch (error) {
    results.attempts.push({ method: 'browser', success: false, error: error.message });
  }

  // All methods failed
  res.status(500).json({
    ...results,
    error: 'All scraping methods failed'
  });
});

// Cookie health monitoring with multi-cookie support
app.get('/cookie-health', async (req, res) => {
  const cookieManager = require('./cookieManager');
  const cookieString = cookieManager.buildCookieString();
  
  if (!cookieString) {
    return res.json({ healthy: false, error: 'No LinkedIn cookies configured' });
  }
  
  try {
    // Test multiple LinkedIn endpoints
    const testUrls = [
      'https://www.linkedin.com/feed/',
      'https://www.linkedin.com/me/',
      'https://www.linkedin.com/voyager/api/me'
    ];
    
    const results = await Promise.allSettled(
      testUrls.map(async (url) => {
        const response = await fetch(url, {
          headers: {
            'Cookie': cookieString,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            'Referer': 'https://www.linkedin.com/',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin'
          },
          timeout: 10000
        });
        return {
          url,
          status: response.status,
          authenticated: response.status === 200 && !response.url.includes('/login'),
          finalUrl: response.url
        };
      })
    );
    
    const successful = results.filter(r => r.status === 'fulfilled' && r.value.authenticated).length;
    const healthy = successful > 0;
    
    // Get available cookies info
    const availableCookies = Object.keys(process.env)
      .filter(key => key.startsWith('LI_'))
      .map(key => ({
        name: key,
        hasValue: !!process.env[key],
        length: process.env[key] ? process.env[key].length : 0
      }));
    
    res.json({
      healthy,
      successfulTests: successful,
      totalTests: testUrls.length,
      results: results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason.message }),
      availableCookies,
      cookieString: cookieString.substring(0, 100) + '...', // Truncated for security
      lastRefresh: new Date().toISOString()
    });
  } catch (err) {
    res.json({ healthy: false, error: err.message });
  }
});

const port = Number(process.env.PORT || 3000);

function boot() {
  const hasLiAt = !!(process.env.LI_AT || process.env.LINKEDIN_LI_AT);
  const hasCreds = !!(process.env.LINKEDIN_EMAIL && process.env.LINKEDIN_PASSWORD);
  const autoLoginFlag = String(process.env.AUTO_LOGIN || '').toLowerCase() === 'true';
  console.log('Startup: hasLiAt=%s hasCreds=%s AUTO_LOGIN=%s', hasLiAt, hasCreds, autoLoginFlag);
  
  // Start periodic cookie health checks
  if (hasLiAt) {
    setInterval(async () => {
      try {
        const response = await fetch(`http://localhost:${port}/cookie-health`);
        const health = await response.json();
        if (!health.healthy) {
          console.warn('Cookie health check failed:', health.error);
        } else {
          console.log('Cookie health check passed:', health.successfulTests + '/' + health.totalTests);
        }
      } catch (err) {
        console.warn('Cookie health check error:', err.message);
      }
    }, 30 * 60 * 1000); // Every 30 minutes
  }
  
  app.listen(port, '0.0.0.0', () => {
    console.log(`LinkedIn scraper API listening on 0.0.0.0:${port}`);
  });
}

boot();


