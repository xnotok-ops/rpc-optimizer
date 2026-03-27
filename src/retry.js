/**
 * Retry & Backoff Module
 * Handle rate limits and transient failures gracefully
 */

/**
 * Retry strategies
 */
export const Strategy = {
  FIXED: 'fixed',           // Same delay every time
  LINEAR: 'linear',         // Delay increases linearly
  EXPONENTIAL: 'exponential', // Delay doubles each time
  FIBONACCI: 'fibonacci'    // Delay follows fibonacci sequence
};

/**
 * Default retry options
 */
const defaultOptions = {
  maxRetries: 3,
  initialDelay: 100,        // ms
  maxDelay: 10000,          // ms
  strategy: Strategy.EXPONENTIAL,
  factor: 2,                // For exponential/linear
  jitter: true,             // Add randomness to prevent thundering herd
  jitterFactor: 0.2,        // ±20% jitter
  retryOn: null,            // Function to determine if should retry
  onRetry: null             // Callback on each retry
};

/**
 * Calculate delay based on strategy
 */
function calculateDelay(attempt, options) {
  let delay;

  switch (options.strategy) {
    case Strategy.FIXED:
      delay = options.initialDelay;
      break;

    case Strategy.LINEAR:
      delay = options.initialDelay + (attempt * options.initialDelay * options.factor);
      break;

    case Strategy.EXPONENTIAL:
      delay = options.initialDelay * Math.pow(options.factor, attempt);
      break;

    case Strategy.FIBONACCI:
      const fib = (n) => {
        if (n <= 1) return n;
        let a = 0, b = 1;
        for (let i = 2; i <= n; i++) {
          [a, b] = [b, a + b];
        }
        return b;
      };
      delay = options.initialDelay * fib(attempt + 2);
      break;

    default:
      delay = options.initialDelay;
  }

  // Apply max delay cap
  delay = Math.min(delay, options.maxDelay);

  // Apply jitter
  if (options.jitter) {
    const jitterAmount = delay * options.jitterFactor;
    delay = delay + (Math.random() * 2 - 1) * jitterAmount;
  }

  return Math.round(delay);
}

/**
 * Check if error is retryable
 */
function isRetryable(error, options) {
  // Custom retry function
  if (options.retryOn && typeof options.retryOn === 'function') {
    return options.retryOn(error);
  }

  // Default: retry on common transient errors
  const message = error.message?.toLowerCase() || '';
  
  const retryablePatterns = [
    'timeout',
    'econnreset',
    'econnrefused',
    'enotfound',
    'socket hang up',
    'network',
    'rate limit',
    '429',
    '502',
    '503',
    '504',
    'too many requests',
    'temporarily unavailable',
    'try again'
  ];

  return retryablePatterns.some(pattern => message.includes(pattern));
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry wrapper function
 */
export async function retry(fn, options = {}) {
  const opts = { ...defaultOptions, ...options };
  let lastError;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const result = await fn(attempt);
      return {
        success: true,
        result,
        attempts: attempt + 1
      };
    } catch (error) {
      lastError = error;

      // Check if we should retry
      if (attempt >= opts.maxRetries) {
        break;
      }

      if (!isRetryable(error, opts)) {
        break;
      }

      // Calculate delay
      const delay = calculateDelay(attempt, opts);

      // Callback
      if (opts.onRetry) {
        opts.onRetry({
          attempt: attempt + 1,
          error,
          delay,
          maxRetries: opts.maxRetries
        });
      }

      await sleep(delay);
    }
  }

  return {
    success: false,
    error: lastError,
    attempts: opts.maxRetries + 1
  };
}

/**
 * Retry class for more control
 */
export class RetryHandler {
  constructor(options = {}) {
    this.options = { ...defaultOptions, ...options };
    this.stats = {
      totalAttempts: 0,
      totalRetries: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      lastError: null
    };
  }

  /**
   * Execute with retry
   */
  async execute(fn) {
    const result = await retry(fn, {
      ...this.options,
      onRetry: (info) => {
        this.stats.totalRetries++;
        if (this.options.onRetry) {
          this.options.onRetry(info);
        }
      }
    });

    this.stats.totalAttempts += result.attempts;

    if (result.success) {
      this.stats.totalSuccesses++;
    } else {
      this.stats.totalFailures++;
      this.stats.lastError = result.error;
    }

    return result;
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      successRate: this.stats.totalSuccesses / 
        (this.stats.totalSuccesses + this.stats.totalFailures) || 0
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalAttempts: 0,
      totalRetries: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      lastError: null
    };
  }
}

/**
 * Rate limiter with token bucket algorithm
 */
export class RateLimiter {
  constructor(options = {}) {
    this.options = {
      maxTokens: 10,          // Max requests in bucket
      refillRate: 1,          // Tokens per second
      refillInterval: 1000,   // ms
      ...options
    };

    this.tokens = this.options.maxTokens;
    this.lastRefill = Date.now();
    this.queue = [];
    this.processing = false;
  }

  /**
   * Refill tokens based on time passed
   */
  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refills = Math.floor(elapsed / this.options.refillInterval);

    if (refills > 0) {
      this.tokens = Math.min(
        this.options.maxTokens,
        this.tokens + (refills * this.options.refillRate)
      );
      this.lastRefill = now;
    }
  }

  /**
   * Acquire a token (wait if necessary)
   */
  async acquire() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this._process();
    });
  }

  /**
   * Process queue
   */
  async _process() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      this._refill();

      if (this.tokens >= 1) {
        this.tokens--;
        const resolve = this.queue.shift();
        resolve();
      } else {
        // Wait for next refill
        const waitTime = this.options.refillInterval - 
          (Date.now() - this.lastRefill);
        await sleep(Math.max(0, waitTime));
      }
    }

    this.processing = false;
  }

  /**
   * Execute function with rate limiting
   */
  async execute(fn) {
    await this.acquire();
    return fn();
  }

  /**
   * Get current state
   */
  getState() {
    this._refill();
    return {
      availableTokens: this.tokens,
      maxTokens: this.options.maxTokens,
      queueLength: this.queue.length
    };
  }
}

/**
 * Circuit breaker pattern
 */
export class CircuitBreaker {
  constructor(options = {}) {
    this.options = {
      failureThreshold: 5,    // Failures before opening
      successThreshold: 2,    // Successes before closing
      timeout: 30000,         // Time in open state before half-open
      ...options
    };

    this.state = 'CLOSED';    // CLOSED, OPEN, HALF_OPEN
    this.failures = 0;
    this.successes = 0;
    this.lastFailure = null;
    this.nextAttempt = null;
  }

  /**
   * Execute function with circuit breaker
   */
  async execute(fn) {
    // Check if circuit is open
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error('Circuit breaker is OPEN');
      }
      // Transition to half-open
      this.state = 'HALF_OPEN';
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (error) {
      this._onFailure();
      throw error;
    }
  }

  /**
   * Handle success
   */
  _onSuccess() {
    this.failures = 0;

    if (this.state === 'HALF_OPEN') {
      this.successes++;
      if (this.successes >= this.options.successThreshold) {
        this.state = 'CLOSED';
        this.successes = 0;
      }
    }
  }

  /**
   * Handle failure
   */
  _onFailure() {
    this.failures++;
    this.lastFailure = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.options.timeout;
      this.successes = 0;
    } else if (this.failures >= this.options.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.options.timeout;
    }
  }

  /**
   * Get current state
   */
  getState() {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailure: this.lastFailure,
      nextAttempt: this.nextAttempt
    };
  }

  /**
   * Manually reset circuit
   */
  reset() {
    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.lastFailure = null;
    this.nextAttempt = null;
  }
}

export default {
  retry,
  Strategy,
  RetryHandler,
  RateLimiter,
  CircuitBreaker
};