'use strict';

const https = require('https');

const GRAPH_HOST = 'graph.microsoft.com';
const GRAPH_BASE = '/v1.0';

/**
 * Makes an authenticated request to the Microsoft Graph API.
 * @param {string} path - API path relative to /v1.0
 * @param {string} method - HTTP method
 * @param {string} accessToken - Bearer token
 * @param {object|null} body - Request body
 * @returns {Promise<object>}
 */
function graphRequest(path, method, accessToken, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const options = {
      hostname: GRAPH_HOST,
      path: `${GRAPH_BASE}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
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
            const msg = parsed.error?.message || parsed.message || `HTTP ${res.statusCode}`;
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

const TeamsConnector = {
  name: 'teams',
  displayName: 'Microsoft Teams',
  description: 'Send messages, list teams/channels, and read recent messages in Microsoft Teams',

  /**
   * Validates that required credentials are present.
   * @param {object} credentials - { accessToken }
   */
  validate(credentials) {
    if (!credentials.accessToken) {
      throw new Error('Teams connector requires an accessToken (Microsoft Graph Bearer token)');
    }
  },

  tools: [
    {
      name: 'teams_list_teams',
      description: 'List all Microsoft Teams the user is a member of',
      input_schema: {
        type: 'object',
        properties: {
          maxResults: { type: 'number', description: 'Max teams to return (default 20)' },
        },
      },
    },
    {
      name: 'teams_list_channels',
      description: 'List channels in a Microsoft Teams team',
      input_schema: {
        type: 'object',
        properties: {
          teamId: { type: 'string', description: 'ID of the team' },
        },
        required: ['teamId'],
      },
    },
    {
      name: 'teams_get_recent_messages',
      description: 'Get recent messages from a Teams channel',
      input_schema: {
        type: 'object',
        properties: {
          teamId: { type: 'string', description: 'ID of the team' },
          channelId: { type: 'string', description: 'ID of the channel' },
          maxResults: { type: 'number', description: 'Number of messages to return (default 20, max 50)' },
        },
        required: ['teamId', 'channelId'],
      },
    },
    {
      name: 'teams_send_message',
      description: 'Send a message to a Teams channel',
      input_schema: {
        type: 'object',
        properties: {
          teamId: { type: 'string', description: 'ID of the team' },
          channelId: { type: 'string', description: 'ID of the channel' },
          content: { type: 'string', description: 'Message text (HTML supported)' },
          contentType: { type: 'string', description: '"text" or "html" — default "text"' },
        },
        required: ['teamId', 'channelId', 'content'],
      },
    },
  ],

  /**
   * Executes a Teams tool call.
   * @param {string} toolName
   * @param {object} params
   * @param {object} credentials - { accessToken }
   * @returns {Promise<object>}
   */
  async execute(toolName, params, credentials) {
    const { accessToken } = credentials;

    switch (toolName) {
      case 'teams_list_teams': {
        const max = Math.min(params.maxResults || 20, 100);
        const data = await graphRequest(`/me/joinedTeams?$top=${max}`, 'GET', accessToken);
        return {
          total: (data.value || []).length,
          teams: (data.value || []).map((t) => ({
            id: t.id,
            displayName: t.displayName,
            description: t.description,
            visibility: t.visibility,
          })),
        };
      }

      case 'teams_list_channels': {
        const data = await graphRequest(`/teams/${params.teamId}/channels`, 'GET', accessToken);
        return {
          total: (data.value || []).length,
          channels: (data.value || []).map((c) => ({
            id: c.id,
            displayName: c.displayName,
            description: c.description,
            membershipType: c.membershipType,
          })),
        };
      }

      case 'teams_get_recent_messages': {
        const max = Math.min(params.maxResults || 20, 50);
        const data = await graphRequest(
          `/teams/${params.teamId}/channels/${params.channelId}/messages?$top=${max}`,
          'GET',
          accessToken,
        );
        return {
          total: (data.value || []).length,
          messages: (data.value || []).map((m) => ({
            id: m.id,
            createdAt: m.createdDateTime,
            from: m.from?.user?.displayName || m.from?.application?.displayName || 'Unknown',
            subject: m.subject,
            body: stripHtml(m.body?.content || '').slice(0, 500),
            importance: m.importance,
            replyCount: m.replies?.length || 0,
          })),
        };
      }

      case 'teams_send_message': {
        const contentType = params.contentType === 'html' ? 'html' : 'text';
        const body = {
          body: { contentType, content: params.content },
        };
        const data = await graphRequest(
          `/teams/${params.teamId}/channels/${params.channelId}/messages`,
          'POST',
          accessToken,
          body,
        );
        return {
          id: data.id,
          createdAt: data.createdDateTime,
          webUrl: data.webUrl,
        };
      }

      default:
        throw new Error(`Unknown Teams tool: ${toolName}`);
    }
  },
};

/** Strips HTML tags from a string. */
function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = TeamsConnector;
