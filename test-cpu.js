#!/usr/bin/env node

/**
 * CPU Performance Test
 * Tests different components to identify CPU bottleneck
 */

const fs = require('fs');
const path = require('path');
const { parseSippStatsFile } = require('./lib/sipp-parser');

const STATS_DIR = process.env.STATS_DIR || path.join(__dirname, 'sipp', 'stats');

console.log('=== CPU Performance Test ===\n');
console.log(`Stats directory: ${STATS_DIR}`);

if (!fs.existsSync(STATS_DIR)) {
  console.error(`Stats directory does not exist: ${STATS_DIR}`);
  process.exit(1);
}

// Test 1: List files
console.log('\nTest 1: Listing files...');
const start1 = Date.now();
const files = fs.readdirSync(STATS_DIR).filter(f => f.endsWith('.csv'));
const time1 = Date.now() - start1;
console.log(`Found ${files.length} CSV files in ${time1}ms`);

// Test 2: Stat all files
console.log('\nTest 2: Stating all files...');
const start2 = Date.now();
let statCount = 0;
for (const file of files) {
  const filePath = path.join(STATS_DIR, file);
  try {
    fs.statSync(filePath);
    statCount++;
  } catch (e) {
    // ignore
  }
}
const time2 = Date.now() - start2;
console.log(`Stated ${statCount} files in ${time2}ms (${(time2 / statCount).toFixed(2)}ms avg per file)`);

// Test 3: Parse a few files
console.log('\nTest 3: Parsing sample files...');
const sampleSize = Math.min(10, files.length);
const sampleFiles = files.slice(0, sampleSize);
const start3 = Date.now();
let parseSuccessCount = 0;
let parseFailCount = 0;
const parseTimes = [];

for (const file of sampleFiles) {
  const filePath = path.join(STATS_DIR, file);
  const parseStart = Date.now();

  try {
    const stats = parseSippStatsFile(filePath);
    const parseTime = Date.now() - parseStart;
    parseTimes.push(parseTime);

    if (stats) {
      parseSuccessCount++;
      console.log(`  ${file}: ${parseTime}ms - ${stats.responseTimes ? stats.responseTimes.count : 0} samples`);
    } else {
      parseFailCount++;
      console.log(`  ${file}: ${parseTime}ms - no data`);
    }
  } catch (e) {
    parseFailCount++;
    console.log(`  ${file}: ERROR - ${e.message}`);
  }
}

const time3 = Date.now() - start3;
const avgParseTime = parseTimes.length > 0
  ? (parseTimes.reduce((a, b) => a + b, 0) / parseTimes.length).toFixed(2)
  : 0;

console.log(`\nParsed ${sampleSize} files in ${time3}ms (${avgParseTime}ms avg per file)`);
console.log(`Success: ${parseSuccessCount}, Failed: ${parseFailCount}`);

// Test 4: Full cycle simulation
console.log('\nTest 4: Simulating full update cycle...');
const start4 = Date.now();
let processedCount = 0;

for (const file of files) {
  const filePath = path.join(STATS_DIR, file);

  try {
    const fileStat = fs.statSync(filePath);
    // Just stat, don't parse (simulating cache hit)
    processedCount++;
  } catch (e) {
    // ignore
  }
}

const time4 = Date.now() - start4;
console.log(`Processed ${processedCount} files in ${time4}ms (all cached, no parsing)`);

// Summary
console.log('\n=== Summary ===');
console.log(`Total files: ${files.length}`);
console.log(`Directory listing: ${time1}ms`);
console.log(`Stat all files: ${time2}ms (${(time2 / statCount).toFixed(2)}ms per file)`);
console.log(`Parse sample files: ${avgParseTime}ms per file`);
console.log(`Full cycle (cached): ${time4}ms`);
console.log(`\nProjected full parse time: ${((files.length * avgParseTime) / 1000).toFixed(1)}s`);
console.log(`Projected cached cycle: ${(time4 / 1000).toFixed(2)}s`);

console.log('\n=== Recommendations ===');
if (avgParseTime > 50) {
  console.log('⚠️  Parsing is slow (>50ms per file)');
  console.log('   Consider reducing UPDATE_INTERVAL or file count');
}
if (time4 > 5000) {
  console.log('⚠️  Stat operations are slow (>5s for all files)');
  console.log('   Consider reducing file count or increasing UPDATE_INTERVAL');
}
if (files.length > 500) {
  console.log('⚠️  Large number of files detected');
  console.log('   Consider archiving old stats files');
}

console.log('\nTo test with metrics disabled:');
console.log('  ENABLE_METRICS=false node metrics-server.js');
console.log('\nTo adjust scan interval (in seconds):');
console.log('  UPDATE_INTERVAL=120 node metrics-server.js');
