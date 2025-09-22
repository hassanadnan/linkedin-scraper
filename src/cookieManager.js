const fs = require('fs');
const path = require('path');

class CookieManager {
  constructor() {
    this.cookieFile = path.resolve(__dirname, '..', 'cookie-backup.json');
    this.lastRefresh = null;
    this.refreshInterval = 6 * 60 * 60 * 1000; // 6 hours
  }

  // Save current cookie state
  async saveCookieState(cookies) {
    try {
      const state = {
        cookies,
        timestamp: new Date().toISOString(),
        expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
      };
      
      await fs.promises.writeFile(this.cookieFile, JSON.stringify(state, null, 2));
      console.log('Cookie state saved');
    } catch (err) {
      console.warn('Failed to save cookie state:', err.message);
    }
  }

  // Load saved cookie state
  async loadCookieState() {
    try {
      if (!fs.existsSync(this.cookieFile)) {
        return null;
      }
      
      const data = await fs.promises.readFile(this.cookieFile, 'utf8');
      const state = JSON.parse(data);
      
      // Check if cookies are still valid (not expired)
      const expiryDate = new Date(state.expires);
      if (expiryDate < new Date()) {
        console.log('Saved cookies have expired');
        return null;
      }
      
      return state;
    } catch (err) {
      console.warn('Failed to load cookie state:', err.message);
      return null;
    }
  }

  // Check if cookies need refresh
  needsRefresh() {
    if (!this.lastRefresh) return true;
    return (Date.now() - this.lastRefresh) > this.refreshInterval;
  }

  // Mark cookies as refreshed
  markRefreshed() {
    this.lastRefresh = Date.now();
  }

  // Get cookie expiry warning (7 days before expiry)
  getCookieWarning() {
    const liAt = process.env.LI_AT || process.env.LINKEDIN_LI_AT;
    if (!liAt) return null;

    // LinkedIn cookies typically expire after 30 days
    // This is a rough estimate - actual expiry depends on LinkedIn's policy
    const warningThreshold = 7 * 24 * 60 * 60 * 1000; // 7 days
    const estimatedExpiry = Date.now() + (23 * 24 * 60 * 60 * 1000); // Assume 23 days left
    
    if (estimatedExpiry - Date.now() < warningThreshold) {
      return {
        warning: true,
        message: 'LI_AT cookie may expire soon. Consider refreshing it.',
        estimatedDaysLeft: Math.floor((estimatedExpiry - Date.now()) / (24 * 60 * 60 * 1000))
      };
    }
    
    return { warning: false };
  }
}

module.exports = new CookieManager();