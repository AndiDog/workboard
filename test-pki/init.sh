#!/usr/bin/env bash
set -eu -o pipefail

if [ -e ca/private/ca.key ] || [ -e localhost.crt ]; then
	>&2 echo "CA already exists. If it expired and you want to recreate it, first run \`rm -rf ca localhost.*\`"
	exit 1
fi

for n in certs crl newcerts private; do mkdir -p ca/$n && touch ca/$n/.gitkeep; done
touch ca/index.txt
[ -e ca/serial ] || echo 1000 >ca/serial

# macOS Catalina limited the maximum validity, even for self-signed certificates
# (https://support.apple.com/en-us/HT210176)
days=825

openssl genrsa -out ca/private/ca.key 2048
chmod 0400 ca/private/ca.key
openssl req -config openssl.cnf -key ca/private/ca.key -new -x509 -days ${days} -sha256 -extensions v3_ca \
	-subj "/C=DE/ST=Nowhere/L=Nowhere/O=Nowhere/OU=Nowhere/CN=workboard-test-pki-ca" \
	-out ca/ca.crt

./create-cert.sh openssl.cnf localhost

echo "Created successfully"
