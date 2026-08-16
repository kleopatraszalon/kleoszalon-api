#!/usr/bin/env bash
set -euo pipefail

HOST="${KLEO_TLS_HOST:-kleoszalon-api-1.onrender.com}"
BUILD_REF="${GITHUB_SHA:-local}"
mkdir -p evidence

http_code="$(curl -sS --max-time 20 -D /tmp/kleo-http-headers -o /tmp/kleo-http-body -w '%{http_code}' "http://${HOST}/api/me" || true)"
if [[ "$http_code" == "200" ]]; then
  echo "Plain HTTP unexpectedly served protected application data" >&2
  exit 1
fi
if [[ "$http_code" =~ ^3 ]]; then
  location="$(awk 'BEGIN{IGNORECASE=1} /^location:/ {sub(/\r$/,""); print $2; exit}' /tmp/kleo-http-headers)"
  [[ "$location" == https://* ]] || { echo "HTTP redirect is not HTTPS: $location" >&2; exit 1; }
fi

# TLS 1.0 and 1.1 must not negotiate successfully.
for legacy in tls1 tls1_1; do
  legacy_out="/tmp/kleo-${legacy}.out"
  (echo | timeout 20 openssl s_client -connect "${HOST}:443" -servername "$HOST" "-${legacy}" >"$legacy_out" 2>&1) || true
  if grep -Eq 'Protocol[[:space:]]*:[[:space:]]*TLSv1(\.0|\.1)?$|Protocol version:[[:space:]]*TLSv1(\.0|\.1)?$' "$legacy_out"; then
    echo "Legacy protocol negotiated successfully: $legacy" >&2
    exit 1
  fi
done

# TLS 1.2 must work with a valid chain and hostname.
echo | timeout 25 openssl s_client -connect "${HOST}:443" -servername "$HOST" -tls1_2 -verify_return_error -showcerts >/tmp/kleo-tls12.out 2>/tmp/kleo-tls12.err
if ! grep -Eq 'Verify return code: 0 \(ok\)|Verification: OK' /tmp/kleo-tls12.out; then
  cat /tmp/kleo-tls12.err >&2 || true
  echo "TLS 1.2 certificate verification failed" >&2
  exit 1
fi
awk '/-----BEGIN CERTIFICATE-----/{capture=1} capture{print} /-----END CERTIFICATE-----/{exit}' /tmp/kleo-tls12.out >/tmp/kleo-leaf.pem
openssl x509 -in /tmp/kleo-leaf.pem -noout -checkhost "$HOST"
openssl x509 -in /tmp/kleo-leaf.pem -noout -checkend 1209600
not_after="$(openssl x509 -in /tmp/kleo-leaf.pem -noout -enddate | cut -d= -f2-)"
subject="$(openssl x509 -in /tmp/kleo-leaf.pem -noout -subject | sed 's/"/\\"/g')"
issuer="$(openssl x509 -in /tmp/kleo-leaf.pem -noout -issuer | sed 's/"/\\"/g')"

cat > evidence/requirements-evidence-tls-security.json <<JSON
{
  "schema_version": "1.0.0",
  "build_ref": "${BUILD_REF}",
  "environment": "production-public-endpoint",
  "host": "${HOST}",
  "http_status": "${http_code}",
  "tls_minimum": "TLS1.2",
  "certificate_not_after": "${not_after}",
  "certificate_subject": "${subject}",
  "certificate_issuer": "${issuer}",
  "result": "passed",
  "criteria": [
    {"criterion_id":"KLEO-NFR-SEC-001-AC-01","result":"passed","test_ref":"tests/tls_security_evidence.sh"},
    {"criterion_id":"KLEO-NFR-SEC-001-AC-02","result":"passed","test_ref":"tests/tls_security_evidence.sh"}
  ],
  "generated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

echo "TLS_SECURITY_EVIDENCE_OK host=${HOST} http=${http_code} not_after=${not_after}"
