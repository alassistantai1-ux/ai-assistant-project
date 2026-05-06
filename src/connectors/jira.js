'use strict';

const https = require('https');

/**
 * Makes an authenticated request to the Jira REST API v3.
 * @param {string} path - API path (relative to /rest/api/3)
 * @param {string} method - HTTP method
 * @param {string} host - Jira instance hostname (e.g. yourorg.atlassian.net)
 * @param {string} token - Base64-encoded email:apiToken or API token
 * @param {object|null} body - Request body
 * @returns {Promise<object>}
 */
function request(path, method, host, token, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const options = {
      hostname: host,
      path: `/rest/api/3${path}`,
      method,
      headers: {
        Authorization: `Basic ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 204) { resolve({}); return; }
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const msg = parsed.errorMessages?.[0] || parsed.message || `HTTP ${res.statusCode}`;
            reject(new Error(msg));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Invalid JSON response (HTTP ${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const JiraConnector = {
  name: 'jira',
  displayName: 'Jira',
  description: 'List, search, and view issues in Jira projects',

  /**
   * Validates that required credentials are present.
   * @param {object} credentials - { host, email, apiToken }
   */
  validate(credentials) {
    if (!credentials.host) throw new Error('Jira connector requires a host (e.g. yourorg.atlassian.net)');
    if (!credentials.email) throw new Error('Jira connector requires an email address');
    if (!credentials.apiToken) throw new Error('Jira connector requires an apiToken');
  },

  tools: [
    {
      name: 'jira_list_issues',
      description: 'List issues in a Jira project',
      input_schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project key (e.g. MYPROJ)' },
          status: { type: 'string', description: 'Filter by status (e.g. "In Progress", "To Do", "Done")' },
          maxResults: { type: 'number', description: 'Number of issues to return (default 20, max 50)' },
        },
        required: ['project'],
      },
    },
    {
      name: 'jira_search_issues',
      description: 'Search Jira issues using JQL (Jira Query Language)',
      input_schema: {
        type: 'object',
        properties: {
          jql: { type: 'string', description: 'JQL query string (e.g. "project = MYPROJ AND assignee = currentUser()")' },
          maxResults: { type: 'number', description: 'Number of results to return (default 20, max 50)' },
        },
        required: ['jql'],
      },
    },
    {
      name: 'jira_get_issue',
      description: 'Get details about a specific Jira issue',
      input_schema: {
        type: 'object',
        properties: {
          issueKey: { type: 'string', description: 'Issue key (e.g. MYPROJ-123)' },
        },
        required: ['issueKey'],
      },
    },
    {
      name: 'jira_list_projects',
      description: 'List all accessible Jira projects',
      input_schema: {
        type: 'object',
        properties: {
          maxResults: { type: 'number', description: 'Max number of projects to return (default 50)' },
        },
      },
    },
    {
      name: 'jira_create_issue',
      description: 'Create a new Jira issue',
      input_schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project key (e.g. MYPROJ)' },
          summary: { type: 'string', description: 'Issue title/summary' },
          description: { type: 'string', description: 'Issue description (plain text)' },
          issueType: { type: 'string', description: 'Issue type (e.g. "Bug", "Story", "Task") — default "Task"' },
          priority: { type: 'string', description: 'Priority (e.g. "High", "Medium", "Low")' },
          assignee: { type: 'string', description: 'Account ID of the assignee' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply' },
        },
        required: ['project', 'summary'],
      },
    },
    {
      name: 'jira_add_comment',
      description: 'Add a comment to an existing Jira issue',
      input_schema: {
        type: 'object',
        properties: {
          issueKey: { type: 'string', description: 'Issue key (e.g. MYPROJ-123)' },
          body: { type: 'string', description: 'Comment text' },
        },
        required: ['issueKey', 'body'],
      },
    },
  ],

  /**
   * Executes a Jira tool call.
   * @param {string} toolName
   * @param {object} params
   * @param {object} credentials - { host, email, apiToken }
   * @returns {Promise<object>}
   */
  async execute(toolName, params, credentials) {
    const { host, email, apiToken } = credentials;
    const token = Buffer.from(`${email}:${apiToken}`).toString('base64');

    switch (toolName) {
      case 'jira_list_issues': {
        const max = Math.min(params.maxResults || 20, 50);
        let jql = `project = "${params.project}" ORDER BY updated DESC`;
        if (params.status) jql = `project = "${params.project}" AND status = "${params.status}" ORDER BY updated DESC`;
        const data = await request(
          `/search?jql=${encodeURIComponent(jql)}&maxResults=${max}&fields=summary,status,assignee,priority,created,updated,issuetype`,
          'GET', host, token,
        );
        return {
          total: data.total,
          issues: (data.issues || []).map(formatIssue),
        };
      }

      case 'jira_search_issues': {
        const max = Math.min(params.maxResults || 20, 50);
        const data = await request(
          `/search?jql=${encodeURIComponent(params.jql)}&maxResults=${max}&fields=summary,status,assignee,priority,created,updated,issuetype`,
          'GET', host, token,
        );
        return {
          total: data.total,
          issues: (data.issues || []).map(formatIssue),
        };
      }

      case 'jira_get_issue': {
        const data = await request(
          `/issue/${params.issueKey}?fields=summary,description,status,assignee,reporter,priority,created,updated,issuetype,comment,labels,components`,
          'GET', host, token,
        );
        const f = data.fields;
        return {
          key: data.key,
          summary: f.summary,
          status: f.status?.name,
          type: f.issuetype?.name,
          priority: f.priority?.name,
          assignee: f.assignee?.displayName,
          reporter: f.reporter?.displayName,
          labels: f.labels || [],
          components: (f.components || []).map((c) => c.name),
          created: f.created,
          updated: f.updated,
          description: extractDescription(f.description),
          comments: (f.comment?.comments || []).slice(-5).map((c) => ({
            author: c.author?.displayName,
            body: extractDescription(c.body),
            created: c.created,
          })),
        };
      }

      case 'jira_list_projects': {
        const max = Math.min(params.maxResults || 50, 100);
        const data = await request(`/project/search?maxResults=${max}&orderBy=name`, 'GET', host, token);
        return {
          total: data.total,
          projects: (data.values || []).map((p) => ({
            key: p.key,
            name: p.name,
            type: p.projectTypeKey,
            style: p.style,
            lead: p.lead?.displayName,
          })),
        };
      }

      case 'jira_create_issue': {
        const fields = {
          project: { key: params.project },
          summary: params.summary,
          issuetype: { name: params.issueType || 'Task' },
        };
        if (params.description) {
          fields.description = {
            version: 1,
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: params.description }] }],
          };
        }
        if (params.priority) fields.priority = { name: params.priority };
        if (params.assignee) fields.assignee = { accountId: params.assignee };
        if (params.labels) fields.labels = params.labels;

        const data = await request('/issue', 'POST', host, token, { fields });
        return { key: data.key, id: data.id, url: `https://${host}/browse/${data.key}` };
      }

      case 'jira_add_comment': {
        const body = {
          version: 1,
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: params.body }] }],
        };
        const data = await request(`/issue/${params.issueKey}/comment`, 'POST', host, token, { body });
        return {
          id: data.id,
          author: data.author?.displayName,
          created: data.created,
          body: extractDescription(data.body),
        };
      }

      default:
        throw new Error(`Unknown Jira tool: ${toolName}`);
    }
  },
};

/** Maps a Jira issue search result to a compact shape. */
function formatIssue(i) {
  return {
    key: i.key,
    summary: i.fields?.summary,
    status: i.fields?.status?.name,
    type: i.fields?.issuetype?.name,
    priority: i.fields?.priority?.name,
    assignee: i.fields?.assignee?.displayName,
    created: i.fields?.created,
    updated: i.fields?.updated,
  };
}

/** Extracts plain text from Atlassian Document Format (ADF) or returns raw string. */
function extractDescription(doc) {
  if (!doc) return null;
  if (typeof doc === 'string') return doc;
  const texts = [];
  function walk(node) {
    if (node.type === 'text') texts.push(node.text || '');
    for (const child of node.content || []) walk(child);
  }
  walk(doc);
  return texts.join('').slice(0, 800);
}

module.exports = JiraConnector;
