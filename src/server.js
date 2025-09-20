const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config();

const { scrapeCompany } = require('./scrape');
const { loginAndSaveStorage } = require('./login');
const { voyagerScrape } = require('./voyager');

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('tiny'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/scrape', async (req, res) => {
  const url = req.query.url || req.query.u;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });
  try {
    // voyager=true to use LinkedIn JSON APIs (faster, requires LI_AT)
    if (String(req.query.voyager || '').toLowerCase() === 'true') {
      const v = await voyagerScrape(url);
      return res.json({ companyUrl: url, ...v, fetchedAt: new Date().toISOString() });
    }
    const data = await scrapeCompany(url, { headless: true });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

const port = Number(process.env.PORT || 3000);

async function boot() {
  // If credentials exist, attempt one-time login to create storageState
  if (process.env.LINKEDIN_EMAIL && process.env.LINKEDIN_PASSWORD) {
    try {
      await loginAndSaveStorage();
    } catch (e) {
      console.warn('Auto-login failed:', e?.message || e);
    }
  }
  app.listen(port, () => {
    console.log(`LinkedIn scraper API listening on http://localhost:${port}`);
  });
}

boot();


