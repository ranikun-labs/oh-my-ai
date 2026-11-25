#!/bin/sh
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$REPO/instructions/harness.md"
MINE_SOURCE="$REPO/instructions/mine.md"
CLAUDE_ADAPTER="$REPO/instructions/adapters/claude.md"
CODEX_ADAPTER="$REPO/instructions/adapters/codex.md"
ROOT_CLAUDE_OUTPUT="$REPO/CLAUDE.md"
CLAUDE_OUTPUT="$REPO/claude/CLAUDE.md"
CODEX_OUTPUT="$REPO/AGENTS.md"
MINE_OUTPUT="$REPO/MINE.md"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/oh-my-ai-render.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
ROUTES="$TMP_DIR/routes.md"
MINE_SKILLS="$TMP_DIR/mine-skills.md"
: > "$ROUTES"
: > "$MINE_SKILLS"

require_marker() {
  template="$1"
  marker="$2"
  count="$(grep -cF "$marker" "$template" || true)"
  if [ "$count" -ne 1 ]; then
    printf 'Expected exactly one marker %s in %s (found %s)\n' "$marker" "$template" "$count" >&2
    exit 1
  fi
}

require_marker "$SOURCE" '{{GENERATED_SKILL_ROUTES}}'
require_marker "$MINE_SOURCE" '{{GENERATED_BORN_HERE_SKILLS}}'

frontmatter_value() {
  file="$1"
  key="$2"
  awk -v key="$key" '
    NR == 1 && $0 == "---" { frontmatter = 1; next }
    frontmatter && $0 == "---" { exit }
    frontmatter {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      prefix = key ":"
      if (index(line, prefix) == 1) {
        sub(/^[^:]*:[[:space:]]*/, "", line)
        print line
        exit
      }
    }
  ' "$file"
}

SKILL_LIST="$TMP_DIR/skill-paths.txt"
# Skill 탐색은 skill-discovery 모듈이 한다(flat + core/library 그룹). 실패 시 set -e로 중단된다.
node "$REPO/scripts/lib/skill-discovery.mjs" --list --root "$REPO" --format paths > "$SKILL_LIST"

while IFS= read -r skill_relpath; do
  skill_file="$REPO/$skill_relpath"
  source="$(frontmatter_value "$skill_file" source)"
  [ "$source" = "born-here" ] || continue

  name="$(frontmatter_value "$skill_file" name)"
  summary="$(frontmatter_value "$skill_file" summary)"
  route="$(frontmatter_value "$skill_file" route)"

  if [ -z "$name" ] || [ -z "$summary" ]; then
    printf 'Missing born-here skill metadata (name/summary): %s\n' "$skill_file" >&2
    exit 1
  fi

  directory_name="$(basename "$(dirname "$skill_file")")"
  if [ "$name" != "$directory_name" ]; then
    printf 'Skill name must match directory: %s (name=%s)\n' "$skill_file" "$name" >&2
    exit 1
  fi

  printf -- '- `%s/` — %s\n' "$(dirname "$skill_relpath")" "$summary" >> "$MINE_SKILLS"
  if [ -n "$route" ]; then
    printf '| %s | `%s` 스킬 |\n' "$route" "$name" >> "$ROUTES"
  fi
done < "$SKILL_LIST"

expand_template() {
  template="$1"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '{{GENERATED_SKILL_ROUTES}}') cat "$ROUTES" ;;
      '{{GENERATED_BORN_HERE_SKILLS}}') cat "$MINE_SKILLS" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$template"
}

trim_trailing_blank_lines() {
  trim_input="$1"
  trim_output="$2"
  awk '
    NF { while (blank > 0) { print ""; blank-- } print; next }
    { blank++ }
  ' "$trim_input" > "$trim_output"
}

render() {
  adapter="$1"
  output="$2"
  temp_output="$TMP_DIR/$(printf '%s' "$output" | tr '/' '_').rendered"
  {
    printf '%s\n\n' '<!-- GENERATED FILE. Edit instructions/harness.md, instructions/adapters/*.md, or skills/*/SKILL.md metadata, then run make instructions. -->'
    cat "$adapter"
    printf '\n---\n\n'
    expand_template "$SOURCE"
  } > "$temp_output"
  trim_trailing_blank_lines "$temp_output" "$temp_output.trimmed"
  mv "$temp_output.trimmed" "$output"
}

render "$CLAUDE_ADAPTER" "$ROOT_CLAUDE_OUTPUT"
render "$CLAUDE_ADAPTER" "$CLAUDE_OUTPUT"
render "$CODEX_ADAPTER" "$CODEX_OUTPUT"

MINE_TEMP="$TMP_DIR/MINE.md.rendered"
{
  printf '%s\n\n' '<!-- GENERATED FILE. Edit instructions/mine.md or skills/*/SKILL.md metadata, then run make instructions. -->'
  expand_template "$MINE_SOURCE"
} > "$MINE_TEMP"
trim_trailing_blank_lines "$MINE_TEMP" "$MINE_TEMP.trimmed"
mv "$MINE_TEMP.trimmed" "$MINE_OUTPUT"

node "$REPO/scripts/render-skill-index.mjs"

printf 'Rendered %s\n' "$ROOT_CLAUDE_OUTPUT"
printf 'Rendered %s\n' "$CLAUDE_OUTPUT"
printf 'Rendered %s\n' "$CODEX_OUTPUT"
printf 'Rendered %s\n' "$MINE_OUTPUT"
