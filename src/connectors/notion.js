'use strict';

const https = require('https');

const NOTION_VERSION = '2022-06-28';

function request(path, method, token, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const options = {
      hostname: 'api.notion.com',
      path: `/v1/${path}`,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, (res) => {
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
    if (payload) req.write(payload);
    req.end();
  });
}

function extractTitle(page) {
  const props = page.properties || {};
  for (const key of ['title', 'Title', 'Name', 'name']) {
    if (props[key]?.title) {
      return props[key].title.map((t) => t.plain_text).join('');
    }
  }
  return '(Untitled)';
}

const NotionConnector = {
  name: 'notion',
  displayName: 'Notion',
  description: 'Search, read, and create pages in Notion',

  validate(credentials) {
    if (!credentials.token) throw new Error('Notion connector requires a token (integration secret)');
  },

  tools: [
    {
      name: 'notion_search',
      description: 'Search for pages and databases in Notion',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          filter: { type: 'string', enum: ['page', 'database'], description: 'Filter by object type' },
          pageSize: { type: 'number', description: 'Number of results (default 10, max 20)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'notion_get_page',
      description: 'Get the content of a Notion page',
      input_schema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'The Notion page ID' },
        },
        required: ['pageId'],
      },
    },
    {
      name: 'notion_create_page',
      description: 'Create a new page in a Notion database or as a child of an existing page',
      input_schema: {
        type: 'object',
        properties: {
          parentId: { type: 'string', description: 'Parent page ID or database ID' },
          parentType: { type: 'string', enum: ['page', 'database'], description: 'Whether the parent is a page or database (default: page)' },
          title: { type: 'string', description: 'Page title' },
          content: { type: 'string', description: 'Page content (plain text, added as a paragraph block)' },
        },
        required: ['parentId', 'title'],
      },
    },
    {
      name: 'notion_list_databases',
      description: 'List Notion databases accessible to the integration',
      input_schema: {
        type: 'object',
        properties: {
          pageSize: { type: 'number', description: 'Number of results (default 10)' },
        },
      },
    },
  ],

  async execute(toolName, params, credentials) {
    const token = credentials.token;

    switch (toolName) {
      case 'notion_search': {
        const body = {
          query: params.query,
          page_size: Math.min(params.pageSize || 10, 20),
        };
        if (params.filter) {
          body.filter = { value: params.filter, property: 'object' };
        }
        const data = await request('search', 'POST', token, body);
        return {
          results: (data.results || []).map((r) => ({
            id: r.id,
            type: r.object,
            title: extractTitle(r),
            url: r.url,
            lastEdited: r.last_edited_time,
          })),
        };
      }

      case 'notion_get_page': {
        const [page, blocks] = await Promise.all([
          request(`pages/${params.pageId}`, 'GET', token),
          request(`blocks/${params.pageId}/children?page_size=50`, 'GET', token),
        ]);
        const textBlocks = (blocks.results || [])
          .filter((b) => b.type === 'paragraph' || b.type === 'heading_1' || b.type === 'heading_2' || b.type === 'heading_3' || b.type === 'bulleted_list_item' || b.type === 'numbered_list_item')
          .map((b) => {
            const rich = b[b.type]?.rich_text || [];
            return rich.map((t) => t.plain_text).join('');
          })
          .filter(Boolean);
        return {
          id: page.id,
          title: extractTitle(page),
          url: page.url,
          lastEdited: page.last_edited_time,
          content: textBlocks.join('\n'),
        };
      }

      case 'notion_create_page': {
        const parentType = params.parentType || 'page';
        const body = {
          parent: parentType === 'database'
            ? { database_id: params.parentId }
            : { page_id: params.parentId },
          properties: {
            title: { title: [{ text: { content: params.title } }] },
          },
        };
        if (params.content) {
          body.children = [{
            object: 'block',
            type: 'paragraph',
            paragraph: { rich_text: [{ text: { content: params.content } }] },
          }];
        }
        const created = await request('pages', 'POST', token, body);
        return { success: true, id: created.id, url: created.url };
      }

      case 'notion_list_databases': {
        const body = { filter: { value: 'database', property: 'object' }, page_size: params.pageSize || 10 };
        const data = await request('search', 'POST', token, body);
        return {
          databases: (data.results || []).map((d) => ({
            id: d.id,
            title: extractTitle(d),
            url: d.url,
            lastEdited: d.last_edited_time,
          })),
        };
      }

      default:
        throw new Error(`Unknown Notion tool: ${toolName}`);
    }
  },
};

module.exports = NotionConnector;
