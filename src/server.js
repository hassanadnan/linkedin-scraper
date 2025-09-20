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
  const hasLiAt = !!(process.env.LI_AT || process.env.LINKEDIN_LI_AT);
  const hasCreds = !!(process.env.LINKEDIN_EMAIL && process.env.LINKEDIN_PASSWORD);
  const autoLoginFlag = String(process.env.AUTO_LOGIN || '').toLowerCase() === 'true';
  const shouldAutoLogin = autoLoginFlag && hasCreds && !hasLiAt;

  if (shouldAutoLogin) {
    try {
      console.log('Attempting auto-login with credentials...');
      await loginAndSaveStorage();
    } catch (e) {
      console.warn('Auto-login failed:', e?.message || e);
    }
  } else {
    console.log('Skipping auto-login. hasLiAt=%s hasCreds=%s AUTO_LOGIN=%s', hasLiAt, hasCreds, autoLoginFlag);
  }
  app.listen(port, () => {
    console.log(`LinkedIn scraper API listening on http://localhost:${port}`);
  });
}

boot();


