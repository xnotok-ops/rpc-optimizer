/**
 * RPC Benchmark Module
 * Test latency and pick fastest RPC automatically
 */

import http from 'http';
import https from 'https';
import { getPool } from './pool.js';
import config from './config.js';

class RPCBenchmark {
  constructor() {
    this.results = new Map();
    this.pool = getPool();
  }

  /**
   * Send JSON-RPC request and measure latency
   */
  async measureLatency(url, method = 'eth_blockNumber', params = []) {
    const agent = this.pool.getAgent(url);
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params
    });

    const start = performance.now();
    
    return new Promise((resolve) => {
      const httpModule = isHttps ? https : http;
      
      const req = httpModule.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname,
          method: 'POST',
          agent,
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        },
        (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            const latency = performance.now() - start;
            try {
              const json = JSON.parse(data);
              resolve({
                url,
                success: !json.error,
                latency: Math.round(latency * 100) / 100,
                result: json.result,
                error: json.error?.message
              });
            } catch (e) {
              resolve({
                url,
                success: false,
                latency: Math.round(latency * 100) / 100,
                error: 'Invalid JSON response'
              });
            }
          });
        }
      );

      req.on('error', (err) => {
        resolve({
          url,
          success: false,
          latency: Math.round((performance.now() - start) * 100) / 100,
          error: err.message
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          url,
          success: false,
          latency: 10000,
          error: 'Timeout'
        });
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Benchmark single RPC with multiple rounds
   */
  async benchmarkRPC(url, rounds = 5, method = 'eth_blockNumber', params = []) {
    const latencies = [];
    let successCount = 0;
    let lastError = null;

    for (let i = 0; i < rounds; i++) {
      const result = await this.measureLatency(url, method, params);
      if (result.success) {
        latencies.push(result.latency);
        successCount++;
      } else {
        lastError = result.error;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    if (latencies.length === 0) {
      return {
        url,
        success: false,
        error: lastError || 'All requests failed'
      };
    }

    latencies.sort((a, b) => a - b);
    const min = latencies[0];
    const max = latencies[latencies.length - 1];
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const median = latencies[Math.floor(latencies.length / 2)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)] || max;

    return {
      url,
      success: true,
      rounds,
      successRate: (successCount / rounds) * 100,
      latency: {
        min: Math.round(min * 100) / 100,
        max: Math.round(max * 100) / 100,
        avg: Math.round(avg * 100) / 100,
        median: Math.round(median * 100) / 100,
        p95: Math.round(p95 * 100) / 100
      }
    };
  }

  /**
   * Benchmark all RPCs for a chain
   */
  async benchmarkChain(chain, rounds = 5) {
    const chainConfig = config[chain];
    if (!chainConfig) {
      throw new Error(`Unknown chain: ${chain}`);
    }

    const isSolana = chain === 'solana';
    const method = isSolana ? 'getSlot' : 'eth_blockNumber';
    const params = [];

    console.log(`\n🔍 Benchmarking ${chainConfig.name} (${rounds} rounds each)...\n`);

    const results = [];
    
    for (const rpc of chainConfig.rpcs) {
      process.stdout.write(`  Testing ${rpc.name.padEnd(15)}... `);
      const result = await this.benchmarkRPC(rpc.url, rounds, method, params);
      result.name = rpc.name;
      results.push(result);

      if (result.success) {
        console.log(`✅ avg: ${result.latency.avg}ms | p95: ${result.latency.p95}ms`);
      } else {
        console.log(`❌ ${result.error}`);
      }
    }

    results.sort((a, b) => {
      if (!a.success) return 1;
      if (!b.success) return -1;
      return a.latency.avg - b.latency.avg;
    });

    this.results.set(chain, {
      chain,
      timestamp: Date.now(),
      results
    });

    return results;
  }

  /**
   * Benchmark all chains
   */
  async benchmarkAll(rounds = 5) {
    const chains = Object.keys(config);
    const allResults = {};

    for (const chain of chains) {
      allResults[chain] = await this.benchmarkChain(chain, rounds);
    }

    return allResults;
  }

  /**
   * Get fastest RPC for a chain
   */
  getFastest(chain) {
    const chainResults = this.results.get(chain);
    if (!chainResults) return null;

    const successful = chainResults.results.filter(r => r.success);
    if (successful.length === 0) return null;

    return successful[0];
  }

  /**
   * Get top N RPCs for a chain
   */
  getTopN(chain, n = 3) {
    const chainResults = this.results.get(chain);
    if (!chainResults) return [];

    return chainResults.results
      .filter(r => r.success)
      .slice(0, n);
  }

  /**
   * Print results table
   */
  printResults(chain) {
    const chainResults = this.results.get(chain);
    if (!chainResults) {
      console.log(`No results for ${chain}`);
      return;
    }

    console.log(`\n📊 Results for ${chain.toUpperCase()}`);
    console.log('─'.repeat(70));
    console.log('Rank │ Name            │ Avg (ms) │ P95 (ms) │ Min (ms) │ Success');
    console.log('─'.repeat(70));

    chainResults.results.forEach((r, i) => {
      if (r.success) {
        console.log(
          `  ${(i + 1).toString().padStart(2)}` +
          ` │ ${r.name.padEnd(15)}` +
          ` │ ${r.latency.avg.toFixed(1).padStart(8)}` +
          ` │ ${r.latency.p95.toFixed(1).padStart(8)}` +
          ` │ ${r.latency.min.toFixed(1).padStart(8)}` +
          ` │ ${r.successRate.toFixed(0)}%`
        );
      } else {
        console.log(
          `  ${(i + 1).toString().padStart(2)}` +
          ` │ ${r.name.padEnd(15)}` +
          ` │ ${'FAILED'.padStart(8)}` +
          ` │ ${'-'.padStart(8)}` +
          ` │ ${'-'.padStart(8)}` +
          ` │ 0%`
        );
      }
    });

    console.log('─'.repeat(70));
  }
}

let instance = null;

export function getBenchmark() {
  if (!instance) {
    instance = new RPCBenchmark();
  }
  return instance;
}

export default RPCBenchmark;

// CLI runner
if (process.argv[1].includes('benchmark')) {
  const benchmark = getBenchmark();
  const chain = process.argv[2] || 'all';
  const rounds = parseInt(process.argv[3]) || 5;

  console.log('🚀 RPC Benchmark Tool');
  console.log('====================');

  (async () => {
    if (chain === 'all') {
      await benchmark.benchmarkAll(rounds);
      for (const c of Object.keys(config)) {
        benchmark.printResults(c);
      }
    } else {
      await benchmark.benchmarkChain(chain, rounds);
      benchmark.printResults(chain);
    }

    console.log('\n🏆 Fastest RPCs:');
    for (const c of Object.keys(config)) {
      const fastest = benchmark.getFastest(c);
      if (fastest) {
        console.log(`  ${c.padEnd(10)}: ${fastest.name} (${fastest.latency.avg}ms avg)`);
      }
    }

    process.exit(0);
  })();
}