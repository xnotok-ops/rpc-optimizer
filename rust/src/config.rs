//! RPC Configuration
//! 
//! Defines RPC endpoints for supported chains

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcEndpoint {
    pub url: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainConfig {
    pub name: String,
    pub chain_id: Option<u64>,
    pub rpcs: Vec<RpcEndpoint>,
    pub websockets: Option<Vec<RpcEndpoint>>,
}

pub type Config = HashMap<String, ChainConfig>;

/// Get default RPC configuration
pub fn default_config() -> Config {
    let mut config = HashMap::new();

    // Ethereum
    config.insert(
        "ethereum".to_string(),
        ChainConfig {
            name: "Ethereum Mainnet".to_string(),
            chain_id: Some(1),
            rpcs: vec![
                RpcEndpoint {
                    url: "https://eth.llamarpc.com".to_string(),
                    name: "Llama".to_string(),
                },
                RpcEndpoint {
                    url: "https://ethereum.publicnode.com".to_string(),
                    name: "PublicNode".to_string(),
                },
                RpcEndpoint {
                    url: "https://eth.drpc.org".to_string(),
                    name: "dRPC".to_string(),
                },
                RpcEndpoint {
                    url: "https://rpc.mevblocker.io".to_string(),
                    name: "MEVBlocker".to_string(),
                },
            ],
            websockets: Some(vec![
                RpcEndpoint {
                    url: "wss://eth.llamarpc.com".to_string(),
                    name: "Llama WS".to_string(),
                },
            ]),
        },
    );

    // Base
    config.insert(
        "base".to_string(),
        ChainConfig {
            name: "Base Mainnet".to_string(),
            chain_id: Some(8453),
            rpcs: vec![
                RpcEndpoint {
                    url: "https://mainnet.base.org".to_string(),
                    name: "Base Official".to_string(),
                },
                RpcEndpoint {
                    url: "https://base.llamarpc.com".to_string(),
                    name: "Llama".to_string(),
                },
                RpcEndpoint {
                    url: "https://base.publicnode.com".to_string(),
                    name: "PublicNode".to_string(),
                },
                RpcEndpoint {
                    url: "https://base.drpc.org".to_string(),
                    name: "dRPC".to_string(),
                },
            ],
            websockets: Some(vec![
                RpcEndpoint {
                    url: "wss://base.publicnode.com".to_string(),
                    name: "PublicNode WS".to_string(),
                },
            ]),
        },
    );

    // Solana
    config.insert(
        "solana".to_string(),
        ChainConfig {
            name: "Solana Mainnet".to_string(),
            chain_id: None,
            rpcs: vec![
                RpcEndpoint {
                    url: "https://api.mainnet-beta.solana.com".to_string(),
                    name: "Solana Official".to_string(),
                },
                RpcEndpoint {
                    url: "https://solana.publicnode.com".to_string(),
                    name: "PublicNode".to_string(),
                },
                RpcEndpoint {
                    url: "https://solana.drpc.org".to_string(),
                    name: "dRPC".to_string(),
                },
            ],
            websockets: Some(vec![
                RpcEndpoint {
                    url: "wss://api.mainnet-beta.solana.com".to_string(),
                    name: "Solana Official WS".to_string(),
                },
            ]),
        },
    );

    config
}