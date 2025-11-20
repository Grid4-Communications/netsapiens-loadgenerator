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

console.log('=== Response Times by Operation ===');
const ops = stats.responseTimesByOperation;

if (Object.keys(ops).length === 0) {
  console.log('No operations found!');
} else {
  for (const [operation, responseTimes] of Object.entries(ops)) {
    console.log(`\nOperation: ${operation}`);
    console.log(`  Sample Count: ${responseTimes.count}`);
    console.log(`  Average: ${responseTimes.average.toFixed(6)}s`);
    console.log(`  P50: ${responseTimes.percentiles.p50.toFixed(6)}s`);
    console.log(`  P95: ${responseTimes.percentiles.p95.toFixed(6)}s`);
    console.log(`  P99: ${responseTimes.percentiles.p99.toFixed(6)}s`);

    if (responseTimes.samples && responseTimes.samples.length > 0 && responseTimes.samples.length <= 10) {
      console.log(`  Buckets:`);
      for (const sample of responseTimes.samples) {
        console.log(`    Threshold: ${sample.threshold}ms, Count: ${sample.count}`);
      }
    }
  }
}
console.log();

// Test a few more files
console.log('=== Testing 5 random files ===');
for (let i = 0; i < Math.min(5, files.length); i++) {
  const file = path.join(STATS_DIR, files[i]);
  const result = parseLatestStats(file);

  if (result.stats && result.stats.responseTimesByOperation) {
    const ops = result.stats.responseTimesByOperation;
    const opNames = Object.keys(ops);
    if (opNames.length > 0) {
      const opSummary = opNames.map(op => {
        const rt = ops[op];
        return `${op}:${rt.count}`;
      }).join(', ');
      console.log(`${files[i].substring(0, 40)}... ${opSummary}`);
    } else {
      console.log(`${files[i].substring(0, 40)}... NO OPERATIONS`);
    }
  } else {
    console.log(`${files[i].substring(0, 40)}... NO DATA`);
  }
}

console.log('\n=== Summary ===');
let totalOperations = { register: 0, reregister: 0, invite: 0, subscribe: 0, notify: 0 };
let allOperationsFound = new Set();
let filesWithData = 0;

files.forEach(f => {
  const result = parseLatestStats(path.join(STATS_DIR, f));
  if (result.stats && result.stats.responseTimesByOperation) {
    const ops = result.stats.responseTimesByOperation;
    if (Object.keys(ops).length > 0) {
      filesWithData++;
      for (const [op, data] of Object.entries(ops)) {
        allOperationsFound.add(op);
        if (totalOperations.hasOwnProperty(op)) {
          totalOperations[op]++;
        } else {
          totalOperations[op] = 1;
        }
      }
    }
  }
});

console.log(`Files with response time data: ${filesWithData} / ${files.length}`);
console.log(`Files without data: ${files.length - filesWithData}`);
console.log(`\nOperations found:`);
console.log(`  register:   ${totalOperations.register || 0} files`);
console.log(`  reregister: ${totalOperations.reregister || 0} files`);
console.log(`  invite:     ${totalOperations.invite || 0} files`);
console.log(`  subscribe:  ${totalOperations.subscribe || 0} files`);
console.log(`  notify:     ${totalOperations.notify || 0} files`);

// Show any other operations found
const otherOps = Array.from(allOperationsFound).filter(
  op => !['register', 'reregister', 'invite', 'subscribe', 'notify'].includes(op)
);
if (otherOps.length > 0) {
  console.log(`\nOther operations found:`);
  otherOps.forEach(op => {
    console.log(`  ${op}: ${totalOperations[op]} files`);
  });
}

if (filesWithData === 0) {
  console.log('\n⚠️  WARNING: No files have response time data!');
  console.log('   This could mean:');
  console.log('   1. SIPp processes just started (no calls made yet)');
  console.log('   2. SIPp not configured to track response times');
  console.log('   3. Parsing issue with ResponseTimeRepartition columns');
}
