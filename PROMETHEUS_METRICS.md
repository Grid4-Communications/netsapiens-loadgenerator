# SIPp Prometheus Metrics

This document describes all Prometheus metrics exported by the SIPp load generator.

## Response Time Metrics

### `sipp_response_time_average_seconds`
**Type:** Gauge
**Labels:** `server`, `scenario`, `operation`, `transport`
**Description:** Average response time in seconds for SIP operations

### `sipp_response_time_p50_seconds`
**Type:** Gauge
**Labels:** `server`, `scenario`, `operation`, `transport`
**Description:** Median (P50) response time in seconds

### `sipp_response_time_p95_seconds`
**Type:** Gauge
**Labels:** `server`, `scenario`, `operation`, `transport`
**Description:** 95th percentile response time in seconds

### `sipp_response_time_p99_seconds`
**Type:** Gauge
**Labels:** `server`, `scenario`, `operation`, `transport`
**Description:** 99th percentile response time in seconds

### `sipp_response_samples`
**Type:** Gauge
**Labels:** `server`, `scenario`, `operation`, `transport`
**Description:** Number of response time samples collected

## Call Volume Metrics (NEW)

### `sipp_current_calls`
**Type:** Gauge
**Labels:** `server`, `scenario`, `transport`
**Description:** Number of currently active SIPp calls
**Aggregation:** Summed across all SIPp processes per label combination

### `sipp_call_rate_cps`
**Type:** Gauge
**Labels:** `server`, `scenario`, `transport`
**Description:** Current call rate in calls per second, calculated from deltas between polling intervals
**Aggregation:** Calculated as `totalCallsDelta / timeDeltaSec` across all processes

### `sipp_total_calls`
**Type:** Gauge
**Labels:** `server`, `scenario`, `transport`
**Description:** Total number of calls created since processes started
**Aggregation:** Summed across all SIPp processes per label combination

## Success/Failure Metrics (NEW)

### `sipp_successful_calls_total`
**Type:** Gauge
**Labels:** `server`, `scenario`, `transport`
**Description:** Total number of successful calls
**Aggregation:** Summed across all SIPp processes per label combination

### `sipp_failed_calls_total`
**Type:** Gauge
**Labels:** `server`, `scenario`, `transport`
**Description:** Total number of failed calls (all reasons)
**Aggregation:** Summed across all SIPp processes per label combination

### `sipp_failed_calls_by_reason`
**Type:** Gauge
**Labels:** `server`, `scenario`, `transport`, `reason`
**Description:** Failed calls broken down by specific failure reason
**Aggregation:** Summed across all SIPp processes per label combination

**Failure Reasons:**
- `cannot_send_message` - Transport/network issues preventing message send
- `max_udp_retrans` - Maximum UDP retransmission attempts reached
- `unexpected_message` - Received SIP message not expected in scenario
- `call_rejected` - Internal SIPp error (scenario sync, action, or variable assignment failure)
- `regexp_no_match` - Regular expression pattern didn't match expected value
- `regexp_hdr_not_found` - Required SIP header not found for regexp matching
- `out_of_call` - SIP messages received that can't be associated with existing calls

## System Metrics

### `sipp_stats_files_active`
**Type:** Gauge
**Description:** Number of active SIPp statistics files being monitored

### `sipp_metrics_last_update_timestamp_seconds`
**Type:** Gauge
**Labels:** `server`, `scenario`
**Description:** Unix timestamp of last metrics update for this server/scenario combination

## Label Definitions

### `server`
Server identifier from the stats filename or "default" for single-server setups.
Example: `prod1`, `core2-phx.ca`

### `scenario`
SIPp scenario type.
Values: `register`, `inbound`

### `transport`
SIP transport protocol used.
Values:
- `u1` - UDP with one socket
- `t1` - TCP with one socket
- `l1` - TLS with one socket

### `operation`
Specific SIP operation within a scenario.
Examples: `register`, `reregister`, `invite`, `subscribe`

### `reason`
Failure reason category (see failure reasons above)

## State Management

The metrics system maintains internal state to properly aggregate stats from multiple SIPp processes:

- **Delta Tracking:** Tracks previous values per file to calculate rates and deltas
- **Stale File Removal:** Automatically removes files from tracking after 5 minutes of no updates
- **Aggregation:** Sums cumulative counters across files with matching labels
- **Rate Calculation:** Computes real-time call rates from deltas: `rate = (current - previous) / time_delta`

## Example PromQL Queries

```promql
# Overall call rate across all servers
sum(sipp_call_rate_cps)

# Call success rate per server
sum(sipp_successful_calls_total) by (server)
  /
sum(sipp_total_calls) by (server)

# Failed calls by reason (top 5)
topk(5, sum(sipp_failed_calls_by_reason) by (reason))

# P95 response time for registration operations
sipp_response_time_p95_seconds{operation="register"}

# Current call capacity utilization per server
sum(sipp_current_calls) by (server)
```

## Performance Notes

- All metrics use Gauges (not Counters) since SIPp provides cumulative values
- Histogram/Summary metrics are disabled for performance (300+ files = slow /metrics endpoint)
- Only the last line of each stats file is parsed (cumulative stats)
- Files older than 10 minutes are automatically cleaned up
- State tracking prevents duplicate counting when aggregating multiple processes
