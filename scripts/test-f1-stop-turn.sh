#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
state_root="$(mktemp -d)"
trap 'rm -rf "$state_root"' EXIT
export OH_MY_AI_STATE_ROOT="$state_root"
export OH_MY_AI_EXPECT_F1=0
event() {
  node -e 'const [name, turn_id, text] = process.argv.slice(1);
  console.log(JSON.stringify({hook_event_name:name, session_id:"test-session", turn_id, cwd:process.cwd(),
    ...(name==="Stop" ? {last_assistant_message:text,stop_hook_active:false} : {prompt:text})}));' "$@"
}
submit() { event UserPromptSubmit "$@" | node scripts/oh-my-ai.mjs hook codex UserPromptSubmit >/dev/null; }
stop() { event Stop "$1" plain-reply | node scripts/oh-my-ai.mjs hook codex Stop; }

submit expected '$dev-main-flow 이어서 진행해'
submit quoted '예시: $dev-main-flow'
submit code '    $dev-main-flow'
test "$(stop unrelated)" = '{}'
test "$(stop quoted)" = '{}'
test "$(stop code)" = '{}'
stop expected | node -e 'let t="";process.stdin.on("data",c=>t+=c).on("end",()=>require("node:assert/strict").deepEqual(Object.keys(JSON.parse(t)),["systemMessage"]));'
submit expected '$dev-main-flow'
test "$(stop expected)" = '{}'
printf 'F1 Stop native event correlation fixtures PASS\n'
