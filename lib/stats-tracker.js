/**
 * SIPp Statistics State Tracker
 * Tracks per-file state to calculate deltas, rates, and aggregate metrics
 * Handles stale file detection and cleanup
 */

const fs = require('fs');
const path = require('path');

// File state cache: Map<filePath, FileState>
// FileState = { lastStats, lastTimestamp, lastFileSize }
const fileStates = new Map();

// Staleness timeout (5 minutes)
const STALE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Update file state and calculate deltas
 * @param {string} filePath - Path to stats file
 * @param {Object} currentStats - Current parsed stats from sipp-parser
 * @param {number} currentFileSize - Current file size
 * @returns {Object|null} Delta stats or null if first read
 */
function updateFileState(filePath, currentStats, currentFileSize) {
  const now = Date.now();
  const prevState = fileStates.get(filePath);

  // Store current state
  fileStates.set(filePath, {
    lastStats: currentStats,
    lastTimestamp: now,
    lastFileSize: currentFileSize
  });

  // If first read, no deltas available
  if (!prevState) {
    return null;
  }

  // Calculate time delta in seconds
  const timeDeltaMs = now - prevState.lastTimestamp;
  const timeDeltaSec = timeDeltaMs / 1000;

  // If file hasn't changed, return null (no new data)
  if (currentFileSize === prevState.lastFileSize) {
    return null;
  }

  // Calculate deltas for cumulative counters
  const deltaStats = {
    timeDeltaSec,
    totalCallsDelta: Math.max(0, currentStats.totalCalls - prevState.lastStats.totalCalls),
    successfulCallsDelta: Math.max(0, currentStats.successfulCalls - prevState.lastStats.successfulCalls),
    failedCallsDelta: Math.max(0, currentStats.failedCalls - prevState.lastStats.failedCalls)
  };

  // Calculate instantaneous call rate (calls per second)
  if (timeDeltaSec > 0) {
    deltaStats.instantCallRate = deltaStats.totalCallsDelta / timeDeltaSec;
  } else {
    deltaStats.instantCallRate = 0;
  }

  return deltaStats;
}

/**
 * Get current state for a file
 * @param {string} filePath - Path to stats file
 * @returns {Object|null} Current file state or null if not tracked
 */
function getFileState(filePath) {
  return fileStates.get(filePath) || null;
}

/**
 * Remove stale files from state cache
 * A file is stale if it hasn't been updated in STALE_TIMEOUT_MS
 * @returns {Array<string>} Array of removed file paths
 */
function removeStaleFiles() {
  const now = Date.now();
  const staleFiles = [];

  for (const [filePath, state] of fileStates.entries()) {
    const age = now - state.lastTimestamp;

    if (age > STALE_TIMEOUT_MS) {
      staleFiles.push(filePath);
      fileStates.delete(filePath);
    }
  }

  return staleFiles;
}

/**
 * Aggregate stats across multiple files
 * Groups by server/scenario/transport and sums values
 * @param {Array<Object>} fileStats - Array of {metadata, stats, deltas} objects
 * @returns {Map<string, Object>} Map of aggregated stats keyed by "server:scenario:transport"
 */
function aggregateStats(fileStats) {
  const aggregated = new Map();

  for (const item of fileStats) {
    const { serverId, scenario, transport } = item.metadata;
    const { stats } = item;
    const key = `${serverId}:${scenario}:${transport}`;

    if (!aggregated.has(key)) {
      aggregated.set(key, {
        labels: { server: serverId, scenario, transport },
        currentCalls: 0,
        totalCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        callRate: 0, // Will be calculated from deltas
        failureBreakdown: {
          cannot_send_message: 0,
          max_udp_retrans: 0,
          unexpected_message: 0,
          call_rejected: 0,
          regexp_no_match: 0,
          regexp_hdr_not_found: 0,
          out_of_call: 0
        },
        fileCount: 0,
        totalCallsDelta: 0,
        timeDeltaSec: 0
      });
    }

    const agg = aggregated.get(key);

    // Sum gauge values (current state)
    agg.currentCalls += stats.currentCalls;
    agg.totalCalls += stats.totalCalls;
    agg.successfulCalls += stats.successfulCalls;
    agg.failedCalls += stats.failedCalls;
    agg.fileCount++;

    // Accumulate deltas for rate calculation
    if (item.deltas) {
      agg.totalCallsDelta += item.deltas.totalCallsDelta;
      agg.timeDeltaSec += item.deltas.timeDeltaSec;
    }

    // Note: Failure breakdown counters need to be added to sipp-parser.js
    // For now, we'll parse the raw record if available
    if (stats.failureBreakdown) {
      agg.failureBreakdown.cannot_send_message += stats.failureBreakdown.cannot_send_message || 0;
      agg.failureBreakdown.max_udp_retrans += stats.failureBreakdown.max_udp_retrans || 0;
      agg.failureBreakdown.unexpected_message += stats.failureBreakdown.unexpected_message || 0;
      agg.failureBreakdown.call_rejected += stats.failureBreakdown.call_rejected || 0;
      agg.failureBreakdown.regexp_no_match += stats.failureBreakdown.regexp_no_match || 0;
      agg.failureBreakdown.regexp_hdr_not_found += stats.failureBreakdown.regexp_hdr_not_found || 0;
      agg.failureBreakdown.out_of_call += stats.failureBreakdown.out_of_call || 0;
    }
  }

  // Calculate aggregated call rates
  for (const [key, agg] of aggregated.entries()) {
    if (agg.timeDeltaSec > 0) {
      agg.callRate = agg.totalCallsDelta / agg.timeDeltaSec;
    } else {
      agg.callRate = 0;
    }
  }

  return aggregated;
}

/**
 * Get statistics about the state cache
 * @returns {Object} Cache statistics
 */
function getCacheStats() {
  const now = Date.now();
  let staleCount = 0;

  for (const [filePath, state] of fileStates.entries()) {
    const age = now - state.lastTimestamp;
    if (age > STALE_TIMEOUT_MS) {
      staleCount++;
    }
  }

  return {
    totalFiles: fileStates.size,
    staleFiles: staleCount,
    activeFiles: fileStates.size - staleCount
  };
}

/**
 * Clear all state (useful for testing)
 */
function clearState() {
  fileStates.clear();
}

module.exports = {
  updateFileState,
  getFileState,
  removeStaleFiles,
  aggregateStats,
  getCacheStats,
  clearState,
  STALE_TIMEOUT_MS
};
