//! Multi-RPC Failover Manager
//!
//! Auto-switch to backup RPC when primary fails

use crate::config::{ChainConfig, RpcEndpoint};
use crate::benchmark::Benchmark;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::{info, warn};

#[derive(Debug, Clone)]
pub struct FailoverOptions {
    pub max_retries: usize,
    pub retry_delay_ms: u64,
    pub failure_threshold: usize,
    pub recovery_time_ms: u64,
    pub timeout_ms: u64,
}

impl Default for FailoverOptions {
    fn default() -> Self {
        Self {
            max_retries: 3,
            retry_delay_ms: 100,
            failure_threshold: 3,
            recovery_time_ms: 30000,
            timeout_ms: 10000,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RpcStatus {
    pub endpoint: RpcEndpoint,
    pub index: usize,
    pub failures: usize,
    pub successes: usize,
    pub healthy: bool,
    pub last_failure: Option<Instant>,
    pub last_success: Option<Instant>,
    pub avg_latency_ms: Option<f64>,
}

impl RpcStatus {
    pub fn new(endpoint: RpcEndpoint, index: usize) -> Self {
        Self {
            endpoint,
            index,
            failures: 0,
            successes: 0,
            healthy: true,
            last_failure: None,
            last_success: None,
            avg_latency_ms: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    pub params: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcResponse {
    pub jsonrpc: String,
    pub id: u64,
    pub result: Option<serde_json::Value>,
    pub error: Option<RpcErrorDetail>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcErrorDetail {
    pub code: i64,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct RequestResult {
    pub success: bool,
    pub result: Option<serde_json::Value>,
    pub rpc_name: String,
    pub latency_ms: f64,
    pub attempts: usize,
    pub error: Option<String>,
}

pub struct FailoverManager {
    chain: String,
    rpcs: Arc<RwLock<Vec<RpcStatus>>>,
    current_index: AtomicUsize,
    options: FailoverOptions,
    client: reqwest::Client,
}

impl FailoverManager {
    /// Create new failover manager for a chain
    pub fn new(chain: &str, chain_config: &ChainConfig, options: Option<FailoverOptions>) -> Self {
        let opts = options.unwrap_or_default();

        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(opts.timeout_ms))
            .pool_max_idle_per_host(10)
            .build()
            .expect("Failed to create HTTP client");

        let rpcs: Vec<RpcStatus> = chain_config
            .rpcs
            .iter()
            .enumerate()
            .map(|(i, rpc)| RpcStatus::new(rpc.clone(), i))
            .collect();

        Self {
            chain: chain.to_string(),
            rpcs: Arc::new(RwLock::new(rpcs)),
            current_index: AtomicUsize::new(0),
            options: opts,
            client,
        }
    }

    /// Get current active RPC
    pub async fn get_current(&self) -> RpcStatus {
        let rpcs = self.rpcs.read().await;
        let idx = self.current_index.load(Ordering::SeqCst);
        rpcs[idx].clone()
    }

    /// Get all healthy RPCs
    pub async fn get_healthy(&self) -> Vec<RpcStatus> {
        let mut rpcs = self.rpcs.write().await;
        let now = Instant::now();

        for rpc in rpcs.iter_mut() {
            if !rpc.healthy {
                if let Some(last_fail) = rpc.last_failure {
                    if now.duration_since(last_fail).as_millis() as u64 > self.options.recovery_time_ms {
                        rpc.healthy = true;
                        rpc.failures = 0;
                    }
                }
            }
        }

        rpcs.iter().filter(|r| r.healthy).cloned().collect()
    }

    /// Mark RPC as failed
    async fn mark_failed(&self, index: usize, _error: &str) {
        let mut rpcs = self.rpcs.write().await;
        
        if let Some(rpc) = rpcs.get_mut(index) {
            rpc.failures += 1;
            rpc.last_failure = Some(Instant::now());

            if rpc.failures >= self.options.failure_threshold {
                rpc.healthy = false;
                warn!("⚠️ RPC {} marked unhealthy after {} failures", rpc.endpoint.name, rpc.failures);
            }
        }
    }

    /// Mark RPC as successful
    async fn mark_success(&self, index: usize, latency_ms: f64) {
        let mut rpcs = self.rpcs.write().await;
        
        if let Some(rpc) = rpcs.get_mut(index) {
            rpc.successes += 1;
            rpc.last_success = Some(Instant::now());
            rpc.failures = rpc.failures.saturating_sub(1);

            // Update average latency (EMA)
            rpc.avg_latency_ms = Some(match rpc.avg_latency_ms {
                Some(avg) => avg * 0.8 + latency_ms * 0.2,
                None => latency_ms,
            });
        }
    }

    /// Switch to next healthy RPC
    pub async fn switch_to_next(&self) -> RpcStatus {
        let healthy = self.get_healthy().await;

        if healthy.is_empty() {
            warn!("⚠️ All RPCs unhealthy, resetting...");
            let mut rpcs = self.rpcs.write().await;
            for rpc in rpcs.iter_mut() {
                rpc.healthy = true;
                rpc.failures = 0;
            }
            return rpcs[0].clone();
        }

        let current_idx = self.current_index.load(Ordering::SeqCst);
        let rpcs = self.rpcs.read().await;

        for i in 1..=rpcs.len() {
            let next_idx = (current_idx + i) % rpcs.len();
            if rpcs[next_idx].healthy {
                self.current_index.store(next_idx, Ordering::SeqCst);
                info!("🔄 Switched to RPC: {}", rpcs[next_idx].endpoint.name);
                return rpcs[next_idx].clone();
            }
        }

        rpcs[0].clone()
    }

    /// Send JSON-RPC request with failover
    pub async fn request(
        &self,
        method: &str,
        params: Vec<serde_json::Value>,
    ) -> RequestResult {
        let start_time = Instant::now();
        let mut last_error: Option<String> = None;
        let mut attempts = 0;

        let healthy = self.get_healthy().await;
        let max_attempts = std::cmp::min(self.options.max_retries, healthy.len().max(1));

        while attempts < max_attempts {
            let rpc = if attempts == 0 {
                self.get_current().await
            } else {
                self.switch_to_next().await
            };
            attempts += 1;

            match self.send_request(&rpc, method, params.clone()).await {
                Ok(result) => {
                    let latency_ms = start_time.elapsed().as_secs_f64() * 1000.0;
                    self.mark_success(rpc.index, latency_ms).await;

                    return RequestResult {
                        success: true,
                        result: Some(result),
                        rpc_name: rpc.endpoint.name,
                        latency_ms: round_2(latency_ms),
                        attempts,
                        error: None,
                    };
                }
                Err(e) => {
                    let err_msg = e.to_string();
                    self.mark_failed(rpc.index, &err_msg).await;
                    last_error = Some(err_msg);

                    if attempts < max_attempts {
                        tokio::time::sleep(Duration::from_millis(
                            self.options.retry_delay_ms * attempts as u64
                        )).await;
                    }
                }
            }
        }

        RequestResult {
            success: false,
            result: None,
            rpc_name: String::new(),
            latency_ms: start_time.elapsed().as_secs_f64() * 1000.0,
            attempts,
            error: last_error.or(Some("All RPCs failed".to_string())),
        }
    }

    /// Send single request
    async fn send_request(
        &self,
        rpc: &RpcStatus,
        method: &str,
        params: Vec<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        let request = RpcRequest {
            jsonrpc: "2.0".to_string(),
            id: 1,
            method: method.to_string(),
            params,
        };

        let response = self
            .client
            .post(&rpc.endpoint.url)
            .json(&request)
            .send()
            .await?;

        let rpc_response: RpcResponse = response.json().await?;

        if let Some(error) = rpc_response.error {
            anyhow::bail!("{}", error.message);
        }

        rpc_response
            .result
            .ok_or_else(|| anyhow::anyhow!("No result in response"))
    }

    /// Get status of all RPCs
    pub async fn get_status(&self) -> Vec<RpcStatusInfo> {
        let rpcs = self.rpcs.read().await;
        let current_idx = self.current_index.load(Ordering::SeqCst);

        rpcs.iter()
            .map(|rpc| RpcStatusInfo {
                name: rpc.endpoint.name.clone(),
                url: rpc.endpoint.url.clone(),
                healthy: rpc.healthy,
                failures: rpc.failures,
                successes: rpc.successes,
                avg_latency_ms: rpc.avg_latency_ms.map(round_2),
                is_current: rpc.index == current_idx,
            })
            .collect()
    }

    /// Set primary RPC by name
    pub async fn set_primary(&self, name: &str) -> bool {
        let rpcs = self.rpcs.read().await;
        
        if let Some(idx) = rpcs.iter().position(|r| r.endpoint.name.to_lowercase() == name.to_lowercase()) {
            self.current_index.store(idx, Ordering::SeqCst);
            return true;
        }
        
        false
    }

    /// Auto-select best RPC based on benchmark
    pub async fn auto_select(&self, chain_config: &ChainConfig) -> Option<String> {
        let mut benchmark = Benchmark::new();
        benchmark.benchmark_chain(&self.chain, chain_config, 3).await;

        if let Some(fastest) = benchmark.get_fastest(&self.chain) {
            if self.set_primary(&fastest.name).await {
                info!("✅ Auto-selected fastest RPC: {} ({:.1}ms)", 
                    fastest.name, 
                    fastest.latency.as_ref().map(|l| l.avg).unwrap_or(0.0)
                );
                return Some(fastest.name.clone());
            }
        }

        None
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RpcStatusInfo {
    pub name: String,
    pub url: String,
    pub healthy: bool,
    pub failures: usize,
    pub successes: usize,
    pub avg_latency_ms: Option<f64>,
    pub is_current: bool,
}

fn round_2(val: f64) -> f64 {
    (val * 100.0).round() / 100.0
}