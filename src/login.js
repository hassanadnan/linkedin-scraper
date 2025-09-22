const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
require('dotenv').config();

function parseBoolean(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  return !(normalized === 'false' || normalized === '0' || normalized === 'no');
}

async function loginAndSaveStorage() {
  const email = process.env.LINKEDIN_EMAIL;
  const password = process.env.LINKEDIN_PASSWORD;
  const headless = parseBoolean(process.env.HEADLESS, true);

  if (!email || !password) {
    console.error('Missing LINKEDIN_EMAIL or LINKEDIN_PASSWORD in environment.');
    process.exit(1);
  }

  const storageStatePath = path.resolve(__dirname, '..', 'storageState.json');

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('Navigating to LinkedIn login page...');
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });

    console.log('Filling credentials...');
    await page.fill('#username', email, { timeout: 15000 });
    await page.fill('#password', password, { timeout: 15000 });

    console.log('Submitting login...');
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForLoadState('networkidle')
    ]);

    // Wait for either feed page or any signed-in nav to appear
    try {
      await page.waitForURL(/https:\/\/www\.linkedin\.com\/feed\//, { timeout: 20000 });
    } catch (_) {
      // Fallback: check if global nav appears (logged-in layout)
      await page.waitForSelector('header.global-nav', { timeout: 20000 });
    }

    // Save storage state
    await context.storageState({ path: storageStatePath });

    if (fs.existsSync(storageStatePath)) {
      console.log(`Saved storage state to: ${storageStatePath}`);
    } else {
      throw new Error('Failed to save storage state.');
    }

    console.log('Login successful.');
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  loginAndSaveStorage().catch((err) => {
    console.error('Login failed:', err?.message || err);
    process.exit(1);
  });
}

module.exports = { loginAndSaveStorage };
