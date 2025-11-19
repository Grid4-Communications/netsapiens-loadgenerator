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
 * Parse SIPp time format HH:MM:SS:microseconds to seconds
 * Example: "00:00:00:067000" -> 0.067
 * @param {string} timeStr - SIPp time string
 * @returns {number} Time in seconds
 */
function parseSippTime(timeStr) {
  if (!timeStr || timeStr === '00:00:00:000000') return 0;

  const parts = timeStr.trim().split(/[\s:]+/);
  if (parts.length < 4) return 0;

  const hours = parseInt(parts[0]) || 0;
  const minutes = parseInt(parts[1]) || 0;
  const seconds = parseInt(parts[2]) || 0;
  const microseconds = parseInt(parts[3]) || 0;

  return hours * 3600 + minutes * 60 + seconds + microseconds / 1000000;
}

/**
 * Extract response time distribution from SIPp record
 * SIPp outputs ResponseTimeRepartition columns with format:
 * ResponseTimeRepartition{operation}_<{threshold}
 * ResponseTimeRepartition{operation}_>={threshold}
 * @param {Object} record - CSV record
 * @returns {Object} Response time statistics for all operations
 */
function extractResponseTimes(record) {
  // Find all unique operations (register, reregister, etc.)
  const operations = new Set();
  const rtdPrefix = 'ResponseTimeRepartition';

  for (const key of Object.keys(record)) {
    if (key.startsWith(rtdPrefix)) {
      // Extract operation name: ResponseTimeRepartitionregister_<10 -> register
      const match = key.match(/^ResponseTimeRepartition([a-zA-Z0-9]+)_/);
      if (match) {
        operations.add(match[1]);
      }
    }
  }

  if (operations.size === 0) {
    return {
      samples: [],
      percentiles: { p50: 0, p95: 0, p99: 0 },
      average: 0,
      count: 0
    };
  }

  // Aggregate stats across all operations
  let allDistribution = [];
  let totalCount = 0;
  let weightedAverage = 0;

  for (const operation of operations) {
    // Get response time buckets for this operation
    // Format: ResponseTimeRepartitionregister_<10, ResponseTimeRepartitionregister_<20, etc.
    const buckets = [];

    for (const key of Object.keys(record)) {
      // Match either _<10 or _>=20 format
      const pattern = new RegExp(`^ResponseTimeRepartition${operation}_(<|>=)(\\d+)$`);
      const match = key.match(pattern);

      if (match) {
        const operator = match[1]; // '<' or '>='
        const threshold = parseInt(match[2]);
        const count = parseInt(record[key]) || 0;

        if (count > 0) {
          buckets.push({ operator, threshold, count });
        }
      }
    }

    // Convert buckets to distribution
    // SIPp format: _<10 means "less than 10", _<20 means "less than 20", _>=20 means "20 and above"
    // We need to convert this to ranges
    if (buckets.length > 0) {
      buckets.sort((a, b) => a.threshold - b.threshold);

      let prevThreshold = 0;
      for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i];

        if (bucket.operator === '<') {
          // This bucket represents [prevThreshold, threshold)
          const midpoint = (prevThreshold + bucket.threshold) / 2;
          allDistribution.push({
            threshold: bucket.threshold,
            count: bucket.count,
            midpoint: midpoint
          });
          totalCount += bucket.count;
          weightedAverage += bucket.count * midpoint;
          prevThreshold = bucket.threshold;
        } else if (bucket.operator === '>=') {
          // This bucket represents [threshold, infinity)
          // Use threshold + 50% as estimate
          const estimate = bucket.threshold * 1.5;
          allDistribution.push({
            threshold: bucket.threshold,
            count: bucket.count,
            midpoint: estimate
          });
          totalCount += bucket.count;
          weightedAverage += bucket.count * estimate;
        }
      }
    }

    // Also try to get average from ResponseTime{operation}(C) column
    const avgColumn = `ResponseTime${operation}(C)`;
    if (record[avgColumn]) {
      const avgTime = parseSippTime(record[avgColumn]);
      // We could use this but the weighted average from buckets is better
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
  allDistribution.sort((a, b) => a.threshold - b.threshold);

  // Calculate percentiles from distribution
  const percentiles = calculatePercentilesFromDistribution(allDistribution, totalCount);
  const average = weightedAverage / totalCount / 1000; // Convert to seconds

  return {
    samples: allDistribution,
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
 * @param {Array} distribution - Array of {threshold, count, midpoint} objects
 * @param {number} totalCount - Total number of samples
 * @returns {Object} Percentile values in milliseconds
 */
function calculatePercentilesFromDistribution(distribution, totalCount) {
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

  let prevMidpoint = 0;

  for (const bucket of distribution) {
    cumulativeCount += bucket.count;

    // Check which percentiles fall in this bucket
    for (const [percentile, targetCount] of Object.entries(targets)) {
      if (percentiles[percentile] === 0 && cumulativeCount >= targetCount) {
        // Use the midpoint of this bucket as the percentile value
        percentiles[percentile] = bucket.midpoint;
      }
    }

    prevMidpoint = bucket.midpoint;

    // Early exit if all percentiles found
    if (percentiles.p50 > 0 && percentiles.p95 > 0 && percentiles.p99 > 0) {
      break;
    }
  }

  // Handle case where highest percentile exceeds all buckets
  if (percentiles.p99 === 0) {
    percentiles.p99 = prevMidpoint;
  }
  if (percentiles.p95 === 0) {
    percentiles.p95 = prevMidpoint;
  }
  if (percentiles.p50 === 0) {
    percentiles.p50 = prevMidpoint;
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
