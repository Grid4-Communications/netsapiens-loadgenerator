#!/bin/bash
#https://github.com/dizzy/sipR/tree/master/sipRtest/register
#https://github.com/saghul/sipp-scenarios/blob/master/sipp_uas_pcap_g711a.xml
#https://github.com/SIPp/sipp/issues/412

# Multi-server compatible registration script
# Called by register_all.sh with appropriate parameters

BASE_DIR="/usr/local/NetSapiens/netsapiens-loadgenerator"
source $BASE_DIR/.env

SUT=$1

INPUTFILE=$2
TRANSPORT=$3
PORT=$4
MEDIA_PORT=$5
CONTROL_PORT=$6
MEDIA_IP=$7
SERVER_ID=$8  # Optional: for multi-server stats tracking
PRIVATEIP=$(ip a s|sed -ne '/127.0.0.1/!{s/^[ \t]*inet[ \t]*\([0-9.]\+\)\/.*$/\1/p}')

MAX_USERS=`cat $INPUTFILE | grep -v SEQUENTIAL | wc -l`
PCT_USERS=$REGISTRATION_PCT # % of the users will be registered

MAX_USERS=`printf "%.0f\n" $(echo "scale=2;$PCT_USERS*$MAX_USERS" |bc)`

LOG_FILE=$(basename "$INPUTFILE")
CALLRATE=8 #8 registrations per second roll out rate

echo "Registering $INPUTFILE"
ulimit -n 65536

# Use BASE_DIR for log file path
LOG_PATH="$BASE_DIR/sipp/scripts"
STATS_PATH="$BASE_DIR/sipp/stats"

# Create stats filename with server ID and transport
if [ -n "$SERVER_ID" ]; then
    STATS_FILE="${STATS_PATH}/${SERVER_ID}_register_${TRANSPORT}_${LOG_FILE}_$$.csv"
else
    STATS_FILE="${STATS_PATH}/register_${TRANSPORT}_${LOG_FILE}_$$.csv"
fi

echo "`date` - [start] $INPUTFILE $PORT $MEDIA_PORT $CONTROL_PORT (max users $MAX_USERS, pct users is $PCT_USERS) stats: $STATS_FILE" >> "$LOG_PATH/error_$LOG_FILE.log"
set -x


#test if sipp has support for min_rtp_port
if sipp -h | grep -q min_rtp_port; then
	MEDIAPORT_LOGIC=" -min_rtp_port $MEDIA_PORT -max_rtp_port $((MEDIA_PORT + 3))"
else
	MEDIAPORT_LOGIC=" -mp $MEDIA_PORT "
fi

sipp \
	${SUT} \
    -key expires 60 \
	-r $[CALLRATE] \
	-m $MAX_USERS \
	-t $TRANSPORT \
	-p $PORT \
	-cp $CONTROL_PORT \
	-rtp_echo \
	-sf $BASE_DIR/sipp/scripts/register.and.subscribe.sipp.xml \
	-oocsf $BASE_DIR/sipp/scripts/sipp_uas_pcap_g711a.xml \
	-inf $INPUTFILE \
	-inf $BASE_DIR/sipp/csv/random_user_agents.csv \
	-recv_timeout 60000 \
	-watchdog_interval 0 \
	-watchdog_minor_threshold 920000 \
	-watchdog_major_threshold 9200000 \
	-aa -default_behaviors -abortunexp \
	$MEDIAPORT_LOGIC \
	-mi $PRIVATEIP \
	-bg -trace_err -error_file "$LOG_PATH/error_$LOG_FILE.log" \
	-trace_stat -stf "$STATS_FILE" -fd 10

	