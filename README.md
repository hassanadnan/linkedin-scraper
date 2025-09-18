## LinkedIn Company Scraper (Playwright)

Scrapes a LinkedIn company URL to extract the jobs posted count and the employee count using Playwright (Chromium).

### Prerequisites
- Node.js 18+
- A LinkedIn account (for best results). Some data requires authentication.

### Setup
1. Copy `.env.example` to `.env` and fill in credentials:
```bash
cp .env.example .env
```
2. Install dependencies and Chromium for Playwright:
```bash
npm install
npm run playwright:install
```

### Authenticate (optional but recommended)
Run the login flow to store your LinkedIn session in `storageState.json`:
```bash
npm run login
```
- If you have 2FA, set `HEADLESS=false` in `.env`, run the command, complete 2FA in the browser, then close the window.

### Usage
Run the scraper with a LinkedIn company URL:
```bash
npm run scrape -- "https://www.linkedin.com/company/microsoft/"
```
Output example (JSON):
```json
{
  "companyUrl": "https://www.linkedin.com/company/microsoft/",
  "jobsPostedCount": 1234,
  "employeeCount": 221000,
  "employeeCountRange": null,
  "fetchedAt": "2025-09-17T12:34:56.789Z"
}
```

### Notes
- This tool is for personal, educational, or permitted use only. Respect LinkedIn's Terms of Service.
- If unauthenticated, the scraper may return partial results or ranges.
- You can delete `storageState.json` to sign out and re-run the login flow.

### API Server

Start an HTTP API to call from Postman or your app:
```bash
PORT=3000 npm start
```
Endpoints:
- `GET /health`
- `GET /scrape?url=<linkedin-company-url>`

### Deploy to Railway (Docker)
1. Ensure you are authenticated locally and want to ship cookies (optional). You can also log in on the server by running the `/login` script once.
2. This repo includes a Dockerfile based on the Playwright image.
3. Push to GitHub and create a new Railway project:
   - Select “Deploy from GitHub” and choose this repo
   - Railway auto-detects the Dockerfile
   - Set env vars in Railway: `HEADLESS=true` (recommended), optionally `LINKEDIN_EMAIL`, `LINKEDIN_PASSWORD` if you plan to run `npm run login` once via a shell
4. Expose port by setting `PORT` (Railway sets it automatically). The command is `node src/server.js` from the Dockerfile.
5. After deploy, call: `https://<your-railway-domain>/scrape?url=https://www.linkedin.com/company/microsoft/`
