# Metrics Server Performance Improvements

## Summary of Changes

This update dramatically reduces CPU usage and improves efficiency of the metrics server.

## Key Features

### 1. **Incremental Parsing**
- Tracks file position for each CSV file
- Only parses NEW lines added since last check
- Processes all new lines in each 10s interval (not just the last one)
- Avoids re-reading entire files repeatedly

### 2. **Automatic File Cleanup**
- Deletes CSV files not modified in 10 minutes (configurable)
- Prevents unlimited disk space growth
- Removes stale metrics from cache automatically

### 3. **10-Second Scan Interval** (Default)
- Reduced from 60s to 10s for fresher metrics
- Fully configurable via `UPDATE_INTERVAL` environment variable
- Efficient incremental parsing makes frequent scans viable

### 4. **Disabled File Watcher by Default**
- `chokidar` file watching disabled (caused high CPU with 500+ files)
- Uses periodic polling instead (much more efficient)
- Can re-enable with `USE_FILE_WATCHER=true` if needed

### 5. **Efficient Buffer-Based Reading**
- Reads only 16KB header + new data (not full multi-MB files)
- ~100x reduction in I/O per file
- Caps incremental reads to 1MB at a time

### 6. **Performance Monitoring**
- `/health` endpoint shows detailed performance stats
- Tracks: lines processed, files deleted, average parse times
- Helps identify bottlenecks

## Configuration

### Environment Variables

```bash
# Update interval in seconds (default: 10)
UPDATE_INTERVAL=10

# File cleanup age in seconds (default: 600 = 10 minutes)
FILE_CLEANUP_AGE=600

# Completely disable metrics processing (for testing)
ENABLE_METRICS=false

# Re-enable chokidar file watching (not recommended with 500+ files)
USE_FILE_WATCHER=true
```

## Usage

### Start Server (Default Settings)
```bash
node metrics-server.js
```

Output:
```
=================================
SIPp Prometheus Metrics Server
=================================
Port: 9090
Stats Directory: ./sipp/stats
Update Interval: 10s
File Cleanup Age: 600s (10min)
Incremental Parsing: ENABLED
=================================

File watching DISABLED - using periodic polling only
Scanning every 10 seconds
```

### Custom Settings
```bash
# Check every 5 seconds, cleanup after 5 minutes
UPDATE_INTERVAL=5 FILE_CLEANUP_AGE=300 node metrics-server.js

# Check every 30 seconds, cleanup after 20 minutes
UPDATE_INTERVAL=30 FILE_CLEANUP_AGE=1200 node metrics-server.js
```

### Disable Cleanup (Keep All Files)
```bash
# Set cleanup age to a very high value
FILE_CLEANUP_AGE=999999 node metrics-server.js
```

## Monitoring

### Health Check
```bash
curl http://localhost:9090/health | jq
```

Response:
```json
{
  "status": "ok",
  "uptime": 123.45,
  "lastUpdate": "2025-11-20T00:10:00.000Z",
  "statsDirectory": "./sipp/stats",
  "activeFiles": 536,
  "enabled": true,
  "settings": {
    "updateIntervalSec": 10,
    "fileCleanupAgeSec": 600
  },
  "performance": {
    "updateCycles": 100,
    "avgUpdateTimeMs": "45.23",
    "avgParseTimeMs": "0.42",
    "totalFilesProcessed": 5000,
    "totalLinesProcessed": 125000,
    "filesDeleted": 12
  }
}
```

### Metrics Endpoint
```bash
curl http://localhost:9090/metrics
```

## Performance Testing

### Run Diagnostic Script
```bash
node test-cpu.js
```

This shows:
- File listing performance
- Stat operation performance
- Parse performance per file
- Projected full cycle times

## Expected Performance

### With 500 Files
- **Scan interval**: 10s
- **Cycle time** (all files cached): ~50ms
- **Cycle time** (new data): ~2-5s depending on updates
- **CPU usage**: <5% (vs 100% before)
- **Lines processed**: 50-200 per cycle

### Log Output
```
Cycle: 143 updated (+1247 lines), 393 skipped, 2 deleted, 536 total, 2341ms (avg: 1523.5ms)
Cycle: 89 updated (+731 lines), 447 skipped, 0 deleted, 534 total, 1456ms (avg: 1489.2ms)
```

## Troubleshooting

### Still High CPU?
1. Test with metrics disabled:
   ```bash
   ENABLE_METRICS=false node metrics-server.js
   ```
   If CPU drops, the issue is in parsing/scanning.

2. Increase scan interval:
   ```bash
   UPDATE_INTERVAL=30 node metrics-server.js
   ```

3. Check if file watcher is accidentally enabled:
   ```bash
   # Should show: "File watching DISABLED"
   # If it shows "ENABLED", force disable:
   USE_FILE_WATCHER=false node metrics-server.js
   ```

### No Metrics Data?
1. Check files are being found:
   ```bash
   ls -la sipp/stats/*.csv | wc -l
   ```

2. Check health endpoint:
   ```bash
   curl http://localhost:9090/health
   ```
   Look for `activeFiles` and `totalLinesProcessed`.

3. Run diagnostic:
   ```bash
   node test-cpu.js
   ```
   Should show successful parsing with data.

### Files Not Being Deleted?
- Check `FILE_CLEANUP_AGE` setting
- Ensure files are actually old (check mtime):
  ```bash
  stat sipp/stats/somefile.csv
  ```
- Look for deletion messages in logs

## Architecture Details

### Incremental Parsing Flow
1. **First scan**: Parse entire file, record file size
2. **Subsequent scans**:
   - Check current file size vs cached size
   - If grown, read only from last position to end
   - Parse all new lines
   - Update metrics with latest values
   - Cache new file size/position

### File Lifecycle
1. **Creation**: SIPp creates CSV file
2. **Active**: Updated every 1-2 seconds by SIPp
3. **Inactive**: SIPp process ends, no more updates
4. **Cleanup**: After 10min of no updates, file is deleted

### Cache Structure
```javascript
statsFileCache = Map {
  '/path/to/file.csv' => {
    mtime: 1763596803575,      // Last modification timestamp
    size: 1234567,              // Current file size in bytes
    lastParsedSize: 1234567     // Byte position we last parsed up to
  }
}
```

## Future Improvements

Potential optimizations if needed:
- Batch multiple files into single parse operation
- Use worker threads for parsing large batches
- Add compression for archived stats
- Stream processing for very large files
- Prometheus pushgateway integration
