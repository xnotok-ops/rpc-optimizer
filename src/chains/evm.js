/**
 * EVM Chain Utilities
 * Helper functions for Ethereum/Base chains
 */

import { getFailover } from '../failover.js';
import { getNonceManager } from '../nonce.js';
import { batch } from '../batch.js';
import { retry } from '../retry.js';

/**
 * EVM Client - High-level API for EVM chains
 */
export class EVMClient {
  constructor(chain, options = {}) {
    this.chain = chain;
    this.failover = getFailover(chain, options.failover);
    this.nonceManager = getNonceManager(chain, options.nonce);
    this.options = {
      confirmations: 1,
      timeout: 60000,
      ...options
    };
  }

  /**
   * Get current block number
   */
  async getBlockNumber() {
    const result = await this.failover.request('eth_blockNumber');
    if (!result.success) {
      throw new Error(result.error);
    }
    return parseInt(result.result, 16);
  }

  /**
   * Get block by number
   */
  async getBlock(blockNumber = 'latest', fullTx = false) {
    const blockTag = typeof blockNumber === 'number' 
      ? '0x' + blockNumber.toString(16) 
      : blockNumber;
    
    const result = await this.failover.request('eth_getBlockByNumber', [blockTag, fullTx]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result;
  }

  /**
   * Get balance
   */
  async getBalance(address, blockTag = 'latest') {
    const result = await this.failover.request('eth_getBalance', [address, blockTag]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return BigInt(result.result);
  }

  /**
   * Get multiple balances in one call
   */
  async getBalances(addresses, blockTag = 'latest') {
    const rpc = this.failover.getCurrent();
    const batchReq = batch(rpc.url);

    for (const addr of addresses) {
      batchReq.getBalance(addr, blockTag);
    }

    const result = await batchReq.execute();
    
    if (!result.success) {
      throw new Error(result.error);
    }

    return addresses.map((addr, i) => ({
      address: addr,
      balance: result.results[i].success ? BigInt(result.results[i].result) : null,
      error: result.results[i].error
    }));
  }

  /**
   * Get nonce for address
   */
  async getNonce(address) {
    const result = await this.nonceManager.get(address);
    return result.nonce;
  }

  /**
   * Get nonce and auto-increment
   */
  async getNextNonce(address) {
    return this.nonceManager.getAndIncrement(address);
  }

  /**
   * Prefetch nonces for multiple addresses
   */
  async prefetchNonces(addresses) {
    return this.nonceManager.prefetch(addresses);
  }

  /**
   * Get gas price
   */
  async getGasPrice() {
    const result = await this.failover.request('eth_gasPrice');
    if (!result.success) {
      throw new Error(result.error);
    }
    return BigInt(result.result);
  }

  /**
   * Get EIP-1559 fee data
   */
  async getFeeData() {
    const rpc = this.failover.getCurrent();
    const batchReq = batch(rpc.url);

    batchReq.gasPrice();
    batchReq.getBlock('latest', false);

    const result = await batchReq.execute();

    if (!result.success) {
      throw new Error(result.error);
    }

    const gasPrice = BigInt(result.results[0].result);
    const block = result.results[1].result;
    const baseFee = block?.baseFeePerGas ? BigInt(block.baseFeePerGas) : null;

    // Calculate suggested fees
    let maxPriorityFeePerGas = 1500000000n; // 1.5 gwei default
    let maxFeePerGas;

    if (baseFee) {
      maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
    } else {
      maxFeePerGas = gasPrice;
    }

    return {
      gasPrice,
      baseFee,
      maxPriorityFeePerGas,
      maxFeePerGas,
      blockNumber: parseInt(block.number, 16)
    };
  }

  /**
   * Estimate gas
   */
  async estimateGas(tx) {
    const result = await this.failover.request('eth_estimateGas', [tx]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return BigInt(result.result);
  }

  /**
   * Call contract (read-only)
   */
  async call(to, data, blockTag = 'latest') {
    const result = await this.failover.request('eth_call', [{ to, data }, blockTag]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result;
  }

  /**
   * Send raw transaction
   */
  async sendRawTransaction(signedTx) {
    const result = await this.failover.request('eth_sendRawTransaction', [signedTx]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result; // tx hash
  }

  /**
   * Get transaction receipt
   */
  async getTransactionReceipt(txHash) {
    const result = await this.failover.request('eth_getTransactionReceipt', [txHash]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result;
  }

  /**
   * Wait for transaction confirmation
   */
  async waitForTransaction(txHash, confirmations = 1, timeout = 60000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const receipt = await this.getTransactionReceipt(txHash);

      if (receipt) {
        if (confirmations <= 1) {
          return {
            success: receipt.status === '0x1',
            receipt,
            confirmations: 1
          };
        }

        // Check confirmations
        const currentBlock = await this.getBlockNumber();
        const txBlock = parseInt(receipt.blockNumber, 16);
        const confirms = currentBlock - txBlock + 1;

        if (confirms >= confirmations) {
          return {
            success: receipt.status === '0x1',
            receipt,
            confirmations: confirms
          };
        }
      }

      // Wait before retry
      await new Promise(r => setTimeout(r, 1000));
    }

    throw new Error(`Transaction ${txHash} not confirmed within ${timeout}ms`);
  }

  /**
   * Get transaction by hash
   */
  async getTransaction(txHash) {
    const result = await this.failover.request('eth_getTransactionByHash', [txHash]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result;
  }

  /**
   * Get logs
   */
  async getLogs(filter) {
    const result = await this.failover.request('eth_getLogs', [filter]);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.result;
  }

  /**
   * Get chain ID
   */
  async getChainId() {
    const result = await this.failover.request('eth_chainId');
    if (!result.success) {
      throw new Error(result.error);
    }
    return parseInt(result.result, 16);
  }

  /**
   * Batch read - execute multiple calls efficiently
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
  async warmup(addresses = []) {
    const tasks = [];

    // Benchmark and select best RPC
    tasks.push(this.failover.autoSelect());

    // Pre-fetch nonces if addresses provided
    if (addresses.length > 0) {
      tasks.push(this.nonceManager.prefetch(addresses));
    }

    // Pre-fetch fee data
    tasks.push(this.getFeeData());

    const results = await Promise.allSettled(tasks);

    return {
      rpc: results[0].status === 'fulfilled' ? results[0].value : null,
      nonces: results[1]?.status === 'fulfilled' ? results[1].value : null,
      feeData: results[2]?.status === 'fulfilled' ? results[2].value : null
    };
  }

  /**
   * Get RPC status
   */
  getStatus() {
    return {
      chain: this.chain,
      rpc: this.failover.getStatus(),
      nonce: this.nonceManager.getStats()
    };
  }
}

/**
 * Utility functions
 */
export function toHex(value) {
  if (typeof value === 'bigint') {
    return '0x' + value.toString(16);
  }
  if (typeof value === 'number') {
    return '0x' + value.toString(16);
  }
  return value;
}

export function fromHex(hex) {
  return BigInt(hex);
}

export function formatEther(wei) {
  const weiStr = wei.toString();
  const padded = weiStr.padStart(19, '0');
  const intPart = padded.slice(0, -18) || '0';
  const decPart = padded.slice(-18).replace(/0+$/, '') || '0';
  return `${intPart}.${decPart}`;
}

export function parseEther(ether) {
  const [intPart, decPart = ''] = ether.split('.');
  const padded = decPart.padEnd(18, '0').slice(0, 18);
  return BigInt(intPart + padded);
}

export function formatGwei(wei) {
  const weiStr = wei.toString();
  const padded = weiStr.padStart(10, '0');
  const intPart = padded.slice(0, -9) || '0';
  const decPart = padded.slice(-9).replace(/0+$/, '') || '0';
  return `${intPart}.${decPart}`;
}

export function parseGwei(gwei) {
  const [intPart, decPart = ''] = gwei.split('.');
  const padded = decPart.padEnd(9, '0').slice(0, 9);
  return BigInt(intPart + padded);
}

/**
 * Factory function
 */
export function createEVMClient(chain, options) {
  return new EVMClient(chain, options);
}

export default EVMClient;