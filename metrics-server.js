#!/usr/bin/env node

/**
 * SIPp Metrics Server
 * Continuous service that monitors SIPp statistics files and exposes Prometheus metrics
 *
 * Usage:
 *   node metrics-server.js
 *
 * Environment variables:
 *   METRICS_PORT - Port to listen on (default: 9090)
 *   STATS_DIR - Directory containing SIPp stats files (default: ./sipp/stats)
 *   UPDATE_INTERVAL - Interval to update metrics in seconds (default: 5)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
require('dotenv').config();

const { parseStatsDirectory, parseSippStatsFile, parseStatsFilename } = require('./lib/sipp-parser');
const {
  updateResponseTimeMetrics,
  updateStatsFileCount,
  getMetrics,
  getContentType
} = require('./lib/prometheus-metrics');

// Configuration
const PORT = process.env.METRICS_PORT || 9090;
const BASE_DIR = process.env.BASE_DIR || __dirname;
const STATS_DIR = process.env.STATS_DIR || path.join(BASE_DIR, 'sipp', 'stats');
const UPDATE_INTERVAL = parseInt(process.env.UPDATE_INTERVAL) || 5; // seconds

// State tracking
let lastUpdateTime = Date.now();
let statsFileCache = new Map(); // Track stats files and their last modification time

/**
 * Initialize Express app
 */
const app = express();

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    lastUpdate: new Date(lastUpdateTime).toISOString(),
    statsDirectory: STATS_DIR,
    activeFiles: statsFileCache.size
  });
});

/**
 * Prometheus metrics endpoint
 */
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', getContentType());
    const metrics = await getMetrics();
    res.end(metrics);
  } catch (error) {
    console.error('Error generating metrics:', error);
    res.status(500).end('Error generating metrics');
  }
});

/**
 * Root endpoint - basic info
 */
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>SIPp Metrics Server</title></head>
      <body>
        <h1>SIPp Prometheus Metrics Server</h1>
        <p>This server monitors SIPp statistics files and exposes metrics for Prometheus.</p>
        <ul>
          <li><a href="/metrics">/metrics</a> - Prometheus metrics endpoint</li>
          <li><a href="/health">/health</a> - Health check endpoint</li>
        </ul>
        <h2>Configuration</h2>
        <ul>
          <li>Stats Directory: <code>${STATS_DIR}</code></li>
          <li>Update Interval: ${UPDATE_INTERVAL} seconds</li>
          <li>Active Files: ${statsFileCache.size}</li>
          <li>Last Update: ${new Date(lastUpdateTime).toISOString()}</li>
        </ul>
      </body>
    </html>
  `);
});

/**
 * Update metrics from all stats files
 * Only parses files that have been modified since last check
 */
function updateMetrics() {
  try {
    if (!fs.existsSync(STATS_DIR)) {
      return;
    }

    const files = fs.readdirSync(STATS_DIR).filter(f => f.endsWith('.csv'));

    // Early exit if no files - skip all processing
    if (files.length === 0) {
      updateStatsFileCount(0);
      return;
    }

    const currentFiles = new Set();
    let parsedCount = 0;
    let skippedCount = 0;

    // Update file count metric
    updateStatsFileCount(files.length);

    // Process each stats file
    for (const filename of files) {
      const filePath = path.join(STATS_DIR, filename);
      currentFiles.add(filePath);

      try {
        // Check if file was modified since last update
        const fileStat = fs.statSync(filePath);
        const lastModified = fileStat.mtimeMs;

        const cachedModTime = statsFileCache.get(filePath);
        if (cachedModTime && cachedModTime >= lastModified) {
          // File hasn't changed, skip parsing
          skippedCount++;
          continue;
        }

        // Parse only this file (moved require to top of file)
        const stats = parseSippStatsFile(filePath);

        if (!stats) {
          continue;
        }

        const metadata = parseStatsFilename(filename);
        const { serverId, scenario } = metadata;

        // Update cache
        statsFileCache.set(filePath, lastModified);
        parsedCount++;

        // Extract response times for different operations
        const { responseTimes } = stats;

        if (responseTimes && responseTimes.count > 0) {
          const operation = scenario === 'register' ? 'register' : scenario;

          updateResponseTimeMetrics(serverId, scenario, operation, responseTimes);

          if (parsedCount <= 5) { // Only log first 5 to reduce noise
            console.log(
              `Updated metrics: server=${serverId}, scenario=${scenario}, ` +
              `count=${responseTimes.count}, avg=${responseTimes.average.toFixed(3)}s, ` +
              `p50=${responseTimes.percentiles.p50.toFixed(3)}s, ` +
              `p95=${responseTimes.percentiles.p95.toFixed(3)}s, ` +
              `p99=${responseTimes.percentiles.p99.toFixed(3)}s`
            );
          }
        }
      } catch (err) {
        console.error(`Error processing file ${filename}:`, err.message);
      }
    }

    // Clean up cache for files that no longer exist
    for (const [file, _] of statsFileCache.entries()) {
      if (!currentFiles.has(file)) {
        statsFileCache.delete(file);
        console.log(`Removed stale file from cache: ${file}`);
      }
    }

    if (parsedCount > 0 || (Date.now() - lastUpdateTime) > 60000) {
      console.log(`Update cycle: ${parsedCount} parsed, ${skippedCount} skipped, ${files.length} total files`);
    }

    lastUpdateTime = Date.now();
  } catch (error) {
    console.error('Error updating metrics:', error);
  }
}

/**
 * Process a single stats file
 * @param {string} filePath - Path to stats file
 */
function processStatsFile(filePath) {
  try {
    const filename = path.basename(filePath);

    // Check if file was modified since last update
    const fileStat = fs.statSync(filePath);
    const lastModified = fileStat.mtimeMs;

    const cachedModTime = statsFileCache.get(filePath);
    if (cachedModTime && cachedModTime >= lastModified) {
      // File hasn't changed, skip parsing
      return false;
    }

    // Parse only this file (moved require to top of file)
    const stats = parseSippStatsFile(filePath);

    if (!stats) {
      return false;
    }

    const metadata = parseStatsFilename(filename);
    const { serverId, scenario } = metadata;

    // Update cache
    statsFileCache.set(filePath, lastModified);

    // Extract response times
    const { responseTimes } = stats;

    if (responseTimes && responseTimes.count > 0) {
      const operation = scenario === 'register' ? 'register' : scenario;
      updateResponseTimeMetrics(serverId, scenario, operation, responseTimes);
      return true;
    }

    return false;
  } catch (err) {
    console.error(`Error processing file ${path.basename(filePath)}:`, err.message);
    return false;
  }
}

// Debounce mechanism to batch rapid file changes
let updateDebounceTimer = null;
let pendingFiles = new Set();

function scheduleFileUpdate(filePath) {
  pendingFiles.add(filePath);

  if (updateDebounceTimer) {
    clearTimeout(updateDebounceTimer);
  }

  updateDebounceTimer = setTimeout(() => {
    const files = Array.from(pendingFiles);
    pendingFiles.clear();

    let processed = 0;
    for (const file of files) {
      if (processStatsFile(file)) {
        processed++;
      }
    }

    if (processed > 0) {
      lastUpdateTime = Date.now();
    }
  }, 200); // Wait 200ms for more changes
}

/**
 * Start watching stats directory
 */
function startWatching() {
  // Ensure stats directory exists
  if (!fs.existsSync(STATS_DIR)) {
    console.log(`Creating stats directory: ${STATS_DIR}`);
    fs.mkdirSync(STATS_DIR, { recursive: true });
  }

  console.log(`Watching stats directory: ${STATS_DIR}`);

  // Watch for file changes with reduced polling
  const watcher = chokidar.watch(`${STATS_DIR}/*.csv`, {
    persistent: true,
    ignoreInitial: true, // Don't process all files on startup
    awaitWriteFinish: {
      stabilityThreshold: 2000, // Increased to reduce churn
      pollInterval: 500
    },
    usePolling: false, // Use native fs events for better performance
    interval: 5000, // Fallback polling interval
    binaryInterval: 5000
  });

  watcher.on('add', (filePath) => {
    scheduleFileUpdate(filePath);
  });

  watcher.on('change', (filePath) => {
    scheduleFileUpdate(filePath);
  });

  watcher.on('unlink', (filePath) => {
    statsFileCache.delete(filePath);
  });

  watcher.on('error', (error) => {
    console.error('Watcher error:', error);
  });

  // Periodic full scan to catch any missed updates
  // Use longer interval when idle to reduce CPU usage
  setInterval(() => {
    // Skip if no files have been seen yet
    if (statsFileCache.size === 0) {
      return;
    }
    updateMetrics();
  }, Math.max(UPDATE_INTERVAL * 1000, 60000)); // At least 60 seconds between full scans

  return watcher;
}

/**
 * Start the metrics server
 */
function startServer() {
  console.log('=================================');
  console.log('SIPp Prometheus Metrics Server');
  console.log('=================================');
  console.log(`Port: ${PORT}`);
  console.log(`Stats Directory: ${STATS_DIR}`);
  console.log(`Update Interval: ${UPDATE_INTERVAL}s`);
  console.log('=================================\n');

  // Start watching stats directory
  const watcher = startWatching();

  // Initial metrics update
  updateMetrics();

  // Start Express server
  const server = app.listen(PORT, () => {
    console.log(`Metrics server listening on http://localhost:${PORT}`);
    console.log(`Prometheus endpoint: http://localhost:${PORT}/metrics`);
    console.log(`Health check: http://localhost:${PORT}/health\n`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down gracefully...');
    watcher.close();
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Start the server if run directly
if (require.main === module) {
  startServer();
}

module.exports = { app, startServer, updateMetrics };
