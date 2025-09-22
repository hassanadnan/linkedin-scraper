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

// Minimal debug (no secrets)
app.get('/debug', (req, res) => {
  res.json({
    hasLiAt: !!(process.env.LI_AT || process.env.LINKEDIN_LI_AT),
    hasCreds: !!(process.env.LINKEDIN_EMAIL && process.env.LINKEDIN_PASSWORD),
    autoLogin: String(process.env.AUTO_LOGIN || '').toLowerCase() === 'true',
    port: Number(process.env.PORT || 3000)
  });
});

app.get('/scrape', async (req, res) => {
  const url = req.query.url || req.query.u;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });
  try {
    // Default to Voyager if LI_AT present (fast), unless ?voyager=false
    const liAtPresent = !!(process.env.LI_AT || process.env.LINKEDIN_LI_AT);
    const q = String(req.query.voyager || '').toLowerCase();
    const wantVoyager = (q === 'true') || (q === '' && liAtPresent);

    if (wantVoyager) {
      const v = await voyagerScrape(url);
      return res.json({ companyUrl: url, ...v, fetchedAt: new Date().toISOString() });
    }
    const data = await scrapeCompany(url, { headless: true });
    res.json(data);
  } catch (err) {
    const msg = err?.message || String(err);
    res.status(500).json({ error: msg });
  }
});

const port = Number(process.env.PORT || 3000);

function boot() {
  const hasLiAt = !!(process.env.LI_AT || process.env.LINKEDIN_LI_AT);
  const hasCreds = !!(process.env.LINKEDIN_EMAIL && process.env.LINKEDIN_PASSWORD);
  const autoLoginFlag = String(process.env.AUTO_LOGIN || '').toLowerCase() === 'true';
  console.log('Startup: hasLiAt=%s hasCreds=%s AUTO_LOGIN=%s', hasLiAt, hasCreds, autoLoginFlag);
  app.listen(port, '0.0.0.0', () => {
    console.log(`LinkedIn scraper API listening on 0.0.0.0:${port}`);
  });
}

boot();


