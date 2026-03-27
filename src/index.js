/**
 * RPC Optimizer
 * High-performance RPC module for EVM (ETH/Base) and Solana
 * 
 * @author xnotok
 * @license MIT
 */

// Core modules
export { default as ConnectionPool, getPool, createPool } from './pool.js';
export { default as RPCBenchmark, getBenchmark } from './benchmark.js';
export { default as FailoverManager, getFailover, createFailover } from './failover.js';
export { default as BatchRequest, batch, createBatchRequest } from './batch.js';
export { 
  default as NonceManager, 
  getNonceManager, 
  createNonceManager,
  SolanaNonceManager 
} from './nonce.js';
export { 
  retry, 
  Strategy, 
  RetryHandler, 
  RateLimiter, 
  CircuitBreaker 
} from './retry.js';
export { 
  createWebSocket, 
  EVMWebSocket, 
  SolanaWebSocket, 
  State as WebSocketState 
} from './websocket.js';

// Chain-specific clients
export { 
  default as EVMClient, 
  createEVMClient,
  toHex,
  fromHex,
  formatEther,
  parseEther,
  formatGwei,
  parseGwei
} from './chains/evm.js';
export { 
  default as SolanaClient, 
  createSolanaClient,
  lamportsToSol,
  solToLamports,
  formatSol,
  shortenPubkey
} from './chains/solana.js';

// Config
export { default as config } from './config.js';

/**
 * Quick start helpers
 */
import { createEVMClient as _createEVM } from './chains/evm.js';
import { createSolanaClient as _createSolana } from './chains/solana.js';

export function ethereum(options) {
  return _createEVM('ethereum', options);
}

export function base(options) {
  return _createEVM('base', options);
}

export function solana(options) {
  return _createSolana(options);
}

/**
 * Quick benchmark all chains
 */
export async function benchmarkAll(rounds = 5) {
  const { getBenchmark } = await import('./benchmark.js');
  const benchmark = getBenchmark();
  return benchmark.benchmarkAll(rounds);
}

/**
 * Default export
 */
export default {
  ethereum,
  base,
  solana,
  benchmarkAll
};