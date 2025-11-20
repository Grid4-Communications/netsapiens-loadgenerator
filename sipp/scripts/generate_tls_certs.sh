#!/bin/bash

# Generate self-signed TLS certificates for SIPp
# This creates certificates valid for TLS testing with SIPp

BASE_DIR="/usr/local/NetSapiens/netsapiens-loadgenerator"
TLS_DIR="$BASE_DIR/sipp/tls"
CERT_FILE="$TLS_DIR/sipp.crt"
KEY_FILE="$TLS_DIR/sipp.key"

echo "=========================================="
echo "SIPp TLS Certificate Generator"
echo "=========================================="
echo ""

# Create TLS directory if it doesn't exist
if [ ! -d "$TLS_DIR" ]; then
    echo "Creating TLS directory: $TLS_DIR"
    mkdir -p "$TLS_DIR"
fi

# Check if certificates already exist
if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
    echo "Certificates already exist:"
    echo "  Certificate: $CERT_FILE"
    echo "  Private Key: $KEY_FILE"
    echo ""
    read -p "Regenerate certificates? (y/N): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Keeping existing certificates."
        exit 0
    fi
fi

# Generate self-signed certificate and private key
echo "Generating self-signed TLS certificate..."
echo ""

openssl req -x509 \
    -newkey rsa:2048 \
    -nodes \
    -keyout "$KEY_FILE" \
    -out "$CERT_FILE" \
    -days 3650 \
    -subj "/C=US/ST=State/L=City/O=LoadTest/OU=SIPp/CN=sipp-loadgen" \
    2>&1

if [ $? -eq 0 ]; then
    echo ""
    echo "=========================================="
    echo "SUCCESS: TLS certificates generated"
    echo "=========================================="
    echo "Certificate: $CERT_FILE"
    echo "Private Key: $KEY_FILE"
    echo ""
    echo "Certificate details:"
    openssl x509 -in "$CERT_FILE" -noout -subject -dates
    echo ""
    echo "These certificates are valid for 10 years and can be used"
    echo "for SIPp TLS testing. For production use, obtain proper"
    echo "certificates from a trusted CA."
    echo ""

    # Set appropriate permissions
    chmod 644 "$CERT_FILE"
    chmod 600 "$KEY_FILE"

    echo "Permissions set:"
    ls -l "$CERT_FILE" "$KEY_FILE"
else
    echo ""
    echo "ERROR: Failed to generate TLS certificates"
    echo "Please ensure openssl is installed: apt-get install openssl"
    exit 1
fi
