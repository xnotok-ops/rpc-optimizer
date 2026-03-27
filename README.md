# 🚀 RPC Optimizer

High-performance RPC optimization for **EVM (Ethereum/Base)** & **Solana** — with both Node.js and Rust implementations.

[![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js)](https://nodejs.org/)
[![Rust](https://img.shields.io/badge/Rust-1.70+-orange?logo=rust)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## ⚡ Performance

| Metric | Node.js | Rust |
|--------|---------|------|
| Batch 5 RPC calls | 188ms | **53ms** |
| Binary size | ~200MB | ~3MB |
| Cold start | ~500ms | Instant |

**Rust is 3.5x faster** for latency-critical operations like minting & arbitrage.

---

## ✨ Features

| Feature | Node.js | Rust | Description |
|---------|:-------:|:----:|-------------|
| **Benchmark RPCs** | ✅ | ✅ | Auto-find fastest RPC endpoint |
| **Multi-RPC Failover** | ✅ | ✅ | Auto-switch on failures |
| **Request Batching** | ✅ | ✅ | Combine calls into 1 HTTP request |
| **Nonce Caching** | ✅ | ✅ | Pre-fetch for fast tx building |
| **Retry + Backoff** | ✅ | ✅ | Exponential/Fibonacci strategies |
| **Rate Limiter** | ✅ | ✅ | Token bucket algorithm |
| **Circuit Breaker** | ✅ | ✅ | Prevent cascade failures |
| **WebSocket** | ✅ | - | Real-time subscriptions |
| **EVM Client** | ✅ | - | High-level ETH/Base API |
| **Solana Client** | ✅ | - | High-level Solana API |

---

## 🔗 Supported Chains

| Chain | RPCs Included |
|-------|---------------|
| **Ethereum** | Llama, PublicNode, dRPC, MEVBlocker |
| **Base** | Base Official, Llama, PublicNode, dRPC |
| **Solana** | Solana Official, PublicNode, dRPC |

---

## 📦 Installation

### Node.js
```bash
cd node
npm install
npm run example
```

### Rust
```bash
cd rust
cargo build --release
cargo run --release
```

---

## 🚀 Quick Start

### Node.js
```javascript
import { createEVMClient, createSolanaClient } from './src/index.js';

// Create client
const eth = createEVMClient('ethereum');

// Auto-select fastest RPC
await eth.warmup(['0xYourWallet...']);

// Use it
const block = await eth.getBlockNumber();
const balance = await eth.getBalance('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');

console.log('Block:', block);
console.log('Balance:', balance, 'ETH');
```

### Rust
```rust
use rpc_optimizer::*;

#[tokio::main]
async fn main() {
    // Benchmark and find fastest
    let config = default_config();
    let mut benchmark = create_benchmark();
    
    if let Some(eth_config) = config.get("ethereum") {
        benchmark.benchmark_chain("ethereum", eth_config, 3).await;
        benchmark.print_results("ethereum");
    }

    // Batch requests
    let result = batch("https://eth.drpc.org")
        .get_balance("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "latest")
        .block_number()
        .gas_price()
        .execute()
        .await;

    println!("Batch completed in {}ms", result.latency_ms);
}
```

---

## 📊 Benchmark Example
```
🔍 Benchmarking Ethereum Mainnet (3 rounds each)...

  Testing Llama          ... ✅ avg: 212.8ms | p95: 212.8ms
  Testing PublicNode     ... ✅ avg: 214.7ms | p95: 263.8ms
  Testing dRPC           ... ✅ avg: 50.6ms  | p95: 73.9ms
  Testing MEVBlocker     ... ✅ avg: 706.6ms | p95: 997.9ms

📊 Results for ETHEREUM
──────────────────────────────────────────────────────────────────
Rank │ Name            │ Avg (ms) │ P95 (ms) │ Min (ms) │ Success
──────────────────────────────────────────────────────────────────
   1 │ dRPC            │     50.6 │     73.9 │     33.9 │ 100%
   2 │ PublicNode      │    214.7 │    263.8 │    180.6 │ 100%
   3 │ Llama           │    212.8 │    212.8 │    212.8 │ 33%
   4 │ MEVBlocker      │    706.6 │    997.9 │    555.8 │ 100%
──────────────────────────────────────────────────────────────────

✅ Fastest: dRPC (50.6ms avg)
```

---

## 🔧 Use Cases

| Use Case | Recommended |
|----------|-------------|
| **FCFS NFT Minting** | Rust (microseconds matter) |
| **Arbitrage Bot** | Rust (latency critical) |
| **MEV Bot** | Rust (racing other bots) |
| **Monitoring/Alerts** | Node.js (easier to build) |
| **Dashboard/API** | Node.js (rich ecosystem) |
| **Prototyping** | Node.js (fast iteration) |

---

## 📁 Project Structure
```
rpc-optimizer/
├── node/                   # Node.js implementation
│   ├── src/
│   │   ├── index.js        # Main exports
│   │   ├── config.js       # RPC configuration
│   │   ├── benchmark.js    # Latency testing
│   │   ├── failover.js     # Multi-RPC failover
│   │   ├── batch.js        # Request batching
│   │   ├── nonce.js        # Nonce caching
│   │   ├── retry.js        # Retry strategies
│   │   ├── websocket.js    # WebSocket support
│   │   └── chains/
│   │       ├── evm.js      # ETH/Base client
│   │       └── solana.js   # Solana client
│   ├── config/
│   │   └── rpcs.json       # RPC endpoints
│   ├── examples/
│   │   └── usage.js        # Example usage
│   └── package.json
│
└── rust/                   # Rust implementation
    ├── src/
    │   ├── lib.rs          # Library exports
    │   ├── main.rs         # Example runner
    │   ├── config.rs       # RPC configuration
    │   ├── benchmark.rs    # Latency testing
    │   ├── failover.rs     # Multi-RPC failover
    │   ├── batch.rs        # Request batching
    │   ├── nonce.rs        # Nonce caching
    │   └── retry.rs        # Retry strategies
    └── Cargo.toml
```

---

## 🤝 Contributing

1. Fork the repo
2. Create feature branch (`git checkout -b feature/amazing`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing`)
5. Open a Pull Request

---

## 📄 License

MIT License - feel free to use in your projects!

---

## 🔗 Related Projects

- [bounty-radar](https://github.com/xnotok-ops/bounty-radar) - Bug bounty research dashboard
- [github-radar](https://github.com/xnotok-ops/github-radar) - Trending GitHub repos tracker
- [hf-radar](https://github.com/xnotok-ops/hf-radar) - HuggingFace trending tracker

---

**Built with ⚡ by [@xnotok](https://github.com/xnotok-ops)**