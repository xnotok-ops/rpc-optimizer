/**
 * Solana Chain Utilities
 * Helper functions for Solana
 */

import { getFailover } from '../failover.js';
import { getNonceManager } from '../nonce.js';
import { batch } from '../batch.js';

/**
 * Solana Client - High-level API
 */
export class SolanaClient {
  constructor(options = {}) {
    this.chain = 'solana';
    this.failover = getFailover('solana', options.failover);
    this.nonceManager = getNonceManager('solana', options.nonce);
    this.options = {
      commitment: 'confirmed',
      timeout: 60000,
      ...options
    };
  }

  /**
   * Get current slot
   */
  async getSlot(commitment = this.options.commitment) {
    const result = await this.failover.request('getSlot', [{ commitment }]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result;
  }

  /**
   * Get block height
   */
  async getBlockHeight(commitment = this.options.commitment) {
    const result = await this.failover.request('getBlockHeight', [{ commitment }]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result;
  }

  /**
   * Get balance for pubkey
   */
  async getBalance(pubkey, commitment = this.options.commitment) {
    const result = await this.failover.request('getBalance', [
      pubkey,
      { commitment }
    ]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return BigInt(result.result.value);
  }

  /**
   * Get multiple balances
   */
  async getBalances(pubkeys, commitment = this.options.commitment) {
    const rpc = this.failover.getCurrent();
    const batchReq = batch(rpc.url);

    for (const pubkey of pubkeys) {
      batchReq.call('getBalance', [pubkey, { commitment }]);
    }

    const result = await batchReq.execute();

    if (!result.success) {
      throw new Error(result.error);
    }

    return pubkeys.map((pubkey, i) => ({
      pubkey,
      balance: result.results[i].success ? BigInt(result.results[i].result.value) : null,
      error: result.results[i].error
    }));
  }

  /**
   * Get account info
   */
  async getAccountInfo(pubkey, encoding = 'base64', commitment = this.options.commitment) {
    const result = await this.failover.request('getAccountInfo', [
      pubkey,
      { encoding, commitment }
    ]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result.value;
  }

  /**
   * Get multiple accounts
   */
  async getMultipleAccounts(pubkeys, encoding = 'base64', commitment = this.options.commitment) {
    const result = await this.failover.request('getMultipleAccounts', [
      pubkeys,
      { encoding, commitment }
    ]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result.value;
  }

  /**
   * Get recent blockhash
   */
  async getLatestBlockhash(commitment = this.options.commitment) {
    const result = await this.nonceManager.getRecentBlockhash();
    return {
      blockhash: result.blockhash,
      lastValidBlockHeight: result.lastValidBlockHeight,
      cached: result.cached
    };
  }

  /**
   * Get fee for message
   */
  async getFeeForMessage(message, commitment = this.options.commitment) {
    const result = await this.failover.request('getFeeForMessage', [
      message,
      { commitment }
    ]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result.value;
  }

  /**
   * Get minimum balance for rent exemption
   */
  async getMinimumBalanceForRentExemption(dataSize) {
    const result = await this.failover.request('getMinimumBalanceForRentExemption', [dataSize]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result;
  }

  /**
   * Send transaction
   */
  async sendTransaction(signedTx, options = {}) {
    const opts = {
      encoding: 'base64',
      skipPreflight: false,
      preflightCommitment: this.options.commitment,
      maxRetries: 3,
      ...options
    };

    const result = await this.failover.request('sendTransaction', [signedTx, opts]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result; // signature
  }

  /**
   * Get transaction status
   */
  async getSignatureStatus(signature, searchTransactionHistory = false) {
    const result = await this.failover.request('getSignatureStatuses', [
      [signature],
      { searchTransactionHistory }
    ]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result.value[0];
  }

  /**
   * Get transaction details
   */
  async getTransaction(signature, options = {}) {
    const opts = {
      encoding: 'json',
      commitment: this.options.commitment,
      maxSupportedTransactionVersion: 0,
      ...options
    };

    const result = await this.failover.request('getTransaction', [signature, opts]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result;
  }

  /**
   * Wait for transaction confirmation
   */
  async confirmTransaction(signature, commitment = 'confirmed', timeout = 60000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const status = await this.getSignatureStatus(signature);

      if (status) {
        if (status.err) {
          return {
            success: false,
            error: status.err,
            slot: status.slot
          };
        }

        const confirmationStatus = status.confirmationStatus;
        
        // Check if reached desired commitment
        const commitmentLevels = ['processed', 'confirmed', 'finalized'];
        const currentLevel = commitmentLevels.indexOf(confirmationStatus);
        const targetLevel = commitmentLevels.indexOf(commitment);

        if (currentLevel >= targetLevel) {
          return {
            success: true,
            slot: status.slot,
            confirmationStatus
          };
        }
      }

      // Wait before retry
      await new Promise(r => setTimeout(r, 500));
    }

    throw new Error(`Transaction ${signature} not confirmed within ${timeout}ms`);
  }

  /**
   * Get token accounts by owner
   */
  async getTokenAccountsByOwner(owner, filter, commitment = this.options.commitment) {
    const result = await this.failover.request('getTokenAccountsByOwner', [
      owner,
      filter,
      { encoding: 'jsonParsed', commitment }
    ]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result.value;
  }

  /**
   * Get token balance
   */
  async getTokenAccountBalance(pubkey, commitment = this.options.commitment) {
    const result = await this.failover.request('getTokenAccountBalance', [
      pubkey,
      { commitment }
    ]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result.value;
  }

  /**
   * Get recent prioritization fees
   */
  async getRecentPrioritizationFees(addresses = []) {
    const result = await this.failover.request('getRecentPrioritizationFees', [addresses]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result;
  }

  /**
   * Calculate recommended priority fee
   */
  async getRecommendedPriorityFee(addresses = []) {
    const fees = await this.getRecentPrioritizationFees(addresses);
    
    if (!fees || fees.length === 0) {
      return {
        min: 0,
        avg: 0,
        max: 0,
        recommended: 1000 // Default 1000 micro-lamports
      };
    }

    const priorityFees = fees.map(f => f.prioritizationFee).filter(f => f > 0);
    
    if (priorityFees.length === 0) {
      return {
        min: 0,
        avg: 0,
        max: 0,
        recommended: 1000
      };
    }

    priorityFees.sort((a, b) => a - b);

    const min = priorityFees[0];
    const max = priorityFees[priorityFees.length - 1];
    const avg = Math.round(priorityFees.reduce((a, b) => a + b, 0) / priorityFees.length);
    const median = priorityFees[Math.floor(priorityFees.length / 2)];
    const p75 = priorityFees[Math.floor(priorityFees.length * 0.75)];

    return {
      min,
      max,
      avg,
      median,
      p75,
      recommended: Math.max(median, 1000) // At least 1000
    };
  }

  /**
   * Simulate transaction
   */
  async simulateTransaction(tx, options = {}) {
    const opts = {
      encoding: 'base64',
      commitment: this.options.commitment,
      sigVerify: false,
      replaceRecentBlockhash: true,
      ...options
    };

    const result = await this.failover.request('simulateTransaction', [tx, opts]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result.value;
  }

  /**
   * Get block
   */
  async getBlock(slot, options = {}) {
    const opts = {
      encoding: 'json',
      transactionDetails: 'full',
      maxSupportedTransactionVersion: 0,
      ...options
    };

    const result = await this.failover.request('getBlock', [slot, opts]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result;
  }

  /**
   * Get epoch info
   */
  async getEpochInfo(commitment = this.options.commitment) {
    const result = await this.failover.request('getEpochInfo', [{ commitment }]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result;
  }

  /**
   * Get health
   */
  async getHealth() {
    const result = await this.failover.request('getHealth');
    return result.success && result.result === 'ok';
  }

  /**
   * Batch read - multiple calls in one request
   */
  async batchRead(calls) {
    const rpc = this.failover.getCurrent();
    const batchReq = batch(rpc.url);

    for (const call of calls) {
      batchReq.call(call.method, call.params || []);
    }

    const result = await batchReq.execute();

    return {
      success: result.success,
      results: result.results,
      latency: result.latency
    };
  }

  /**
   * Warmup - prepare connections and cache
   */
  async warmup() {
    const tasks = [];

    // Benchmark and select best RPC
    tasks.push(this.failover.autoSelect());

    // Pre-fetch blockhash
    tasks.push(this.nonceManager.prefetch());

    // Pre-fetch priority fees
    tasks.push(this.getRecommendedPriorityFee());

    const results = await Promise.allSettled(tasks);

    return {
      rpc: results[0].status === 'fulfilled' ? results[0].value : null,
      blockhash: results[1].status === 'fulfilled' ? results[1].value : null,
      priorityFee: results[2].status === 'fulfilled' ? results[2].value : null
    };
  }

  /**
   * Get RPC status
   */
  getStatus() {
    return {
      chain: 'solana',
      rpc: this.failover.getStatus(),
      nonce: this.nonceManager.getStats()
    };
  }
}

/**
 * Utility functions
 */
export function lamportsToSol(lamports) {
  const lamportsBigInt = BigInt(lamports);
  const sol = Number(lamportsBigInt) / 1_000_000_000;
  return sol;
}

export function solToLamports(sol) {
  return BigInt(Math.round(sol * 1_000_000_000));
}

export function formatSol(lamports, decimals = 4) {
  const sol = lamportsToSol(lamports);
  return sol.toFixed(decimals);
}

export function shortenPubkey(pubkey, chars = 4) {
  if (!pubkey) return '';
  return `${pubkey.slice(0, chars)}...${pubkey.slice(-chars)}`;
}

/**
 * Factory function
 */
export function createSolanaClient(options) {
  return new SolanaClient(options);
}

export default SolanaClient;