//! Nonce Cache Manager
//!
//! Pre-fetch and cache nonces for fast transaction building

use crate::batch::batch;
use crate::failover::FailoverManager;
use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

#[derive(Debug, Clone)]
pub struct NonceEntry {
    pub nonce: u64,
    pub pending: u64,
    pub timestamp: Instant,
}

#[derive(Debug, Clone)]
pub struct NonceResult {
    pub nonce: u64,
    pub cached: bool,
    pub pending: u64,
    pub stale: bool,
}

#[derive(Debug, Clone)]
pub struct NonceOptions {
    pub cache_time_ms: u64,
    pub auto_increment: bool,
}

impl Default for NonceOptions {
    fn default() -> Self {
        Self {
            cache_time_ms: 10000, // 10 seconds
            auto_increment: true,
        }
    }
}

/// EVM Nonce Manager
pub struct NonceManager {
    cache: Arc<RwLock<HashMap<String, NonceEntry>>>,
    options: NonceOptions,
}

impl NonceManager {
    /// Create new nonce manager
    pub fn new(options: Option<NonceOptions>) -> Self {
        Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
            options: options.unwrap_or_default(),
        }
    }

    /// Get cached nonce or fetch from RPC
    pub async fn get(&self, address: &str, failover: &FailoverManager) -> Result<NonceResult> {
        let addr = address.to_lowercase();
        let now = Instant::now();

        // Check cache
        {
            let cache = self.cache.read().await;
            if let Some(entry) = cache.get(&addr) {
                if now.duration_since(entry.timestamp).as_millis() < self.options.cache_time_ms as u128 {
                    return Ok(NonceResult {
                        nonce: entry.nonce + entry.pending,
                        cached: true,
                        pending: entry.pending,
                        stale: false,
                    });
                }
            }
        }

        // Fetch fresh nonce
        let result = failover
            .request("eth_getTransactionCount", vec![
                serde_json::json!(addr),
                serde_json::json!("pending"),
            ])
            .await;

        if !result.success {
            // Return stale cache if available
            let cache = self.cache.read().await;
            if let Some(entry) = cache.get(&addr) {
                return Ok(NonceResult {
                    nonce: entry.nonce + entry.pending,
                    cached: true,
                    pending: entry.pending,
                    stale: true,
                });
            }
            anyhow::bail!("Failed to get nonce for {}: {:?}", addr, result.error);
        }

        // Parse nonce from hex
        let nonce = match &result.result {
            Some(serde_json::Value::String(hex)) => {
                u64::from_str_radix(hex.trim_start_matches("0x"), 16)?
            }
            _ => anyhow::bail!("Invalid nonce response"),
        };

        // Update cache
        {
            let mut cache = self.cache.write().await;
            cache.insert(
                addr,
                NonceEntry {
                    nonce,
                    pending: 0,
                    timestamp: now,
                },
            );
        }

        Ok(NonceResult {
            nonce,
            cached: false,
            pending: 0,
            stale: false,
        })
    }

    /// Get nonce and auto-increment pending counter
    pub async fn get_and_increment(&self, address: &str, failover: &FailoverManager) -> Result<u64> {
        let result = self.get(address, failover).await?;
        let addr = address.to_lowercase();

        if self.options.auto_increment {
            let mut cache = self.cache.write().await;
            if let Some(entry) = cache.get_mut(&addr) {
                entry.pending += 1;
            }
        }

        Ok(result.nonce)
    }

    /// Pre-fetch nonces for multiple addresses
    pub async fn prefetch(
        &self,
        addresses: &[&str],
        rpc_url: &str,
    ) -> Vec<PrefetchResult> {
        let mut results = Vec::new();
        let now = Instant::now();

        // Check which need fetching
        let mut to_fetch: Vec<String> = Vec::new();
        {
            let cache = self.cache.read().await;
            for addr in addresses {
                let addr_lower = addr.to_lowercase();
                if let Some(entry) = cache.get(&addr_lower) {
                    if now.duration_since(entry.timestamp).as_millis() < self.options.cache_time_ms as u128 {
                        results.push(PrefetchResult {
                            address: addr_lower,
                            nonce: Some(entry.nonce),
                            cached: true,
                            error: None,
                        });
                        continue;
                    }
                }
                to_fetch.push(addr_lower);
            }
        }

        // Batch fetch remaining
        if !to_fetch.is_empty() {
            let mut batch_builder = batch(rpc_url);
            for addr in &to_fetch {
                batch_builder = batch_builder.get_nonce(addr, "pending");
            }

            let batch_result = batch_builder.execute().await;

            if batch_result.success {
                let mut cache = self.cache.write().await;

                for (i, addr) in to_fetch.iter().enumerate() {
                    if let Some(res) = batch_result.results.get(i) {
                        if res.success {
                            if let Some(serde_json::Value::String(hex)) = &res.result {
                                if let Ok(nonce) = u64::from_str_radix(hex.trim_start_matches("0x"), 16) {
                                    cache.insert(
                                        addr.clone(),
                                        NonceEntry {
                                            nonce,
                                            pending: 0,
                                            timestamp: now,
                                        },
                                    );
                                    results.push(PrefetchResult {
                                        address: addr.clone(),
                                        nonce: Some(nonce),
                                        cached: false,
                                        error: None,
                                    });
                                    continue;
                                }
                            }
                        }
                        results.push(PrefetchResult {
                            address: addr.clone(),
                            nonce: None,
                            cached: false,
                            error: res.error.clone(),
                        });
                    }
                }
            } else {
                for addr in to_fetch {
                    results.push(PrefetchResult {
                        address: addr,
                        nonce: None,
                        cached: false,
                        error: batch_result.error.clone(),
                    });
                }
            }
        }

        results
    }

    /// Manually set nonce
    pub async fn set(&self, address: &str, nonce: u64) {
        let addr = address.to_lowercase();
        let mut cache = self.cache.write().await;
        cache.insert(
            addr,
            NonceEntry {
                nonce,
                pending: 0,
                timestamp: Instant::now(),
            },
        );
    }

    /// Increment pending count
    pub async fn increment(&self, address: &str) {
        let addr = address.to_lowercase();
        let mut cache = self.cache.write().await;
        if let Some(entry) = cache.get_mut(&addr) {
            entry.pending += 1;
        }
    }

    /// Reset pending count (after tx confirmed)
    pub async fn reset_pending(&self, address: &str) {
        let addr = address.to_lowercase();
        let mut cache = self.cache.write().await;
        if let Some(entry) = cache.get_mut(&addr) {
            entry.nonce += entry.pending;
            entry.pending = 0;
            entry.timestamp = Instant::now();
        }
    }

    /// Invalidate cache for address
    pub async fn invalidate(&self, address: &str) {
        let addr = address.to_lowercase();
        let mut cache = self.cache.write().await;
        cache.remove(&addr);
    }

    /// Clear all cache
    pub async fn clear(&self) {
        let mut cache = self.cache.write().await;
        cache.clear();
    }

    /// Get cache stats
    pub async fn get_stats(&self) -> NonceStats {
        let cache = self.cache.read().await;
        let now = Instant::now();

        let addresses: Vec<AddressNonceInfo> = cache
            .iter()
            .map(|(addr, entry)| {
                let age_ms = now.duration_since(entry.timestamp).as_millis() as u64;
                AddressNonceInfo {
                    address: addr.clone(),
                    nonce: entry.nonce,
                    pending: entry.pending,
                    effective_nonce: entry.nonce + entry.pending,
                    age_ms,
                    valid: age_ms < self.options.cache_time_ms,
                }
            })
            .collect();

        NonceStats {
            total_cached: cache.len(),
            addresses,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PrefetchResult {
    pub address: String,
    pub nonce: Option<u64>,
    pub cached: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NonceStats {
    pub total_cached: usize,
    pub addresses: Vec<AddressNonceInfo>,
}

#[derive(Debug, Clone)]
pub struct AddressNonceInfo {
    pub address: String,
    pub nonce: u64,
    pub pending: u64,
    pub effective_nonce: u64,
    pub age_ms: u64,
    pub valid: bool,
}

/// Solana blockhash manager (Solana's equivalent of nonce)
pub struct SolanaBlockhashManager {
    blockhash: Arc<RwLock<Option<BlockhashEntry>>>,
    cache_time_ms: u64,
}

#[derive(Debug, Clone)]
pub struct BlockhashEntry {
    pub blockhash: String,
    pub last_valid_block_height: u64,
    pub timestamp: Instant,
}

#[derive(Debug, Clone)]
pub struct BlockhashResult {
    pub blockhash: String,
    pub last_valid_block_height: u64,
    pub cached: bool,
    pub stale: bool,
}

impl SolanaBlockhashManager {
    /// Create new blockhash manager
    pub fn new(cache_time_ms: Option<u64>) -> Self {
        Self {
            blockhash: Arc::new(RwLock::new(None)),
            cache_time_ms: cache_time_ms.unwrap_or(5000), // 5 seconds for Solana
        }
    }

    /// Get recent blockhash
    pub async fn get_blockhash(&self, failover: &FailoverManager) -> Result<BlockhashResult> {
        let now = Instant::now();

        // Check cache
        {
            let cache = self.blockhash.read().await;
            if let Some(entry) = &*cache {
                if now.duration_since(entry.timestamp).as_millis() < self.cache_time_ms as u128 {
                    return Ok(BlockhashResult {
                        blockhash: entry.blockhash.clone(),
                        last_valid_block_height: entry.last_valid_block_height,
                        cached: true,
                        stale: false,
                    });
                }
            }
        }

        // Fetch fresh
        let result = failover
            .request("getLatestBlockhash", vec![
                serde_json::json!({ "commitment": "finalized" }),
            ])
            .await;

        if !result.success {
            // Return stale if available
            let cache = self.blockhash.read().await;
            if let Some(entry) = &*cache {
                return Ok(BlockhashResult {
                    blockhash: entry.blockhash.clone(),
                    last_valid_block_height: entry.last_valid_block_height,
                    cached: true,
                    stale: true,
                });
            }
            anyhow::bail!("Failed to get blockhash: {:?}", result.error);
        }

        // Parse response
        let value = result.result.ok_or_else(|| anyhow::anyhow!("No result"))?;
        let blockhash = value["value"]["blockhash"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid blockhash"))?
            .to_string();
        let last_valid_block_height = value["value"]["lastValidBlockHeight"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("Invalid lastValidBlockHeight"))?;

        // Update cache
        {
            let mut cache = self.blockhash.write().await;
            *cache = Some(BlockhashEntry {
                blockhash: blockhash.clone(),
                last_valid_block_height,
                timestamp: now,
            });
        }

        Ok(BlockhashResult {
            blockhash,
            last_valid_block_height,
            cached: false,
            stale: false,
        })
    }

    /// Clear cache
    pub async fn clear(&self) {
        let mut cache = self.blockhash.write().await;
        *cache = None;
    }

    /// Get stats
    pub async fn get_stats(&self) -> Option<BlockhashStats> {
        let cache = self.blockhash.read().await;
        cache.as_ref().map(|entry| {
            let now = Instant::now();
            let age_ms = now.duration_since(entry.timestamp).as_millis() as u64;
            BlockhashStats {
                blockhash: entry.blockhash.clone(),
                last_valid_block_height: entry.last_valid_block_height,
                age_ms,
                valid: age_ms < self.cache_time_ms,
            }
        })
    }
}

#[derive(Debug, Clone)]
pub struct BlockhashStats {
    pub blockhash: String,
    pub last_valid_block_height: u64,
    pub age_ms: u64,
    pub valid: bool,
}