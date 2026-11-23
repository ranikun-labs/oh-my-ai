import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

function git(cwd, args, options = {}) {
  return execFileSync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024, ...options });
}

// The caller supplies a trusted task and checkpoint. Untracked files are
// refused because git diff cannot prove that they have been preserved.
export function prepareF4HandoffWorkspace({ source, parentDirectory, task }) {
  const root = git(source, ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const head = git(root, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!task?.id || !task.checkpoint || task.commit !== head) throw new Error("handoff_context_mismatch");
  if (git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).length) {
    throw new Error("handoff_untracked_requires_preservation");
  }
  const patch = git(root, ["diff", "--binary", "HEAD", "--"]);
  const destination = mkdtempSync(path.join(parentDirectory, "f4-handoff-"));
  try {
    git(parentDirectory, ["clone", "--quiet", "--no-hardlinks", "--no-local", "--no-checkout", root, destination]);
    git(destination, ["checkout", "--quiet", "--detach", head]);
    if (patch.length) git(destination, ["apply", "--binary", "-"], { input: patch });
    const restored = git(destination, ["diff", "--binary", "HEAD", "--"]);
    if (!patch.equals(restored) || !patch.equals(git(root, ["diff", "--binary", "HEAD", "--"]))) {
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
