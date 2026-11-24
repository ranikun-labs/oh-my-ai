import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

function git(cwd, args, options = {}) {
  return execFileSync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options });
}

// The caller supplies a trusted task and checkpoint. Untracked files are
// refused because git diff cannot prove that they have been preserved.
export function prepareF4HandoffWorkspace({ source, parentDirectory, task }) {
  const root = git(source, ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const snapshot = cwd => {
    const read = args => git(cwd, args);
    if (read(["ls-files", "--others", "--exclude-standard", "-z"]).length) {
      throw new Error("handoff_untracked_requires_preservation");
    }
    if (read(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).length) {
      throw new Error("handoff_ignored_requires_preservation");
    }
    return {
      head: read(["rev-parse", "HEAD"]).toString().trim(),
      ref: read(["rev-parse", "--symbolic-full-name", "HEAD"]).toString().trim(),
      index: read(["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"]),
      worktree: read(["diff", "--binary", "--no-ext-diff", "--no-textconv", "--"]),
    };
  };
  const before = snapshot(root);
  const { head } = before;
  if (!task?.id || !task.checkpoint || task.commit !== head) throw new Error("handoff_context_mismatch");
  const destination = mkdtempSync(path.join(parentDirectory, "f4-handoff-"));
  try {
    git(parentDirectory, ["clone", "--quiet", "--no-hardlinks", "--no-local", "--no-checkout", root, destination]);
    git(destination, ["checkout", "--quiet", "--detach", head]);
    const patchFile = path.join(destination, ".git", "f4-handoff.patch");
    for (const [patch, args] of [[before.index, ["--index"]], [before.worktree, []]]) {
      if (!patch.length) continue;
      writeFileSync(patchFile, patch, { mode: 0o600 });
      git(destination, ["apply", ...args, patchFile]);
    }
    rmSync(patchFile, { force: true });
    const restored = snapshot(destination);
    const after = snapshot(root);
    const sameContent = state => state.head === head
      && state.index.equals(before.index) && state.worktree.equals(before.worktree);
    if (!sameContent(restored) || !sameContent(after) || after.ref !== before.ref) {
      throw new Error("handoff_source_changed");
    }
    return {
      workspace: destination, taskId: task.id, commit: head, checkpoint: task.checkpoint,
      next: task.next, testEvidence: task.testEvidence,
      testEvidenceStatus: "REVALIDATION_REQUIRED",
    };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
