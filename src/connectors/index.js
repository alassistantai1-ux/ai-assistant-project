'use strict';

const GoogleConnector = require('./google');
const GitHubConnector = require('./github');
const SlackConnector = require('./slack');
const NotionConnector = require('./notion');
const JiraConnector = require('./jira');
const TeamsConnector = require('./teams');

const CONNECTORS = {
  google: GoogleConnector,
  github: GitHubConnector,
  slack: SlackConnector,
  notion: NotionConnector,
  jira: JiraConnector,
  teams: TeamsConnector,
};

class ConnectorRegistry {
  constructor() {
    /** @type {Map<string, Map<string, object>>} clientId -> connectorName -> credentials */
    this._accounts = new Map();
  }

  /**
   * Returns all registered connector definitions with their connection status for a client.
   * @param {string} [clientId] - Optional client ID to include connected status
   * @returns {Array<{name, displayName, description, connected}>}
   */
  list(clientId) {
    const connected = clientId ? (this._accounts.get(clientId) || new Map()) : new Map();
    return Object.values(CONNECTORS).map((c) => ({
      name: c.name,
      displayName: c.displayName,
      description: c.description,
      connected: connected.has(c.name),
    }));
  }

  /**
   * Connects an account for a client by validating and storing credentials.
   * @param {string} clientId
   * @param {string} connectorName
   * @param {object} credentials
   * @returns {{ connected: boolean, connector: string }}
   */
  connect(clientId, connectorName, credentials) {
    const connector = CONNECTORS[connectorName];
    if (!connector) throw new Error(`Unknown connector: ${connectorName}`);
    connector.validate(credentials);

    if (!this._accounts.has(clientId)) this._accounts.set(clientId, new Map());
    this._accounts.get(clientId).set(connectorName, credentials);
    return { connected: true, connector: connectorName };
  }

  /**
   * Disconnects an account for a client.
   * @param {string} clientId
   * @param {string} connectorName
   * @returns {{ disconnected: boolean, connector: string }}
   */
  disconnect(clientId, connectorName) {
    this._accounts.get(clientId)?.delete(connectorName);
    return { disconnected: true, connector: connectorName };
  }

  /**
   * Returns the list of connector names the client has credentials for.
   * @param {string} clientId
   * @returns {string[]}
   */
  connectedAccounts(clientId) {
    const accounts = this._accounts.get(clientId);
    if (!accounts) return [];
    return [...accounts.keys()];
  }

  /**
   * Returns Claude tool definitions for all connected accounts of a client.
   * @param {string} clientId
   * @returns {Array<object>}
   */
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

  /**
   * Executes a tool call from the Claude AI.
   * @param {string} clientId
   * @param {string} toolName
   * @param {object} params
   * @returns {Promise<object>}
   */
  async executeToolCall(clientId, toolName, params) {
    const connected = this._accounts.get(clientId);
    if (!connected) throw new Error('No connected accounts for this client');

    for (const [connectorName, credentials] of connected.entries()) {
      const connector = CONNECTORS[connectorName];
      if (connector && connector.tools.some((t) => t.name === toolName)) {
        return connector.execute(toolName, params, credentials);
      }
    }
    throw new Error(`No connected account found for tool: ${toolName}`);
  }

  /**
   * Removes all accounts for a disconnected client.
   * @param {string} clientId
   */
  removeClient(clientId) {
    this._accounts.delete(clientId);
  }
}

module.exports = { ConnectorRegistry };
