'use strict';

const https = require('https');

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Makes an authenticated HTTPS request to a Google API endpoint.
 * @param {string} url - Full URL including query params
 * @param {object} options - https.request options (method, headers)
 * @param {object|null} body - Request body (will be JSON-serialized)
 * @returns {Promise<object>}
 */
function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error?.message || `HTTP ${res.statusCode}`));
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

/**
 * Builds Authorization header object for a Bearer token.
 * @param {string} token
 * @returns {object}
 */
function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/**
 * Refreshes an expired Google OAuth2 access token using a refresh token.
 * Updates the credentials object in place with the new access_token.
 * @param {object} credentials - Must have refresh_token, client_id, client_secret
 * @returns {Promise<string>} New access token
 */
async function refreshAccessToken(credentials) {
  const { refresh_token, client_id, client_secret } = credentials;
  if (!refresh_token || !client_id || !client_secret) {
    throw new Error('Cannot refresh token: missing refresh_token, client_id, or client_secret');
  }
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token,
    client_id,
    client_secret,
  });
  const payload = params.toString();
  const result = await new Promise((resolve, reject) => {
    const req = https.request(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(parsed.error_description || 'Token refresh failed'));
          else resolve(parsed);
        } catch { reject(new Error('Invalid token refresh response')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
  credentials.access_token = result.access_token;
  if (result.refresh_token) credentials.refresh_token = result.refresh_token;
  return result.access_token;
}

/**
 * Executes a Google API call, automatically retrying once after refreshing
 * the access token if a 401 Unauthorized response is received.
 * @param {object} credentials
 * @param {Function} fn - Async function that takes an access_token and returns a promise
 * @returns {Promise<object>}
 */
async function withTokenRefresh(credentials, fn) {
  try {
    return await fn(credentials.access_token);
  } catch (err) {
    if (err.message.includes('401') || err.message.toLowerCase().includes('invalid credentials') || err.message.toLowerCase().includes('unauthorized')) {
      const newToken = await refreshAccessToken(credentials);
      return fn(newToken);
    }
    throw err;
  }
}

const GoogleConnector = {
  name: 'google',
  displayName: 'Google',
  description: 'Access Gmail, Google Calendar, and Google Drive',

  /**
   * Validates that required credentials are present.
   * @param {object} credentials - Must include access_token
   */
  validate(credentials) {
    if (!credentials.access_token) throw new Error('Google connector requires an access_token');
  },

  tools: [
    {
      name: 'google_list_emails',
      description: 'List recent emails from Gmail inbox',
      input_schema: {
        type: 'object',
        properties: {
          maxResults: { type: 'number', description: 'Number of emails to return (default 10, max 20)' },
          query: { type: 'string', description: 'Gmail search query (e.g. "is:unread", "from:boss@example.com")' },
        },
      },
    },
    {
      name: 'google_send_email',
      description: 'Send an email via Gmail',
      input_schema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string', description: 'Email subject' },
          body: { type: 'string', description: 'Email body (plain text)' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
    {
      name: 'google_list_calendar_events',
      description: 'List upcoming Google Calendar events',
      input_schema: {
        type: 'object',
        properties: {
          maxResults: { type: 'number', description: 'Number of events to return (default 10)' },
          calendarId: { type: 'string', description: 'Calendar ID (default: primary)' },
        },
      },
    },
    {
      name: 'google_create_calendar_event',
      description: 'Create a new Google Calendar event',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Event title' },
          start: { type: 'string', description: 'Start datetime in ISO 8601 format' },
          end: { type: 'string', description: 'End datetime in ISO 8601 format' },
          description: { type: 'string', description: 'Event description' },
          attendees: { type: 'array', items: { type: 'string' }, description: 'List of attendee email addresses' },
        },
        required: ['summary', 'start', 'end'],
      },
    },
    {
      name: 'google_list_drive_files',
      description: 'List files in Google Drive',
      input_schema: {
        type: 'object',
        properties: {
          maxResults: { type: 'number', description: 'Number of files to return (default 10)' },
          query: { type: 'string', description: "Drive search query (e.g. \"mimeType='application/pdf'\")" },
        },
      },
    },
  ],

  /**
   * Executes a Google tool call. Automatically refreshes expired tokens.
   * @param {string} toolName
   * @param {object} params
   * @param {object} credentials - { access_token, [refresh_token, client_id, client_secret] }
   * @returns {Promise<object>}
   */
  async execute(toolName, params, credentials) {
    switch (toolName) {
      case 'google_list_emails': {
        return withTokenRefresh(credentials, async (token) => {
          const headers = authHeaders(token);
          const max = Math.min(params.maxResults || 10, 20);
          const q = params.query ? `&q=${encodeURIComponent(params.query)}` : '';
          const list = await request(
            `${GMAIL_BASE}/users/me/messages?maxResults=${max}${q}`,
            { method: 'GET', headers },
          );
          if (!list.messages || list.messages.length === 0) return { emails: [] };
          const emails = await Promise.all(
            list.messages.slice(0, max).map(async (m) => {
              const msg = await request(
                `${GMAIL_BASE}/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
                { method: 'GET', headers },
              );
              const hdrs = Object.fromEntries(
                (msg.payload?.headers || []).map((h) => [h.name, h.value]),
              );
              return { id: m.id, subject: hdrs.Subject, from: hdrs.From, date: hdrs.Date, snippet: msg.snippet };
            }),
          );
          return { emails };
        });
      }

      case 'google_send_email': {
        return withTokenRefresh(credentials, async (token) => {
          const headers = authHeaders(token);
          const raw = Buffer.from(
            `To: ${params.to}\r\nSubject: ${params.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${params.body}`,
          ).toString('base64url');
          await request(
            `${GMAIL_BASE}/users/me/messages/send`,
            { method: 'POST', headers },
            { raw },
          );
          return { success: true, message: `Email sent to ${params.to}` };
        });
      }

      case 'google_list_calendar_events': {
        return withTokenRefresh(credentials, async (token) => {
          const headers = authHeaders(token);
          const calId = encodeURIComponent(params.calendarId || 'primary');
          const max = params.maxResults || 10;
          const now = new Date().toISOString();
          const data = await request(
            `${CALENDAR_BASE}/calendars/${calId}/events?maxResults=${max}&timeMin=${encodeURIComponent(now)}&orderBy=startTime&singleEvents=true`,
            { method: 'GET', headers },
          );
          return {
            events: (data.items || []).map((e) => ({
              id: e.id,
              summary: e.summary,
              start: e.start?.dateTime || e.start?.date,
              end: e.end?.dateTime || e.end?.date,
              description: e.description,
              location: e.location,
            })),
          };
        });
      }

      case 'google_create_calendar_event': {
        return withTokenRefresh(credentials, async (token) => {
          const headers = authHeaders(token);
          const calId = encodeURIComponent(params.calendarId || 'primary');
          const event = {
            summary: params.summary,
            description: params.description,
            start: { dateTime: params.start, timeZone: 'UTC' },
            end: { dateTime: params.end, timeZone: 'UTC' },
            attendees: (params.attendees || []).map((email) => ({ email })),
          };
          const created = await request(
            `${CALENDAR_BASE}/calendars/${calId}/events`,
            { method: 'POST', headers },
            event,
          );
          return { success: true, eventId: created.id, htmlLink: created.htmlLink };
        });
      }

      case 'google_list_drive_files': {
        return withTokenRefresh(credentials, async (token) => {
          const headers = authHeaders(token);
          const max = params.maxResults || 10;
          const q = params.query ? `&q=${encodeURIComponent(params.query)}` : '';
          const data = await request(
            `${DRIVE_BASE}/files?pageSize=${max}&fields=files(id,name,mimeType,modifiedTime,size)${q}`,
            { method: 'GET', headers },
          );
          return { files: data.files || [] };
        });
      }

      default:
        throw new Error(`Unknown Google tool: ${toolName}`);
    }
  },
};

module.exports = GoogleConnector;
