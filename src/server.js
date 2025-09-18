const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config();

const { scrapeCompany } = require('./scrape');

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
    const data = await scrapeCompany(url, { headless: true });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`LinkedIn scraper API listening on http://localhost:${port}`);
});


