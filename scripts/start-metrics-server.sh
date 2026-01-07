#!/bin/bash
#
# Start SIPp Metrics Server
# Starts the metrics server as a background service with logging
#
# Usage:
#   ./scripts/start-metrics-server.sh [start|stop|restart|status]
#

BASE_DIR="/usr/local/NetSapiens/netsapiens-loadgenerator"
SCRIPT_NAME="metrics-server.js"
PID_FILE="$BASE_DIR/logs/metrics-server.pid"
LOG_FILE="$BASE_DIR/logs/metrics-server.log"

# Ensure logs directory exists
mkdir -p "$BASE_DIR/logs"

# Function to get PID
get_pid() {
    if [ -f "$PID_FILE" ]; then
        cat "$PID_FILE"
    fi
}

# Function to check if server is running
is_running() {
    local pid=$(get_pid)
    if [ -n "$pid" ]; then
        if ps -p "$pid" > /dev/null 2>&1; then
            return 0
        fi
    fi
    return 1
}

# Function to start server
start_server() {
    if is_running; then
        echo "Metrics server is already running (PID: $(get_pid))"
        return 1
    fi

    echo "Starting SIPp Metrics Server..."
    echo "Log file: $LOG_FILE"

    cd "$BASE_DIR"

    # Start the server in background
    nohup node "$SCRIPT_NAME" >> "$LOG_FILE" 2>&1 &
    local pid=$!

    # Save PID
    echo $pid > "$PID_FILE"

    # Wait a moment and check if it's still running
    sleep 2

    if is_running; then
        echo "Metrics server started successfully (PID: $pid)"
        echo "Prometheus endpoint: http://localhost:9090/metrics"
        echo "Health check: http://localhost:9090/health"
        return 0
    else
        echo "Failed to start metrics server. Check logs: $LOG_FILE"
        rm -f "$PID_FILE"
        return 1
    fi
}

# Function to stop server
stop_server() {
    if ! is_running; then
        echo "Metrics server is not running"
        rm -f "$PID_FILE"
        return 0
    fi

    local pid=$(get_pid)
    echo "Stopping metrics server (PID: $pid)..."

    # Try graceful shutdown first (SIGTERM)
    kill -TERM "$pid" 2>/dev/null

    # Wait up to 10 seconds for graceful shutdown
    local count=0
    while is_running && [ $count -lt 10 ]; do
        sleep 1
        count=$((count + 1))
    done

    # Force kill if still running
    if is_running; then
        echo "Forcing shutdown..."
        kill -KILL "$pid" 2>/dev/null
        sleep 1
    fi

    if is_running; then
        echo "Failed to stop metrics server"
        return 1
    else
        echo "Metrics server stopped"
        rm -f "$PID_FILE"
        return 0
    fi
}

# Function to show status
show_status() {
    if is_running; then
        local pid=$(get_pid)
        echo "Metrics server is running (PID: $pid)"
        echo "Endpoint: http://localhost:9090/metrics"
        echo "Uptime:"
        ps -p "$pid" -o etime= | xargs
        return 0
    else
        echo "Metrics server is not running"
        return 1
    fi
}

# Function to show logs
show_logs() {
    if [ -f "$LOG_FILE" ]; then
        echo "=== Last 50 lines of $LOG_FILE ==="
        tail -n 50 "$LOG_FILE"
    else
        echo "Log file not found: $LOG_FILE"
    fi
}

# Main script logic
case "${1:-start}" in
    start)
        start_server
        ;;
    stop)
        stop_server
        ;;
    restart)
        stop_server
        sleep 2
        start_server
        ;;
    status)
        show_status
        ;;
    logs)
        show_logs
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs}"
        echo ""
        echo "Commands:"
        echo "  start   - Start the metrics server"
        echo "  stop    - Stop the metrics server"
        echo "  restart - Restart the metrics server"
        echo "  status  - Check server status"
        echo "  logs    - Show recent log output"
        exit 1
        ;;
esac

exit $?
