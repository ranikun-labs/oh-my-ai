#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT

cat > "$fixture_dir/codex" <<'SERVER'
#!/usr/bin/env bash
set -euo pipefail
test "$*" = 'app-server --stdio'
if [[ -n "${FX_F1_SIGNAL_FIXTURE:-}" ]]; then
  exec node -e 'process.on("SIGTERM", () => process.exit(23)); require("node:fs").writeFileSync(process.env.FX_F1_SIGNAL_FIXTURE, "ready"); setInterval(() => {}, 1000);'
fi
cat
SERVER
chmod +x "$fixture_dir/codex"

cat > "$fixture_dir/stream" <<'EVENTS'
{"method":"thread/tokenUsage/updated","params":{"threadId":"private-thread","turnId":"private-turn","tokenUsage":{"last":{"inputTokens":12,"cachedInputTokens":0,"outputTokens":3,"reasoningOutputTokens":0,"totalTokens":15},"total":{"inputTokens":120,"cachedInputTokens":0,"outputTokens":30,"reasoningOutputTokens":0,"totalTokens":150}}}}
{"method":"turn/completed","params":{"threadId":"private-thread","turn":{"id":"private-turn","status":"completed","items":[]}}}
EVENTS

PATH="$fixture_dir:$PATH" node "$repo_root/scripts/codex-app-server-f1.mjs" < "$fixture_dir/stream" > "$fixture_dir/rpc" 2> "$fixture_dir/f1"
cmp "$fixture_dir/stream" "$fixture_dir/rpc"
test "$(grep -c '^\[F1\]' "$fixture_dir/f1")" = 1
grep -q '입력 12.*출력 3.*턴 전체 사용량 UNKNOWN' "$fixture_dir/f1"
if grep -Eq 'private-thread|private-turn|120' "$fixture_dir/f1"; then exit 1; fi

node -e 'process.stdout.write("x".repeat(4 * 1024 * 1024 + 1) + "\n")' > "$fixture_dir/oversize"
cat "$fixture_dir/stream" >> "$fixture_dir/oversize"
PATH="$fixture_dir:$PATH" node "$repo_root/scripts/codex-app-server-f1.mjs" < "$fixture_dir/oversize" > "$fixture_dir/rpc" 2> "$fixture_dir/f1"
cmp "$fixture_dir/oversize" "$fixture_dir/rpc"
test "$(grep -c '^\[F1\]' "$fixture_dir/f1")" = 1
grep -q '관측 크기 제한 초과' "$fixture_dir/f1"
FX_F1_SIGNAL_FIXTURE="$fixture_dir/ready" PATH="$fixture_dir:$PATH" node "$repo_root/scripts/codex-app-server-f1.mjs" < /dev/null > "$fixture_dir/signal-ready" 2>&1 &
proxy_pid=$!
for _ in {1..50}; do
  if test -f "$fixture_dir/ready"; then break; fi
  sleep 0.1
done
if ! test -f "$fixture_dir/ready"; then
  cat "$fixture_dir/signal-ready" >&2
  kill -TERM "$proxy_pid" || true
  exit 1
fi
# Signal only the proxy PID.
kill -TERM "$proxy_pid"
result=0
wait "$proxy_pid" || result=$?
test "$result" = 23
echo "Codex App Server F1 proxy fixture PASS"
