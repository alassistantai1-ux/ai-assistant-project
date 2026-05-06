'use strict';

const GoogleConnector = require('./google');
const GitHubConnector = require('./github');
const SlackConnector = require('./slack');
const NotionConnector = require('./notion');

const CONNECTORS = {
  google: GoogleConnector,
  github: GitHubConnector,
  slack: SlackConnector,
  notion: NotionConnector,
};

class ConnectorRegistry {
  constructor() {
    // Map of clientId -> { connectorName -> credentials }
    this._accounts = new Map();
  }

  // Returns all connector definitions
  list() {
    return Object.values(CONNECTORS).map((c) => ({
      name: c.name,
      displayName: c.displayName,
      description: c.description,
    }));
  }

  // Connect an account for a client
  connect(clientId, connectorName, credentials) {
    const connector = CONNECTORS[connectorName];
    if (!connector) throw new Error(`Unknown connector: ${connectorName}`);
    connector.validate(credentials);

    if (!this._accounts.has(clientId)) this._accounts.set(clientId, new Map());
    this._accounts.get(clientId).set(connectorName, credentials);
    return { connected: true, connector: connectorName };
  }

  // Disconnect an account for a client
  disconnect(clientId, connectorName) {
    this._accounts.get(clientId)?.delete(connectorName);
    return { disconnected: true, connector: connectorName };
  }

  // List which connectors a client has credentials for
  connectedAccounts(clientId) {
    const accounts = this._accounts.get(clientId);
    if (!accounts) return [];
    return [...accounts.keys()];
  }

  // Get the Claude tool definitions for all connected accounts of a client
  getTools(clientId) {
    const connected = this._accounts.get(clientId);
    if (!connected || connected.size === 0) return [];
    const tools = [];
    for (const name of connected.keys()) {
      const connector = CONNECTORS[name];
      if (connector) tools.push(...connector.tools);
    }
    return tools;
  }

  // Execute a tool call from the Claude AI (called during tool_use handling)
  async executeToolCall(clientId, toolName, params) {
    const connected = this._accounts.get(clientId);
    if (!connected) throw new Error('No connected accounts for this client');

    // Find which connector owns this tool
    for (const [connectorName, credentials] of connected.entries()) {
      const connector = CONNECTORS[connectorName];
      if (connector && connector.tools.some((t) => t.name === toolName)) {
        return connector.execute(toolName, params, credentials);
      }
    }
    throw new Error(`No connected account found for tool: ${toolName}`);
  }

  // Remove all accounts for a disconnected client
  removeClient(clientId) {
    this._accounts.delete(clientId);
  }
}

module.exports = { ConnectorRegistry };
