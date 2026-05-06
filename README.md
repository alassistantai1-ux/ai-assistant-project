# AI Assistant Project

A WebSocket-based AI assistant server powered by Claude. Desktop apps connect via WebSocket and can query the AI, which can also take actions on connected third-party accounts.

## Setup

```bash
npm install
export ANTHROPIC_API_KEY=your_key_here
npm start
```

The server listens on `ws://localhost:8765` (override with `PORT` env var).

## Account Connectors

The server supports connecting external accounts so the AI can take actions on your behalf. Supported connectors:

| Connector | Credentials key | Capabilities |
|-----------|----------------|--------------|
| `google`  | `access_token` (OAuth2) | Gmail read/send, Calendar events, Drive files |
| `github`  | `token` (Personal Access Token) | List repos, issues, create issues, search code |
| `slack`   | `token` (Bot/User OAuth token) | List channels, send messages, read history |
| `notion`  | `token` (Integration secret) | Search, read pages, create pages, list databases |

### Connecting an account (client → server)

```json
{ "type": "connect_account", "requestId": "1", "connector": "github", "credentials": { "token": "ghp_..." } }
```

Server responds:
```json
{ "type": "account_connected", "requestId": "1", "connected": true, "connector": "github" }
```

### Listing available / connected connectors

```json
{ "type": "list_connectors", "requestId": "2" }
```

### Disconnecting an account

```json
{ "type": "disconnect_account", "requestId": "3", "connector": "github" }
```

### Querying the AI (with connected accounts)

Once accounts are connected, the AI automatically has access to tools for those accounts and will use them when relevant:

```json
{ "type": "query", "requestId": "4", "text": "List my open GitHub issues in owner/repo" }
```

The server streams back `response_delta` messages, and may emit `tool_call` events as the AI invokes connectors:

```json
{ "type": "tool_call", "requestId": "4", "tool": "github_list_issues", "input": { "owner": "...", "repo": "...", "state": "open" } }
```

## Message Protocol

### Client → Server

| type | required fields | description |
|------|----------------|-------------|
| `query` | `text` | Ask the AI a question |
| `connect_account` | `connector`, `credentials` | Connect a third-party account |
| `disconnect_account` | `connector` | Disconnect an account |
| `list_connectors` | — | List available and connected accounts |
| `status` | — | Server health + connected account info |
| `pong` | — | Response to server ping |

### Server → Client

| type | fields | description |
|------|--------|-------------|
| `connected` | `clientId` | Sent on connection |
| `response_start` | `requestId` | AI response is beginning |
| `response_delta` | `requestId`, `delta` | Streamed text chunk |
| `tool_call` | `requestId`, `tool`, `input` | AI is calling a connector tool |
| `response_end` | `requestId`, `usage` | AI response finished |
| `account_connected` | `connector` | Account connected successfully |
| `account_disconnected` | `connector` | Account disconnected |
| `connectors_list` | `available`, `connected` | Connector info |
| `status` | `connectedClients`, `uptime`, `connectedAccounts` | Server status |
| `error` | `message` | Error response |
| `ping` | — | Keepalive (respond with `pong`) |
