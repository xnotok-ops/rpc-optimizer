/**
 * RPC Optimizer - Usage Examples
 * 
 * Run: npm run example
 */

import { 
  createEVMClient, 
  createSolanaClient,
  getBenchmark,
  getFailover,
  batch,
  createWebSocket,
  retry,
  RateLimiter,
  formatEther,
  formatGwei,
  lamportsToSol
} from '../src/index.js';

// Separator helper
const sep = (title) => {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${title}`);
  console.log('='.repeat(60) + '\n');
};

/**
 * Example 1: Benchmark RPCs
 */
async function exampleBenchmark() {
  sep('Example 1: Benchmark RPCs');

  const benchmark = getBenchmark();

  // Benchmark Ethereum RPCs
  console.log('Benchmarking Ethereum RPCs...');
  await benchmark.benchmarkChain('ethereum', 3);
  benchmark.printResults('ethereum');

  // Get fastest
  const fastest = benchmark.getFastest('ethereum');
  console.log(`\n✅ Fastest: ${fastest.name} (${fastest.latency.avg}ms avg)`);
}

/**
 * Example 2: Basic EVM Client
 */
async function exampleEVMClient() {
  sep('Example 2: EVM Client (Ethereum)');

  const eth = createEVMClient('ethereum');

  // Get block number
  const blockNumber = await eth.getBlockNumber();
  console.log(`Current block: ${blockNumber.toLocaleString()}`);

  // Get gas price
  const gasPrice = await eth.getGasPrice();
  console.log(`Gas price: ${formatGwei(gasPrice)} gwei`);

  // Get fee data (EIP-1559)
  const feeData = await eth.getFeeData();
  console.log(`Base fee: ${feeData.baseFee ? formatGwei(feeData.baseFee) + ' gwei' : 'N/A'}`);
  console.log(`Max fee: ${formatGwei(feeData.maxFeePerGas)} gwei`);

  // Get balance (Vitalik's address)
  const vitalik = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
  const balance = await eth.getBalance(vitalik);
  console.log(`\nVitalik's balance: ${formatEther(balance)} ETH`);
}

/**
 * Example 3: Batch Requests
 */
async function exampleBatching() {
  sep('Example 3: Batch Requests');

  const failover = getFailover('ethereum');
  const rpc = failover.getCurrent();

  // Create batch request
  const batchReq = batch(rpc.url);

  // Add multiple calls
  const addresses = [
    '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', // Vitalik
    '0xBE0eB53F46cd790Cd13851d5EFf43D12404d33E8', // Binance
    '0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503'  // Binance 2
  ];

  for (const addr of addresses) {
    batchReq.getBalance(addr);
  }
  batchReq.blockNumber();
  batchReq.gasPrice();

  console.log(`Sending batch of ${addresses.length + 2} requests...`);
  
  const result = await batchReq.execute();

  console.log(`✅ Batch completed in ${result.latency}ms`);
  console.log(`\nBalances:`);
  
  addresses.forEach((addr, i) => {
    if (result.results[i].success) {
      const bal = BigInt(result.results[i].result);
      console.log(`  ${addr.slice(0, 10)}...: ${formatEther(bal)} ETH`);
    }
  });

  console.log(`\nBlock: ${parseInt(result.results[3].result, 16)}`);
  console.log(`Gas: ${formatGwei(BigInt(result.results[4].result))} gwei`);
}

/**
 * Example 4: Failover
 */
async function exampleFailover() {
  sep('Example 4: Multi-RPC Failover');

  const failover = getFailover('base');

  console.log('Making requests with automatic failover...\n');

  // Make several requests
  for (let i = 0; i < 5; i++) {
    const result = await failover.request('eth_blockNumber');
    if (result.success) {
      console.log(`Request ${i + 1}: Block ${parseInt(result.result, 16)} via ${result.rpc} (${result.latency}ms)`);
    } else {
      console.log(`Request ${i + 1}: Failed - ${result.error}`);
    }
  }

  // Show status
  console.log('\nRPC Status:');
  const status = failover.getStatus();
  status.forEach(rpc => {
    const icon = rpc.healthy ? '✅' : '❌';
    const current = rpc.isCurrent ? '👈' : '';
    console.log(`  ${icon} ${rpc.name.padEnd(15)} | Successes: ${rpc.successes} | Failures: ${rpc.failures} ${current}`);
  });
}

/**
 * Example 5: Solana Client
 */
async function exampleSolana() {
  sep('Example 5: Solana Client');

  const sol = createSolanaClient();

  // Get slot
  const slot = await sol.getSlot();
  console.log(`Current slot: ${slot.toLocaleString()}`);

  // Get block height
  const height = await sol.getBlockHeight();
  console.log(`Block height: ${height.toLocaleString()}`);

  // Get balance (some known address)
  const pubkey = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg';
  try {
    const balance = await sol.getBalance(pubkey);
    console.log(`\nBalance of ${pubkey.slice(0, 10)}...: ${lamportsToSol(balance)} SOL`);
  } catch (e) {
    console.log(`\nBalance check: ${e.message}`);
  }

  // Get priority fee recommendation
  const priorityFee = await sol.getRecommendedPriorityFee();
  console.log(`\nRecommended priority fee: ${priorityFee.recommended} micro-lamports`);
}

/**
 * Example 6: Retry with Backoff
 */
async function exampleRetry() {
  sep('Example 6: Retry with Backoff');

  let attempts = 0;

  const result = await retry(
    async (attempt) => {
      attempts++;
      console.log(`  Attempt ${attempt + 1}...`);
      
      // Simulate failure for first 2 attempts
      if (attempt < 2) {
        throw new Error('Simulated network timeout');
      }
      
      return { data: 'Success!' };
    },
    {
      maxRetries: 5,
      initialDelay: 100,
      strategy: 'exponential',
      onRetry: ({ attempt, delay }) => {
        console.log(`  ↳ Retrying in ${delay}ms...`);
      }
    }
  );

  if (result.success) {
    console.log(`\n✅ Success after ${result.attempts} attempts`);
    console.log(`   Result: ${result.result.data}`);
  } else {
    console.log(`\n❌ Failed: ${result.error.message}`);
  }
}

/**
 * Example 7: Rate Limiter
 */
async function exampleRateLimiter() {
  sep('Example 7: Rate Limiter');

  const limiter = new RateLimiter({
    maxTokens: 3,
    refillRate: 1,
    refillInterval: 1000
  });

  console.log('Sending 5 requests with rate limit of 3/sec...\n');

  const start = Date.now();

  for (let i = 0; i < 5; i++) {
    await limiter.execute(async () => {
      const elapsed = Date.now() - start;
      console.log(`  Request ${i + 1} sent at ${elapsed}ms`);
    });
  }

  console.log(`\n✅ All requests completed`);
  console.log(`   State: ${JSON.stringify(limiter.getState())}`);
}

/**
 * Example 8: Warmup (Pre-optimization)
 */
async function exampleWarmup() {
  sep('Example 8: Warmup (Pre-optimization)');

  const eth = createEVMClient('ethereum');

  console.log('Running warmup sequence...\n');

  const warmupResult = await eth.warmup([
    '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
  ]);

  console.log('Warmup complete:');
  console.log(`  ✅ Best RPC: ${warmupResult.rpc?.name || 'N/A'}`);
  console.log(`  ✅ Nonces prefetched: ${warmupResult.nonces?.length || 0}`);
  console.log(`  ✅ Fee data cached: ${warmupResult.feeData ? 'Yes' : 'No'}`);

  if (warmupResult.feeData) {
    console.log(`     - Base fee: ${formatGwei(warmupResult.feeData.baseFee || 0n)} gwei`);
    console.log(`     - Block: ${warmupResult.feeData.blockNumber}`);
  }
}

/**
 * Run all examples
 */
async function main() {
  console.log('\n🚀 RPC Optimizer - Examples\n');
  console.log('This will demonstrate all features of the RPC optimizer.\n');

  try {
    await exampleBenchmark();
    await exampleEVMClient();
    await exampleBatching();
    await exampleFailover();
    await exampleSolana();
    await exampleRetry();
    await exampleRateLimiter();
    await exampleWarmup();

    sep('All Examples Complete! 🎉');
    console.log('The RPC optimizer is ready to use in your projects.\n');
    console.log('Import like this:');
    console.log('  import { createEVMClient, createSolanaClient } from "./src/index.js"\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
  }
}

// Run
main();