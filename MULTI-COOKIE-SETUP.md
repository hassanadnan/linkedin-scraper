# LinkedIn Multi-Cookie Setup Guide

For maximum stability and longevity, use LinkedIn's complete cookie set instead of just `li_at`.

## Why Multi-Cookie Strategy?

- ✅ **More Stable**: Survives device/IP changes better
- ✅ **Longer Lasting**: Multiple authentication tokens provide redundancy
- ✅ **Better Detection Avoidance**: Mimics real browser behavior
- ✅ **Session Persistence**: Includes session storage data

## Step-by-Step Setup

### 1. Export LinkedIn Session

1. **Open LinkedIn** in your browser and log in
2. **Open Developer Tools** (F12)
3. **Go to Application tab** → Storage → Cookies → linkedin.com
4. **Copy all cookie values** (see list below)

### 2. Required Cookies

Set these as environment variables in Railway:

| Environment Variable | Cookie Name | Purpose |
|---------------------|-------------|---------|
| `LI_AT` | li_at | Primary authentication token |
| `LI_JSESSIONID` | JSESSIONID | Session identifier |
| `LI_BCOOKIE` | bcookie | Browser tracking cookie |
| `LI_BSCOOKIE` | bscookie | Secure browser cookie |
| `LI_LIAP` | liap | Additional auth parameter |
| `LI_RM` | li_rm | Remember me token |
| `LI_MC` | li_mc | Member context |
| `LI_LIDC` | lidc | Data center routing |

### 3. Optional Cookies (for enhanced stability)

| Environment Variable | Cookie Name | Purpose |
|---------------------|-------------|---------|
| `LI_SUGR` | li_sugr | Suggestion tracking |
| `LI_ALERTS` | li_alerts | Alert preferences |
| `LI_TIMEZONE` | timezone | User timezone |
| `LI_LANG` | lang | Language preference |

### 4. Railway Configuration

In your Railway project:

1. Go to **Variables** tab
2. Add each cookie as a separate environment variable
3. Use the exact names from the table above
4. **Save** and redeploy

### 5. Verification

Test your setup:

```bash
# Check available cookies
curl "https://your-app.railway.app/session-export-guide"

# Test cookie health
curl "https://your-app.railway.app/cookie-health"

# Test scraping
curl "https://your-app.railway.app/scrape?url=microsoft"
```

## Cookie Extraction Script

Use this JavaScript in your browser console on LinkedIn:

```javascript
// Run this in LinkedIn's browser console
const cookies = {};
document.cookie.split(';').forEach(cookie => {
  const [name, value] = cookie.trim().split('=');
  if (name.startsWith('li_') || ['JSESSIONID', 'bcookie', 'bscookie', 'liap', 'lidc'].includes(name)) {
    cookies[`LI_${name.toUpperCase()}`] = value;
  }
});

console.log('Environment Variables for Railway:');
Object.entries(cookies).forEach(([key, value]) => {
  console.log(`${key}=${value}`);
});
```

## Benefits Over Single li_at Cookie

| Single li_at | Multi-Cookie Strategy |
|-------------|----------------------|
| ❌ Expires quickly | ✅ Multiple fallbacks |
| ❌ Device-sensitive | ✅ More resilient |
| ❌ IP-sensitive | ✅ Better stability |
| ❌ Single point of failure | ✅ Redundant authentication |

## Troubleshooting

### If cookies still expire quickly:
1. **Use a dedicated browser profile** for LinkedIn
2. **Don't clear browser data** on that profile
3. **Keep the browser session active** occasionally
4. **Export fresh cookies** every 2-3 weeks

### If authentication fails:
1. Check `/cookie-health` endpoint
2. Verify all environment variables are set
3. Re-export cookies from a fresh LinkedIn session
4. Ensure no typos in variable names

## Maintenance

The system will:
- ✅ Auto-refresh cookies every 6 hours
- ✅ Monitor health every 30 minutes  
- ✅ Warn before expiration
- ✅ Use all available cookies for requests

Your scraper will be much more stable with this multi-cookie approach!