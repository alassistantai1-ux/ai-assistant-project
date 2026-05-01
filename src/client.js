const { WebSocket } = require('ws');

const DEFAULT_URL = `ws://localhost:${process.env.PORT || 8765}`;
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 5;

class DesktopAppConnector {
  constructor(url = DEFAULT_URL) {
    this.url = url;
    this.ws = null;
    this.clientId = null;
    this.pendingRequests = new Map();
    this.reconnectAttempts = 0;
    this._onResponse = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      console.log(`Connecting to AI Assistant at ${this.url}...`);
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        console.log('Connection established, waiting for server handshake...');
      });

      this.ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        this._handleMessage(msg, resolve);
      });

      this.ws.on('error', (err) => {
        console.error('Connection error:', err.message);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`Disconnected (code=${code}). Attempting reconnect...`);
        this._scheduleReconnect();
      });
    });
  }

  _handleMessage(msg, connectResolve) {
    switch (msg.type) {
      case 'connected':
        this.clientId = msg.clientId;
        console.log(`Ready. Client ID: ${this.clientId}`);
        if (connectResolve) connectResolve(this);
        break;

      case 'response_start':
        // Server is beginning a streamed AI response
        this._streamBuffers = this._streamBuffers || new Map();
        this._streamBuffers.set(msg.requestId, '');
        break;

      case 'response_delta': {
        if (this._streamBuffers && this._streamBuffers.has(msg.requestId)) {
          this._streamBuffers.set(
            msg.requestId,
            this._streamBuffers.get(msg.requestId) + msg.delta,
          );
        }
        if (this._onDelta) this._onDelta(msg.requestId, msg.delta);
        break;
      }

      case 'response_end': {
        const fullText = this._streamBuffers && this._streamBuffers.get(msg.requestId);
        if (this._streamBuffers) this._streamBuffers.delete(msg.requestId);
        const resolver = this.pendingRequests.get(msg.requestId);
        if (resolver) {
          resolver(fullText || '');
          this.pendingRequests.delete(msg.requestId);
        }
        if (this._onResponse) this._onResponse({ ...msg, text: fullText });
        break;
      }

      case 'ping':
        this._send({ type: 'pong' });
        break;

      case 'error': {
        console.error('Server error:', msg.message);
        const errResolver = this.pendingRequests.get(msg.requestId);
        if (errResolver) {
          this.pendingRequests.delete(msg.requestId);
          // Reject by calling resolver with null; callers can check for null
          errResolver(null);
        }
        break;
      }

      case 'status':
        if (this._onResponse) this._onResponse(msg);
        break;
    }
  }

  // Register a handler called for each streamed token delta
  onDelta(handler) {
    this._onDelta = handler;
  }

  query(text) {
    const requestId = String(Date.now());
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, resolve);
      const ok = this._send({ type: 'query', requestId, text });
      if (!ok) {
        this.pendingRequests.delete(requestId);
        reject(new Error('Not connected'));
      }
    });
  }

  getStatus() {
    const requestId = String(Date.now());
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, resolve);
      const ok = this._send({ type: 'status', requestId });
      if (!ok) {
        this.pendingRequests.delete(requestId);
        reject(new Error('Not connected'));
      }
    });
  }

  onResponse(handler) {
    this._onResponse = handler;
  }

  _send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error('Max reconnect attempts reached. Giving up.');
      return;
    }
    this.reconnectAttempts++;
    const delay = RECONNECT_DELAY_MS * this.reconnectAttempts;
    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    setTimeout(() => this.connect().catch(() => {}), delay);
  }

  disconnect() {
    if (this.ws) {
      this.ws.removeAllListeners('close');
      this.ws.close(1000, 'Client disconnecting');
      this.ws = null;
    }
  }
}

module.exports = { DesktopAppConnector };

// Self-test when run directly
if (require.main === module) {
  (async () => {
    const connector = new DesktopAppConnector();
    try {
      await connector.connect();
      const reply = await connector.query('Hello from desktop app!');
      console.log('Response:', reply);
      connector.disconnect();
    } catch (err) {
      console.error('Failed:', err.message);
      process.exit(1);
    }
  })();
}
