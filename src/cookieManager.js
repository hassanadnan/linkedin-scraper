const fs = require('fs');
const path = require('path');

class CookieManager {
    constructor() {
        this.cookieFile = path.resolve(__dirname, '..', 'cookie-backup.json');
        this.sessionFile = path.resolve(__dirname, '..', 'full-session.json');
        this.lastRefresh = null;
        this.refreshInterval = 6 * 60 * 60 * 1000; // 6 hours

        // LinkedIn cookie types and their purposes
        this.linkedinCookies = {
            'li_at': 'Primary authentication token',
            'JSESSIONID': 'Session identifier',
            'bcookie': 'Browser cookie for tracking',
            'bscookie': 'Secure browser cookie',
            'liap': 'Additional authentication parameter',
            'li_rm': 'Remember me token',
            'li_mc': 'Member context',
            'lidc': 'Data center routing',
            'li_sugr': 'Suggestion tracking',
            'UserMatchHistory': 'User matching history',
            'AnalyticsSyncHistory': 'Analytics sync data',
            'lms_ads': 'LinkedIn Marketing Solutions',
            'lms_analytics': 'Marketing analytics',
            'li_alerts': 'Alert preferences',
            'timezone': 'User timezone',
            'lang': 'Language preference'
        };
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

    // Validate session health without triggering resets
    async validateSessionHealth() {
        const liAt = process.env.LI_AT || process.env.LINKEDIN_LI_AT;
        if (!liAt) return { valid: false, reason: 'No LI_AT cookie' };

        try {
            // Use a lightweight endpoint that doesn't trigger security
            const response = await fetch('https://www.linkedin.com/voyager/api/me', {
                method: 'HEAD', // HEAD request is less suspicious
                headers: {
                    'Cookie': this.buildCookieString(),
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/vnd.linkedin.normalized+json+2.1',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                },
                timeout: 5000
            });

            const valid = response.status === 200;
            return {
                valid,
                status: response.status,
                reason: valid ? 'Session healthy' : `HTTP ${response.status}`,
                lastChecked: new Date().toISOString()
            };
        } catch (err) {
            return {
                valid: false,
                reason: err.message,
                lastChecked: new Date().toISOString()
            };
        }
    }

    // Get session stability score
    getSessionStability() {
        const liAt = process.env.LI_AT || process.env.LINKEDIN_LI_AT;
        if (!liAt) return { score: 0, issues: ['No LI_AT cookie'] };

        const issues = [];
        let score = 100;

        // Check cookie age (estimate)
        const cookieLength = liAt.length;
        if (cookieLength < 100) {
            issues.push('Cookie seems too short');
            score -= 20;
        }

        // Check available supporting cookies
        const supportingCookies = Object.keys(process.env).filter(key => 
            key.startsWith('LI_') && key !== 'LI_AT' && process.env[key]
        );
        
        if (supportingCookies.length < 3) {
            issues.push('Missing supporting cookies (bcookie, bscookie, etc.)');
            score -= 30;
        }

        // Check refresh frequency
        if (this.lastRefresh && (Date.now() - this.lastRefresh) < 60000) {
            issues.push('Too frequent refresh attempts');
            score -= 25;
        }

        return {
            score: Math.max(0, score),
            issues,
            supportingCookies: supportingCookies.length,
            recommendations: this.getStabilityRecommendations(score, issues)
        };
    }

    // Get recommendations for better stability
    getStabilityRecommendations(score, issues) {
        const recommendations = [];

        if (score < 50) {
            recommendations.push('Export complete LinkedIn session (all cookies + localStorage)');
            recommendations.push('Use a dedicated browser profile for LinkedIn');
            recommendations.push('Avoid clearing browser data');
        }

        if (issues.some(i => i.includes('supporting cookies'))) {
            recommendations.push('Add JSESSIONID, bcookie, bscookie, liap cookies');
            recommendations.push('Use the /session-export-guide endpoint for instructions');
        }

        if (issues.some(i => i.includes('frequent'))) {
            recommendations.push('Reduce request frequency');
            recommendations.push('Add longer delays between requests');
        }

        return recommendations;
    }

    // Save complete session state (cookies + storage)
    async saveFullSession(context) {
        try {
            const cookies = await context.cookies();
            const storageState = await context.storageState();

            const sessionData = {
                cookies,
                storageState,
                timestamp: new Date().toISOString(),
                expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                linkedinCookies: this.extractLinkedInCookies(cookies)
            };

            await fs.promises.writeFile(this.sessionFile, JSON.stringify(sessionData, null, 2));
            console.log('Full session state saved with', cookies.length, 'cookies');
            return sessionData;
        } catch (err) {
            console.warn('Failed to save full session:', err.message);
            return null;
        }
    }

    // Extract LinkedIn-specific cookies
    extractLinkedInCookies(cookies) {
        const linkedinCookies = {};
        cookies.forEach(cookie => {
            if (cookie.domain.includes('linkedin.com') && this.linkedinCookies[cookie.name]) {
                linkedinCookies[cookie.name] = {
                    value: cookie.value,
                    expires: cookie.expires,
                    purpose: this.linkedinCookies[cookie.name]
                };
            }
        });
        return linkedinCookies;
    }

    // Build comprehensive cookie string for requests
    buildCookieString() {
        const cookies = [];

        // Add environment cookies
        Object.keys(process.env).forEach(key => {
            if (key.startsWith('LI_') && process.env[key]) {
                const cookieName = key.toLowerCase().replace('li_', '');
                if (cookieName === 'at') {
                    cookies.push(`li_at=${process.env[key]}`);
                } else {
                    cookies.push(`${cookieName}=${process.env[key]}`);
                }
            }
        });

        return cookies.join('; ');
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

    // Generate session export instructions
    getSessionExportInstructions() {
        return {
            instructions: [
                "1. Open LinkedIn in your browser and log in",
                "2. Press F12 to open Developer Tools",
                "3. Go to Application tab → Storage",
                "4. Right-click on 'linkedin.com' under Cookies",
                "5. Copy all cookie values",
                "6. Set these as environment variables in Railway:"
            ],
            environmentVariables: Object.keys(this.linkedinCookies).map(name => ({
                name: `LI_${name.toUpperCase()}`,
                description: this.linkedinCookies[name],
                example: `LI_${name.toUpperCase()}=your_${name}_value_here`
            }))
        };
    }
}

module.exports = new CookieManager();