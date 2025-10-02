const crypto = require('crypto');

class LinkedInGraphQLClient {
  constructor() {
    this.endpoint = 'https://www.linkedin.com/voyager/api/graphql';
    this.cookieManager = require('./cookieManager');
  }

  async executeQuery(query, variables = {}) {
    const headers = this.buildHeaders();
    
    // Add delay to avoid rate limiting
    await this.randomDelay(1000, 3000);
    
    const payload = {
      query: typeof query === 'string' ? query : query.query,
      variables
    };

    try {
      console.log('Executing GraphQL query:', { 
        endpoint: this.endpoint,
        variables,
        queryLength: payload.query.length 
      });

      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      console.log('GraphQL response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GraphQL request failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      
      if (data.errors) {
        console.error('GraphQL errors:', data.errors);
        throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
      }

      console.log('GraphQL query successful');
      return data.data;
    } catch (error) {
      console.error('GraphQL query failed:', error.message);
      throw error;
    }
  }

  buildHeaders() {
    const cookieString = this.cookieManager.buildCookieString();
    const csrf = `ajax:${crypto.randomBytes(8).toString('hex')}`;

    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Li-Lang': 'en_US',
      'X-Li-Track': JSON.stringify({
        clientVersion: '1.13.0',
        mpVersion: '1.13.0',
        osName: 'web',
        timezoneOffset: new Date().getTimezoneOffset(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      }),
      'Cookie': `${cookieString}; JSESSIONID="${csrf}"`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.linkedin.com/',
      'Origin': 'https://www.linkedin.com',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'X-LI-CSRF-TOKEN': csrf
    };
  }

  async randomDelay(min, max) {
    const delay = min + Math.random() * (max - min);
    return new Promise(resolve => setTimeout(resolve, delay));
  }

  // Helper method to convert company URL to universal name
  extractUniversalName(companyUrl) {
    const match = companyUrl.match(/linkedin\.com\/company\/([^\/\?]+)/);
    return match ? match[1] : null;
  }

  // Helper method to get organization URN from universal name
  async getOrganizationUrn(universalName) {
    const query = `
      query GetOrgUrn($universalName: String!) {
        organization(universalName: $universalName) {
          entityUrn
        }
      }
    `;

    try {
      const result = await this.executeQuery(query, { universalName });
      return result?.organization?.entityUrn;
    } catch (error) {
      console.log('Failed to get organization URN:', error.message);
      return null;
    }
  }
}

module.exports = LinkedInGraphQLClient;