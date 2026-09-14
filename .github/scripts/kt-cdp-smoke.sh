#!/usr/bin/env bash
# Container-level acceptance for the KT CDP gateway.
#
# Every assertion parses the response body. A byte-count check cannot tell
# "correctly filtered to this session" from "leaked every target" from "failed
# closed and returned []" -- and that distinction is the whole point of the
# gateway. The three phases below cover the default (fail-closed) configuration,
# the authenticated configuration, and the loopback-only escape hatch.
#
# Usage: IMAGE=<image ref> .github/scripts/kt-cdp-smoke.sh
set -euo pipefail

IMAGE="${IMAGE:?IMAGE must be set to the image ref under test}"
SMOKE_TOKEN="${SMOKE_TOKEN:-smoke-token}"
# Host ports the containers publish. Override these when something else on the
# machine already holds 3000/9223 -- a stale listener there silently answers the
# probes and produces nonsense results.
API_PORT="${API_PORT:-3000}"
GW_PORT="${GW_PORT:-9223}"
# Ports inside the container are fixed by the image.
CONTAINER_API_PORT=3000
CONTAINER_GW_PORT=9223
WAIT_SECS="${WAIT_SECS:-180}"
FOREIGN_TARGET="0BADF00D0BADF00D0BADF00D0BADF00D"

fail() {
  echo "SMOKE FAIL: $*" >&2
  exit 1
}
pass() { echo "  ok: $*"; }

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

for p in "$API_PORT" "$GW_PORT"; do
  port_free "$p" || fail "host port ${p} is already in use; rerun with API_PORT/GW_PORT overrides"
done

cleanup() {
  for c in smoke-notoken smoke-token smoke-anon; do
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

container_state() { docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null || echo "missing"; }

wait_api_healthy() {
  for _ in $(seq 1 "$WAIT_SECS"); do
    if curl -fsS "http://127.0.0.1:${API_PORT}/v1/health" >/dev/null 2>&1; then
      return 0
    fi
    [ "$(container_state "$1")" = "running" ] || return 1
    sleep 1
  done
  return 1
}

# The gateway binds inside onListen, after the browser launch, so the API being
# healthy does not imply 9223 is up yet. Tolerate connection resets while waiting.
wait_gateway() { # $1=container $2="host"|"exec"
  for _ in $(seq 1 "$WAIT_SECS"); do
    local code
    if [ "$2" = "exec" ]; then
      code="$(docker exec "$1" curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
        "http://127.0.0.1:${CONTAINER_GW_PORT}/json/list" 2>/dev/null || true)"
    else
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
        "http://127.0.0.1:${GW_PORT}/json/list" 2>/dev/null || true)"
    fi
    case "$code" in
      "" | 000) sleep 1 ;;
      *) echo "$code"; return 0 ;;
    esac
    [ "$(container_state "$1")" = "running" ] || { echo "$code"; return 1; }
  done
  return 1
}

# WS upgrade probe on node's http client (runner-preinstalled, no deps). Prints
# the status of either the 101 upgrade or the gateway's denial response.
ws_status() { # $1=path $2=token (may be empty)
  node -e '
    const http = require("http");
    const [path, token, port] = process.argv.slice(1);
    const headers = {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    };
    if (token) headers["x-cdp-token"] = token;
    const req = http.request({ host: "127.0.0.1", port: Number(port), path, headers });
    const done = (code) => { console.log(code); process.exit(0); };
    req.on("upgrade", (res) => done(res.statusCode));
    req.on("response", (res) => { res.resume(); done(res.statusCode); });
    req.on("error", () => done("ERR"));
    setTimeout(() => done("TIMEOUT"), 8000);
    req.end();
  ' "$1" "$2" "$GW_PORT"
}

expect_status() { # $1=expected $2=actual $3=label
  [ "$2" = "$1" ] || fail "$3: expected $1, got $2"
  pass "$3 -> $2"
}

echo "== phase 1: no CDP_TOKEN and no CDP_ALLOW_ANONYMOUS => refuse to start =="
docker rm -f smoke-notoken smoke-token smoke-anon >/dev/null 2>&1 || true
docker run -d --name smoke-notoken --shm-size=1g \
  -p "${API_PORT}:${CONTAINER_API_PORT}" -p "${GW_PORT}:${CONTAINER_GW_PORT}" "$IMAGE" >/dev/null
for _ in $(seq 1 "$WAIT_SECS"); do
  [ "$(container_state smoke-notoken)" = "running" ] || break
  sleep 1
done
state="$(container_state smoke-notoken)"
[ "$state" = "exited" ] || fail "expected the container to refuse to start, state=${state}"
exit_code="$(docker inspect -f '{{.State.ExitCode}}' smoke-notoken)"
[ "$exit_code" != "0" ] || fail "expected a non-zero exit code"
docker logs smoke-notoken 2>&1 | grep -q "CDP_TOKEN is not set" ||
  fail "startup logs do not explain the refusal (expected 'CDP_TOKEN is not set')"
pass "container exited ${exit_code} with an explicit CDP_TOKEN error"
# Release the published ports before the next phase binds them again.
docker rm -f smoke-notoken >/dev/null
sleep 2

echo "== phase 2: CDP_TOKEN set => authenticated, session-scoped, no WS path leak =="
docker run -d --name smoke-token --shm-size=1g \
  -p "${API_PORT}:${CONTAINER_API_PORT}" -p "${GW_PORT}:${CONTAINER_GW_PORT}" \
  -e "CDP_TOKEN=${SMOKE_TOKEN}" "$IMAGE" >/dev/null
wait_api_healthy smoke-token || {
  docker logs smoke-token
  fail "API never became healthy"
}
curl -fsS "http://127.0.0.1:${API_PORT}/v1/health" >/dev/null ||
  fail "GET /v1/health did not return 200"
pass "GET /v1/health -> 200"

gw_code="$(wait_gateway smoke-token host)" ||
  { docker logs smoke-token; fail "CDP gateway never answered on ${GW_PORT} (last code ${gw_code:-none})"; }
if [ "$gw_code" != "401" ]; then
  echo "  unexpected unauthenticated response body:" >&2
  curl -s "http://127.0.0.1:${GW_PORT}/json/list" >&2 || true
  echo >&2
  docker logs smoke-token 2>&1 | grep -i "cdpgateway\|CDP_TOKEN" >&2 || true
fi
expect_status 401 "$gw_code" "GET /json/list without token (first probe)"

body="$(curl -fsS -H "x-cdp-token: ${SMOKE_TOKEN}" "http://127.0.0.1:${GW_PORT}/json/list")"
echo "  /json/list body: ${body}"
echo "$body" | jq -e 'type == "array"' >/dev/null || fail "/json/list is not a JSON array"
count="$(echo "$body" | jq 'length')"
[ "$count" -ge 1 ] ||
  fail "expected at least this session's page target, got ${count} (a byte-count check would pass on a fail-closed [])"
echo "$body" | jq -e 'all(.[]; .type == "page")' >/dev/null ||
  fail "a non-page target leaked into /json/list"
echo "$body" | jq -e 'all(.[]; has("webSocketDebuggerUrl") | not)' >/dev/null ||
  fail "webSocketDebuggerUrl leaked"
echo "$body" | jq -e 'all(.[]; has("devtoolsFrontendUrl") | not)' >/dev/null ||
  fail "devtoolsFrontendUrl leaked (its ?ws= query carries the same WS path)"
echo "$body" | jq -e 'all(.[]; (keys | sort) == ["id", "targetId", "title", "type", "url"])' >/dev/null ||
  fail "response is not the expected allowlist projection"
echo "$body" | jq -e 'all(.[]; has("id") and .id == .targetId and (.id | length) >= 8)' >/dev/null ||
  fail "target id projection is missing or malformed"
case "$body" in
  *"/devtools/page/"*) fail "a reachable /devtools/page/ path leaked in the response" ;;
esac
pass "GET /json/list with token -> ${count} session page target(s), projection clean"

target_id="$(echo "$body" | jq -r '.[0].id')"
expect_status 405 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "x-cdp-token: ${SMOKE_TOKEN}" \
    "http://127.0.0.1:${GW_PORT}/json/new")" \
  "GET /json/new with token"
expect_status 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "x-cdp-token: ${SMOKE_TOKEN}" \
    "http://127.0.0.1:${GW_PORT}/json/version")" \
  "GET /json/version with token"
expect_status 404 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "x-cdp-token: ${SMOKE_TOKEN}" \
    "http://127.0.0.1:${GW_PORT}/json/whatever")" \
  "GET /json/whatever with token"

# WS upgrade paths: the browser endpoint is the highest-privilege surface in the
# process, so it must be authenticated; page targets must be session-scoped.
expect_status 401 "$(ws_status /devtools/browser "")" "WS /devtools/browser without token"
expect_status 401 "$(ws_status "/devtools/page/${target_id}" "")" \
  "WS /devtools/page/<session target> without token"
expect_status 101 "$(ws_status /devtools/browser "$SMOKE_TOKEN")" \
  "WS /devtools/browser with token (real handshake delegated)"
expect_status 101 "$(ws_status "/devtools/page/${target_id}" "$SMOKE_TOKEN")" \
  "WS /devtools/page/${target_id} with token (real handshake delegated)"
expect_status 403 "$(ws_status "/devtools/page/${FOREIGN_TARGET}" "$SMOKE_TOKEN")" \
  "WS /devtools/page/<foreign target> with token"

echo "== phase 3: CDP_ALLOW_ANONYMOUS=true, no token => loopback only =="
docker rm -f smoke-token >/dev/null
docker run -d --name smoke-anon --shm-size=1g \
  -p "${API_PORT}:${CONTAINER_API_PORT}" -p "${GW_PORT}:${CONTAINER_GW_PORT}" \
  -e CDP_ALLOW_ANONYMOUS=true "$IMAGE" >/dev/null
wait_api_healthy smoke-anon || {
  docker logs smoke-anon
  fail "API never became healthy in anonymous mode"
}
inner_code="$(wait_gateway smoke-anon exec)" ||
  { docker logs smoke-anon; fail "anonymous gateway never answered on container loopback"; }
expect_status 200 "$inner_code" \
  "in-container GET 127.0.0.1:${CONTAINER_GW_PORT}/json/list without token"
host_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  "http://127.0.0.1:${GW_PORT}/json/list" 2>/dev/null || true)"
case "$host_code" in
  "" | 000) pass "published ${GW_PORT} unreachable from outside the container (loopback bind)" ;;
  *) fail "anonymous gateway is reachable through the published port (got ${host_code})" ;;
esac

echo "SMOKE PASS: all CDP gateway assertions green"
