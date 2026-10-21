#!/bin/sh
# Starts tesla-http-proxy on localhost only (self-signed TLS, pinned by server.js), then the Node app.
# Accepts the key from TESLA_PRIVATE_KEY_B64 (base64, one line) or a Render Secret File
# (PEM or base64, tolerant of stray spaces / CRLF / leading blank lines).
OUT=/tmp/tesla_private.pem
SRC="${TESLA_KEY_FILE:-/etc/secrets/tesla_private.pem}"
try_key() { openssl pkey -in "$OUT" -noout 2>/dev/null; }
KEY=""
if [ -n "$TESLA_PRIVATE_KEY_B64" ]; then
  echo "TESLA_PRIVATE_KEY_B64 found (${#TESLA_PRIVATE_KEY_B64} chars)"
  printf '%s' "$TESLA_PRIVATE_KEY_B64" | tr -d ' \r\n\t' | base64 -d > "$OUT" 2>/dev/null
  if try_key; then KEY=$OUT; echo "Tesla key loaded from TESLA_PRIVATE_KEY_B64"; else echo "TESLA_PRIVATE_KEY_B64 is not a valid key"; fi
else
  echo "TESLA_PRIVATE_KEY_B64 not set"
fi
if [ -z "$KEY" ] && [ -f "$SRC" ]; then
  echo "secret file found at $SRC ($(wc -c < "$SRC") bytes)"
  tr -d '\r' < "$SRC" | sed 's/^[ \t]*//;s/[ \t]*$//' | sed '/^$/d' > "$OUT"
  if try_key; then KEY=$OUT; echo "Tesla key loaded from secret file (PEM)"
  else
    tr -d ' \r\n\t' < "$SRC" | base64 -d > "$OUT" 2>/dev/null
    if try_key; then KEY=$OUT; echo "Tesla key loaded from secret file (base64)"; else echo "secret file is not a valid key"; fi
  fi
fi
if [ -n "$KEY" ]; then
  chmod 600 "$OUT"
  openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -keyout /tmp/proxy-tls-key.pem -out /tmp/proxy-tls-cert.pem -days 3650 >/dev/null 2>&1
  tesla-http-proxy -tls-key /tmp/proxy-tls-key.pem -cert /tmp/proxy-tls-cert.pem -key-file "$KEY" -host 127.0.0.1 -port 4443 &
  sleep 2; if kill -0 $! 2>/dev/null; then echo "tesla-http-proxy running"; else echo "tesla-http-proxy FAILED to start"; fi
else
  echo "no valid Tesla private key: signed commands disabled"; unset TESLA_PROXY_URL
fi
exec node server.js
