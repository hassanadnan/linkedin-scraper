const LinkedInGraphQLClient = require('./linkedinGraphQL');

class GraphQLScraper {
  constructor() {
    this.client = new LinkedInGraphQLClient();
  }

  async scrapeCompanyData(companyUrl) {
    try {
      console.log('Starting GraphQL scraping for:', companyUrl);
      
      const universalName = this.client.extractUniversalName(companyUrl);
      if (!universalName) {
        throw new Error('Invalid LinkedIn company URL');
      }

      console.log('Extracted universal name:', universalName);

      // Try different approaches to get company data
      const results = await this.tryMultipleQueries(universalName, companyUrl);

      return {
        companyUrl,
        method: 'graphql',
        universalName,
        ...results,
        fetchedAt: new Date().toISOString()
      };

    } catch (error) {
      console.error('GraphQL scraping failed:', error.message);
      throw error;
    }
  }

  async tryMultipleQueries(universalName, companyUrl) {
    const results = {
      companyName: null,
      employeeCount: null,
      associatedMembers: null,
      jobsPostedCount: null,
      dataSource: 'graphql',
      queryResults: []
    };

    // Query 1: Basic company information
    try {
      const companyInfo = await this.getBasicCompanyInfo(universalName);
      results.queryResults.push({ query: 'basicCompanyInfo', success: true });
      Object.assign(results, companyInfo);
    } catch (error) {
      results.queryResults.push({ query: 'basicCompanyInfo', success: false, error: error.message });
    }

    // Query 2: Try to get organization URN for advanced queries
    try {
      const orgUrn = await this.client.getOrganizationUrn(universalName);
      if (orgUrn) {
        results.orgUrn = orgUrn;
        
        // Query 3: Employee insights
        try {
          const employeeData = await this.getEmployeeInsights(orgUrn);
          results.queryResults.push({ query: 'employeeInsights', success: true });
          Object.assign(results, employeeData);
        } catch (error) {
          results.queryResults.push({ query: 'employeeInsights', success: false, error: error.message });
        }

        // Query 4: Job postings
        try {
          const jobData = await this.getJobPostings(orgUrn);
          results.queryResults.push({ query: 'jobPostings', success: true });
          Object.assign(results, jobData);
        } catch (error) {
          results.queryResults.push({ query: 'jobPostings', success: false, error: error.message });
        }
      }
    } catch (error) {
      results.queryResults.push({ query: 'getOrgUrn', success: false, error: error.message });
    }

    return results;
  }

  async getBasicCompanyInfo(universalName) {
    const query = `
      query GetCompanyInfo($universalName: String!) {
        organization(universalName: $universalName) {
          name
          universalName
          description
          website
          industryV2 {
            name
          }
          staffCount
          staffCountRange {
            start
            end
          }
          foundedOn {
            year
          }
          headquarter {
            city
            country
          }
        }
      }
    `;

    const result = await this.client.executeQuery(query, { universalName });
    const org = result?.organization;

    if (!org) {
      throw new Error('No organization data returned');
    }

    return {
      companyName: org.name,
      industry: org.industryV2?.name,
      website: org.website,
      foundedYear: org.foundedOn?.year,
      employeeCount: org.staffCount,
      employeeCountRange: org.staffCountRange ? 
        `${org.staffCountRange.start}-${org.staffCountRange.end}` : null,
      headquarters: org.headquarter ? 
        `${org.headquarter.city}, ${org.headquarter.country}` : null
    };
  }

  async getEmployeeInsights(orgUrn) {
    // Try multiple employee-related queries
    const queries = [
      {
        name: 'organizationInsights',
        query: `
          query GetEmployeeInsights($orgUrn: String!) {
            organizationInsights(organizationUrn: $orgUrn) {
              headcount {
                total
                growth {
                  percentage
                  timeframe
                }
              }
            }
          }
        `
      },
      {
        name: 'peopleSearch',
        query: `
          query GetPeopleCount($companyUrn: String!) {
            peopleSearch(
              query: {
                currentCompany: [$companyUrn]
              }
              start: 0
              count: 1
            ) {
              metadata {
                totalResultCount
              }
            }
          }
        `
      }
    ];

    for (const queryDef of queries) {
      try {
        const result = await this.client.executeQuery(queryDef.query, { 
          orgUrn, 
          companyUrn: orgUrn 
        });
        
        if (queryDef.name === 'organizationInsights') {
          const insights = result?.organizationInsights;
          if (insights?.headcount?.total) {
            return {
              associatedMembers: insights.headcount.total,
              employeeGrowth: insights.headcount.growth?.percentage,
              dataSource: 'graphql_insights'
            };
          }
        } else if (queryDef.name === 'peopleSearch') {
          const peopleData = result?.peopleSearch;
          if (peopleData?.metadata?.totalResultCount) {
            return {
              associatedMembers: peopleData.metadata.totalResultCount,
              dataSource: 'graphql_people_search'
            };
          }
        }
      } catch (error) {
        console.log(`Employee query ${queryDef.name} failed:`, error.message);
      }
    }

    return {};
  }

  async getJobPostings(orgUrn) {
    const query = `
      query GetJobPostings($companyUrns: [String!]!) {
        jobSearch(
          origin: JOBS_HOME_PAGE
          query: {
            companyFilter: {
              values: $companyUrns
            }
          }
          start: 0
          count: 1
        ) {
          metadata {
            totalResultCount
          }
        }
      }
    `;

    try {
      const result = await this.client.executeQuery(query, { 
        companyUrns: [orgUrn] 
      });

      const jobData = result?.jobSearch;
      if (jobData?.metadata?.totalResultCount !== undefined) {
        return {
          jobsPostedCount: jobData.metadata.totalResultCount
        };
      }
    } catch (error) {
      console.log('Job postings query failed:', error.message);
    }

    return {};
  }
}

module.exports = GraphQLScraper;