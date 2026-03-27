\# 🚀 RPC Optimizer



\[!\[Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

\[!\[License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)



High-performance RPC optimization module for \*\*EVM (Ethereum/Base)\*\* and \*\*Solana\*\* chains.



Built for speed-critical applications: mint bots, arbitrage, trading, MEV.



\---



\## ✨ Features



| Feature | Description |

|---------|-------------|

| 🔌 \*\*Connection Pooling\*\* | Keep HTTP connections warm, avoid cold start penalty |

| 🔄 \*\*Multi-RPC Failover\*\* | Auto-switch to backup RPC on failure |

| ⚡ \*\*Latency Benchmark\*\* | Test and pick fastest RPC automatically |

| 📦 \*\*Request Batching\*\* | Multiple calls → 1 HTTP request |

| 🔢 \*\*Nonce Caching\*\* | Pre-fetch nonces for fast transaction building |

| 🔁 \*\*Retry + Backoff\*\* | Handle rate limits gracefully |

| 📡 \*\*WebSocket Support\*\* | Real-time updates via persistent connections |

| 🛡️ \*\*Circuit Breaker\*\* | Prevent cascade failures |

| ⏱️ \*\*Rate Limiter\*\* | Token bucket algorithm |



\---



\## 🔗 Supported Chains



| Chain | HTTP | WebSocket |

|-------|------|-----------|

| Ethereum | ✅ | ✅ |

| Base | ✅ | ✅ |

| Solana | ✅ | ✅ |



\---



\## 📦 Installation

```bash

npm install

```



\---



\## 🚀 Quick Start



\### Benchmark RPCs

```javascript

import { getBenchmark } from './src/index.js';



const benchmark = getBenchmark();

await benchmark.benchmarkChain('ethereum', 5);

benchmark.printResults('ethereum');



const fastest = benchmark.getFastest('ethereum');

console.log(`Fastest: ${fastest.name} (${fastest.latency.avg}ms)`);

```



\### EVM Client (Ethereum/Base)

```javascript

import { createEVMClient, formatEther } from './src/index.js';



const eth = createEVMClient('ethereum');



// Warmup (benchmark + prefetch)

await eth.warmup(\['0xYourWallet...']);



// Get data

const block = await eth.getBlockNumber();

const balance = await eth.getBalance('0x...');

const feeData = await eth.getFeeData();



console.log(`Block: ${block}`);

console.log(`Balance: ${formatEther(balance)} ETH`);

```



\### Solana Client

```javascript

import { createSolanaClient, lamportsToSol } from './src/index.js';



const sol = createSolanaClient();



// Warmup

await sol.warmup();



// Get data

const slot = await sol.getSlot();

const balance = await sol.getBalance('pubkey...');

const priorityFee = await sol.getRecommendedPriorityFee();



console.log(`Slot: ${slot}`);

console.log(`Balance: ${lamportsToSol(balance)} SOL`);

```



\### Request Batching

```javascript

import { batch, getFailover } from './src/index.js';



const failover = getFailover('ethereum');

const rpc = failover.getCurrent();



// Batch multiple calls into 1 HTTP request

const result = await batch(rpc.url)

&#x20; .getBalance('0xAddress1')

&#x20; .getBalance('0xAddress2')

&#x20; .getBalance('0xAddress3')

&#x20; .blockNumber()

&#x20; .gasPrice()

&#x20; .execute();



console.log(`5 calls in ${result.latency}ms`);

```



\### Failover

```javascript

import { getFailover } from './src/index.js';



const failover = getFailover('ethereum');



// Auto-switch on failure

const result = await failover.request('eth\_blockNumber');

console.log(`Block: ${result.result} via ${result.rpc}`);



// Auto-select fastest RPC

await failover.autoSelect();

```



\### Nonce Management

```javascript

import { getNonceManager } from './src/index.js';



const nonces = getNonceManager('ethereum');



// Prefetch for multiple wallets

await nonces.prefetch(\['0xWallet1', '0xWallet2', '0xWallet3']);



// Get and auto-increment

const nonce = await nonces.getAndIncrement('0xWallet1');

```



\### Retry with Backoff

```javascript

import { retry, Strategy } from './src/index.js';



const result = await retry(

&#x20; async (attempt) => {

&#x20;   // Your function that might fail

&#x20;   return await riskyOperation();

&#x20; },

&#x20; {

&#x20;   maxRetries: 5,

&#x20;   initialDelay: 100,

&#x20;   strategy: Strategy.EXPONENTIAL,

&#x20;   onRetry: ({ attempt, delay }) => {

&#x20;     console.log(`Retry ${attempt} in ${delay}ms`);

&#x20;   }

&#x20; }

);

```



\### Rate Limiter

```javascript

import { RateLimiter } from './src/index.js';



const limiter = new RateLimiter({

&#x20; maxTokens: 10,      // 10 requests

&#x20; refillRate: 1,      // 1 token per interval

&#x20; refillInterval: 1000 // 1 second

});



// Execute with rate limiting

await limiter.execute(async () => {

&#x20; await makeRequest();

});

```



\### WebSocket (Real-time)

```javascript

import { createWebSocket } from './src/index.js';



const ws = createWebSocket('ethereum');

await ws.connect();



// Subscribe to new blocks

await ws.subscribeNewHeads((block) => {

&#x20; console.log(`New block: ${parseInt(block.number, 16)}`);

});



// Subscribe to pending transactions

await ws.subscribePendingTx((txHash) => {

&#x20; console.log(`Pending tx: ${txHash}`);

});



// Events

ws.on('connected', () => console.log('Connected!'));

ws.on('disconnected', () => console.log('Disconnected!'));

```



\---



\## 📁 Project Structure

```

rpc-optimizer/node/

├── src/

│   ├── index.js         # Main export

│   ├── pool.js          # Connection pooling

│   ├── benchmark.js     # Latency testing

│   ├── failover.js      # Multi-RPC failover

│   ├── batch.js         # Request batching

│   ├── nonce.js         # Nonce caching

│   ├── retry.js         # Retry + backoff + rate limiter

│   ├── websocket.js     # WebSocket support

│   └── chains/

│       ├── evm.js       # Ethereum/Base client

│       └── solana.js    # Solana client

├── config/

│   └── rpcs.json        # RPC endpoints

├── examples/

│   └── usage.js         # Example usage

├── package.json

└── README.md

```



\---



\## ⚙️ Configuration



Edit `config/rpcs.json` to add/modify RPC endpoints:

```json

{

&#x20; "ethereum": {

&#x20;   "name": "Ethereum Mainnet",

&#x20;   "chainId": 1,

&#x20;   "rpcs": \[

&#x20;     { "url": "https://eth.llamarpc.com", "name": "Llama" },

&#x20;     { "url": "https://rpc.ankr.com/eth", "name": "Ankr" }

&#x20;   ],

&#x20;   "websockets": \[

&#x20;     { "url": "wss://eth.llamarpc.com", "name": "Llama WS" }

&#x20;   ]

&#x20; }

}

```



\---



\## 🏃 Run Examples

```bash

\# Run all examples

npm run example



\# Benchmark only

npm run benchmark



\# Benchmark specific chain

node src/benchmark.js ethereum 5

node src/benchmark.js base 5

node src/benchmark.js solana 5

```



\---



\## 🎯 Use Cases



\### Mint Bot

```javascript

const eth = createEVMClient('base');



// 1. Warmup 5 seconds before mint

await eth.warmup(walletAddresses);



// 2. Nonces already cached

const nonce = await eth.getNextNonce(wallet);



// 3. Fee data already cached

const feeData = await eth.getFeeData();



// 4. Build and send tx (you handle signing)

const txHash = await eth.sendRawTransaction(signedTx);



// 5. Wait for confirmation

const receipt = await eth.waitForTransaction(txHash);

```



\### Arbitrage Bot

```javascript

// Batch read prices from multiple sources

const result = await eth.batchRead(\[

&#x20; { method: 'eth\_call', params: \[{ to: uniswap, data: priceCall }] },

&#x20; { method: 'eth\_call', params: \[{ to: sushiswap, data: priceCall }] },

&#x20; { method: 'eth\_call', params: \[{ to: curve, data: priceCall }] }

]);



// All prices in 1 HTTP request!

```



\### Real-time Monitoring

```javascript

const ws = createWebSocket('ethereum');

await ws.connect();



// Monitor mempool

await ws.subscribePendingTx((txHash) => {

&#x20; // Analyze pending tx

});



// Monitor blocks

await ws.subscribeNewHeads((block) => {

&#x20; // New block arrived

});

```



\---



\## 📊 Performance



| Operation | Single RPC | With Optimizer |

|-----------|------------|----------------|

| 10 balance checks | \~1000ms | \~100ms (batched) |

| Cold start request | \~200ms | \~50ms (warm pool) |

| RPC failure recovery | Manual | Automatic (<100ms) |

| Nonce fetch | \~50ms each | Cached (\~1ms) |



\---



\## 📄 License



MIT License - feel free to use for your own projects!



\---



\*\*Built for speed by \[@xnotok](https://twitter.com/xnotok)\*\* 🚀

