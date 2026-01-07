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
/**
 * Read only the header (first line) and last line from a file efficiently
 * This avoids loading the entire file into memory for large CSV files
 * @param {string} filePath - Path to the file
 * @returns {Object|null} Object with header and lastLine, or null on error
 */
function readHeaderAndLastLine(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const stats = fs.fstatSync(fd);
    const fileSize = stats.size;

    if (fileSize === 0) {
      fs.closeSync(fd);
      return null;
    }

    // Read first 16KB to get header (SIPp CSV headers are very long with 96 columns)
    const headerBuffer = Buffer.alloc(Math.min(16384, fileSize));
    fs.readSync(fd, headerBuffer, 0, headerBuffer.length, 0);
    const headerText = headerBuffer.toString('utf-8');
    const headerEnd = headerText.indexOf('\n');

    if (headerEnd === -1) {
      fs.closeSync(fd);
      return null; // No newline found, invalid file
    }

    const header = headerText.substring(0, headerEnd);

    // Read last 16KB to get the last line (SIPp CSV data lines are also very long)
    const tailSize = Math.min(16384, fileSize);
    const tailBuffer = Buffer.alloc(tailSize);
    fs.readSync(fd, tailBuffer, 0, tailSize, fileSize - tailSize);
    fs.closeSync(fd);

    const tailText = tailBuffer.toString('utf-8');
    const lines = tailText.trim().split('\n');
    const lastLine = lines[lines.length - 1];

    return { header, lastLine };
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error.message);
    return null;
  }
}

function parseSippStatsFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    // Read only header and last line efficiently without loading entire file
    const fileData = readHeaderAndLastLine(filePath);

    if (!fileData) {
      return null;
    }

    const { header, lastLine } = fileData;

    // Parse just these two lines
    const records = parse(header + '\n' + lastLine, {
      delimiter: ';',
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      trim: true
    });

    if (records.length === 0) {
      return null;
    }

    return parseStatsRecord(records[0]);
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
    responseTimesByOperation: extractResponseTimes(record), // Now returns per-operation stats
    failureBreakdown: extractFailureBreakdown(record)
  };

  return stats;
}

/**
 * Extract failure breakdown counters from SIPp record
 * @param {Object} record - CSV record
 * @returns {Object} Failure counts by reason
 */
function extractFailureBreakdown(record) {
  return {
    cannot_send_message: parseInt(record['FailedCannotSendMessage']) || 0,
    max_udp_retrans: parseInt(record['FailedMaxUDPRetrans']) || 0,
    unexpected_message: parseInt(record['FailedUnexpectedMessage']) || 0,
    call_rejected: parseInt(record['FailedCallRejected']) || 0,
    regexp_no_match: parseInt(record['FailedRegexpDoesntMatch']) || 0,
    regexp_hdr_not_found: parseInt(record['FailedRegexpHdrNotFound']) || 0,
    out_of_call: parseInt(record['OutOfCallMsgs']) || 0
  };
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
 * @returns {Object} Response time statistics per operation
 */
function extractResponseTimes(record) {
  // Find all unique operations (register, reregister, 1=INVITE, etc.)
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
    return {};
  }

  // Build per-operation stats
  const operationStats = {};

  for (const operation of operations) {
    // Get response time buckets for this operation
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

    // Convert buckets to distribution for this operation
    let distribution = [];
    let totalCount = 0;
    let weightedAverage = 0;

    if (buckets.length > 0) {
      buckets.sort((a, b) => a.threshold - b.threshold);

      let prevThreshold = 0;
      for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i];

        if (bucket.operator === '<') {
          // This bucket represents [prevThreshold, threshold)
          const midpoint = (prevThreshold + bucket.threshold) / 2;
          distribution.push({
            threshold: bucket.threshold,
            count: bucket.count,
            midpoint: midpoint
          });
          totalCount += bucket.count;
          weightedAverage += bucket.count * midpoint;
          prevThreshold = bucket.threshold;
        } else if (bucket.operator === '>=') {
          // This bucket represents [threshold, infinity)
          const estimate = bucket.threshold * 1.5;
          distribution.push({
            threshold: bucket.threshold,
            count: bucket.count,
            midpoint: estimate
          });
          totalCount += bucket.count;
          weightedAverage += bucket.count * estimate;
        }
      }
    }

    if (totalCount === 0) {
      continue; // Skip operations with no data
    }

    // Sort by threshold
    distribution.sort((a, b) => a.threshold - b.threshold);

    // Calculate percentiles from distribution
    const percentiles = calculatePercentilesFromDistribution(distribution, totalCount);
    const average = weightedAverage / totalCount / 1000; // Convert to seconds

    // Normalize operation names (SIPp uses numbers for some operations)
    let operationName = operation;
    if (operation === '1') {
      operationName = 'invite';
    } else if (operation === '2') {
      operationName = 'subscribe';
    } else if (operation === '3') {
      operationName = 'notify';
    } else {
      // Keep original name (register, reregister, etc.)
      operationName = operation.toLowerCase();
    }

    operationStats[operationName] = {
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

  return operationStats;
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
 * Expected format: <server_id>_<scenario>_<transport>_<device_file_or_timezone>_<pid>.csv
 * Examples:
 *   - prod1_register_t1_example_com_12345.csv
 *   - prod1_inbound_u1_US_Eastern_12346.csv
 *   - register_l1_example_com_12347.csv (no server ID)
 * @param {string} filename - Stats filename
 * @returns {Object} Metadata {serverId, scenario, transport, deviceFile, pid}
 */
function parseStatsFilename(filename) {
  const basename = path.basename(filename, '.csv');

  // Try format with server ID: <server_id>_<scenario>_<transport>_<device_file_or_timezone>_<pid>
  let match = basename.match(/^(.+?)_(register|inbound)_([utl]1)_(.+?)_(\d+)$/);

  if (match) {
    return {
      serverId: match[1],
      scenario: match[2],
      transport: match[3],
      deviceFile: match[4],
      pid: match[5]
    };
  }

  // Try format without server ID: <scenario>_<transport>_<device_file_or_timezone>_<pid>
  match = basename.match(/^(register|inbound)_([utl]1)_(.+?)_(\d+)$/);

  if (match) {
    return {
      serverId: 'default',
      scenario: match[1],
      transport: match[2],
      deviceFile: match[3],
      pid: match[4]
    };
  }

  // Fallback - return unknown for all fields
  return {
    serverId: 'unknown',
    scenario: 'unknown',
    transport: 'unknown',
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

/**
 * Parse only the LAST line from a file (most recent stats)
 * Since SIPp stats are cumulative, we only need the latest line
 * @param {string} filePath - Path to the file
 * @returns {Object} { stats: Object|null, fileSize: number }
 */
function parseLatestStats(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    if (fileSize === 0) {
      fs.closeSync(fd);
      return { stats: null, fileSize: 0 };
    }

    // Read first 16KB to get header
    const headerBuffer = Buffer.alloc(Math.min(16384, fileSize));
    fs.readSync(fd, headerBuffer, 0, headerBuffer.length, 0);
    const headerText = headerBuffer.toString('utf-8');
    const headerEnd = headerText.indexOf('\n');

    if (headerEnd === -1) {
      fs.closeSync(fd);
      return { stats: null, fileSize };
    }

    const header = headerText.substring(0, headerEnd);

    // Read last 16KB to get the last line
    const tailSize = Math.min(16384, fileSize);
    const tailBuffer = Buffer.alloc(tailSize);
    fs.readSync(fd, tailBuffer, 0, tailSize, fileSize - tailSize);
    fs.closeSync(fd);

    const tailText = tailBuffer.toString('utf-8');
    const lines = tailText.trim().split('\n');
    const lastLine = lines[lines.length - 1];

    // Parse just the last line
    const records = parse(header + '\n' + lastLine, {
      delimiter: ';',
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      trim: true
    });

    if (records.length === 0) {
      return { stats: null, fileSize };
    }

    return {
      stats: parseStatsRecord(records[0]),
      fileSize
    };
  } catch (error) {
    console.error(`Error parsing latest stats from ${filePath}:`, error.message);
    return { stats: null, fileSize: 0 };
  }
}

module.exports = {
  parseSippStatsFile,
  parseStatsDirectory,
  parseStatsFilename,
  extractResponseTimes,
  parseLatestStats
};
