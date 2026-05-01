const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk').default;

const PORT = process.env.PORT || 8765;
const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT =
  'You are a helpful AI assistant embedded in a desktop application. ' +
  'Provide clear, concise, and accurate answers. ' +
  'Format responses in plain text unless the user requests structured output.';

const anthropic = new Anthropic();

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
    if (ws.readyState === ws.OPEN) {
      send(ws, { type: 'ping' });
    }
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

    case 'query': {
      if (!msg.text) {
        send(ws, { type: 'error', requestId: msg.requestId, message: 'Missing text field' });
        return;
      }
      console.log(`Query from [${clientId}]: ${msg.text}`);
      handleQuery(ws, msg).catch((err) => {
        console.error(`Query error [${clientId}]:`, err.message);
        send(ws, { type: 'error', requestId: msg.requestId, message: 'AI request failed' });
      });
      break;
    }

    case 'status':
      send(ws, {
        type: 'status',
        requestId: msg.requestId,
        connectedClients: clients.size,
        uptime: process.uptime(),
      });
      break;

    default:
      send(ws, { type: 'error', requestId: msg.requestId, message: `Unknown message type: ${msg.type}` });
  }
}

async function handleQuery(ws, msg) {
  // Signal stream start
  send(ws, { type: 'response_start', requestId: msg.requestId });

  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        // Cache the system prompt — it never changes between requests
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: msg.text }],
  });

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      send(ws, {
        type: 'response_delta',
        requestId: msg.requestId,
        delta: event.delta.text,
      });
    }
  }

  const finalMessage = await stream.finalMessage();

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
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  for (const { ws } of clients.values()) {
    ws.close(1001, 'Server shutting down');
  }
  wss.close(() => process.exit(0));
});
