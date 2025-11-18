# Migration Guide: Single-Server to Multi-Server Configuration

This guide helps you migrate from the legacy single-server configuration to the new multi-server architecture.

## Overview

The multi-server feature allows you to generate and manage load test data for multiple NetSapiens target servers from a single installation. Key benefits include:

- **Independent SEEDs**: Each server has its own reproducible test data
- **Isolated CSV files**: Server-specific data organization prevents conflicts
- **Port management**: Automatic port offsets prevent conflicts when testing multiple servers
- **Centralized management**: Single codebase manages all target servers

## Backward Compatibility

**Good news**: Your existing single-server setup will continue to work without any changes! The system automatically detects whether you're using:

- **Legacy mode**: Single `.env` file with `TARGET_SERVER` and `APIKEY`
- **Multi-server mode**: New `servers.json` configuration file

## Migration Options

### Option 1: Continue Using Legacy Mode (No Changes Required)

If you only need to test a single server, you don't need to change anything. Your existing setup will continue to work:

```bash
# Your existing workflow remains unchanged
node server.js
sipp/scripts/register_all.sh
sipp/scripts/inbound.sh US_Eastern
```

### Option 2: Migrate to Multi-Server Mode

Follow these steps to enable multi-server support:

#### Step 1: Create `servers.json`

Copy the example configuration and customize it:

```bash
cp servers.json.example servers.json
```

Edit `servers.json` with your server configurations:

```json
{
  "servers": [
    {
      "id": "prod1",
      "hostname": "sas1.yourcompany.com",
      "apikey": "nss_your_api_key_here",
      "maxDomains": 50,
      "peakCps": 10,
      "registrationPct": 80,
      "seed": 12345,
      "description": "Production Server 1"
    },
    {
      "id": "prod2",
      "hostname": "sas2.yourcompany.com",
      "apikey": "nss_another_api_key",
      "maxDomains": 100,
      "peakCps": 20,
      "registrationPct": 90,
      "seed": 67890,
      "description": "Production Server 2"
    }
  ]
}
```

**Important**: Each server should have:
- **Unique `id`**: Used for file organization and command-line arguments
- **Independent `seed`**: Ensures each server has distinct but reproducible test data
- **Server-specific settings**: `maxDomains`, `peakCps`, `registrationPct` can differ per server

#### Step 2: Install `jq` (Required for Multi-Server Mode)

The bash scripts use `jq` to parse `servers.json`:

**Ubuntu/Debian**:
```bash
sudo apt-get install jq
```

**macOS**:
```bash
brew install jq
```

**Verify installation**:
```bash
jq --version
```

#### Step 3: Generate Data for Each Server

You must explicitly specify which server to target:

```bash
# Generate data for prod1
node server.js --server prod1

# Generate data for prod2
node server.js --server prod2
```

**What happens**:
- CSV files are created in `sipp/csv/servers/{server-id}/devices/` and `sipp/csv/servers/{server-id}/phonenumbers/`
- Each server uses its own SEED for reproducible data
- Domains are independent across servers

#### Step 4: Run SIPp Scripts with Server Specification

Update your cron jobs or manual commands to specify the target server:

**Registration**:
```bash
# Legacy (still works)
sipp/scripts/register_all.sh

# Multi-server mode
sipp/scripts/register_all.sh --server prod1
sipp/scripts/register_all.sh --server prod2
```

**Inbound calling**:
```bash
# Legacy (still works)
sipp/scripts/inbound.sh US_Eastern

# Multi-server mode
sipp/scripts/inbound.sh US_Eastern --server prod1
sipp/scripts/inbound.sh US_Pacific --server prod2
```

## File Organization Changes

### Legacy Structure
```
sipp/csv/
├── devices/
│   ├── domain1.csv
│   └── domain2.csv
├── phonenumbers/
│   ├── US_Eastern.csv
│   └── US_Pacific.csv
├── random_caller_ids.csv
└── random_user_agents.csv
```

### Multi-Server Structure
```
sipp/csv/
├── servers/
│   ├── prod1/
│   │   ├── devices/
│   │   │   ├── domain1.csv
│   │   │   └── domain2.csv
│   │   └── phonenumbers/
│   │       ├── US_Eastern.csv
│   │       └── US_Pacific.csv
│   └── prod2/
│       ├── devices/
│       └── phonenumbers/
├── random_caller_ids.csv (shared)
└── random_user_agents.csv (shared)
```

## Logging Changes

### Legacy Logs
- `sipp/scripts/error_register.log`
- `sipp/scripts/register.log`
- `sipp/scripts/inbound_US_Eastern.log`

### Multi-Server Logs
- `sipp/scripts/error_register_prod1.log`
- `sipp/scripts/register_prod1.log`
- `sipp/scripts/inbound_prod1_US_Eastern.log`
- `sipp/scripts/error_register_prod2.log`
- `sipp/scripts/register_prod2.log`
- `sipp/scripts/inbound_prod2_US_Eastern.log`

## Port Management

To prevent conflicts when running load tests against multiple servers simultaneously, the system automatically calculates port offsets:

- **Legacy mode**: Uses standard ports (6060, 8060, 20000, etc.)
- **Multi-server mode**: Adds server-specific offset based on server ID hash

Example for server `prod1`:
```
Base SIP port: 6060
Server offset: +2000 (calculated from hash of "prod1")
Actual SIP port: 8060
```

This allows multiple concurrent test runs without port conflicts.

## Updating Cron Jobs

### Legacy Cron Configuration
```bash
# /etc/cron.d/netsapiens-loadgen
*/1 * * * * root cd /usr/local/NetSapiens/netsapiens-loadgenerator && sipp/scripts/register_all.sh
0,5,10... * * * * root cd /usr/local/NetSapiens/netsapiens-loadgenerator && sipp/scripts/inbound.sh "US_Eastern"
```

### Multi-Server Cron Configuration

**Option A: Separate entries per server**
```bash
# Prod1
*/1 * * * * root cd /usr/local/NetSapiens/netsapiens-loadgenerator && sipp/scripts/register_all.sh --server prod1
0,5,10... * * * * root cd /usr/local/NetSapiens/netsapiens-loadgenerator && sipp/scripts/inbound.sh "US_Eastern" --server prod1

# Prod2
*/1 * * * * root cd /usr/local/NetSapiens/netsapiens-loadgenerator && sipp/scripts/register_all.sh --server prod2
0,5,10... * * * * root cd /usr/local/NetSapiens/netsapiens-loadgenerator && sipp/scripts/inbound.sh "US_Eastern" --server prod2
```

**Option B: Wrapper script** (create `multi_server_wrapper.sh`)
```bash
#!/bin/bash
SERVERS=$(jq -r '.servers[].id' servers.json)
for server in $SERVERS; do
    echo "Running for server: $server"
    sipp/scripts/register_all.sh --server "$server"
done
```

Then in cron:
```bash
*/1 * * * * root cd /usr/local/NetSapiens/netsapiens-loadgenerator && ./multi_server_wrapper.sh
```

## Troubleshooting

### "Server not found in servers.json"
- Verify the server ID in `servers.json` matches the `--server` argument
- Check JSON syntax with `jq . servers.json`

### "jq: command not found"
- Install jq: `sudo apt-get install jq` or `brew install jq`

### "Device CSV directory not found"
- Run `node server.js --server <server-id>` to generate data first
- Verify the server ID matches your configuration

### "Configuration Mode: multi" but want legacy mode
- Remove or rename `servers.json`
- System will automatically use `.env` configuration

### Port conflicts
- Check if multiple instances are using the same server ID
- Verify port offset calculation in logs: "Port ranges - SIP: XXXX+"
- Ensure different server IDs to get different port offsets

## Rollback Plan

If you need to revert to legacy mode:

1. **Stop all load generation**:
   ```bash
   pkill -f sipp
   ```

2. **Rename or remove servers.json**:
   ```bash
   mv servers.json servers.json.backup
   ```

3. **Use legacy commands**:
   ```bash
   node server.js
   sipp/scripts/register_all.sh
   ```

4. **Restore cron jobs** to legacy format

The system will automatically detect the absence of `servers.json` and use `.env` configuration.

## Best Practices

1. **Use descriptive server IDs**: `prod1`, `staging`, `dev` instead of `server1`, `server2`
2. **Keep independent SEEDs**: Ensures reproducible but distinct data per server
3. **Document your configuration**: Add meaningful `description` fields in `servers.json`
4. **Test incrementally**: Start with one server in multi-server mode before adding more
5. **Monitor logs separately**: Use server-specific log files for easier debugging
6. **Version control**: Commit `servers.json.example` but not `servers.json` (contains API keys)

## Need Help?

If you encounter issues during migration:

1. Check the logs in `sipp/scripts/error_*.log`
2. Verify `servers.json` syntax: `jq . servers.json`
3. Test data generation first: `node server.js --server <id>`
4. Then test scripts: `sipp/scripts/register_all.sh --server <id>`
5. Report issues at: https://github.com/anthropics/claude-code/issues
