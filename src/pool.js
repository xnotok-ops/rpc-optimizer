/**
 * Connection Pool Manager
 * Keep HTTP connections warm to avoid cold start penalty
 */

import http from 'http';
import https from 'https';

class ConnectionPool {
  constructor(options = {}) {
    this.pools = new Map();
    this.options = {
      keepAlive: true,
      keepAliveMsecs: 30000,      // 30 seconds
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: 60000,             // 60 seconds
      scheduling: 'fifo',
      ...options
    };
  }

  /**
   * Get or create HTTP agent for a URL
   */
  getAgent(url) {
    const parsed = new URL(url);
    const key = `${parsed.protocol}//${parsed.host}`;
    
    if (!this.pools.has(key)) {
      const AgentClass = parsed.protocol === 'https:' ? https.Agent : http.Agent;
      const agent = new AgentClass(this.options);
      this.pools.set(key, {
        agent,
        host: parsed.host,
        protocol: parsed.protocol,
        lastUsed: Date.now(),
        requestCount: 0
      });
    }
    
    const pool = this.pools.get(key);
    pool.lastUsed = Date.now();
    pool.requestCount++;
    
    return pool.agent;
  }

  /**
   * Warm up connections by sending HEAD/OPTIONS request
   */
  async warmup(urls) {
    const results = [];
    
    const warmupOne = async (url) => {
      const start = Date.now();
      try {
        const agent = this.getAgent(url);
        const parsed = new URL(url);
        
        return new Promise((resolve) => {
          const req = (parsed.protocol === 'https:' ? https : http).request(
            {
              hostname: parsed.hostname,
              port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
              path: '/',
              method: 'OPTIONS',
              agent,
              timeout: 5000
            },
            (res) => {
              res.resume(); // drain response
              resolve({
                url,
                success: true,
                latency: Date.now() - start,
                status: res.statusCode
              });
            }
          );
          
          req.on('error', (err) => {
            resolve({
              url,
              success: false,
              latency: Date.now() - start,
              error: err.message
            });
          });
          
          req.on('timeout', () => {
            req.destroy();
            resolve({
              url,
              success: false,
              latency: Date.now() - start,
              error: 'timeout'
            });
          });
          
          req.end();
        });
      } catch (err) {
        return {
          url,
          success: false,
          latency: Date.now() - start,
          error: err.message
        };
      }
    };

    // Warmup all URLs concurrently
    const promises = urls.map(url => warmupOne(url));
    const settled = await Promise.all(promises);
    
    return settled;
  }

  /**
   * Get pool statistics
   */
  getStats() {
    const stats = {};
    for (const [key, pool] of this.pools) {
      const agent = pool.agent;
      stats[key] = {
        host: pool.host,
        requestCount: pool.requestCount,
        lastUsed: pool.lastUsed,
        sockets: Object.keys(agent.sockets).length,
        freeSockets: Object.keys(agent.freeSockets).length,
        requests: Object.keys(agent.requests).length
      };
    }
    return stats;
  }

  /**
   * Close all connections
   */
  destroy() {
    for (const [key, pool] of this.pools) {
      pool.agent.destroy();
    }
    this.pools.clear();
  }

  /**
   * Close idle connections (not used in last X ms)
   */
  pruneIdle(maxIdleMs = 60000) {
    const now = Date.now();
    const pruned = [];
    
    for (const [key, pool] of this.pools) {
      if (now - pool.lastUsed > maxIdleMs) {
        pool.agent.destroy();
        this.pools.delete(key);
        pruned.push(key);
      }
    }
    
    return pruned;
  }
}

// Singleton instance
let defaultPool = null;

export function getPool(options) {
  if (!defaultPool) {
    defaultPool = new ConnectionPool(options);
  }
  return defaultPool;
}

export function createPool(options) {
  return new ConnectionPool(options);
}

export default ConnectionPool;