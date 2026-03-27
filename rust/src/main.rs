//! RPC Optimizer - Examples
//!
//! Run: cargo run --release

use rpc_optimizer::*;
use std::time::Instant;

#[tokio::main]
async fn main() {
    println!("\n🚀 RPC Optimizer (Rust) - Examples\n");
    println!("{}\n", "=".repeat(60));

    // Example 1: Benchmark
    example_benchmark().await;

    // Example 2: Failover
    example_failover().await;

    // Example 3: Batch
    example_batch().await;

    // Example 4: Retry
    example_retry().await;

    // Example 5: Rate Limiter
    example_rate_limiter().await;

    // Example 6: Circuit Breaker
    example_circuit_breaker().await;

    println!("\n{}", "=".repeat(60));
    println!("  All Examples Complete! 🎉");
    println!("{}\n", "=".repeat(60));
}

async fn example_benchmark() {
    println!("Example 1: Benchmark RPCs");
    println!("{}\n", "-".repeat(40));

    let config = default_config();
    let mut benchmark = create_benchmark();

    // Benchmark Ethereum
    if let Some(eth_config) = config.get("ethereum") {
        benchmark.benchmark_chain("ethereum", eth_config, 3).await;
        benchmark.print_results("ethereum");

        if let Some(fastest) = benchmark.get_fastest("ethereum") {
            println!("\n✅ Fastest: {} ({:.1}ms avg)\n", 
                fastest.name, 
                fastest.latency.as_ref().map(|l| l.avg).unwrap_or(0.0)
            );
        }
    }
}

async fn example_failover() {
    println!("\nExample 2: Multi-RPC Failover");
    println!("{}\n", "-".repeat(40));

    let config = default_config();
    
    if let Some(base_config) = config.get("base") {
        let failover = FailoverManager::new("base", base_config, None);

        println!("Making 5 requests with automatic failover...\n");

        for i in 1..=5 {
            let result = failover.request("eth_blockNumber", vec![]).await;
            
            if result.success {
                if let Some(block) = &result.result {
                    let block_num = u64::from_str_radix(
                        block.as_str().unwrap_or("0x0").trim_start_matches("0x"), 
                        16
                    ).unwrap_or(0);
                    println!("  Request {}: Block {} via {} ({:.1}ms)", 
                        i, block_num, result.rpc_name, result.latency_ms);
                }
            } else {
                println!("  Request {}: ❌ {}", i, result.error.unwrap_or_default());
            }
        }

        // Print status
        println!("\nRPC Status:");
        for status in failover.get_status().await {
            let icon = if status.healthy { "✅" } else { "❌" };
            let current = if status.is_current { "👈" } else { "" };
            println!("  {} {:15} | Successes: {} | Failures: {} {}", 
                icon, status.name, status.successes, status.failures, current);
        }
    }
}

async fn example_batch() {
    println!("\nExample 3: Batch Requests");
    println!("{}\n", "-".repeat(40));

    let addresses = [
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", // vitalik.eth
        "0xBE0eB53F46cd790Cd13851d5EFf43D12404d33E8", // Binance
        "0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503", // Binance 2
    ];

    println!("Batching {} balance requests + block + gas...\n", addresses.len());

    let start = Instant::now();
    
    let result = batch("https://eth.drpc.org")
        .get_balance(addresses[0], "latest")
        .get_balance(addresses[1], "latest")
        .get_balance(addresses[2], "latest")
        .block_number()
        .gas_price()
        .execute()
        .await;

    let elapsed = start.elapsed().as_secs_f64() * 1000.0;

    if result.success {
        println!("✅ Batch completed in {:.1}ms ({} calls)\n", elapsed, result.count);

        // Parse balances
        for (i, addr) in addresses.iter().enumerate() {
            if let Some(res) = result.results.get(i) {
                if let Some(hex) = res.result.as_ref().and_then(|v| v.as_str()) {
                    let wei = u128::from_str_radix(hex.trim_start_matches("0x"), 16).unwrap_or(0);
                    let eth = wei as f64 / 1e18;
                    println!("  {}...{}: {:.4} ETH", &addr[..10], &addr[38..], eth);
                }
            }
        }

        // Block number
        if let Some(res) = result.results.get(3) {
            if let Some(hex) = res.result.as_ref().and_then(|v| v.as_str()) {
                let block = u64::from_str_radix(hex.trim_start_matches("0x"), 16).unwrap_or(0);
                println!("\n  Block: {}", format_number(block));
            }
        }

        // Gas price
        if let Some(res) = result.results.get(4) {
            if let Some(hex) = res.result.as_ref().and_then(|v| v.as_str()) {
                let gas = u128::from_str_radix(hex.trim_start_matches("0x"), 16).unwrap_or(0);
                let gwei = gas as f64 / 1e9;
                println!("  Gas: {:.4} gwei", gwei);
            }
        }
    } else {
        println!("❌ Batch failed: {:?}", result.error);
    }
}

async fn example_retry() {
    println!("\nExample 4: Retry with Backoff");
    println!("{}\n", "-".repeat(40));

    let mut attempt_count = 0;

    let result = retry(
        |attempt| {
            attempt_count = attempt;
            async move {
                println!("  Attempt {}...", attempt + 1);
                
                // Simulate failure on first 2 attempts
                if attempt < 2 {
                    Err("Temporary failure")
                } else {
                    Ok("Success!")
                }
            }
        },
        Some(RetryOptions {
            max_retries: 5,
            initial_delay_ms: 100,
            strategy: Strategy::Exponential,
            ..Default::default()
        }),
    )
    .await;

    if result.success {
        println!("\n✅ Success after {} attempts", result.attempts);
        println!("   Result: {}", result.result.unwrap_or(""));
    } else {
        println!("\n❌ Failed after {} attempts: {:?}", result.attempts, result.error);
    }
}

async fn example_rate_limiter() {
    println!("\nExample 5: Rate Limiter");
    println!("{}\n", "-".repeat(40));

    // 3 requests per second
    let limiter = create_rate_limiter(3);

    println!("Sending 6 requests with rate limit of 3/sec...\n");

    let start = Instant::now();

    for i in 1..=6 {
        limiter.acquire().await;
        let elapsed = start.elapsed().as_millis();
        println!("  Request {} sent at {}ms", i, elapsed);
    }

    let state = limiter.get_state();
    println!("\n✅ Complete. Tokens remaining: {}/{}", state.available_tokens, state.max_tokens);
}

async fn example_circuit_breaker() {
    println!("\nExample 6: Circuit Breaker");
    println!("{}\n", "-".repeat(40));

    let cb = create_circuit_breaker();

    println!("Simulating failures to trip circuit...\n");

    // Simulate 5 failures
    for i in 1..=5 {
        let result: Result<(), &str> = Err("Simulated error");
        match cb.execute(|| async { result }).await {
            Ok(_) => println!("  Request {}: ✅ Success", i),
            Err(CircuitBreakerError::CircuitOpen) => {
                println!("  Request {}: 🔴 Circuit OPEN", i);
            }
            Err(CircuitBreakerError::Inner(e)) => {
                println!("  Request {}: ❌ Failed - {}", i, e);
            }
        }
    }

    let state = cb.get_state();
    println!("\n  Circuit state: {:?}", state.state);
    println!("  Failures: {}, Successes: {}", state.failures, state.successes);

    // Try one more (should be blocked)
    println!("\n  Trying one more request...");
    match cb.execute(|| async { Ok::<_, &str>(()) }).await {
        Ok(_) => println!("  ✅ Request allowed"),
        Err(CircuitBreakerError::CircuitOpen) => println!("  🔴 Blocked - Circuit still OPEN"),
        _ => {}
    }
}

fn format_number(n: u64) -> String {
    let s = n.to_string();
    let mut result = String::new();
    for (i, c) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            result.push('.');
        }
        result.push(c);
    }
    result.chars().rev().collect()
}