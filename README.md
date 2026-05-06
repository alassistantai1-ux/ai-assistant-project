# AI Assistant Project

![Node](https://img.shields.io/badge/node-%3E%3D20-green?logo=node.js)
![License](https://img.shields.io/badge/license-MIT-blue)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

A monorepo containing two production-ready applications:

1. **AidWatch** — A humanitarian aid accountability search engine tracking fraud, corruption, and misconduct in the aid sector.
2. **AI Assistant Server** — A WebSocket-based AI agent powered by Claude, with connectors for Google, GitHub, Slack, Notion, and Jira.

---

## Architecture

```
ai-assistant-project/
│
├── aidwatch/                   # AidWatch Express API + SPA frontend
│   ├── server.js               # REST API (Express + Helmet + rate-limit)
│   ├── public/index.html       # Single-page frontend (no build step)
│   ├── data/cases.json         # 50 documented cases + 48 organizations
│   ├── tests/api.test.js       # Jest + Supertest API tests
│   ├── Dockerfile              # Production container
│   └── package.json
│
├── src/                        # AI Assistant WebSocket server
│   ├── server.js               # WS server + HTTP server (serves public/)
│   └── connectors/
│       ├── index.js            # ConnectorRegistry
│       ├── google.js           # Gmail, Calendar, Drive (with OAuth refresh)
│       ├── github.js           # Repos, Issues, Code search
│       ├── slack.js            # Channels, Messages, Users
│       ├── notion.js           # Pages, Databases
│       └── jira.js             # Issues, JQL search
│
├── public/index.html           # Web chat UI (served by src/server.js)
│
├── .env.example                # Environment variable documentation
├── .eslintrc.js                # ESLint configuration
├── .github/workflows/ci.yml    # GitHub Actions CI
└── package.json                # Root scripts
```

**Data flow:**

```
Browser  ──WebSocket──►  src/server.js  ──tool_use──►  ConnectorRegistry
                              │                              │
                              └──► Anthropic Claude API      └──► Google / GitHub / Slack / Notion / Jira

Browser  ──HTTP──►  aidwatch/server.js  ──reads──►  data/cases.json
```

---

## Quick Start

### Prerequisites

- Node.js >= 20
- An [Anthropic API key](https://console.anthropic.com)

### 1. Clone & install

```bash
git clone https://github.com/alassistantai1-ux/ai-assistant-project.git
cd ai-assistant-project
npm install           # installs root deps
cd aidwatch && npm install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — at minimum set ANTHROPIC_API_KEY
```

### 3. Run

```bash
# Start both servers
npm run dev

# Or individually:
npm run start:aidwatch    # AidWatch on http://localhost:3000
npm run start:server      # AI Assistant on http://localhost:8765

# Run tests
npm test
```

---

## AidWatch

### Overview

AidWatch is a public-interest accountability tool that aggregates documented cases of fraud, corruption, sexual exploitation, procurement violations, and sanctions breaches across humanitarian and development aid organizations.

**50 real, documented cases** sourced from:
- World Bank Integrity Vice Presidency (INT)
- USAID Office of Inspector General (OIG)
- UN Office of Internal Oversight Services (OIOS)
- Global Fund Inspector General
- UNODC / EU OLAF reports
- Investigative journalism (The Guardian, Reuters, AP)

### Quick Start

```bash
cd aidwatch
npm install
npm start       # http://localhost:3000
```

For development with auto-reload:
```bash
npm run dev
```

### API Reference

All endpoints return `{ success: boolean, data?: any, error?: string }`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server health + case count |
| `GET` | `/api/search` | Full-text search with filters |
| `GET` | `/api/cases/:id` | Case detail + related cases |
| `GET` | `/api/org/:id` | Organization profile + cases |
| `GET` | `/api/stats` | Aggregate statistics |
| `GET` | `/api/sources` | Data source descriptions |
| `GET` | `/api/external/worldbank` | Live World Bank debarment list |
| `GET` | `/api/external/opensanctions` | Live OpenSanctions data |
| `GET` | `/api/external/gdelt` | Live GDELT media coverage |
| `GET` | `/api/external/wikipedia` | Wikipedia summaries |
| `GET` | `/api/everything` | Aggregated live search across all sources |

#### `/api/search` parameters

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Full-text search query |
| `type` | string | Case type filter (fraud, corruption, sea, procurement, sanctions, diversion, mismanagement, default) |
| `region` | string | Region filter (Africa, Asia, Middle East, Latin America, Global, etc.) |
| `sourceType` | string | Source type filter (UN, INGO, Government, Multilateral) |
| `status` | string | Status filter (ongoing, resolved, debarred, referred, settled, inconclusive) |
| `severity` | string | Severity filter (critical, high, medium) |
| `yearFrom` | number | Earliest year |
| `yearTo` | number | Latest year |
| `sort` | string | relevance, newest, oldest, amount, severity |
| `page` | number | Page number (default: 1) |
| `limit` | number | Results per page (default: 20, max: 50) |

#### Example

```bash
curl "http://localhost:3000/api/search?q=procurement+fraud&region=Africa&severity=critical&sort=amount"
```

### Severity Logic

| Severity | Criteria |
|----------|----------|
| **Critical** | SEA cases, or amount >= $50M, or debarment actions |
| **High** | Amount >= $10M, or corruption/sanctions types |
| **Medium** | Everything else |

### Docker

```bash
cd aidwatch
docker build -t aidwatch .
docker run -p 3000:3000 aidwatch
```

---

## AI Assistant Server

### Overview

A WebSocket server that wraps Claude with account connectors, enabling an agentic AI that can read email, manage calendars, create GitHub issues, send Slack messages, and query Jira — all from a single chat interface.

Features:
- **Streaming responses** via the Anthropic Messages API
- **Agentic tool-use loop** — Claude calls tools and continues until the task is complete
- **Per-session conversation history** (capped at 20 turns)
- **Structured JSON logging** to stdout
- **Web chat UI** served at `http://localhost:8765`

### Quick Start

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... node src/server.js
# Open http://localhost:8765 in your browser
```

### Connectors

| Connector | Tools | Required Credentials |
|-----------|-------|---------------------|
| **Google** | List emails, Send email, List/Create calendar events, List Drive files | `access_token` (+ `refresh_token`, `client_id`, `client_secret` for auto-refresh) |
| **GitHub** | List repos, List/Create issues, Get repo, Search code | `token` (Personal Access Token) |
| **Slack** | List channels, Send message, Get channel history, Get user info | `token` (Bot OAuth Token `xoxb-...`) |
| **Notion** | Search, Get page, Create page, List databases | `token` (Integration Secret) |
| **Jira** | List issues, Search by JQL, Get issue details | `host`, `email`, `apiToken` |

### WebSocket Protocol

Connect to `ws://localhost:8765`. Messages are JSON.

#### Client -> Server

| `type` | Fields | Description |
|--------|--------|-------------|
| `query` | `text`, `requestId`, `stream?` | Send a query to Claude |
| `connect_account` | `connector`, `credentials`, `requestId` | Connect an account |
| `disconnect_account` | `connector`, `requestId` | Disconnect an account |
| `list_connectors` | `requestId` | List all connectors + connection status |
| `new_conversation` | `requestId` | Clear conversation history |
| `status` | `requestId` | Get server status |
| `pong` | — | Heartbeat response |

#### Server -> Client

| `type` | Fields | Description |
|--------|--------|-------------|
| `connected` | `clientId` | Connection established |
| `response_start` | `requestId` | Response beginning |
| `response_delta` | `requestId`, `delta` | Streaming text chunk |
| `tool_call` | `requestId`, `tool`, `input` | Claude is calling a tool |
| `response_end` | `requestId`, `usage` | Response complete with token usage |
| `account_connected` | `connector` | Account connected successfully |
| `account_disconnected` | `connector` | Account disconnected |
| `connectors_list` | `available`, `connected` | Connector metadata |
| `conversation_cleared` | — | History cleared |
| `error` | `message` | Error occurred |
| `ping` | — | Heartbeat |

#### Example session

```js
const ws = new WebSocket('ws://localhost:8765');

ws.onopen = () => {
  // Connect a GitHub account
  ws.send(JSON.stringify({
    type: 'connect_account',
    connector: 'github',
    credentials: { token: 'ghp_...' },
    requestId: 'r1',
  }));

  // Ask Claude to do something with it
  ws.send(JSON.stringify({
    type: 'query',
    text: 'List my last 5 repos',
    requestId: 'r2',
  }));
};
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | **Required.** Anthropic API key |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Model ID to use |
| `PORT` | `8765` | AI Assistant server port |
| `AIDWATCH_PORT` | `3000` | AidWatch server port |
| `CORS_ORIGIN` | `*` | AidWatch allowed CORS origin |
| `GOOGLE_ACCESS_TOKEN` | — | Google OAuth2 access token |
| `GOOGLE_REFRESH_TOKEN` | — | Google OAuth2 refresh token |
| `GOOGLE_CLIENT_ID` | — | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | — | Google OAuth2 client secret |
| `GITHUB_TOKEN` | — | GitHub personal access token |
| `SLACK_TOKEN` | — | Slack Bot OAuth token |
| `NOTION_TOKEN` | — | Notion integration secret |
| `JIRA_HOST` | — | Jira cloud hostname |
| `JIRA_EMAIL` | — | Jira account email |
| `JIRA_API_TOKEN` | — | Jira API token |

---

## Testing

```bash
# AidWatch API tests (Jest + Supertest)
cd aidwatch && npm test

# Lint everything
npx eslint src/ aidwatch/server.js --ext .js
```

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes and add tests
4. Ensure lint passes: `npx eslint src/ aidwatch/server.js`
5. Open a pull request

Please follow the existing code style (single quotes, `'use strict'`, JSDoc on public functions).

---

## License

MIT (c) 2024 AI Assistant Project contributors
