'use strict';

const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk').default;
const { ConnectorRegistry } = require('./connectors');

const PORT = process.env.PORT || 8765;
const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT =
  'You are a helpful AI assistant embedded in a desktop application. ' +
  'Provide clear, concise, and accurate answers. ' +
  'When the user asks you to perform actions on their connected accounts (email, calendar, GitHub, Slack, Notion, etc.), ' +
  'use the available tools to do so. Always confirm what you did after completing an action. ' +
  'Format responses in plain text unless the user requests structured output.';

const anthropic = new Anthropic();
const registry = new ConnectorRegistry();

const wss = new WebSocketServer({ port: PORT });
const clients = new Map();

wss.on('listening', () => {
  console.log(`AI Assistant WebSocket server listening on ws://localhost:${PORT}`);
});

wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  const remoteAddress = req.socket.remoteAddress;

  clients.set(clientId, { ws, connectedAt: new Date() });
  console.log(`Desktop app connected [${clientId}] from ${remoteAddress}. Total clients: ${clients.size}`);

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
    console.log(`Desktop app disconnected [${clientId}] code=${code}. Total clients: ${clients.size}`);
  });

  ws.on('error', (err) => {
    console.error(`Client error [${clientId}]:`, err.message);
  });
});

function handleMessage(ws, clientId, msg) {
  switch (msg.type) {
    case 'pong':
      break;

    case 'query':
      if (!msg.text) {
        send(ws, { type: 'error', requestId: msg.requestId, message: 'Missing text field' });
        return;
      }
      console.log(`Query from [${clientId}]: ${msg.text}`);
      handleQuery(ws, clientId, msg).catch((err) => {
        console.error(`Query error [${clientId}]:`, err.message);
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
        console.log(`Account connected [${clientId}]: ${msg.connector}`);
        send(ws, { type: 'account_connected', requestId: msg.requestId, ...result });
      } catch (err) {
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
      console.log(`Account disconnected [${clientId}]: ${msg.connector}`);
      send(ws, { type: 'account_disconnected', requestId: msg.requestId, ...result });
      break;
    }

    case 'list_connectors':
      send(ws, {
        type: 'connectors_list',
        requestId: msg.requestId,
        available: registry.list(),
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
      });
      break;

    default:
      send(ws, { type: 'error', requestId: msg.requestId, message: `Unknown message type: ${msg.type}` });
  }
}

async function handleQuery(ws, clientId, msg) {
  send(ws, { type: 'response_start', requestId: msg.requestId });

  const tools = registry.getTools(clientId);
  const messages = [{ role: 'user', content: msg.text }];

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
      messages,
    };

    if (tools.length > 0) requestParams.tools = tools;

    // If tools are available, allow Claude to decide when to stop
    if (tools.length > 0) requestParams.tool_choice = { type: 'auto' };

    let finalMessage;

    if (msg.stream !== false && tools.length === 0) {
      // Pure streaming path (no tools)
      const stream = anthropic.messages.stream(requestParams);

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          send(ws, { type: 'response_delta', requestId: msg.requestId, delta: event.delta.text });
        }
      }
      finalMessage = await stream.finalMessage();
    } else {
      // Non-streaming path (needed for tool_use to inspect content blocks)
      finalMessage = await anthropic.messages.create(requestParams);

      // Stream text blocks to the client as deltas
      for (const block of finalMessage.content) {
        if (block.type === 'text') {
          send(ws, { type: 'response_delta', requestId: msg.requestId, delta: block.text });
        }
      }
    }

    // If the model wants to use tools, execute them and continue the loop
    if (finalMessage.stop_reason === 'tool_use') {
      const toolUseBlocks = finalMessage.content.filter((b) => b.type === 'tool_use');

      // Add the assistant turn with all content blocks
      messages.push({ role: 'assistant', content: finalMessage.content });

      // Execute each tool call and collect results
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          console.log(`Tool call [${clientId}]: ${block.name}`, block.input);
          send(ws, {
            type: 'tool_call',
            requestId: msg.requestId,
            tool: block.name,
            input: block.input,
          });
          try {
            const result = await registry.executeToolCall(clientId, block.name, block.input);
            console.log(`Tool result [${clientId}]: ${block.name} OK`);
            return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) };
          } catch (err) {
            console.error(`Tool error [${clientId}]: ${block.name}`, err.message);
            return {
              type: 'tool_result',
              tool_use_id: block.id,
              is_error: true,
              content: err.message,
            };
          }
        }),
      );

      // Add tool results and continue the loop
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Model is done — send usage and exit loop
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

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  for (const { ws } of clients.values()) ws.close(1001, 'Server shutting down');
  wss.close(() => process.exit(0));
});
