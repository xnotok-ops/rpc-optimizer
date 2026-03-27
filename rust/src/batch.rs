//! Request Batching Module
//!
//! Combine multiple RPC calls into single HTTP request

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize)]
pub struct BatchRpcRequest {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    pub params: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BatchRpcResponse {
    pub jsonrpc: String,
    pub id: u64,
    pub result: Option<serde_json::Value>,
    pub error: Option<BatchRpcError>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BatchRpcError {
    pub code: i64,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct BatchResult {
    pub success: bool,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BatchExecuteResult {
    pub success: bool,
    pub results: Vec<BatchResult>,
    pub count: usize,
    pub latency_ms: f64,
    pub error: Option<String>,
}

/// Batch request builder
pub struct BatchBuilder {
    rpc_url: String,
    calls: Vec<(String, Vec<serde_json::Value>)>,
    client: reqwest::Client,
    timeout_ms: u64,
}

impl BatchBuilder {
    /// Create new batch builder
    pub fn new(rpc_url: &str) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(10)
            .build()
            .expect("Failed to create HTTP client");

        Self {
            rpc_url: rpc_url.to_string(),
            calls: Vec::new(),
            client,
            timeout_ms: 30000,
        }
    }

    /// Set custom timeout
    pub fn timeout(mut self, timeout_ms: u64) -> Self {
        self.timeout_ms = timeout_ms;
        self
    }

    /// Add generic RPC call
    pub fn call(mut self, method: &str, params: Vec<serde_json::Value>) -> Self {
        self.calls.push((method.to_string(), params));
        self
    }

    /// Add eth_call
    pub fn eth_call(self, to: &str, data: &str, block_tag: &str) -> Self {
        let params = vec![
            serde_json::json!({ "to": to, "data": data }),
            serde_json::json!(block_tag),
        ];
        self.call("eth_call", params)
    }

    /// Add eth_getBalance
    pub fn get_balance(self, address: &str, block_tag: &str) -> Self {
        let params = vec![
            serde_json::json!(address),
            serde_json::json!(block_tag),
        ];
        self.call("eth_getBalance", params)
    }

    /// Add eth_getTransactionCount (nonce)
    pub fn get_nonce(self, address: &str, block_tag: &str) -> Self {
        let params = vec![
            serde_json::json!(address),
            serde_json::json!(block_tag),
        ];
        self.call("eth_getTransactionCount", params)
    }

    /// Add eth_blockNumber
    pub fn block_number(self) -> Self {
        self.call("eth_blockNumber", vec![])
    }

    /// Add eth_gasPrice
    pub fn gas_price(self) -> Self {
        self.call("eth_gasPrice", vec![])
    }

    /// Add eth_getBlockByNumber
    pub fn get_block(self, block_number: &str, full_tx: bool) -> Self {
        let params = vec![
            serde_json::json!(block_number),
            serde_json::json!(full_tx),
        ];
        self.call("eth_getBlockByNumber", params)
    }

    /// Add eth_chainId
    pub fn chain_id(self) -> Self {
        self.call("eth_chainId", vec![])
    }

    /// Add eth_estimateGas
    pub fn estimate_gas(self, to: &str, data: &str, value: Option<&str>) -> Self {
        let mut tx = serde_json::json!({ "to": to, "data": data });
        if let Some(v) = value {
            tx["value"] = serde_json::json!(v);
        }
        self.call("eth_estimateGas", vec![tx])
    }

    /// Add Solana getSlot
    pub fn get_slot(self) -> Self {
        self.call("getSlot", vec![])
    }

    /// Add Solana getBalance
    pub fn solana_get_balance(self, pubkey: &str) -> Self {
        let params = vec![serde_json::json!(pubkey)];
        self.call("getBalance", params)
    }

    /// Add Solana getLatestBlockhash
    pub fn get_latest_blockhash(self) -> Self {
        let params = vec![serde_json::json!({ "commitment": "finalized" })];
        self.call("getLatestBlockhash", params)
    }

    /// Get number of calls in batch
    pub fn len(&self) -> usize {
        self.calls.len()
    }

    /// Check if batch is empty
    pub fn is_empty(&self) -> bool {
        self.calls.is_empty()
    }

    /// Execute batch request
    pub async fn execute(self) -> BatchExecuteResult {
        if self.calls.is_empty() {
            return BatchExecuteResult {
                success: true,
                results: vec![],
                count: 0,
                latency_ms: 0.0,
                error: None,
            };
        }

        // Build batch payload
        let batch: Vec<BatchRpcRequest> = self
            .calls
            .iter()
            .enumerate()
            .map(|(i, (method, params))| BatchRpcRequest {
                jsonrpc: "2.0".to_string(),
                id: (i + 1) as u64,
                method: method.clone(),
                params: params.clone(),
            })
            .collect();

        let count = batch.len();
        let start = Instant::now();

        // Send request
        let response = match self.client.post(&self.rpc_url).json(&batch).send().await {
            Ok(r) => r,
            Err(e) => {
                return BatchExecuteResult {
                    success: false,
                    results: vec![],
                    count,
                    latency_ms: start.elapsed().as_secs_f64() * 1000.0,
                    error: Some(e.to_string()),
                };
            }
        };

        // Parse response
        let responses: Vec<BatchRpcResponse> = match response.json().await {
            Ok(r) => r,
            Err(e) => {
                return BatchExecuteResult {
                    success: false,
                    results: vec![],
                    count,
                    latency_ms: start.elapsed().as_secs_f64() * 1000.0,
                    error: Some(format!("Invalid JSON response: {}", e)),
                };
            }
        };

        let latency_ms = start.elapsed().as_secs_f64() * 1000.0;

        // Sort by id and map results
        let mut sorted_responses = responses;
        sorted_responses.sort_by_key(|r| r.id);

        let results: Vec<BatchResult> = sorted_responses
            .into_iter()
            .map(|r| {
                if let Some(error) = r.error {
                    BatchResult {
                        success: false,
                        result: None,
                        error: Some(error.message),
                    }
                } else {
                    BatchResult {
                        success: true,
                        result: r.result,
                        error: None,
                    }
                }
            })
            .collect();

        BatchExecuteResult {
            success: true,
            results,
            count,
            latency_ms: round_2(latency_ms),
            error: None,
        }
    }
}

/// Create new batch builder
pub fn batch(rpc_url: &str) -> BatchBuilder {
    BatchBuilder::new(rpc_url)
}

fn round_2(val: f64) -> f64 {
    (val * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_batch_builder() {
        let b = batch("https://eth.llamarpc.com")
            .block_number()
            .gas_price()
            .get_balance("0x0000000000000000000000000000000000000000", "latest");

        assert_eq!(b.len(), 3);
    }
}