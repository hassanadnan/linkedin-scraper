# LinkedIn Scraper API - Usage Guide

This API is deployed and ready to use! No authentication or setup required.

## Base URL
Replace `YOUR_RAILWAY_URL` with your actual Railway deployment URL.

## Endpoints

### Health Check
```
GET https://YOUR_RAILWAY_URL/health
```
Returns server status and timestamp.

### Scrape Company Data
```
GET https://YOUR_RAILWAY_URL/scrape?url=LINKEDIN_COMPANY_URL
```

**Parameters:**
- `url` (required): LinkedIn company URL or slug
- `voyager` (optional): Set to `false` to force browser scraping instead of API method

**Examples:**
```bash
# Full company URL
curl "https://YOUR_RAILWAY_URL/scrape?url=https://www.linkedin.com/company/microsoft/"

# Company slug only
curl "https://YOUR_RAILWAY_URL/scrape?url=microsoft"

# Force browser scraping
curl "https://YOUR_RAILWAY_URL/scrape?url=microsoft&voyager=false"
```

**Response:**
```json
{
  "companyUrl": "https://www.linkedin.com/company/microsoft/",
  "jobsPostedCount": 1234,
  "employeeCount": 221000,
  "employeeCountRange": null,
  "fetchedAt": "2025-09-22T12:34:56.789Z"
}
```

## JavaScript Example
```javascript
async function scrapeCompany(companySlug) {
  const response = await fetch(`https://YOUR_RAILWAY_URL/scrape?url=${companySlug}`);
  const data = await response.json();
  return data;
}

// Usage
scrapeCompany('microsoft').then(console.log);
```

## Python Example
```python
import requests

def scrape_company(company_slug):
    url = f"https://YOUR_RAILWAY_URL/scrape?url={company_slug}"
    response = requests.get(url)
    return response.json()

# Usage
data = scrape_company('microsoft')
print(data)
```

## Rate Limiting
Please be respectful with API usage. The service uses your provided authentication, so excessive requests could impact the account.

## Supported Data
- **Jobs Posted Count**: Number of active job postings
- **Employee Count**: Total employees on LinkedIn
- **Employee Count Range**: Range format (e.g., "51-200") when exact count unavailable

## Error Handling
The API returns appropriate HTTP status codes:
- `400`: Missing or invalid URL parameter
- `500`: Scraping failed (with error message)

Example error response:
```json
{
  "error": "URL must be a LinkedIn URL"
}
```