#!/bin/sh
# Starts tesla-http-proxy on localhost only (self-signed TLS, pinned by server.js), then the Node app.
KEY="${TESLA_KEY_FILE:-/etc/secrets/tesla_private.pem}"
if [ -n "$TESLA_PRIVATE_KEY_B64" ]; then
  echo "$TESLA_PRIVATE_KEY_B64" | tr -d ' \r\n' | base64 -d > /tmp/tesla_private.pem 2>/dev/null && chmod 600 /tmp/tesla_private.pem
  if openssl pkey -in /tmp/tesla_private.pem -noout 2>/dev/null; then KEY=/tmp/tesla_private.pem; echo "Tesla key loaded from TESLA_PRIVATE_KEY_B64"; else echo "TESLA_PRIVATE_KEY_B64 is not a valid key"; fi
fi
if [ -f "$KEY" ]; then
  openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -keyout /tmp/proxy-tls-key.pem -out /tmp/proxy-tls-cert.pem -days 3650 >/dev/null 2>&1
  tesla-http-proxy -tls-key /tmp/proxy-tls-key.pem -cert /tmp/proxy-tls-cert.pem -key-file "$KEY" -host 127.0.0.1 -port 4443 &
  sleep 2; if kill -0 $! 2>/dev/null; then echo "tesla-http-proxy running"; else echo "tesla-http-proxy FAILED to start"; fi
else
  echo "no Tesla private key at $KEY: signed commands disabled"; unset TESLA_PROXY_URL
fi
exec node server.js
