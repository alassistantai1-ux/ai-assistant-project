'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk').default;
const { ConnectorRegistry } = require('./connectors');

const PORT = process.env.PORT || 8765;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MAX_HISTORY_TURNS = 20; // max user+assistant turn pairs per session

const SYSTEM_PROMPT =
  'You are a helpful AI assistant embedded in a desktop application. ' +
  'Provide clear, concise, and accurate answers. ' +
  'When the user asks you to perform actions on their connected accounts (email, calendar, GitHub, Slack, Notion, Jira, etc.), ' +
  'use the available tools to do so. Always confirm what you did after completing an action. ' +
  'Format responses in plain text unless the user requests structured output.';

const anthropic = new Anthropic();
const registry = new ConnectorRegistry();

/** @type {Map<string, Array<{role: string, content: any}>>} Per-client conversation history */
const conversations = new Map();

// ─── Structured logger ────────────────────────────────────────────────────────

/**
 * Emits a structured JSON log line to stdout.
 * @param {string} event - Short event identifier
 * @param {object} [meta] - Additional key/value metadata
 */
function log(event, meta = {}) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...meta }) + '\n');
}

// ─── HTTP server (serves static chat UI) ─────────────────────────────────────

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // ── HTTP API endpoints ─────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/connectors') {
    const connectors = registry.list();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { connectors } }));
    return;
  }

  const healthMatch = req.method === 'GET' && url.pathname.match(/^\/api\/connectors\/([^/]+)\/health$/);
  if (healthMatch) {
    const name = healthMatch[1];
    const all = registry.list();
    const connector = all.find((c) => c.name === name);
    if (!connector) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Connector not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { name, status: 'available', connected: connector.connected } }));
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  const safePath = url.pathname === '/' ? '/index.html' : url.pathname;
  // Prevent path traversal
  const filePath = path.resolve(PUBLIC_DIR, '.' + safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ─── WebSocket server (shares the HTTP server) ────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });
const clients = new Map();

httpServer.listen(PORT, () => {
  log('server_started', { port: PORT, ui: `http://localhost:${PORT}` });
});

wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  const remoteAddress = req.socket.remoteAddress;

  clients.set(clientId, { ws, connectedAt: new Date() });
  conversations.set(clientId, []);
  log('client_connected', { clientId, remoteAddress, totalClients: clients.size });

  send(ws, { type: 'connected', clientId, message: 'AI Assistant ready' });

  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) send(ws, { type: 'ping' });
  }, 30000);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }
    handleMessage(ws, clientId, msg);
  });

  ws.on('close', (code) => {
    clearInterval(heartbeat);
    clients.delete(clientId);
    registry.removeClient(clientId);
    conversations.delete(clientId);
    log('client_disconnected', { clientId, code, totalClients: clients.size });
  });

  ws.on('error', (err) => {
    log('client_error', { clientId, error: err.message });
  });
});

// ─── Message handler ──────────────────────────────────────────────────────────

/**
 * Dispatches an incoming WebSocket message to the appropriate handler.
 * @param {import('ws').WebSocket} ws
 * @param {string} clientId
 * @param {object} msg
 */
function handleMessage(ws, clientId, msg) {
  switch (msg.type) {
    case 'pong':
      break;

    case 'new_conversation':
      conversations.set(clientId, []);
      send(ws, { type: 'conversation_cleared', requestId: msg.requestId });
      log('conversation_cleared', { clientId });
      break;

    case 'query':
      if (!msg.text) {
        send(ws, { type: 'error', requestId: msg.requestId, message: 'Missing text field' });
        return;
      }
      log('query_received', { clientId, requestId: msg.requestId, text: msg.text.slice(0, 120) });
      handleQuery(ws, clientId, msg).catch((err) => {
        log('query_error', { clientId, requestId: msg.requestId, error: err.message });
        send(ws, { type: 'error', requestId: msg.requestId, message: 'AI request failed' });
      });
      break;

    case 'connect_account': {
      if (!msg.connector || !msg.credentials) {
        send(ws, { type: 'error', requestId: msg.requestId, message: 'Missing connector or credentials' });
        return;
      }
      try {
        const result = registry.connect(clientId, msg.connector, msg.credentials);
        log('account_connected', { clientId, connector: msg.connector });
        send(ws, { type: 'account_connected', requestId: msg.requestId, ...result });
      } catch (err) {
        log('account_connect_error', { clientId, connector: msg.connector, error: err.message });
        send(ws, { type: 'error', requestId: msg.requestId, message: err.message });
      }
      break;
    }

    case 'disconnect_account': {
      if (!msg.connector) {
        send(ws, { type: 'error', requestId: msg.requestId, message: 'Missing connector field' });
        return;
      }
      const result = registry.disconnect(clientId, msg.connector);
      log('account_disconnected', { clientId, connector: msg.connector });
      send(ws, { type: 'account_disconnected', requestId: msg.requestId, ...result });
      break;
    }

    case 'list_connectors':
      send(ws, {
        type: 'connectors_list',
        requestId: msg.requestId,
        available: registry.list(clientId),
        connected: registry.connectedAccounts(clientId),
      });
      break;

    case 'status':
      send(ws, {
        type: 'status',
        requestId: msg.requestId,
        connectedClients: clients.size,
        uptime: process.uptime(),
        connectedAccounts: registry.connectedAccounts(clientId),
        conversationLength: (conversations.get(clientId) || []).length,
      });
      break;

    default:
      send(ws, { type: 'error', requestId: msg.requestId, message: `Unknown message type: ${msg.type}` });
  }
}

// ─── Agentic query loop ───────────────────────────────────────────────────────

/**
 * Handles a query message: builds conversation history, runs the agentic
 * tool-use loop with Claude, and streams the response back to the client.
 * @param {import('ws').WebSocket} ws
 * @param {string} clientId
 * @param {object} msg
 */
async function handleQuery(ws, clientId, msg) {
  send(ws, { type: 'response_start', requestId: msg.requestId });

  const tools = registry.getTools(clientId);
  const history = conversations.get(clientId) || [];

  // Append the new user message
  history.push({ role: 'user', content: msg.text });

  // Cap history at MAX_HISTORY_TURNS turn pairs (2 messages per turn)
  while (history.length > MAX_HISTORY_TURNS * 2) {
    history.splice(0, 2);
  }

  // Agentic loop: keep running until the model stops calling tools
  while (true) {
    const requestParams = {
      model: MODEL,
      max_tokens: 4096,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: history,
    };

    if (tools.length > 0) {
      requestParams.tools = tools;
      requestParams.tool_choice = { type: 'auto' };
    }

    let finalMessage;

    if (msg.stream !== false && tools.length === 0) {
      // Pure streaming path (no tools)
      const stream = anthropic.messages.stream(requestParams);

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          send(ws, { type: 'response_delta', requestId: msg.requestId, delta: event.delta.text });
        }
      }
      finalMessage = await stream.finalMessage();
    } else {
      // Non-streaming path (required for tool_use to inspect content blocks)
      finalMessage = await anthropic.messages.create(requestParams);

      for (const block of finalMessage.content) {
        if (block.type === 'text') {
          send(ws, { type: 'response_delta', requestId: msg.requestId, delta: block.text });
        }
      }
    }

    // If the model wants to use tools, execute them and continue the loop
    if (finalMessage.stop_reason === 'tool_use') {
      const toolUseBlocks = finalMessage.content.filter((b) => b.type === 'tool_use');

      history.push({ role: 'assistant', content: finalMessage.content });

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          log('tool_call', { clientId, tool: block.name, input: block.input });
          send(ws, { type: 'tool_call', requestId: msg.requestId, tool: block.name, input: block.input });
          try {
            const result = await registry.executeToolCall(clientId, block.name, block.input);
            log('tool_result', { clientId, tool: block.name, status: 'ok' });
            return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) };
          } catch (err) {
            log('tool_result', { clientId, tool: block.name, status: 'error', error: err.message });
            return { type: 'tool_result', tool_use_id: block.id, is_error: true, content: err.message };
          }
        }),
      );

      history.push({ role: 'user', content: toolResults });
      continue;
    }

    // Model is done — persist the assistant turn and send usage
    history.push({ role: 'assistant', content: finalMessage.content });

    log('query_complete', {
      clientId,
      requestId: msg.requestId,
      inputTokens: finalMessage.usage.input_tokens,
      outputTokens: finalMessage.usage.output_tokens,
    });

    send(ws, {
      type: 'response_end',
      requestId: msg.requestId,
      usage: {
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
        cacheReadTokens: finalMessage.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: finalMessage.usage.cache_creation_input_tokens ?? 0,
      },
    });
    break;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sends a JSON message to a WebSocket client if the connection is open.
 * @param {import('ws').WebSocket} ws
 * @param {object} payload
 */
function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

process.on('SIGINT', () => {
  log('server_shutdown');
  for (const { ws } of clients.values()) ws.close(1001, 'Server shutting down');
  httpServer.close(() => process.exit(0));
});
