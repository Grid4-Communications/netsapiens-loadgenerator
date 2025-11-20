#!/usr/bin/env node

/**
 * Test parsing a sample CSV file to debug response time metrics
 */

const { parseLatestStats } = require('./lib/sipp-parser');
const path = require('path');
const fs = require('fs');

const STATS_DIR = process.env.STATS_DIR || path.join(__dirname, 'sipp', 'stats');

console.log('=== Testing CSV Parsing ===\n');

// Get first CSV file
const files = fs.readdirSync(STATS_DIR).filter(f => f.endsWith('.csv'));

if (files.length === 0) {
  console.error('No CSV files found in', STATS_DIR);
  process.exit(1);
}

console.log(`Found ${files.length} CSV files. Testing first one...\n`);

const testFile = path.join(STATS_DIR, files[0]);
console.log(`File: ${files[0]}`);
console.log(`Path: ${testFile}`);

const stat = fs.statSync(testFile);
console.log(`Size: ${(stat.size / 1024).toFixed(2)} KB`);
console.log(`Modified: ${new Date(stat.mtime).toISOString()}\n`);

console.log('Parsing...');
const result = parseLatestStats(testFile);

if (!result.stats) {
  console.error('❌ Parsing failed - no stats returned');
  process.exit(1);
}

console.log('✓ Parsing successful!\n');

const { stats } = result;

console.log('=== Basic Stats ===');
console.log(`Total Calls: ${stats.totalCalls}`);
console.log(`Successful: ${stats.successfulCalls}`);
console.log(`Failed: ${stats.failedCalls}`);
console.log(`Current: ${stats.currentCalls}`);
console.log(`Call Rate: ${stats.callRate}`);
console.log();

console.log('=== Response Times ===');
console.log(`Sample Count: ${stats.responseTimes.count}`);
console.log(`Average: ${stats.responseTimes.average.toFixed(6)}s`);
console.log(`P50: ${stats.responseTimes.percentiles.p50.toFixed(6)}s`);
console.log(`P95: ${stats.responseTimes.percentiles.p95.toFixed(6)}s`);
console.log(`P99: ${stats.responseTimes.percentiles.p99.toFixed(6)}s`);
console.log();

if (stats.responseTimes.samples && stats.responseTimes.samples.length > 0) {
  console.log('=== Response Time Buckets ===');
  for (const sample of stats.responseTimes.samples) {
    console.log(`  Threshold: ${sample.threshold}ms, Count: ${sample.count}, Midpoint: ${sample.midpoint}ms`);
  }
  console.log();
}

// Test a few more files
console.log('=== Testing 5 random files ===');
for (let i = 0; i < Math.min(5, files.length); i++) {
  const file = path.join(STATS_DIR, files[i]);
  const result = parseLatestStats(file);

  if (result.stats && result.stats.responseTimes) {
    const rt = result.stats.responseTimes;
    console.log(
      `${files[i].substring(0, 50)}... count=${rt.count}, avg=${rt.average.toFixed(3)}s`
    );
  } else {
    console.log(`${files[i].substring(0, 50)}... NO DATA`);
  }
}

console.log('\n=== Summary ===');
const filesWithData = files.map(f => {
  const result = parseLatestStats(path.join(STATS_DIR, f));
  return result.stats && result.stats.responseTimes && result.stats.responseTimes.count > 0;
}).filter(Boolean).length;

console.log(`Files with response time data: ${filesWithData} / ${files.length}`);
console.log(`Files without data: ${files.length - filesWithData}`);

if (filesWithData === 0) {
  console.log('\n⚠️  WARNING: No files have response time data!');
  console.log('   This could mean:');
  console.log('   1. SIPp processes just started (no calls made yet)');
  console.log('   2. SIPp not configured to track response times');
  console.log('   3. Parsing issue with ResponseTimeRepartition columns');
}
