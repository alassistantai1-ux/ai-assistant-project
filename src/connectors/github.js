'use strict';

const https = require('https');

const BASE = 'https://api.github.com';

function request(path, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = path.startsWith('http') ? path : `${BASE}${path}`;
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.message || `HTTP ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Invalid JSON response (HTTP ${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'ai-assistant-project',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

const GitHubConnector = {
  name: 'github',
  displayName: 'GitHub',
  description: 'Access GitHub repositories, issues, and pull requests',

  validate(credentials) {
    if (!credentials.token) throw new Error('GitHub connector requires a token (personal access token)');
  },

  tools: [
    {
      name: 'github_list_repos',
      description: 'List GitHub repositories for the authenticated user',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['all', 'owner', 'public', 'private'], description: 'Filter repos by type (default: owner)' },
          sort: { type: 'string', enum: ['created', 'updated', 'pushed', 'full_name'], description: 'Sort repos (default: updated)' },
          perPage: { type: 'number', description: 'Number of repos to return (default 10, max 30)' },
        },
      },
    },
    {
      name: 'github_list_issues',
      description: 'List issues in a GitHub repository',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner (username or org)' },
          repo: { type: 'string', description: 'Repository name' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state (default: open)' },
          perPage: { type: 'number', description: 'Number of issues to return (default 10, max 30)' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'github_create_issue',
      description: 'Create a new issue in a GitHub repository',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          title: { type: 'string', description: 'Issue title' },
          body: { type: 'string', description: 'Issue body (markdown)' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply' },
        },
        required: ['owner', 'repo', 'title'],
      },
    },
    {
      name: 'github_get_repo',
      description: 'Get details about a specific GitHub repository',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'github_search_code',
      description: 'Search code across GitHub repositories',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (supports GitHub code search syntax)' },
          perPage: { type: 'number', description: 'Number of results (default 10, max 20)' },
        },
        required: ['query'],
      },
    },
  ],

  async execute(toolName, params, credentials) {
    const headers = authHeaders(credentials.token);

    switch (toolName) {
      case 'github_list_repos': {
        const per = Math.min(params.perPage || 10, 30);
        const type = params.type || 'owner';
        const sort = params.sort || 'updated';
        const data = await request(
          `/user/repos?type=${type}&sort=${sort}&per_page=${per}`,
          { method: 'GET', headers },
        );
        return {
          repos: data.map((r) => ({
            name: r.full_name,
            description: r.description,
            private: r.private,
            stars: r.stargazers_count,
            updatedAt: r.updated_at,
            language: r.language,
            openIssues: r.open_issues_count,
          })),
        };
      }

      case 'github_list_issues': {
        const per = Math.min(params.perPage || 10, 30);
        const state = params.state || 'open';
        const data = await request(
          `/repos/${params.owner}/${params.repo}/issues?state=${state}&per_page=${per}`,
          { method: 'GET', headers },
        );
        return {
          issues: data.map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            author: i.user?.login,
            labels: i.labels?.map((l) => l.name),
            createdAt: i.created_at,
            url: i.html_url,
            body: i.body?.slice(0, 300),
          })),
        };
      }

      case 'github_create_issue': {
        const data = await request(
          `/repos/${params.owner}/${params.repo}/issues`,
          { method: 'POST', headers },
          { title: params.title, body: params.body || '', labels: params.labels || [] },
        );
        return { success: true, number: data.number, url: data.html_url };
      }

      case 'github_get_repo': {
        const data = await request(
          `/repos/${params.owner}/${params.repo}`,
          { method: 'GET', headers },
        );
        return {
          name: data.full_name,
          description: data.description,
          private: data.private,
          stars: data.stargazers_count,
          forks: data.forks_count,
          openIssues: data.open_issues_count,
          defaultBranch: data.default_branch,
          language: data.language,
          topics: data.topics,
          createdAt: data.created_at,
          updatedAt: data.updated_at,
          url: data.html_url,
        };
      }

      case 'github_search_code': {
        const per = Math.min(params.perPage || 10, 20);
        const data = await request(
          `/search/code?q=${encodeURIComponent(params.query)}&per_page=${per}`,
          { method: 'GET', headers },
        );
        return {
          totalCount: data.total_count,
          items: (data.items || []).map((i) => ({
            name: i.name,
            path: i.path,
            repo: i.repository?.full_name,
            url: i.html_url,
          })),
        };
      }

      default:
        throw new Error(`Unknown GitHub tool: ${toolName}`);
    }
  },
};

module.exports = GitHubConnector;
