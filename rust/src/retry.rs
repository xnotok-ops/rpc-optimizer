//! Retry & Backoff Module
//!
//! Handle rate limits and transient failures gracefully

use std::future::Future;
use std::time::Duration;
use tokio::time::sleep;

/// Retry strategies
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Strategy {
    Fixed,
    Linear,
    Exponential,
    Fibonacci,
}

/// Retry options
#[derive(Debug, Clone)]
pub struct RetryOptions {
    pub max_retries: usize,
    pub initial_delay_ms: u64,
    pub max_delay_ms: u64,
    pub strategy: Strategy,
    pub factor: f64,
    pub jitter: bool,
    pub jitter_factor: f64,
}

impl Default for RetryOptions {
    fn default() -> Self {
        Self {
            max_retries: 3,
            initial_delay_ms: 100,
            max_delay_ms: 10000,
            strategy: Strategy::Exponential,
            factor: 2.0,
            jitter: true,
            jitter_factor: 0.2,
        }
    }
}

/// Retry result
#[derive(Debug, Clone)]
pub struct RetryResult<T> {
    pub success: bool,
    pub result: Option<T>,
    pub attempts: usize,
    pub error: Option<String>,
}

/// Calculate delay based on strategy
fn calculate_delay(attempt: usize, options: &RetryOptions) -> u64 {
    let delay = match options.strategy {
        Strategy::Fixed => options.initial_delay_ms,
        Strategy::Linear => {
            options.initial_delay_ms + (attempt as u64 * options.initial_delay_ms * options.factor as u64)
        }
        Strategy::Exponential => {
            (options.initial_delay_ms as f64 * options.factor.powi(attempt as i32)) as u64
        }
        Strategy::Fibonacci => {
            let fib = |n: usize| -> u64 {
                if n <= 1 {
                    return n as u64;
                }
                let mut a = 0u64;
                let mut b = 1u64;
                for _ in 2..=n {
                    let tmp = a + b;
                    a = b;
                    b = tmp;
                }
                b
            };
            options.initial_delay_ms * fib(attempt + 2)
        }
    };

    // Apply max delay cap
    let mut delay = delay.min(options.max_delay_ms);

    // Apply jitter
    if options.jitter {
        let jitter_amount = (delay as f64 * options.jitter_factor) as i64;
        let random_factor = (rand_simple() * 2.0 - 1.0) * jitter_amount as f64;
        delay = (delay as i64 + random_factor as i64).max(0) as u64;
    }

    delay
}

/// Simple pseudo-random number generator (0.0 to 1.0)
fn rand_simple() -> f64 {
    use std::time::SystemTime;
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    (nanos % 1000) as f64 / 1000.0
}

/// Check if error is retryable
pub fn is_retryable(error: &str) -> bool {
    let error_lower = error.to_lowercase();
    let retryable_patterns = [
        "timeout",
        "connection reset",
        "connection refused",
        "network",
        "rate limit",
        "429",
        "502",
        "503",
        "504",
        "too many requests",
        "temporarily unavailable",
        "try again",
    ];

    retryable_patterns.iter().any(|p| error_lower.contains(p))
}

/// Retry async function with backoff
pub async fn retry<F, Fut, T, E>(
    mut f: F,
    options: Option<RetryOptions>,
) -> RetryResult<T>
where
    F: FnMut(usize) -> Fut,
    Fut: Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    let opts = options.unwrap_or_default();
    let mut last_error: Option<String> = None;

    for attempt in 0..=opts.max_retries {
        match f(attempt).await {
            Ok(result) => {
                return RetryResult {
                    success: true,
                    result: Some(result),
                    attempts: attempt + 1,
                    error: None,
                };
            }
            Err(e) => {
                let err_str = e.to_string();
                last_error = Some(err_str.clone());

                if attempt >= opts.max_retries {
                    break;
                }

                if !is_retryable(&err_str) {
                    break;
                }

                let delay = calculate_delay(attempt, &opts);
                sleep(Duration::from_millis(delay)).await;
            }
        }
    }

    RetryResult {
        success: false,
        result: None,
        attempts: opts.max_retries + 1,
        error: last_error,
    }
}

/// Rate limiter using token bucket algorithm
pub struct RateLimiter {
    max_tokens: usize,
    tokens: std::sync::atomic::AtomicUsize,
    refill_rate: usize,
    refill_interval_ms: u64,
    last_refill: std::sync::Mutex<std::time::Instant>,
}

impl RateLimiter {
    /// Create new rate limiter
    pub fn new(max_tokens: usize, refill_rate: usize, refill_interval_ms: u64) -> Self {
        Self {
            max_tokens,
            tokens: std::sync::atomic::AtomicUsize::new(max_tokens),
            refill_rate,
            refill_interval_ms,
            last_refill: std::sync::Mutex::new(std::time::Instant::now()),
        }
    }

    /// Refill tokens based on time passed
    fn refill(&self) {
        let mut last_refill = self.last_refill.lock().unwrap();
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(*last_refill).as_millis() as u64;
        let refills = elapsed / self.refill_interval_ms;

        if refills > 0 {
            let current = self.tokens.load(std::sync::atomic::Ordering::SeqCst);
            let new_tokens = (current + (refills as usize * self.refill_rate)).min(self.max_tokens);
            self.tokens.store(new_tokens, std::sync::atomic::Ordering::SeqCst);
            *last_refill = now;
        }
    }

    /// Try to acquire a token (non-blocking)
    pub fn try_acquire(&self) -> bool {
        self.refill();
        
        let current = self.tokens.load(std::sync::atomic::Ordering::SeqCst);
        if current >= 1 {
            self.tokens.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    /// Acquire a token (blocking)
    pub async fn acquire(&self) {
        loop {
            if self.try_acquire() {
                return;
            }
            sleep(Duration::from_millis(self.refill_interval_ms / 10)).await;
        }
    }

    /// Execute function with rate limiting
    pub async fn execute<F, Fut, T>(&self, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        self.acquire().await;
        f().await
    }

    /// Get current state
    pub fn get_state(&self) -> RateLimiterState {
        self.refill();
        RateLimiterState {
            available_tokens: self.tokens.load(std::sync::atomic::Ordering::SeqCst),
            max_tokens: self.max_tokens,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RateLimiterState {
    pub available_tokens: usize,
    pub max_tokens: usize,
}

/// Circuit breaker states
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CircuitState {
    Closed,
    Open,
    HalfOpen,
}

/// Circuit breaker for preventing cascade failures
pub struct CircuitBreaker {
    state: std::sync::RwLock<CircuitState>,
    failure_threshold: usize,
    success_threshold: usize,
    timeout_ms: u64,
    failures: std::sync::atomic::AtomicUsize,
    successes: std::sync::atomic::AtomicUsize,
    last_failure: std::sync::Mutex<Option<std::time::Instant>>,
}

impl CircuitBreaker {
    /// Create new circuit breaker
    pub fn new(failure_threshold: usize, success_threshold: usize, timeout_ms: u64) -> Self {
        Self {
            state: std::sync::RwLock::new(CircuitState::Closed),
            failure_threshold,
            success_threshold,
            timeout_ms,
            failures: std::sync::atomic::AtomicUsize::new(0),
            successes: std::sync::atomic::AtomicUsize::new(0),
            last_failure: std::sync::Mutex::new(None),
        }
    }

    /// Check if circuit allows execution
    pub fn can_execute(&self) -> bool {
        let state = *self.state.read().unwrap();

        match state {
            CircuitState::Closed => true,
            CircuitState::Open => {
                let last_failure = self.last_failure.lock().unwrap();
                if let Some(t) = *last_failure {
                    if t.elapsed().as_millis() as u64 >= self.timeout_ms {
                        *self.state.write().unwrap() = CircuitState::HalfOpen;
                        return true;
                    }
                }
                false
            }
            CircuitState::HalfOpen => true,
        }
    }

    /// Record success
    pub fn on_success(&self) {
        self.failures.store(0, std::sync::atomic::Ordering::SeqCst);

        let state = *self.state.read().unwrap();
        if state == CircuitState::HalfOpen {
            let successes = self.successes.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            if successes >= self.success_threshold {
                *self.state.write().unwrap() = CircuitState::Closed;
                self.successes.store(0, std::sync::atomic::Ordering::SeqCst);
            }
        }
    }

    /// Record failure
    pub fn on_failure(&self) {
        let state = *self.state.read().unwrap();
        *self.last_failure.lock().unwrap() = Some(std::time::Instant::now());

        if state == CircuitState::HalfOpen {
            *self.state.write().unwrap() = CircuitState::Open;
            self.successes.store(0, std::sync::atomic::Ordering::SeqCst);
        } else {
            let failures = self.failures.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            if failures >= self.failure_threshold {
                *self.state.write().unwrap() = CircuitState::Open;
            }
        }
    }

    /// Execute with circuit breaker
    pub async fn execute<F, Fut, T, E>(&self, f: F) -> Result<T, CircuitBreakerError<E>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, E>>,
    {
        if !self.can_execute() {
            return Err(CircuitBreakerError::CircuitOpen);
        }

        match f().await {
            Ok(result) => {
                self.on_success();
                Ok(result)
            }
            Err(e) => {
                self.on_failure();
                Err(CircuitBreakerError::Inner(e))
            }
        }
    }

    /// Get current state
    pub fn get_state(&self) -> CircuitBreakerState {
        CircuitBreakerState {
            state: *self.state.read().unwrap(),
            failures: self.failures.load(std::sync::atomic::Ordering::SeqCst),
            successes: self.successes.load(std::sync::atomic::Ordering::SeqCst),
        }
    }

    /// Reset circuit breaker
    pub fn reset(&self) {
        *self.state.write().unwrap() = CircuitState::Closed;
        self.failures.store(0, std::sync::atomic::Ordering::SeqCst);
        self.successes.store(0, std::sync::atomic::Ordering::SeqCst);
        *self.last_failure.lock().unwrap() = None;
    }
}

#[derive(Debug)]
pub enum CircuitBreakerError<E> {
    CircuitOpen,
    Inner(E),
}

#[derive(Debug, Clone)]
pub struct CircuitBreakerState {
    pub state: CircuitState,
    pub failures: usize,
    pub successes: usize,
}