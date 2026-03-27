/**
 * WebSocket Manager
 * Real-time updates via persistent connections
 */

import WebSocket from 'ws';
import config from './config.js';

/**
 * WebSocket connection states
 */
export const State = {
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  DISCONNECTED: 'DISCONNECTED',
  CLOSED: 'CLOSED'
};

/**
 * EVM WebSocket Client
 */
class EVMWebSocket {
  constructor(chain, options = {}) {
    this.chain = chain;
    this.chainConfig = config[chain];
    
    if (!this.chainConfig) {
      throw new Error(`Unknown chain: ${chain}`);
    }

    this.options = {
      reconnect: true,
      reconnectDelay: 1000,
      maxReconnectDelay: 30000,
      maxReconnectAttempts: 10,
      pingInterval: 30000,
      pongTimeout: 5000,
      ...options
    };

    this.ws = null;
    this.state = State.DISCONNECTED;
    this.subscriptions = new Map();
    this.pendingRequests = new Map();
    this.idCounter = 1;
    this.reconnectAttempts = 0;
    this.pingTimer = null;
    this.pongTimer = null;
    this.listeners = new Map();
    this.currentWsIndex = 0;
  }

  /**
   * Connect to WebSocket
   */
  async connect() {
    if (this.state === State.CONNECTED || this.state === State.CONNECTING) {
      return;
    }

    this.state = State.CONNECTING;
    
    const wsConfig = this.chainConfig.websockets?.[this.currentWsIndex];
    if (!wsConfig) {
      throw new Error(`No WebSocket endpoints for ${this.chain}`);
    }

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsConfig.url);

        this.ws.on('open', () => {
          this.state = State.CONNECTED;
          this.reconnectAttempts = 0;
          this._startPing();
          this._emit('connected', { url: wsConfig.url });
          resolve();
        });

        this.ws.on('message', (data) => {
          this._handleMessage(data.toString());
        });

        this.ws.on('close', (code, reason) => {
          this._handleClose(code, reason?.toString());
        });

        this.ws.on('error', (error) => {
          this._emit('error', error);
          if (this.state === State.CONNECTING) {
            reject(error);
          }
        });

        this.ws.on('pong', () => {
          if (this.pongTimer) {
            clearTimeout(this.pongTimer);
            this.pongTimer = null;
          }
        });

      } catch (error) {
        this.state = State.DISCONNECTED;
        reject(error);
      }
    });
  }

  /**
   * Handle incoming message
   */
  _handleMessage(data) {
    try {
      const json = JSON.parse(data);

      // Subscription notification
      if (json.method === 'eth_subscription') {
        const subId = json.params?.subscription;
        const sub = this.subscriptions.get(subId);
        if (sub && sub.callback) {
          sub.callback(json.params.result, json.params);
        }
        this._emit('subscription', json.params);
        return;
      }

      // Response to request
      if (json.id) {
        const pending = this.pendingRequests.get(json.id);
        if (pending) {
          this.pendingRequests.delete(json.id);
          if (json.error) {
            pending.reject(new Error(json.error.message));
          } else {
            pending.resolve(json.result);
          }
        }
      }

    } catch (error) {
      this._emit('error', new Error('Invalid JSON message'));
    }
  }

  /**
   * Handle connection close
   */
  _handleClose(code, reason) {
    this._stopPing();
    this.state = State.DISCONNECTED;
    this._emit('disconnected', { code, reason });

    // Reject pending requests
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();

    // Reconnect if enabled
    if (this.options.reconnect && this.reconnectAttempts < this.options.maxReconnectAttempts) {
      this._reconnect();
    } else {
      this.state = State.CLOSED;
      this._emit('closed');
    }
  }

  /**
   * Reconnect with backoff
   */
  async _reconnect() {
    this.state = State.RECONNECTING;
    this.reconnectAttempts++;

    const delay = Math.min(
      this.options.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.options.maxReconnectDelay
    );

    this._emit('reconnecting', { attempt: this.reconnectAttempts, delay });

    await new Promise(r => setTimeout(r, delay));

    // Try next WebSocket endpoint
    if (this.chainConfig.websockets?.length > 1) {
      this.currentWsIndex = (this.currentWsIndex + 1) % this.chainConfig.websockets.length;
    }

    try {
      await this.connect();
      // Resubscribe
      await this._resubscribe();
    } catch (error) {
      // Will trigger another reconnect via close handler
    }
  }

  /**
   * Resubscribe after reconnect
   */
  async _resubscribe() {
    const subs = [...this.subscriptions.values()];
    this.subscriptions.clear();

    for (const sub of subs) {
      try {
        await this.subscribe(sub.type, sub.params, sub.callback);
      } catch (error) {
        this._emit('error', new Error(`Resubscribe failed: ${error.message}`));
      }
    }
  }

  /**
   * Start ping/pong heartbeat
   */
  _startPing() {
    this._stopPing();
    
    this.pingTimer = setInterval(() => {
      if (this.ws && this.state === State.CONNECTED) {
        this.ws.ping();
        
        // Set pong timeout
        this.pongTimer = setTimeout(() => {
          this._emit('error', new Error('Pong timeout'));
          this.ws?.terminate();
        }, this.options.pongTimeout);
      }
    }, this.options.pingInterval);
  }

  /**
   * Stop ping/pong
   */
  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /**
   * Send JSON-RPC request
   */
  async request(method, params = []) {
    if (this.state !== State.CONNECTED) {
      throw new Error('WebSocket not connected');
    }

    const id = this.idCounter++;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params
      }));
    });
  }

  /**
   * Subscribe to events
   */
  async subscribe(type, params = [], callback) {
    const subParams = [type];
    if (params && Object.keys(params).length > 0) {
      subParams.push(params);
    }

    const subId = await this.request('eth_subscribe', subParams);

    this.subscriptions.set(subId, {
      id: subId,
      type,
      params,
      callback
    });

    return subId;
  }

  /**
   * Subscribe to new blocks
   */
  async subscribeNewHeads(callback) {
    return this.subscribe('newHeads', {}, callback);
  }

  /**
   * Subscribe to pending transactions
   */
  async subscribePendingTx(callback) {
    return this.subscribe('newPendingTransactions', {}, callback);
  }

  /**
   * Subscribe to logs
   */
  async subscribeLogs(filter, callback) {
    return this.subscribe('logs', filter, callback);
  }

  /**
   * Unsubscribe
   */
  async unsubscribe(subId) {
    const result = await this.request('eth_unsubscribe', [subId]);
    this.subscriptions.delete(subId);
    return result;
  }

  /**
   * Unsubscribe all
   */
  async unsubscribeAll() {
    for (const subId of this.subscriptions.keys()) {
      try {
        await this.unsubscribe(subId);
      } catch (e) {
        // Ignore
      }
    }
  }

  /**
   * Event listener
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  /**
   * Remove event listener
   */
  off(event, callback) {
    const list = this.listeners.get(event);
    if (list) {
      const idx = list.indexOf(callback);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
    }
  }

  /**
   * Emit event
   */
  _emit(event, data) {
    const list = this.listeners.get(event);
    if (list) {
      list.forEach(cb => cb(data));
    }
  }

  /**
   * Close connection
   */
  close() {
    this.options.reconnect = false;
    this._stopPing();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.state = State.CLOSED;
    this.subscriptions.clear();
    this.pendingRequests.clear();
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      state: this.state,
      chain: this.chain,
      subscriptions: this.subscriptions.size,
      pendingRequests: this.pendingRequests.size,
      reconnectAttempts: this.reconnectAttempts,
      currentEndpoint: this.chainConfig.websockets?.[this.currentWsIndex]?.name
    };
  }
}

/**
 * Solana WebSocket Client
 */
class SolanaWebSocket {
  constructor(options = {}) {
    this.chain = 'solana';
    this.chainConfig = config.solana;
    
    this.options = {
      reconnect: true,
      reconnectDelay: 1000,
      maxReconnectDelay: 30000,
      maxReconnectAttempts: 10,
      commitment: 'confirmed',
      ...options
    };

    this.ws = null;
    this.state = State.DISCONNECTED;
    this.subscriptions = new Map();
    this.pendingRequests = new Map();
    this.idCounter = 1;
    this.reconnectAttempts = 0;
    this.listeners = new Map();
    this.currentWsIndex = 0;
  }

  /**
   * Connect to WebSocket
   */
  async connect() {
    if (this.state === State.CONNECTED || this.state === State.CONNECTING) {
      return;
    }

    this.state = State.CONNECTING;
    
    const wsConfig = this.chainConfig.websockets?.[this.currentWsIndex];
    if (!wsConfig) {
      throw new Error('No WebSocket endpoints for Solana');
    }

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsConfig.url);

        this.ws.on('open', () => {
          this.state = State.CONNECTED;
          this.reconnectAttempts = 0;
          this._emit('connected', { url: wsConfig.url });
          resolve();
        });

        this.ws.on('message', (data) => {
          this._handleMessage(data.toString());
        });

        this.ws.on('close', (code, reason) => {
          this._handleClose(code, reason?.toString());
        });

        this.ws.on('error', (error) => {
          this._emit('error', error);
          if (this.state === State.CONNECTING) {
            reject(error);
          }
        });

      } catch (error) {
        this.state = State.DISCONNECTED;
        reject(error);
      }
    });
  }

  /**
   * Handle incoming message
   */
  _handleMessage(data) {
    try {
      const json = JSON.parse(data);

      // Subscription notification
      if (json.method) {
        const subId = json.params?.subscription;
        const sub = this.subscriptions.get(subId);
        if (sub && sub.callback) {
          sub.callback(json.params.result, json.params);
        }
        this._emit('subscription', json.params);
        return;
      }

      // Response to request
      if (json.id !== undefined) {
        const pending = this.pendingRequests.get(json.id);
        if (pending) {
          this.pendingRequests.delete(json.id);
          if (json.error) {
            pending.reject(new Error(json.error.message));
          } else {
            pending.resolve(json.result);
          }
        }
      }

    } catch (error) {
      this._emit('error', new Error('Invalid JSON message'));
    }
  }

  /**
   * Handle connection close
   */
  _handleClose(code, reason) {
    this.state = State.DISCONNECTED;
    this._emit('disconnected', { code, reason });

    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();

    if (this.options.reconnect && this.reconnectAttempts < this.options.maxReconnectAttempts) {
      this._reconnect();
    } else {
      this.state = State.CLOSED;
      this._emit('closed');
    }
  }

  /**
   * Reconnect with backoff
   */
  async _reconnect() {
    this.state = State.RECONNECTING;
    this.reconnectAttempts++;

    const delay = Math.min(
      this.options.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.options.maxReconnectDelay
    );

    this._emit('reconnecting', { attempt: this.reconnectAttempts, delay });

    await new Promise(r => setTimeout(r, delay));

    if (this.chainConfig.websockets?.length > 1) {
      this.currentWsIndex = (this.currentWsIndex + 1) % this.chainConfig.websockets.length;
    }

    try {
      await this.connect();
    } catch (error) {
      // Will trigger another reconnect
    }
  }

  /**
   * Send JSON-RPC request
   */
  async request(method, params = []) {
    if (this.state !== State.CONNECTED) {
      throw new Error('WebSocket not connected');
    }

    const id = this.idCounter++;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params
      }));
    });
  }

  /**
   * Subscribe to account changes
   */
  async subscribeAccount(pubkey, callback) {
    const subId = await this.request('accountSubscribe', [
      pubkey,
      { encoding: 'jsonParsed', commitment: this.options.commitment }
    ]);

    this.subscriptions.set(subId, {
      id: subId,
      type: 'account',
      pubkey,
      callback
    });

    return subId;
  }

  /**
   * Subscribe to slot changes
   */
  async subscribeSlot(callback) {
    const subId = await this.request('slotSubscribe', []);

    this.subscriptions.set(subId, {
      id: subId,
      type: 'slot',
      callback
    });

    return subId;
  }

  /**
   * Subscribe to logs
   */
  async subscribeLogs(filter, callback) {
    const subId = await this.request('logsSubscribe', [
      filter,
      { commitment: this.options.commitment }
    ]);

    this.subscriptions.set(subId, {
      id: subId,
      type: 'logs',
      filter,
      callback
    });

    return subId;
  }

  /**
   * Unsubscribe
   */
  async unsubscribe(subId) {
    const sub = this.subscriptions.get(subId);
    if (!sub) return false;

    let method;
    switch (sub.type) {
      case 'account':
        method = 'accountUnsubscribe';
        break;
      case 'slot':
        method = 'slotUnsubscribe';
        break;
      case 'logs':
        method = 'logsUnsubscribe';
        break;
      default:
        method = 'unsubscribe';
    }

    const result = await this.request(method, [subId]);
    this.subscriptions.delete(subId);
    return result;
  }

  /**
   * Event listener
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  /**
   * Emit event
   */
  _emit(event, data) {
    const list = this.listeners.get(event);
    if (list) {
      list.forEach(cb => cb(data));
    }
  }

  /**
   * Close connection
   */
  close() {
    this.options.reconnect = false;
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.state = State.CLOSED;
    this.subscriptions.clear();
    this.pendingRequests.clear();
  }

  /**
   * Get status
   */
  getStatus() {
    return {
      state: this.state,
      chain: 'solana',
      subscriptions: this.subscriptions.size,
      pendingRequests: this.pendingRequests.size,
      reconnectAttempts: this.reconnectAttempts
    };
  }
}

/**
 * Factory functions
 */
export function createWebSocket(chain, options) {
  if (chain === 'solana') {
    return new SolanaWebSocket(options);
  }
  return new EVMWebSocket(chain, options);
}

export { EVMWebSocket, SolanaWebSocket };
export default { createWebSocket, EVMWebSocket, SolanaWebSocket, State };