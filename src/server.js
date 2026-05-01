const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8765;

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

  ws.on('close', (code, reason) => {
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
      // Placeholder: replace with real AI model call
      send(ws, {
        type: 'response',
        requestId: msg.requestId,
        text: `Echo: ${msg.text}`,
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
