#!/bin/bash
#https://github.com/dizzy/sipR/tree/master/sipRtest/register
#https://github.com/saghul/sipp-scenarios/blob/master/sipp_uas_pcap_g711a.xml
#https://github.com/SIPp/sipp/issues/412

# Multi-server support with backward compatibility
# Usage: register_all.sh [--server <server-id>]

BASE_DIR="/usr/local/NetSapiens/netsapiens-loadgenerator"
source $BASE_DIR/.env

# Parse command-line arguments for multi-server support
SERVER_ID=""
if [ "$1" == "--server" ] && [ -n "$2" ]; then
    SERVER_ID="$2"

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
        echo "Running for ALL servers in servers.json"
        echo "=========================================="

        # Loop through each server and call this script recursively
        for SID in $SERVER_IDS; do
            echo ""
            echo ">>> Starting registration for server: $SID"
            echo "---"
            $0 --server "$SID"
            RESULT=$?
            if [ $RESULT -ne 0 ]; then
                echo "Warning: Registration for server '$SID' failed with exit code $RESULT"
            else
                echo ">>> Completed registration for server: $SID"
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

# Determine CSV path and target server
if [ -n "$SERVER_ID" ]; then
    # Multi-server mode: Load configuration from servers.json
    if [ -f "$BASE_DIR/servers.json" ]; then
        # Extract server configuration from servers.json using jq
        if command -v jq &> /dev/null; then
            SUT=$(jq -r ".servers[] | select(.id==\"$SERVER_ID\") | .hostname" "$BASE_DIR/servers.json")
            if [ -z "$SUT" ] || [ "$SUT" == "null" ]; then
                echo "Error: Server '$SERVER_ID' not found in servers.json"
                exit 1
            fi
        else
            echo "Error: jq is required for multi-server mode but not installed"
            echo "Install with: sudo apt-get install jq (Ubuntu) or brew install jq (macOS)"
            exit 1
        fi
    else
        echo "Error: servers.json not found. Required for multi-server mode."
        exit 1
    fi

    CSV_PATH="$BASE_DIR/sipp/csv/servers/$SERVER_ID/devices"

    if [ ! -d "$CSV_PATH" ]; then
        echo "Error: Device CSV directory not found: $CSV_PATH"
        echo "Have you generated data for this server using: node server.js --server $SERVER_ID"
        exit 1
    fi
else
    # Legacy single-server mode: Use environment variable
    SUT=$TARGET_SERVER
    CSV_PATH="$BASE_DIR/sipp/csv/devices"

    if [ ! -d "$CSV_PATH" ]; then
        echo "Error: Legacy device CSV directory not found: $CSV_PATH"
        echo "Have you generated data using: node server.js"
        exit 1
    fi
    echo "Legacy single-server mode: Using TARGET_SERVER from .env"
fi

echo "Target server: $SUT"
echo "CSV path: $CSV_PATH"

COUNTER=0;
if [ -z "$2" ]; then
	COUNTER=$2;
fi

FILES=`ls $CSV_PATH/* 2>/dev/null | wc -l`
echo "Found $FILES files"

if [ "$FILES" -eq 0 ]; then
    echo "Error: No device CSV files found in $CSV_PATH"
    exit 1
fi

COUNTER_LOCAL=0;
HOUROFDAY=`date +"%H"`
MINOFHOUR=`date +"%M"`
ADJUSTPORT=$((HOUROFDAY % 2)) # 0 or 1, use to adjust port numbers every hour to avoid conflicts at the top of the hour during flip over.

# Calculate server-specific port offset to prevent conflicts when multiple servers run on same machine
SERVER_PORT_OFFSET=0
if [ -n "$SERVER_ID" ]; then
    # Generate a unique offset based on server ID hash (0-9000 range in increments of 1000)
    SERVER_HASH=$(echo -n "$SERVER_ID" | md5sum | cut -c1-2)
    SERVER_PORT_OFFSET=$((0x$SERVER_HASH % 10 * 1000))
    echo "Server-specific port offset: $SERVER_PORT_OFFSET"
fi

if [ $ADJUSTPORT -eq 0 ]; then
	SIPPORT=$((6060 + SERVER_PORT_OFFSET));
	MEDIAPORT=$((20000 + SERVER_PORT_OFFSET));
	CONTROLPORT=$((10000 + SERVER_PORT_OFFSET));
else
	SIPPORT=$((8060 + SERVER_PORT_OFFSET));
	MEDIAPORT=$((30004 + SERVER_PORT_OFFSET));
	CONTROLPORT=$((12004 + SERVER_PORT_OFFSET));
fi

echo "Port ranges - SIP: $SIPPORT+, Media: $MEDIAPORT+, Control: $CONTROLPORT+"

# get the public ip and push it into the sipp scripts for the media ip.
PUBLICIP=`dig +short myip.opendns.com @resolver1.opendns.com -4`
PRIVATEIP=$(ip a s|sed -ne '/127.0.0.1/!{s/^[ \t]*inet[ \t]*\([0-9.]\+\)\/.*$/\1/p}')

if [ "$IP_USE_PUBLIC" == "1" ]; then
	sed -i -e "s/\[media_ip\]/$PUBLICIP/g" /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uas_pcap_g711a.xml
else 
	sed -i -e "s/\[media_ip\]/$PRIVATEIP/g" /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uas_pcap_g711a.xml
fi

ulimit -n 65536

# Use server-specific log files if in multi-server mode
if [ -n "$SERVER_ID" ]; then
    ERROR_LOG="$BASE_DIR/sipp/scripts/error_register_${SERVER_ID}.log"
    REGISTER_LOG="$BASE_DIR/sipp/scripts/register_${SERVER_ID}.log"
else
    ERROR_LOG="$BASE_DIR/sipp/scripts/error_register.log"
    REGISTER_LOG="$BASE_DIR/sipp/scripts/register.log"
fi

echo "starting run... " > "$ERROR_LOG"
echo "scheduling batch" >> "$REGISTER_LOG"

for file in $CSV_PATH/*; do
	SIPPORT=$((SIPPORT + 1));
	CONTROLPORT=$((CONTROLPORT + 1));
	MEDIAPORT=$((MEDIAPORT + 4));

	#modulo COUNTER AND MINOFHOUR
	MODU=$((COUNTER % 60));
	if [ $MODU -eq $MINOFHOUR ]; then
		echo "Registering $file"
	else
		COUNTER=$((COUNTER + 1)); ##incremenet here to keep looping. 
		continue;		
	fi

	COUNTER=$((COUNTER + 1)); #moved below to keep 0 based index.

	sleep 2; #disperse the load a bit.

	TRANSPORT_TYPE=$((COUNTER % 3));
	if [ $TRANSPORT_TYPE -eq 2 ]; then
		/usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/register.sh "$SUT" "$file" "u1" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP "$SERVER_ID"
	elif [ $TRANSPORT_TYPE -eq 1 ]; then
		/usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/register.sh "$SUT" "$file" "t1" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP "$SERVER_ID"
	else
		#TODO: add tls support here.
		/usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/register.sh "$SUT" "$file" "u1" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP "$SERVER_ID"
	fi
    
done
