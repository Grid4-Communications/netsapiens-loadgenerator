/**
 * Prometheus Metrics Wrapper
 * Defines and manages Prometheus metrics for SIPp response times
 */

const client = require('prom-client');

// Create a Registry to hold metrics
const register = new client.Registry();

// Add default metrics (process CPU, memory, etc.)
//client.collectDefaultMetrics({ register });

/**
 * Response Time Histogram
 * DISABLED FOR PERFORMANCE: With 300+ files, observe() calls make /metrics too slow
 * Using gauges instead (P50, P95, P99) which are instant set() operations
 */
// const responseTimeHistogram = new client.Histogram({
//   name: 'sipp_response_time_seconds',
//   help: 'SIPp response time distribution in seconds',
//   labelNames: ['server', 'scenario', 'operation'],
//   buckets: [0.01, 0.02, 0.03, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
//   registers: [register]
// });

/**
 * Response Time Summary
 * DISABLED FOR PERFORMANCE: Same reason as histogram
 */
// const responseTimeSummary = new client.Summary({
//   name: 'sipp_response_time_seconds_summary',
//   help: 'SIPp response time summary with quantiles',
//   labelNames: ['server', 'scenario', 'operation'],
//   percentiles: [0.5, 0.95, 0.99],
//   maxAgeSeconds: 600,
//   ageBuckets: 5,
//   registers: [register]
// });

/**
 * Response Time Average Gauge
 * Current average response time
 */
const responseTimeAverage = new client.Gauge({
  name: 'sipp_response_time_average_seconds',
  help: 'Average SIPp response time in seconds',
  labelNames: ['server', 'scenario', 'operation'],
  registers: [register]
});

/**
 * Response Time Percentile Gauges
 * Separate gauges for each percentile (P50, P95, P99)
 */
const responseTimeP50 = new client.Gauge({
  name: 'sipp_response_time_p50_seconds',
  help: 'SIPp response time P50 (median) in seconds',
  labelNames: ['server', 'scenario', 'operation'],
  registers: [register]
});

const responseTimeP95 = new client.Gauge({
  name: 'sipp_response_time_p95_seconds',
  help: 'SIPp response time P95 in seconds',
  labelNames: ['server', 'scenario', 'operation'],
  registers: [register]
});

const responseTimeP99 = new client.Gauge({
  name: 'sipp_response_time_p99_seconds',
  help: 'SIPp response time P99 in seconds',
  labelNames: ['server', 'scenario', 'operation'],
  registers: [register]
});

/**
 * Response Count
 * Total number of responses tracked
 */
const responseCount = new client.Gauge({
  name: 'sipp_response_count_total',
  help: 'Total number of SIPp responses tracked',
  labelNames: ['server', 'scenario', 'operation'],
  registers: [register]
});

/**
 * Last Update Timestamp
 * Timestamp of last metrics update (useful for detecting stale data)
 */
const lastUpdateTimestamp = new client.Gauge({
  name: 'sipp_metrics_last_update_timestamp_seconds',
  help: 'Unix timestamp of last metrics update',
  labelNames: ['server', 'scenario'],
  registers: [register]
});

/**
 * Stats File Count
 * Number of active stats files being monitored
 */
const statsFileCount = new client.Gauge({
  name: 'sipp_stats_files_active',
  help: 'Number of active SIPp stats files being monitored',
  registers: [register]
});

/**
 * Update response time metrics from parsed SIPp data
 * @param {string} serverId - Server identifier
 * @param {string} scenario - Scenario name (e.g., 'register', 'inbound')
 * @param {string} operation - Operation name (e.g., 'register', 'reregister')
 * @param {Object} responseTimes - Response time data from sipp-parser
 */
function updateResponseTimeMetrics(serverId, scenario, operation, responseTimes) {
  const labels = { server: serverId, scenario, operation };

  // Update average
  if (responseTimes.average > 0) {
    responseTimeAverage.set(labels, responseTimes.average);
  }

  // Update percentiles as gauges (instant set operations - very fast)
  if (responseTimes.percentiles) {
    responseTimeP50.set(labels, responseTimes.percentiles.p50);
    responseTimeP95.set(labels, responseTimes.percentiles.p95);
    responseTimeP99.set(labels, responseTimes.percentiles.p99);
  }

  // Update count
  responseCount.set(labels, responseTimes.count);

  // NOTE: Histogram and Summary metrics are disabled for performance
  // With 300+ stats files, calling observe() thousands of times causes
  // the /metrics endpoint to take 60+ seconds to generate.
  // The gauge metrics (P50, P95, P99, average) provide the same information
  // instantly via set() operations.

  // Update last update timestamp
  lastUpdateTimestamp.set(
    { server: serverId, scenario },
    Math.floor(Date.now() / 1000)
  );
}

/**
 * Update the count of active stats files
 * @param {number} count - Number of active files
 */
function updateStatsFileCount(count) {
  statsFileCount.set(count);
}

/**
 * Get metrics in Prometheus text format
 * @returns {Promise<string>} Prometheus metrics text
 */
async function getMetrics() {
  return register.metrics();
}

/**
 * Get content type for Prometheus metrics
 * @returns {string} Content type
 */
function getContentType() {
  return register.contentType;
}

/**
 * Reset all metrics (useful for testing)
 */
function resetMetrics() {
  register.resetMetrics();
}

/**
 * Get the Prometheus registry
 * @returns {client.Registry} The registry instance
 */
function getRegistry() {
  return register;
}

module.exports = {
  updateResponseTimeMetrics,
  updateStatsFileCount,
  getMetrics,
  getContentType,
  resetMetrics,
  getRegistry,
  // Export individual metrics for testing
  metrics: {
    // responseTimeHistogram, // Disabled for performance
    // responseTimeSummary,   // Disabled for performance
    responseTimeAverage,
    responseTimeP50,
    responseTimeP95,
    responseTimeP99,
    responseCount,
    lastUpdateTimestamp,
    statsFileCount
  }
};
