//! RPC Optimizer
//!
//! High-performance RPC optimization for EVM & Solana
//!
//! Features:
//! - Connection pooling
//! - Multi-RPC failover
//! - Latency benchmarking
//! - Request batching
//! - Nonce caching
//! - Retry with backoff
//! - Rate limiting
//! - Circuit breaker

pub mod config;
pub mod benchmark;
pub mod failover;
pub mod batch;
pub mod nonce;
pub mod retry;

// Re-exports
pub use config::{default_config, ChainConfig, Config, RpcEndpoint};
pub use benchmark::{Benchmark, BenchmarkResult, LatencyResult, LatencyStats};
pub use failover::{FailoverManager, FailoverOptions, RequestResult, RpcStatusInfo};
pub use batch::{batch, BatchBuilder, BatchExecuteResult, BatchResult};
pub use nonce::{NonceManager, NonceOptions, NonceResult, SolanaBlockhashManager, BlockhashResult};
pub use retry::{
    retry, is_retryable, 
    RetryOptions, RetryResult, Strategy,
    RateLimiter, RateLimiterState,
    CircuitBreaker, CircuitBreakerError, CircuitBreakerState, CircuitState,
};

/// Library version
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Quick start: Create EVM client for a chain
pub fn create_failover(chain: &str) -> Option<FailoverManager> {
    let config = default_config();
    let chain_config = config.get(chain)?;
    Some(FailoverManager::new(chain, chain_config, None))
}

/// Quick start: Create benchmark instance
pub fn create_benchmark() -> Benchmark {
    Benchmark::new()
}

/// Quick start: Create nonce manager
pub fn create_nonce_manager() -> NonceManager {
    NonceManager::new(None)
}

/// Quick start: Create Solana blockhash manager
pub fn create_blockhash_manager() -> SolanaBlockhashManager {
    SolanaBlockhashManager::new(None)
}

/// Quick start: Create rate limiter (default: 10 req/sec)
pub fn create_rate_limiter(max_per_second: usize) -> RateLimiter {
    RateLimiter::new(max_per_second, max_per_second, 1000)
}

/// Quick start: Create circuit breaker
pub fn create_circuit_breaker() -> CircuitBreaker {
    CircuitBreaker::new(5, 3, 30000)
}