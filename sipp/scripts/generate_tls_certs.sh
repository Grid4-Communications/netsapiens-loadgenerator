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
    echo ""

    # Generate empty CRL file for SIPp
    echo "Generating empty CRL (Certificate Revocation List) file..."
    CRL_FILE="$TLS_DIR/sipp.crl"

    # Create temporary files needed by openssl ca command
    touch /tmp/index.txt.sipp
    echo "00" > /tmp/crlnumber.sipp

    # Generate the CRL
    openssl ca -gencrl \
        -keyfile "$KEY_FILE" \
        -cert "$CERT_FILE" \
        -out "$CRL_FILE" \
        -config <(cat <<EOF
[ ca ]
default_ca = CA_default

[ CA_default ]
database = /tmp/index.txt.sipp
crlnumber = /tmp/crlnumber.sipp
default_md = sha256
default_days = 365
default_crl_days = 30

[ crl_ext ]
authorityKeyIdentifier=keyid:always
EOF
) 2>/dev/null

    # Clean up temp files
    rm -f /tmp/index.txt.sipp /tmp/crlnumber.sipp /tmp/crlnumber.sipp.old

    if [ -f "$CRL_FILE" ]; then
        chmod 644 "$CRL_FILE"
        echo "✓ CRL file created: $CRL_FILE"
    else
        echo "⚠ CRL file creation failed, but certificates are still usable"
    fi

else
    echo ""
    echo "ERROR: Failed to generate TLS certificates"
    echo "Please ensure openssl is installed: apt-get install openssl"
    exit 1
fi
