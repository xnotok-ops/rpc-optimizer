//! RPC Benchmark Module
//! 
//! Test latency and pick fastest RPC automatically

use crate::config::{ChainConfig, Config, RpcEndpoint};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tracing::{info, warn};

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
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct LatencyResult {
    pub url: String,
    pub name: String,
    pub success: bool,
    pub latency_ms: f64,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BenchmarkResult {
    pub url: String,
    pub name: String,
    pub success: bool,
    pub rounds: usize,
    pub success_rate: f64,
    pub latency: Option<LatencyStats>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LatencyStats {
    pub min: f64,
    pub max: f64,
    pub avg: f64,
    pub median: f64,
    pub p95: f64,
}

pub struct Benchmark {
    client: reqwest::Client,
    results: HashMap<String, Vec<BenchmarkResult>>,
}

impl Benchmark {
    /// Create new benchmark instance
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .pool_max_idle_per_host(10)
            .build()
            .expect("Failed to create HTTP client");

        Self {
            client,
            results: HashMap::new(),
        }
    }

    /// Measure single request latency
    pub async fn measure_latency(
        &self,
        url: &str,
        method: &str,
        params: Vec<serde_json::Value>,
    ) -> LatencyResult {
        let request = RpcRequest {
            jsonrpc: "2.0".to_string(),
            id: 1,
            method: method.to_string(),
            params,
        };

        let start = Instant::now();

        let result = self
            .client
            .post(url)
            .json(&request)
            .send()
            .await;

        let latency_ms = start.elapsed().as_secs_f64() * 1000.0;

        match result {
            Ok(response) => {
                match response.json::<RpcResponse>().await {
                    Ok(rpc_response) => {
                        if let Some(error) = rpc_response.error {
                            LatencyResult {
                                url: url.to_string(),
                                name: String::new(),
                                success: false,
                                latency_ms,
                                error: Some(error.message),
                            }
                        } else {
                            LatencyResult {
                                url: url.to_string(),
                                name: String::new(),
                                success: true,
                                latency_ms,
                                error: None,
                            }
                        }
                    }
                    Err(e) => LatencyResult {
                        url: url.to_string(),
                        name: String::new(),
                        success: false,
                        latency_ms,
                        error: Some(e.to_string()),
                    },
                }
            }
            Err(e) => LatencyResult {
                url: url.to_string(),
                name: String::new(),
                success: false,
                latency_ms: 10000.0,
                error: Some(e.to_string()),
            },
        }
    }

    /// Benchmark single RPC with multiple rounds
    pub async fn benchmark_rpc(
        &self,
        endpoint: &RpcEndpoint,
        rounds: usize,
        method: &str,
        params: Vec<serde_json::Value>,
    ) -> BenchmarkResult {
        let mut latencies: Vec<f64> = Vec::new();
        let mut success_count = 0;
        let mut last_error: Option<String> = None;

        for _ in 0..rounds {
            let result = self.measure_latency(&endpoint.url, method, params.clone()).await;

            if result.success {
                latencies.push(result.latency_ms);
                success_count += 1;
            } else {
                last_error = result.error;
            }

            // Small delay between requests
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        if latencies.is_empty() {
            return BenchmarkResult {
                url: endpoint.url.clone(),
                name: endpoint.name.clone(),
                success: false,
                rounds,
                success_rate: 0.0,
                latency: None,
                error: last_error,
            };
        }

        // Calculate stats
        latencies.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let min = latencies[0];
        let max = latencies[latencies.len() - 1];
        let avg = latencies.iter().sum::<f64>() / latencies.len() as f64;
        let median = latencies[latencies.len() / 2];
        let p95_idx = ((latencies.len() as f64) * 0.95) as usize;
        let p95 = latencies.get(p95_idx).copied().unwrap_or(max);

        BenchmarkResult {
            url: endpoint.url.clone(),
            name: endpoint.name.clone(),
            success: true,
            rounds,
            success_rate: (success_count as f64 / rounds as f64) * 100.0,
            latency: Some(LatencyStats {
                min: round_2(min),
                max: round_2(max),
                avg: round_2(avg),
                median: round_2(median),
                p95: round_2(p95),
            }),
            error: None,
        }
    }

    /// Benchmark all RPCs for a chain
    pub async fn benchmark_chain(
        &mut self,
        chain: &str,
        chain_config: &ChainConfig,
        rounds: usize,
    ) -> Vec<BenchmarkResult> {
        let is_solana = chain == "solana";
        let method = if is_solana { "getSlot" } else { "eth_blockNumber" };
        let params: Vec<serde_json::Value> = vec![];

        println!("\n🔍 Benchmarking {} ({} rounds each)...\n", chain_config.name, rounds);

        let mut results: Vec<BenchmarkResult> = Vec::new();

        for rpc in &chain_config.rpcs {
            print!("  Testing {:15}... ", rpc.name);

            let result = self.benchmark_rpc(rpc, rounds, method, params.clone()).await;

            if result.success {
                if let Some(ref lat) = result.latency {
                    println!("✅ avg: {:.1}ms | p95: {:.1}ms", lat.avg, lat.p95);
                }
            } else {
                println!("❌ {}", result.error.as_deref().unwrap_or("Unknown error"));
            }

            results.push(result);
        }

        // Sort by avg latency (fastest first)
        results.sort_by(|a, b| {
            match (&a.latency, &b.latency) {
                (Some(la), Some(lb)) => la.avg.partial_cmp(&lb.avg).unwrap(),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
        });

        self.results.insert(chain.to_string(), results.clone());
        results
    }

    /// Benchmark all chains
    pub async fn benchmark_all(&mut self, config: &Config, rounds: usize) -> HashMap<String, Vec<BenchmarkResult>> {
        let mut all_results = HashMap::new();

        for (chain, chain_config) in config {
            let results = self.benchmark_chain(chain, chain_config, rounds).await;
            all_results.insert(chain.clone(), results);
        }

        all_results
    }

    /// Get fastest RPC for a chain
    pub fn get_fastest(&self, chain: &str) -> Option<&BenchmarkResult> {
        self.results
            .get(chain)?
            .iter()
            .find(|r| r.success)
    }

    /// Get top N RPCs for a chain
    pub fn get_top_n(&self, chain: &str, n: usize) -> Vec<&BenchmarkResult> {
        self.results
            .get(chain)
            .map(|results| {
                results
                    .iter()
                    .filter(|r| r.success)
                    .take(n)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Print results table
    pub fn print_results(&self, chain: &str) {
        let results = match self.results.get(chain) {
            Some(r) => r,
            None => {
                println!("No results for {}", chain);
                return;
            }
        };

        println!("\n📊 Results for {}", chain.to_uppercase());
        println!("{}", "─".repeat(70));
        println!("Rank │ Name            │ Avg (ms) │ P95 (ms) │ Min (ms) │ Success");
        println!("{}", "─".repeat(70));

        for (i, r) in results.iter().enumerate() {
            if r.success {
                if let Some(ref lat) = r.latency {
                    println!(
                        "  {:2} │ {:15} │ {:8.1} │ {:8.1} │ {:8.1} │ {:.0}%",
                        i + 1,
                        r.name,
                        lat.avg,
                        lat.p95,
                        lat.min,
                        r.success_rate
                    );
                }
            } else {
                println!(
                    "  {:2} │ {:15} │ {:>8} │ {:>8} │ {:>8} │ 0%",
                    i + 1,
                    r.name,
                    "FAILED",
                    "-",
                    "-"
                );
            }
        }

        println!("{}", "─".repeat(70));
    }
}

impl Default for Benchmark {
    fn default() -> Self {
        Self::new()
    }
}

fn round_2(val: f64) -> f64 {
    (val * 100.0).round() / 100.0
}