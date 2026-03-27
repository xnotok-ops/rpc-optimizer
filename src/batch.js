/**
 * Request Batching Module
 * Combine multiple RPC calls into single HTTP request
 */

import http from 'http';
import https from 'https';
import { getPool } from './pool.js';

class BatchRequest {
  constructor(rpcUrl, options = {}) {
    this.rpcUrl = rpcUrl;
    this.pool = getPool();
    this.options = {
      maxBatchSize: 100,
      timeout: 30000,
      autoFlush: true,
      flushInterval: 50,
      ...options
    };

    this.queue = [];
    this.pending = new Map();
    this.idCounter = 1;
    this.flushTimer = null;
  }

  add(method, params = []) {
    return new Promise((resolve, reject) => {
      const id = this.idCounter++;
      
      this.queue.push({
        jsonrpc: '2.0',
        id,
        method,
        params
      });

      this.pending.set(id, { resolve, reject });

      if (this.queue.length >= this.options.maxBatchSize) {
        this.flush();
      } else if (this.options.autoFlush && !this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flush();
        }, this.options.flushInterval);
      }
    });
  }

  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.queue.length === 0) {
      return { success: true, results: [], count: 0 };
    }

    const batch = [...this.queue];
    const pendingCopy = new Map(this.pending);
    this.queue = [];
    this.pending.clear();

    const startTime = performance.now();

    try {
      const responses = await this._sendBatch(batch);
      const latency = performance.now() - startTime;

      if (Array.isArray(responses)) {
        for (const response of responses) {
          const pending = pendingCopy.get(response.id);
          if (pending) {
            if (response.error) {
              pending.reject(new Error(response.error.message || 'RPC Error'));
            } else {
              pending.resolve(response.result);
            }
            pendingCopy.delete(response.id);
          }
        }
      }

      for (const [id, pending] of pendingCopy) {
        pending.reject(new Error('No response received'));
      }

      return {
        success: true,
        count: batch.length,
        latency: Math.round(latency * 100) / 100
      };
    } catch (error) {
      for (const [id, pending] of pendingCopy) {
        pending.reject(error);
      }

      return {
        success: false,
        count: batch.length,
        error: error.message
      };
    }
  }

  async _sendBatch(batch) {
    const agent = this.pool.getAgent(this.rpcUrl);
    const parsed = new URL(this.rpcUrl);
    const isHttps = parsed.protocol === 'https:';

    const payload = JSON.stringify(batch);

    return new Promise((resolve, reject) => {
      const httpModule = isHttps ? https : http;

      const req = httpModule.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname,
          method: 'POST',
          agent,
          timeout: this.options.timeout,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        },
        (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json);
            } catch (e) {
              reject(new Error('Invalid JSON response'));
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Batch request timeout'));
      });

      req.write(payload);
      req.end();
    });
  }

  get size() {
    return this.queue.length;
  }

  clear() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    for (const [id, pending] of this.pending) {
      pending.reject(new Error('Batch cleared'));
    }

    this.queue = [];
    this.pending.clear();
  }
}

class BatchBuilder {
  constructor(rpcUrl) {
    this.rpcUrl = rpcUrl;
    this.calls = [];
  }

  call(method, params = []) {
    this.calls.push({ method, params });
    return this;
  }

  ethCall(to, data, blockTag = 'latest') {
    return this.call('eth_call', [{ to, data }, blockTag]);
  }

  getBalance(address, blockTag = 'latest') {
    return this.call('eth_getBalance', [address, blockTag]);
  }

  getNonce(address, blockTag = 'latest') {
    return this.call('eth_getTransactionCount', [address, blockTag]);
  }

  blockNumber() {
    return this.call('eth_blockNumber', []);
  }

  gasPrice() {
    return this.call('eth_gasPrice', []);
  }

  getBlock(blockNumber = 'latest', fullTx = false) {
    return this.call('eth_getBlockByNumber', [blockNumber, fullTx]);
  }

  getSlot() {
    return this.call('getSlot', []);
  }

  solanaGetBalance(pubkey) {
    return this.call('getBalance', [pubkey]);
  }

  async execute() {
    if (this.calls.length === 0) {
      return { success: true, results: [], latency: 0 };
    }

    const pool = getPool();
    const agent = pool.getAgent(this.rpcUrl);
    const parsed = new URL(this.rpcUrl);
    const isHttps = parsed.protocol === 'https:';

    const batch = this.calls.map((call, index) => ({
      jsonrpc: '2.0',
      id: index + 1,
      method: call.method,
      params: call.params
    }));

    const payload = JSON.stringify(batch);
    const startTime = performance.now();

    return new Promise((resolve) => {
      const httpModule = isHttps ? https : http;

      const req = httpModule.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname,
          method: 'POST',
          agent,
          timeout: 30000,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        },
        (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            const latency = performance.now() - startTime;
            try {
              const json = JSON.parse(data);
              
              const sorted = Array.isArray(json) 
                ? json.sort((a, b) => a.id - b.id)
                : [json];

              const results = sorted.map(r => ({
                success: !r.error,
                result: r.result,
                error: r.error?.message
              }));

              resolve({
                success: true,
                results,
                count: this.calls.length,
                latency: Math.round(latency * 100) / 100
              });
            } catch (e) {
              resolve({
                success: false,
                error: 'Invalid JSON response',
                count: this.calls.length,
                latency: Math.round(latency * 100) / 100
              });
            }
          });
        }
      );

      req.on('error', (err) => {
        resolve({
          success: false,
          error: err.message,
          count: this.calls.length,
          latency: Math.round((performance.now() - startTime) * 100) / 100
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          success: false,
          error: 'Timeout',
          count: this.calls.length,
          latency: 30000
        });
      });

      req.write(payload);
      req.end();
    });
  }
}

export function createBatchRequest(rpcUrl, options) {
  return new BatchRequest(rpcUrl, options);
}

export function batch(rpcUrl) {
  return new BatchBuilder(rpcUrl);
}

export default BatchRequest;