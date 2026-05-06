'use strict';

const https = require('https');

const BASE = 'https://slack.com/api';

function request(method, body = null, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const options = {
      hostname: 'slack.com',
      path: `/api/${method}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            reject(new Error(parsed.error || 'Slack API error'));
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

const SlackConnector = {
  name: 'slack',
  displayName: 'Slack',
  description: 'Send messages and read channels in Slack',

  validate(credentials) {
    if (!credentials.token) throw new Error('Slack connector requires a token (Bot/User OAuth token)');
  },

  tools: [
    {
      name: 'slack_list_channels',
      description: 'List Slack channels the bot has access to',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of channels to return (default 20, max 50)' },
          types: { type: 'string', description: 'Channel types: public_channel, private_channel, mpim, im (default: public_channel)' },
        },
      },
    },
    {
      name: 'slack_send_message',
      description: 'Send a message to a Slack channel or user',
      input_schema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel ID or name (e.g. #general or C0123456)' },
          text: { type: 'string', description: 'Message text (supports Slack markdown)' },
          thread_ts: { type: 'string', description: 'Thread timestamp to reply in a thread' },
        },
        required: ['channel', 'text'],
      },
    },
    {
      name: 'slack_get_channel_history',
      description: 'Get recent messages from a Slack channel',
      input_schema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel ID (e.g. C0123456)' },
          limit: { type: 'number', description: 'Number of messages to return (default 10, max 30)' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'slack_get_user_info',
      description: 'Get information about a Slack user',
      input_schema: {
        type: 'object',
        properties: {
          user: { type: 'string', description: 'User ID (e.g. U0123456)' },
        },
        required: ['user'],
      },
    },
  ],

  async execute(toolName, params, credentials) {
    const token = credentials.token;

    switch (toolName) {
      case 'slack_list_channels': {
        const limit = Math.min(params.limit || 20, 50);
        const types = params.types || 'public_channel';
        const data = await request('conversations.list', { limit, types }, token);
        return {
          channels: (data.channels || []).map((c) => ({
            id: c.id,
            name: c.name,
            topic: c.topic?.value,
            memberCount: c.num_members,
            isPrivate: c.is_private,
          })),
        };
      }

      case 'slack_send_message': {
        const payload = { channel: params.channel, text: params.text };
        if (params.thread_ts) payload.thread_ts = params.thread_ts;
        const data = await request('chat.postMessage', payload, token);
        return { success: true, ts: data.ts, channel: data.channel };
      }

      case 'slack_get_channel_history': {
        const limit = Math.min(params.limit || 10, 30);
        const data = await request('conversations.history', { channel: params.channel, limit }, token);
        return {
          messages: (data.messages || []).map((m) => ({
            ts: m.ts,
            user: m.user,
            text: m.text,
            replyCount: m.reply_count,
          })),
        };
      }

      case 'slack_get_user_info': {
        const data = await request('users.info', { user: params.user }, token);
        const u = data.user;
        return {
          id: u.id,
          name: u.name,
          realName: u.real_name,
          email: u.profile?.email,
          title: u.profile?.title,
          timezone: u.tz,
          isBot: u.is_bot,
        };
      }

      default:
        throw new Error(`Unknown Slack tool: ${toolName}`);
    }
  },
};

module.exports = SlackConnector;
