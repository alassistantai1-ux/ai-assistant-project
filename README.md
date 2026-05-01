# ai-assistant-project

AI assistant backend with WebSocket connectivity for desktop apps.

## Setup

```bash
npm install
```

## Running the server

```bash
npm start
```

The server listens on `ws://localhost:8765` by default. Override with the `PORT` environment variable.

## Connecting from a desktop app

```js
const { DesktopAppConnector } = require('./src/client');

const connector = new DesktopAppConnector();
await connector.connect();

const reply = await connector.query('What is the weather today?');
console.log(reply);

connector.disconnect();
```

## Message protocol

All messages are JSON objects with a `type` field.

### Client → Server

| type | fields | description |
|------|--------|-------------|
| `query` | `text`, `requestId` | Send a question to the assistant |
| `status` | `requestId` | Request server status |
| `pong` | — | Heartbeat reply |

### Server → Client

| type | fields | description |
|------|--------|-------------|
| `connected` | `clientId` | Sent on successful connection |
| `response` | `text`, `requestId` | Assistant reply to a query |
| `status` | `connectedClients`, `uptime`, `requestId` | Server status |
| `ping` | — | Heartbeat (reply with `pong`) |
| `error` | `message`, `requestId` | Error details |
