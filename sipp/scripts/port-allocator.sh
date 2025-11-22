#!/bin/bash

# Port Allocator with Lock-Based Reservation
# Finds available ports in a range and creates lock files with timestamps
# Usage: source port-allocator.sh
#        allocate_ports <num_sip_ports> <num_media_ports> <num_control_ports>
#        release_ports <sip_port> <media_port> <control_port>

# Configuration
PORT_LOCK_DIR="${PORT_LOCK_DIR:-/tmp/sipp-ports}"
LOCK_TIMEOUT="${LOCK_TIMEOUT:-4200}"  # 70 minutes default (register.sh runs ~1hr)

# Port ranges (ephemeral range to avoid conflicts)
SIP_PORT_MIN=20000
SIP_PORT_MAX=22000
CONTROL_PORT_MIN=22001
CONTROL_PORT_MAX=24000
MEDIA_PORT_MIN=24001
MEDIA_PORT_MAX=60000


# Maximum attempts to find available ports
MAX_ATTEMPTS=200

##
# Initialize port lock directory
##
init_port_locks() {
    mkdir -p "$PORT_LOCK_DIR" 2>/dev/null
    if [ ! -d "$PORT_LOCK_DIR" ]; then
        echo "ERROR: Cannot create port lock directory: $PORT_LOCK_DIR" >&2
        return 1
    fi
    # Cleanup old locks on init
    cleanup_stale_locks
}

##
# Cleanup stale lock files older than LOCK_TIMEOUT seconds
##
cleanup_stale_locks() {
    if [ ! -d "$PORT_LOCK_DIR" ]; then
        return 0
    fi

    local now=$(date +%s)
    local cleaned=0

    # Use find to avoid glob expansion issues with nonexistent files
    find "$PORT_LOCK_DIR" -name "*.lock" -type f 2>/dev/null | while read -r lockfile; do
        if [ ! -f "$lockfile" ]; then
            continue
        fi

        # Read timestamp from lock file
        local timestamp=$(cat "$lockfile" 2>/dev/null | head -n1)
        if [ -z "$timestamp" ]; then
            # Invalid lock file, remove it
            rm -f "$lockfile"
            cleaned=$((cleaned + 1))
            continue
        fi

        # Check if lock is stale
        local age=$((now - timestamp))
        if [ "$age" -gt "$LOCK_TIMEOUT" ]; then
            rm -f "$lockfile"
            cleaned=$((cleaned + 1))
        fi
    done

    if [ "$cleaned" -gt 0 ]; then
        echo "Cleaned up $cleaned stale port locks" >&2
    fi
}

##
# Check if a port is available (not locked and not in use)
# Args: $1 = port number
# Returns: 0 if available, 1 if locked or in use
##
is_port_available() {
    local port=$1
    local lockfile="$PORT_LOCK_DIR/port_${port}.lock"

    # Check if port is locked
    if [ -f "$lockfile" ]; then
        # Check if lock is stale
        local now=$(date +%s)
        local timestamp=$(cat "$lockfile" 2>/dev/null | head -n1)
        if [ -n "$timestamp" ]; then
            local age=$((now - timestamp))
            if [ "$age" -le "$LOCK_TIMEOUT" ]; then
                return 1  # Port is locked and lock is fresh
            fi
        fi
        # Lock is stale, remove it
        rm -f "$lockfile"
    fi

    # # Check if port is actually in use by the system
    # # Use netstat or ss to check
    # if command -v ss &>/dev/null; then
    #     ss -tan | grep -q ":${port} " && return 1
    # elif command -v netstat &>/dev/null; then
    #     netstat -tan | grep -q ":${port} " && return 1
    # fi

    return 0  # Port is available
}

##
# Lock a port by creating a lock file
# Args: $1 = port number, $2 = purpose (sip|media|control)
# Returns: 0 on success, 1 on failure
##
lock_port() {
    local port=$1
    local purpose=$2
    local lockfile="$PORT_LOCK_DIR/port_${port}.lock"
    local now=$(date +%s)

    # Create lock file atomically using noclobber
    (
        set -o noclobber
        echo "$now" > "$lockfile" 2>/dev/null
        echo "$purpose" >> "$lockfile" 2>/dev/null
        echo "$$" >> "$lockfile" 2>/dev/null
    )

    # Verify lock was created
    if [ -f "$lockfile" ]; then
        return 0
    else
        return 1
    fi
}

##
# Unlock/release a port by removing its lock file
# Args: $1 = port number
##
unlock_port() {
    local port=$1
    local lockfile="$PORT_LOCK_DIR/port_${port}.lock"
    rm -f "$lockfile" 2>/dev/null
}

##
# Find the first available port in a range
# Args: $1 = min port, $2 = max port, $3 = purpose (for logging)
# Returns: port number on stdout, or empty string if none found
##
find_available_port() {
    local min_port=$1
    local max_port=$2
    local purpose=$3
    local attempts=0

    # Start from a random position to spread load
    local range=$((max_port - min_port))
    local start_offset=$((RANDOM % range))

    while [ "$attempts" -lt "$MAX_ATTEMPTS" ]; do
        local port=$((min_port + ((start_offset + attempts) % range)))

        if is_port_available "$port"; then
            echo "$port"
            return 0
        fi

        attempts=$((attempts + 1))
    done

    # No port found after MAX_ATTEMPTS
    return 1
}

##
# Allocate a set of ports (SIP, media range, control)
# Args: $1 = num_sip_ports (default 1), $2 = num_media_ports (default 4), $3 = num_control_ports (default 1)
# Sets global variables: ALLOCATED_SIP_PORT, ALLOCATED_MEDIA_PORT, ALLOCATED_CONTROL_PORT
# Returns: 0 on success, 1 on failure
##
allocate_ports() {
    local num_sip=${1:-1}
    local num_media=${2:-4}
    local num_control=${3:-1}

    # Initialize
    init_port_locks || return 1

    # Allocate SIP port
    local sip_port=$(find_available_port "$SIP_PORT_MIN" "$SIP_PORT_MAX" "sip")
    if [ -z "$sip_port" ]; then
        echo "ERROR: No available SIP ports in range $SIP_PORT_MIN-$SIP_PORT_MAX" >&2
        return 1
    fi

    # Allocate media ports (need contiguous range)
    local media_port=""
    local attempts=0
    while [ "$attempts" -lt "$MAX_ATTEMPTS" ]; do
        local candidate=$(find_available_port "$MEDIA_PORT_MIN" "$MEDIA_PORT_MAX" "media")
        if [ -z "$candidate" ]; then
            unlock_port "$sip_port"
            echo "ERROR: No available media ports" >&2
            return 1
        fi

        # Check if we can get num_media contiguous ports
        local all_available=1
        for i in $(seq 0 $((num_media - 1))); do
            local check_port=$((candidate + i))
            if ! is_port_available "$check_port"; then
                all_available=0
                break
            fi
        done

        if [ "$all_available" -eq 1 ]; then
            media_port=$candidate
            break
        fi

        attempts=$((attempts + 1))
    done

    if [ -z "$media_port" ]; then
        unlock_port "$sip_port"
        echo "ERROR: Could not find $num_media contiguous media ports" >&2
        return 1
    fi

    # Allocate control port
    local control_port=$(find_available_port "$CONTROL_PORT_MIN" "$CONTROL_PORT_MAX" "control")
    if [ -z "$control_port" ]; then
        unlock_port "$sip_port"
        echo "ERROR: No available control ports" >&2
        return 1
    fi

    # Lock all allocated ports
    lock_port "$sip_port" "sip" || {
        echo "ERROR: Failed to lock SIP port $sip_port" >&2
        return 1
    }

    for i in $(seq 0 $((num_media - 1))); do
        local mport=$((media_port + i))
        lock_port "$mport" "media" || {
            echo "ERROR: Failed to lock media port $mport" >&2
            unlock_port "$sip_port"
            return 1
        }
    done

    lock_port "$control_port" "control" || {
        echo "ERROR: Failed to lock control port $control_port" >&2
        unlock_port "$sip_port"
        for i in $(seq 0 $((num_media - 1))); do
            unlock_port $((media_port + i))
        done
        return 1
    }

    # Export results
    export ALLOCATED_SIP_PORT=$sip_port
    export ALLOCATED_MEDIA_PORT=$media_port
    export ALLOCATED_CONTROL_PORT=$control_port
    export ALLOCATED_PORTS_PID=$$

    return 0
}

##
# Release previously allocated ports
# Args: $1 = sip_port, $2 = media_port, $3 = control_port, $4 = num_media (default 4)
##
release_ports() {
    local sip_port=$1
    local media_port=$2
    local control_port=$3
    local num_media=${4:-4}

    if [ -n "$sip_port" ]; then
        unlock_port "$sip_port"
    fi

    if [ -n "$media_port" ]; then
        for i in $(seq 0 $((num_media - 1))); do
            unlock_port $((media_port + i))
        done
    fi

    if [ -n "$control_port" ]; then
        unlock_port "$control_port"
    fi
}

##
# Cleanup function to release ports on script exit
##
cleanup_allocated_ports() {
    if [ -n "$ALLOCATED_SIP_PORT" ] && [ -n "$ALLOCATED_PORTS_PID" ] && [ "$ALLOCATED_PORTS_PID" -eq "$$" ]; then
        release_ports "$ALLOCATED_SIP_PORT" "$ALLOCATED_MEDIA_PORT" "$ALLOCATED_CONTROL_PORT" 4
    fi
}

# Register cleanup trap
trap cleanup_allocated_ports EXIT INT TERM

##
# Get port allocation statistics
##
get_port_stats() {
    if [ ! -d "$PORT_LOCK_DIR" ]; then
        echo "No locks directory"
        return
    fi

    local total_locks=$(find "$PORT_LOCK_DIR" -name "*.lock" -type f 2>/dev/null | wc -l)
    local now=$(date +%s)
    local stale=0

    find "$PORT_LOCK_DIR" -name "*.lock" -type f 2>/dev/null | while read -r lockfile; do
        if [ ! -f "$lockfile" ]; then
            continue
        fi
        local timestamp=$(cat "$lockfile" 2>/dev/null | head -n1)
        if [ -n "$timestamp" ]; then
            local age=$((now - timestamp))
            if [ "$age" -gt "$LOCK_TIMEOUT" ]; then
                stale=$((stale + 1))
            fi
        fi
    done

    echo "Total locks: $total_locks, Stale: $stale, Active: $((total_locks - stale))"
}
