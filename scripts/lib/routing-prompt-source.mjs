export function extractRoutingPrompt(event, prompt) {
  // The adapters forward UserPromptSubmit JSON unchanged. No verified source
  // field is available here. Envelope recognition is advisory filtering only;
  // text (including attributes) is never evidence of identity or consent.
  if (!event || typeof event !== "object" || !["prompt", "user_prompt", "message"]
    .some(field => typeof event[field] === "string" && event[field] === prompt)) return prompt;

  const opening = /^[ \t]*<(agent-message|task-notification)(?:[ \t]+[a-z_][\w:.-]*[ \t]*=[ \t]*(?:"[^"<>\r\n]*"|'[^'<>\r\n]*'))*[ \t]*>/i;
  const closing = /<\/(agent-message|task-notification)>([ \t].*)?$/i;
  const fenceMarker = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
  const lines = prompt.split(/\r?\n/);
  const kept = [];
  let block = null;
  let fence = null;
  let removed = false;

  const append = (target, values) => {
    for (const value of values) target.push(value);
  };
  for (const line of lines) {
    const marker = fenceMarker.exec(line);
    if (fence) {
      fence.lines.push(line);
      if (marker && marker[1][0] === fence.marker[0]
        && marker[1].length >= fence.marker.length && !marker[2].trim()) {
        if (block) append(block.lines, fence.lines);
        // A quoted envelope example is data, not a runtime return. Exclude its
        // report keywords from advisory matching without changing user input.
        else if (fence.lines.some(value => opening.test(value))
          && fence.lines.some(value => closing.test(value))) removed = true;
        else append(kept, fence.lines);
        fence = null;
      }
      continue;
    }
    if (marker) {
      fence = { marker: marker[1], lines: [line] };
      continue;
    }

    const open = opening.exec(line);
    if (!block && !open) {
      kept.push(line);
      continue;
    }
    if (!block) block = { lines: [], tags: [] };
    block.lines.push(line);
    if (open) block.tags.push(open[1].toLowerCase());
    const close = closing.exec(line);
    if (!close) continue;
    const suffix = (close[2] || "").trim();
    // Preserve a same-line user suffix only at a clear envelope boundary.
    if (suffix && !open && line.slice(0, close.index).trim()) continue;
    if (block.tags.at(-1) !== close[1].toLowerCase()) {
      append(kept, block.lines);
      block = null;
      continue;
    }
    block.tags.pop();
    if (block.tags.length === 0) {
      removed = true;
      block = null;
      if (suffix) kept.push(suffix);
    }
  }

  // Incomplete/mismatched markup is ordinary, untrusted prompt text. Never
  // silently discard a user's request based on a partial envelope.
  if (fence) append(block ? block.lines : kept, fence.lines);
  if (block) append(kept, block.lines);
  if (!removed) return prompt;
  const remaining = kept.join("\n");
  return remaining.trim() ? remaining : null;
}
