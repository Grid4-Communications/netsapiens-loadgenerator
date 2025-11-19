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

const { parseStatsDirectory } = require('./lib/sipp-parser');
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
 */
function updateMetrics() {
  try {
    // Parse all stats files in directory
    const parsedStats = parseStatsDirectory(STATS_DIR);

    // Update file count metric
    updateStatsFileCount(parsedStats.length);

    // Update cache with current files
    const currentFiles = new Set();

    // Process each stats file
    for (const entry of parsedStats) {
      const { serverId, scenario, stats, file } = entry;

      currentFiles.add(file);

      // Check if file was modified since last update
      const fileStat = fs.statSync(file);
      const lastModified = fileStat.mtimeMs;

      const cachedModTime = statsFileCache.get(file);
      if (cachedModTime && cachedModTime >= lastModified) {
        // File hasn't changed, skip
        continue;
      }

      // Update cache
      statsFileCache.set(file, lastModified);

      // Extract response times for different operations
      // SIPp register.and.subscribe.sipp.xml has 'register' and 'reregister' operations
      const { responseTimes } = stats;

      if (responseTimes && responseTimes.count > 0) {
        // For register scenario, we'll track as 'register' operation
        // In a more complex setup, you'd parse which specific RTD label was used
        const operation = scenario === 'register' ? 'register' : scenario;

        updateResponseTimeMetrics(serverId, scenario, operation, responseTimes);

        console.log(
          `Updated metrics: server=${serverId}, scenario=${scenario}, ` +
          `count=${responseTimes.count}, avg=${responseTimes.average.toFixed(3)}s, ` +
          `p50=${responseTimes.percentiles.p50.toFixed(3)}s, ` +
          `p95=${responseTimes.percentiles.p95.toFixed(3)}s, ` +
          `p99=${responseTimes.percentiles.p99.toFixed(3)}s`
        );
      }
    }

    // Clean up cache for files that no longer exist
    for (const [file, _] of statsFileCache.entries()) {
      if (!currentFiles.has(file)) {
        statsFileCache.delete(file);
        console.log(`Removed stale file from cache: ${file}`);
      }
    }

    lastUpdateTime = Date.now();
  } catch (error) {
    console.error('Error updating metrics:', error);
  }
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

  // Watch for file changes
  const watcher = chokidar.watch(`${STATS_DIR}/*.csv`, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 100
    }
  });

  watcher.on('add', (filePath) => {
    console.log(`New stats file detected: ${path.basename(filePath)}`);
    updateMetrics();
  });

  watcher.on('change', (filePath) => {
    console.log(`Stats file updated: ${path.basename(filePath)}`);
    updateMetrics();
  });

  watcher.on('unlink', (filePath) => {
    console.log(`Stats file removed: ${path.basename(filePath)}`);
    statsFileCache.delete(filePath);
  });

  watcher.on('error', (error) => {
    console.error('Watcher error:', error);
  });

  // Also poll periodically to catch any missed updates
  setInterval(() => {
    updateMetrics();
  }, UPDATE_INTERVAL * 1000);

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
