#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
tmpdir="$(mktemp -d /tmp/rpl-121-phony.XXXXXX)"
trap 'rm -rf "$tmpdir"' EXIT

mkdir -p "$tmpdir/scripts/lib"
cp "$repo_root/Makefile" "$tmpdir/Makefile"
cp "$repo_root/scripts/test-portfolio-briefing-mcp-adapter.mjs" "$tmpdir/scripts/"
cp "$repo_root/scripts/lib/portfolio-briefing-mcp-adapter.mjs" "$tmpdir/scripts/lib/"
cp "$repo_root/scripts/lib/portfolio-briefing-snapshot.mjs" "$tmpdir/scripts/lib/"
printf '%s\n' 'same-name file must not suppress the Make recipe' > "$tmpdir/test-portfolio-briefing-mcp-adapter-fixtures"

if ! output="$(make -C "$tmpdir" test-portfolio-briefing-mcp-adapter-fixtures 2>&1)"; then
  printf '%s\n' "$output" >&2
  exit 1
fi

if ! grep -Fq 'PORTFOLIO BRIEFING MCP ADAPTER FIXTURES ' <<<"$output"; then
  printf '%s\n' "$output" >&2
  printf '%s\n' 'Expected Make to run the adapter fixture recipe despite a same-named file.' >&2
  exit 1
fi

printf '%s\n' "$output"
printf '%s\n' 'F6 PHONY TARGET COLLISION REGRESSION PASS'
