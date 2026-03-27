/**
 * Nonce Cache Manager
 * Pre-fetch and cache nonces for fast transaction building
 */

import { getFailover } from './failover.js';
import { batch } from './batch.js';

class NonceManager {
  constructor(chain, options = {}) {
    this.chain = chain;
    this.failover = getFailover(chain);
    this.options = {
      cacheTime: 10000,         // Cache valid for 10 seconds
      prefetchCount: 1,         // How many nonces ahead to track
      autoIncrement: true,      // Auto-increment after use
      ...options
    };

    this.cache = new Map();     // address -> { nonce, timestamp, pending }
  }

  /**
   * Get cached nonce or fetch from RPC
   */
  async get(address) {
    const addr = address.toLowerCase();
    const cached = this.cache.get(addr);
    const now = Date.now();

    // Return cached if still valid
    if (cached && (now - cached.timestamp) < this.options.cacheTime) {
      return {
        nonce: cached.nonce + cached.pending,
        cached: true,
        pending: cached.pending
      };
    }

    // Fetch fresh nonce
    const result = await this.failover.request('eth_getTransactionCount', [addr, 'pending']);
    
    if (!result.success) {
      // Return stale cache if available
      if (cached) {
        console.warn(`⚠️ Nonce fetch failed, using stale cache for ${addr}`);
        return {
          nonce: cached.nonce + cached.pending,
          cached: true,
          stale: true,
          pending: cached.pending
        };
      }
      throw new Error(`Failed to get nonce for ${addr}: ${result.error}`);
    }

    const nonce = parseInt(result.result, 16);
    
    this.cache.set(addr, {
      nonce,
      timestamp: now,
      pending: 0
    });

    return {
      nonce,
      cached: false,
      pending: 0
    };
  }

  /**
   * Get nonce and increment pending counter
   */
  async getAndIncrement(address) {
    const addr = address.toLowerCase();
    const result = await this.get(addr);
    
    if (this.options.autoIncrement) {
      const cached = this.cache.get(addr);
      if (cached) {
        cached.pending++;
      }
    }

    return result.nonce;
  }

  /**
   * Pre-fetch nonces for multiple addresses
   */
  async prefetch(addresses) {
    const results = [];
    const toFetch = [];
    const now = Date.now();

    // Check which addresses need fetching
    for (const address of addresses) {
      const addr = address.toLowerCase();
      const cached = this.cache.get(addr);

      if (cached && (now - cached.timestamp) < this.options.cacheTime) {
        results.push({
          address: addr,
          nonce: cached.nonce,
          cached: true
        });
      } else {
        toFetch.push(addr);
      }
    }

    // Batch fetch remaining
    if (toFetch.length > 0) {
      const rpc = this.failover.getCurrent();
      const batchReq = batch(rpc.url);

      for (const addr of toFetch) {
        batchReq.getNonce(addr, 'pending');
      }

      const batchResult = await batchReq.execute();

      if (batchResult.success) {
        batchResult.results.forEach((result, index) => {
          const addr = toFetch[index];
          if (result.success) {
            const nonce = parseInt(result.result, 16);
            this.cache.set(addr, {
              nonce,
              timestamp: now,
              pending: 0
            });
            results.push({
              address: addr,
              nonce,
              cached: false
            });
          } else {
            results.push({
              address: addr,
              error: result.error,
              cached: false
            });
          }
        });
      } else {
        // Fallback: fetch one by one
        for (const addr of toFetch) {
          try {
            const result = await this.get(addr);
            results.push({
              address: addr,
              nonce: result.nonce,
              cached: result.cached
            });
          } catch (err) {
            results.push({
              address: addr,
              error: err.message,
              cached: false
            });
          }
        }
      }
    }

    return results;
  }

  /**
   * Manually set nonce (useful after sending tx)
   */
  set(address, nonce) {
    const addr = address.toLowerCase();
    this.cache.set(addr, {
      nonce,
      timestamp: Date.now(),
      pending: 0
    });
  }

  /**
   * Increment pending count (after sending tx)
   */
  increment(address) {
    const addr = address.toLowerCase();
    const cached = this.cache.get(addr);
    if (cached) {
      cached.pending++;
    }
  }

  /**
   * Reset pending count (after tx confirmed)
   */
  resetPending(address) {
    const addr = address.toLowerCase();
    const cached = this.cache.get(addr);
    if (cached) {
      cached.nonce += cached.pending;
      cached.pending = 0;
      cached.timestamp = Date.now();
    }
  }

  /**
   * Invalidate cache for address
   */
  invalidate(address) {
    const addr = address.toLowerCase();
    this.cache.delete(addr);
  }

  /**
   * Clear all cache
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Get cache stats
   */
  getStats() {
    const stats = {
      totalCached: this.cache.size,
      addresses: []
    };

    const now = Date.now();
    for (const [addr, data] of this.cache) {
      stats.addresses.push({
        address: addr,
        nonce: data.nonce,
        pending: data.pending,
        effectiveNonce: data.nonce + data.pending,
        age: now - data.timestamp,
        valid: (now - data.timestamp) < this.options.cacheTime
      });
    }

    return stats;
  }
}

/**
 * Solana Nonce Manager (different API)
 */
class SolanaNonceManager {
  constructor(options = {}) {
    this.chain = 'solana';
    this.failover = getFailover('solana');
    this.options = {
      cacheTime: 5000,    // Solana is faster, shorter cache
      ...options
    };

    this.cache = new Map();  // pubkey -> { slot, blockhash, timestamp }
  }

  /**
   * Get recent blockhash (Solana's "nonce")
   */
  async getRecentBlockhash() {
    const cached = this.cache.get('blockhash');
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.options.cacheTime) {
      return {
        blockhash: cached.blockhash,
        lastValidBlockHeight: cached.lastValidBlockHeight,
        cached: true
      };
    }

    const result = await this.failover.request('getLatestBlockhash', [
      { commitment: 'finalized' }
    ]);

    if (!result.success) {
      if (cached) {
        console.warn('⚠️ Blockhash fetch failed, using stale cache');
        return {
          blockhash: cached.blockhash,
          lastValidBlockHeight: cached.lastValidBlockHeight,
          cached: true,
          stale: true
        };
      }
      throw new Error(`Failed to get blockhash: ${result.error}`);
    }

    const { blockhash, lastValidBlockHeight } = result.result.value;

    this.cache.set('blockhash', {
      blockhash,
      lastValidBlockHeight,
      timestamp: now
    });

    return {
      blockhash,
      lastValidBlockHeight,
      cached: false
    };
  }

  /**
   * Prefetch blockhash (warmup)
   */
  async prefetch() {
    return this.getRecentBlockhash();
  }

  /**
   * Clear cache
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Get stats
   */
  getStats() {
    const cached = this.cache.get('blockhash');
    if (!cached) {
      return { cached: false };
    }

    const now = Date.now();
    return {
      cached: true,
      blockhash: cached.blockhash,
      lastValidBlockHeight: cached.lastValidBlockHeight,
      age: now - cached.timestamp,
      valid: (now - cached.timestamp) < this.options.cacheTime
    };
  }
}

/**
 * Factory functions
 */
const evmManagers = new Map();
let solanaManager = null;

export function getNonceManager(chain, options) {
  if (chain === 'solana') {
    if (!solanaManager) {
      solanaManager = new SolanaNonceManager(options);
    }
    return solanaManager;
  }

  // EVM chains
  if (!evmManagers.has(chain)) {
    evmManagers.set(chain, new NonceManager(chain, options));
  }
  return evmManagers.get(chain);
}

export function createNonceManager(chain, options) {
  if (chain === 'solana') {
    return new SolanaNonceManager(options);
  }
  return new NonceManager(chain, options);
}

export { NonceManager, SolanaNonceManager };
export default NonceManager;