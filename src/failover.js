/**
 * Multi-RPC Failover Manager
 * Auto-switch to backup RPC when primary fails
 */

import http from 'http';
import https from 'https';
import { getPool } from './pool.js';
import { getBenchmark } from './benchmark.js';
import config from './config.js';

class FailoverManager {
  constructor(chain, options = {}) {
    this.chain = chain;
    this.chainConfig = config[chain];
    
    if (!this.chainConfig) {
      throw new Error(`Unknown chain: ${chain}`);
    }

    this.options = {
      maxRetries: 3,
      retryDelay: 100,
      failureThreshold: 3,
      recoveryTime: 30000,
      timeout: 10000,
      ...options
    };

    this.pool = getPool();
    this.rpcs = this.chainConfig.rpcs.map((rpc, index) => ({
      ...rpc,
      index,
      failures: 0,
      successes: 0,
      healthy: true,
      lastFailure: null,
      lastSuccess: null,
      avgLatency: null
    }));

    this.currentIndex = 0;
  }

  getCurrent() {
    return this.rpcs[this.currentIndex];
  }

  getHealthy() {
    const now = Date.now();
    return this.rpcs.filter(rpc => {
      if (!rpc.healthy && rpc.lastFailure) {
        if (now - rpc.lastFailure > this.options.recoveryTime) {
          rpc.healthy = true;
          rpc.failures = 0;
        }
      }
      return rpc.healthy;
    });
  }

  markFailed(rpc, error) {
    rpc.failures++;
    rpc.lastFailure = Date.now();

    if (rpc.failures >= this.options.failureThreshold) {
      rpc.healthy = false;
      console.warn(`⚠️ RPC ${rpc.name} marked unhealthy after ${rpc.failures} failures`);
    }

    return rpc.healthy;
  }

  markSuccess(rpc, latency) {
    rpc.successes++;
    rpc.lastSuccess = Date.now();
    rpc.failures = Math.max(0, rpc.failures - 1);
    
    if (rpc.avgLatency === null) {
      rpc.avgLatency = latency;
    } else {
      rpc.avgLatency = (rpc.avgLatency * 0.8) + (latency * 0.2);
    }
  }

  switchToNext() {
    const healthy = this.getHealthy();
    
    if (healthy.length === 0) {
      console.warn('⚠️ All RPCs unhealthy, resetting...');
      this.rpcs.forEach(rpc => {
        rpc.healthy = true;
        rpc.failures = 0;
      });
      return this.rpcs[0];
    }

    const currentIdx = this.currentIndex;
    for (let i = 1; i <= this.rpcs.length; i++) {
      const nextIdx = (currentIdx + i) % this.rpcs.length;
      if (this.rpcs[nextIdx].healthy) {
        this.currentIndex = nextIdx;
        console.log(`🔄 Switched to RPC: ${this.rpcs[nextIdx].name}`);
        return this.rpcs[nextIdx];
      }
    }

    return this.rpcs[0];
  }

  async request(method, params = []) {
    const startTime = performance.now();
    let lastError = null;
    let attempts = 0;

    const healthy = this.getHealthy();
    const maxAttempts = Math.min(this.options.maxRetries, healthy.length);

    while (attempts < maxAttempts) {
      const rpc = attempts === 0 ? this.getCurrent() : this.switchToNext();
      attempts++;

      try {
        const result = await this._sendRequest(rpc, method, params);
        const latency = performance.now() - startTime;
        
        this.markSuccess(rpc, latency);
        
        return {
          success: true,
          result: result.result,
          rpc: rpc.name,
          latency: Math.round(latency * 100) / 100,
          attempts
        };
      } catch (error) {
        lastError = error;
        this.markFailed(rpc, error);
        
        if (attempts < maxAttempts) {
          await this._delay(this.options.retryDelay * attempts);
        }
      }
    }

    return {
      success: false,
      error: lastError?.message || 'All RPCs failed',
      attempts
    };
  }

  async _sendRequest(rpc, method, params) {
    const agent = this.pool.getAgent(rpc.url);
    const parsed = new URL(rpc.url);
    const isHttps = parsed.protocol === 'https:';

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params
    });

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
              if (json.error) {
                reject(new Error(json.error.message || 'RPC Error'));
              } else {
                resolve(json);
              }
            } catch (e) {
              reject(new Error('Invalid JSON response'));
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(payload);
      req.end();
    });
  }

  _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  getStatus() {
    return this.rpcs.map(rpc => ({
      name: rpc.name,
      url: rpc.url,
      healthy: rpc.healthy,
      failures: rpc.failures,
      successes: rpc.successes,
      avgLatency: rpc.avgLatency ? Math.round(rpc.avgLatency) : null,
      isCurrent: rpc.index === this.currentIndex
    }));
  }

  setPrimary(nameOrIndex) {
    if (typeof nameOrIndex === 'number') {
      if (nameOrIndex >= 0 && nameOrIndex < this.rpcs.length) {
        this.currentIndex = nameOrIndex;
        return true;
      }
    } else {
      const idx = this.rpcs.findIndex(r => 
        r.name.toLowerCase() === nameOrIndex.toLowerCase()
      );
      if (idx !== -1) {
        this.currentIndex = idx;
        return true;
      }
    }
    return false;
  }

  async autoSelect() {
    const benchmark = getBenchmark();
    await benchmark.benchmarkChain(this.chain, 3);
    
    const fastest = benchmark.getFastest(this.chain);
    if (fastest) {
      this.setPrimary(fastest.name);
      console.log(`✅ Auto-selected fastest RPC: ${fastest.name} (${fastest.latency.avg}ms)`);
      return fastest;
    }
    
    return null;
  }
}

const managers = new Map();

export function getFailover(chain, options) {
  const key = `${chain}-${JSON.stringify(options || {})}`;
  
  if (!managers.has(key)) {
    managers.set(key, new FailoverManager(chain, options));
  }
  
  return managers.get(key);
}

export function createFailover(chain, options) {
  return new FailoverManager(chain, options);
}

export default FailoverManager;