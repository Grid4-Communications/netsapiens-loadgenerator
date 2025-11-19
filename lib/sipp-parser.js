/**
 * SIPp CSV Statistics Parser
 * Parses SIPp -trace_stat CSV output files and extracts response time metrics
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

/**
 * Parse a single SIPp statistics CSV file
 * @param {string} filePath - Path to the SIPp CSV stats file
 * @returns {Object|null} Parsed statistics or null if file doesn't exist
 */
function parseSippStatsFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');

    // SIPp CSV has semicolon-separated values
    const records = parse(content, {
      delimiter: ';',
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      trim: true
    });

    if (records.length === 0) {
      return null;
    }

    // Get the most recent record (last line)
    const latestRecord = records[records.length - 1];

    return parseStatsRecord(latestRecord);
  } catch (error) {
    console.error(`Error parsing SIPp stats file ${filePath}:`, error.message);
    return null;
  }
}

/**
 * Parse a single statistics record and extract metrics
 * @param {Object} record - Single CSV record from SIPp
 * @returns {Object} Parsed statistics
 */
function parseStatsRecord(record) {
  const stats = {
    timestamp: parseInt(record.CurrentTime) || Date.now(),
    elapsedTime: parseFloat(record.ElapsedTime) || 0,
    callRate: parseFloat(record.CallRate) || 0,
    currentCalls: parseInt(record.CurrentCall) || 0,
    totalCalls: parseInt(record.TotalCallCreated) || 0,
    successfulCalls: parseInt(record.SuccessfulCall) || 0,
    failedCalls: parseInt(record.FailedCall) || 0,
    responseTimes: extractResponseTimes(record)
  };

  return stats;
}

/**
 * Extract response time distribution from SIPp record
 * SIPp outputs ResponseTimeRepartition columns with counts in buckets
 * @param {Object} record - CSV record
 * @returns {Object} Response time statistics
 */
function extractResponseTimes(record) {
  const rtdColumns = Object.keys(record).filter(key =>
    key.startsWith('ResponseTimeRepartition_')
  );

  if (rtdColumns.length === 0) {
    return {
      samples: [],
      percentiles: { p50: 0, p95: 0, p99: 0 },
      average: 0,
      count: 0
    };
  }

  // Build array of [timeThreshold, count] from the repartition data
  // SIPp column names are like: ResponseTimeRepartition_<threshold_ms>
  const distribution = [];
  let totalCount = 0;
  let totalTime = 0;

  for (const column of rtdColumns) {
    const match = column.match(/ResponseTimeRepartition_(\d+)/);
    if (match) {
      const thresholdMs = parseInt(match[1]);
      const count = parseInt(record[column]) || 0;

      if (count > 0) {
        distribution.push({ threshold: thresholdMs, count });
        totalCount += count;
        // Estimate actual time as midpoint of bucket (rough approximation)
        totalTime += count * thresholdMs;
      }
    }
  }

  // Also check for the < min bucket (responses faster than first threshold)
  if (record.ResponseTimeRepartition_0) {
    const count = parseInt(record.ResponseTimeRepartition_0) || 0;
    if (count > 0) {
      distribution.unshift({ threshold: 0, count });
      totalCount += count;
      // Assume very fast responses average half the first threshold
      const firstThreshold = distribution.length > 1 ? distribution[1].threshold : 10;
      totalTime += count * (firstThreshold / 2);
    }
  }

  if (totalCount === 0) {
    return {
      samples: [],
      percentiles: { p50: 0, p95: 0, p99: 0 },
      average: 0,
      count: 0
    };
  }

  // Sort by threshold
  distribution.sort((a, b) => a.threshold - b.threshold);

  // Calculate percentiles
  const percentiles = calculatePercentiles(distribution, totalCount);
  const average = totalTime / totalCount / 1000; // Convert to seconds

  return {
    samples: distribution,
    percentiles: {
      p50: percentiles.p50 / 1000, // Convert to seconds
      p95: percentiles.p95 / 1000,
      p99: percentiles.p99 / 1000
    },
    average,
    count: totalCount
  };
}

/**
 * Calculate percentiles from distribution buckets
 * @param {Array} distribution - Array of {threshold, count} objects
 * @param {number} totalCount - Total number of samples
 * @returns {Object} Percentile values in milliseconds
 */
function calculatePercentiles(distribution, totalCount) {
  const percentiles = { p50: 0, p95: 0, p99: 0 };

  if (distribution.length === 0 || totalCount === 0) {
    return percentiles;
  }

  let cumulativeCount = 0;
  const targets = {
    p50: totalCount * 0.50,
    p95: totalCount * 0.95,
    p99: totalCount * 0.99
  };

  let prevThreshold = 0;

  for (const bucket of distribution) {
    cumulativeCount += bucket.count;

    // Check which percentiles fall in this bucket
    for (const [percentile, targetCount] of Object.entries(targets)) {
      if (percentiles[percentile] === 0 && cumulativeCount >= targetCount) {
        // Linear interpolation within the bucket
        const prevCount = cumulativeCount - bucket.count;
        const fraction = (targetCount - prevCount) / bucket.count;
        percentiles[percentile] = prevThreshold + fraction * (bucket.threshold - prevThreshold);
      }
    }

    prevThreshold = bucket.threshold;

    // Early exit if all percentiles found
    if (percentiles.p50 > 0 && percentiles.p95 > 0 && percentiles.p99 > 0) {
      break;
    }
  }

  // Handle case where highest percentile exceeds all buckets
  if (percentiles.p99 === 0) {
    percentiles.p99 = prevThreshold;
  }
  if (percentiles.p95 === 0) {
    percentiles.p95 = prevThreshold;
  }
  if (percentiles.p50 === 0) {
    percentiles.p50 = prevThreshold;
  }

  return percentiles;
}

/**
 * Extract metadata from stats filename
 * Expected format: <server_id>_register_<device_file>_<pid>.csv
 * or: register_<device_file>_<pid>.csv (legacy)
 * @param {string} filename - Stats filename
 * @returns {Object} Metadata {serverId, scenario, deviceFile, pid}
 */
function parseStatsFilename(filename) {
  const basename = path.basename(filename, '.csv');

  // Try multi-server format first: <server_id>_register_<device_file>_<pid>
  let match = basename.match(/^(.+?)_(register|inbound)_(.+?)_(\d+)$/);

  if (match) {
    return {
      serverId: match[1],
      scenario: match[2],
      deviceFile: match[3],
      pid: match[4]
    };
  }

  // Try legacy format: register_<device_file>_<pid>
  match = basename.match(/^(register|inbound)_(.+?)_(\d+)$/);

  if (match) {
    return {
      serverId: 'default',
      scenario: match[1],
      deviceFile: match[2],
      pid: match[3]
    };
  }

  // Fallback
  return {
    serverId: 'unknown',
    scenario: 'unknown',
    deviceFile: basename,
    pid: '0'
  };
}

/**
 * Watch a stats directory and parse all files
 * @param {string} statsDir - Directory containing SIPp stats files
 * @returns {Array} Array of parsed stats with metadata
 */
function parseStatsDirectory(statsDir) {
  if (!fs.existsSync(statsDir)) {
    return [];
  }

  const files = fs.readdirSync(statsDir).filter(f => f.endsWith('.csv'));
  const results = [];

  for (const file of files) {
    const filePath = path.join(statsDir, file);
    const stats = parseSippStatsFile(filePath);

    if (stats) {
      const metadata = parseStatsFilename(file);
      results.push({
        ...metadata,
        file: filePath,
        stats
      });
    }
  }

  return results;
}

module.exports = {
  parseSippStatsFile,
  parseStatsDirectory,
  parseStatsFilename,
  extractResponseTimes
};
