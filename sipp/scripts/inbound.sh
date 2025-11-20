#!/bin/bash

# Multi-server support with backward compatibility
# Usage: inbound.sh <timezone> [--server <server-id>]
# Example: inbound.sh US_Eastern --server prod1

BASE_DIR="/usr/local/NetSapiens/netsapiens-loadgenerator"
source $BASE_DIR/.env

# Parse arguments: timezone is first, --server is optional
TIMEZONE="$1"
SERVER_ID=""

if [ -z "$TIMEZONE" ]; then
    echo "Error: Timezone argument required"
    echo "Usage: inbound.sh <timezone> [--server <server-id>]"
    echo "Example: inbound.sh US_Eastern --server prod1"
    exit 1
fi

# Check for --server flag in second position
if [ "$2" == "--server" ] && [ -n "$3" ]; then
    SERVER_ID="$3"

    # Handle --server all: loop through all servers in servers.json
    if [ "$SERVER_ID" == "all" ]; then
        if [ ! -f "$BASE_DIR/servers.json" ]; then
            echo "Error: servers.json not found. Required for --server all"
            exit 1
        fi

        if ! command -v jq &> /dev/null; then
            echo "Error: jq is required for --server all but not installed"
            exit 1
        fi

        # Get all server IDs from servers.json
        SERVER_IDS=$(jq -r '.servers[].id' "$BASE_DIR/servers.json")

        if [ -z "$SERVER_IDS" ]; then
            echo "Error: No servers found in servers.json"
            exit 1
        fi

        echo "=========================================="
        echo "Running inbound for ALL servers in servers.json"
        echo "Timezone: $TIMEZONE"
        echo "=========================================="

        # Loop through each server and call this script recursively
        for SID in $SERVER_IDS; do
            echo ""
            echo ">>> Starting inbound calls for server: $SID (timezone: $TIMEZONE)"
            echo "---"
            $0 "$TIMEZONE" --server "$SID"
            RESULT=$?
            if [ $RESULT -ne 0 ]; then
                echo "Warning: Inbound calls for server '$SID' failed with exit code $RESULT"
            else
                echo ">>> Completed inbound calls for server: $SID"
            fi
            echo ""
        done

        echo "=========================================="
        echo "Finished running for all servers"
        echo "=========================================="
        exit 0
    fi

    echo "Multi-server mode: Using server '$SERVER_ID'"
fi

# Determine target server and CSV path
if [ -n "$SERVER_ID" ]; then
    # Multi-server mode: Load configuration from servers.json
    if [ -f "$BASE_DIR/servers.json" ]; then
        if command -v jq &> /dev/null; then
            SUT=$(jq -r ".servers[] | select(.id==\"$SERVER_ID\") | .hostname" "$BASE_DIR/servers.json")
            if [ -z "$SUT" ] || [ "$SUT" == "null" ]; then
                echo "Error: Server '$SERVER_ID' not found in servers.json"
                exit 1
            fi
        else
            echo "Error: jq is required for multi-server mode but not installed"
            exit 1
        fi
    else
        echo "Error: servers.json not found"
        exit 1
    fi

    INPUTFILE="$BASE_DIR/sipp/csv/servers/$SERVER_ID/phonenumbers/${TIMEZONE}.csv"
else
    # Legacy single-server mode
    SUT=${SAS_SERVER:-$TARGET_SERVER}
    INPUTFILE="$BASE_DIR/sipp/csv/phonenumbers/${TIMEZONE}.csv"
    echo "Legacy single-server mode"
fi


echo "Target server: $SUT"
echo "Input file: $INPUTFILE"

# Create stats filename with server ID if provided
if [ -n "$SERVER_ID" ]; then
    STATS_FILE="${STATS_PATH}/${SERVER_ID}_register_${LOG_FILE}_$$.csv"
else
    STATS_FILE="${STATS_PATH}/register_${LOG_FILE}_$$.csv"
fi

if [ ! -f "$INPUTFILE" ]; then
	echo "Error: File $INPUTFILE does not exist"
	echo "Have you generated data for timezone $TIMEZONE?"
	exit 1
fi

# Load PEAK_CPS from server-specific config if available
if [ -n "$SERVER_ID" ] && [ -f "$BASE_DIR/servers.json" ]; then
    if command -v jq &> /dev/null; then
        SERVER_PEAK_CPS=$(jq -r ".servers[] | select(.id==\"$SERVER_ID\") | .peakCps" "$BASE_DIR/servers.json")
        if [ -n "$SERVER_PEAK_CPS" ] && [ "$SERVER_PEAK_CPS" != "null" ]; then
            PEAK_CPS=$SERVER_PEAK_CPS
            echo "Using server-specific PEAK_CPS: $PEAK_CPS"
        fi
    fi
fi

# Fallback to .env or default
if [ -z "$PEAK_CPS" ]; then
	echo "No PEAK_CPS specified, defaulting to 7 cps, 1 per script"
	PEAK_CPS=7
fi

#add some randomness to the PEAK_CPS to avoid exact same call rate every run, make it + or - 10%
# Use bc for decimal arithmetic to support CPS < 1
TEN_PERCENT=$(echo "scale=4; $PEAK_CPS * 0.1" | bc)

# Generate random adjustment between 0 and 10% of PEAK_CPS
# RANDOM generates 0-32767, we'll scale it to 0-1 range then multiply by 10%
RANDOM_FACTOR=$(echo "scale=4; $RANDOM / 32767" | bc)
RANDOM_ADJUSTMENT=$(echo "scale=4; $TEN_PERCENT * $RANDOM_FACTOR" | bc)

# Randomly add or subtract the adjustment
if (( RANDOM % 2 )); then
	PEAK_CPS=$(echo "scale=4; $PEAK_CPS + $RANDOM_ADJUSTMENT" | bc)
else
	PEAK_CPS=$(echo "scale=4; $PEAK_CPS - $RANDOM_ADJUSTMENT" | bc)
fi

#round PEAK_CPS to 2 decimal places (to support CPS < 1)
PEAK_CPS=$(echo "scale=2; $PEAK_CPS / 1" | bc)


PUBLICIP=`dig +short myip.opendns.com @resolver1.opendns.com -4`
PRIVATEIP=$(ip a s|sed -ne '/127.0.0.1/!{s/^[ \t]*inet[ \t]*\([0-9.]\+\)\/.*$/\1/p}')

if [ "$IP_USE_PUBLIC" == "1" ]; then
	sed -i -e "s/\[media_ip\]/$PUBLICIP/g" /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uac_pcap_g711a.xml
else 
	sed -i -e "s/\[media_ip\]/$PRIVATEIP/g" /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uac_pcap_g711a.xml
fi


CALLRATE=`printf "%.2f\n" $(echo "scale=2;$PEAK_CPS/7" |bc)` # 7 scripts running at once assuming all TZ's in play.
DURATION=275 # 5 minutes minus some time for calls to complete
NUMCALLS=`printf "%.0f\n" $(echo "scale=2;$CALLRATE*$DURATION" |bc)`
echo "Submitting $NUMCALLS calls to $SUT for $DURATION seconds at $CALLRATE cps using $INPUTFILE"

# Use server-specific log file if in multi-server mode
if [ -n "$SERVER_ID" ]; then
    LOG_FILE="$BASE_DIR/sipp/scripts/inbound_${SERVER_ID}_${TIMEZONE}.log"
else
    LOG_FILE="$BASE_DIR/sipp/scripts/inbound_${TIMEZONE}.log"
fi

sipp \
	${SUT} \
    -r "$CALLRATE" \
	-m $NUMCALLS \
	-sf $BASE_DIR/sipp/scripts/sipp_uac_pcap_g711a.xml \
	-inf $INPUTFILE \
	-watchdog_interval 900000 \
	-watchdog_minor_threshold 920000 \
	-watchdog_major_threshold 9200000 \
	-t u1 \
    -inf $BASE_DIR/sipp/csv/random_caller_ids.csv \
	-recv_timeout 60000 \
	-key media_ip $PUBLICIP \
	-bg \
    -trace_err \
    -trace_stat -stf "$STATS_FILE" -fd 10 \
    > "$LOG_FILE" 2>&1

