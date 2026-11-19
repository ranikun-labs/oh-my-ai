import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const localGitEnvironment = {
  ...process.env,
  GIT_ALLOW_PROTOCOL: "",
  GIT_NO_LAZY_FETCH: "1",
  GIT_OPTIONAL_LOCKS: "0",
};

function git(repository, args, env = localGitEnvironment, { allowedStatuses = [0], input } = {}) {
  const result = spawnSync("git", ["--no-optional-locks", "-C", repository, "-c", "core.fsmonitor=false", ...args], {
    env,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowedStatuses.includes(result.status)) throw new Error("Git worktree inspection failed");
  return result.stdout;
}

function gitConfig(repository, args, env) {
  const configEnv = { ...env };
  delete configEnv.GIT_CONFIG;
  return git(repository, ["config", ...args], configEnv, { allowedStatuses: [0, 1] });
}

function verifiedStatusArgs(repository, indexedFiles, env) {
  const output = gitConfig(repository, ["--null", "--get-regexp", "^filter\\..+\\.(clean|process)$"], env);
  const registrations = new Map();
  for (const entry of nulRecords(output.toString())) {
    const separator = entry.indexOf("\n");
    if (separator < 0) throw new Error("Invalid filter registration");
    registrations.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  const externalDrivers = new Set([...registrations].filter(([, command]) => command)
    .map(([key]) => /^filter\.(.+)\.(?:clean|process)$/.exec(key)[1]));
  if (externalDrivers.size === 0) return [];

  if (indexedFiles.length > 0) {
    const input = Buffer.from(indexedFiles.join("\0") + "\0", "latin1");
    const attributes = nulRecords(git(repository, ["check-attr", "--stdin", "-z", "filter"], env, { input }).toString("latin1"));
    if (attributes.length !== indexedFiles.length * 3) throw new Error("Incomplete filter attributes");
    for (const [i, indexedFile] of indexedFiles.entries()) {
      const [file, attribute, value] = attributes.slice(i * 3, i * 3 + 3);
      if (file !== indexedFile || attribute !== "filter") throw new Error("Invalid filter attributes");
      if (externalDrivers.has(decoder.decode(Buffer.from(value, "latin1")))) throw new Error("Indexed file uses an external filter");
    }
  }
  // Prevent an inspected driver from running if its attributes change after the check.
  return [...externalDrivers].flatMap(driver => ["-c", `filter.${driver}.clean=`, "-c", `filter.${driver}.process=`, "-c", `filter.${driver}.required=false`]);
}

function nulRecords(output) {
  if (!output) return [];
  if (!output.endsWith("\0")) throw new Error("Incomplete Git records");
  return output.slice(0, -1).split("\0");
}

function indexEntries(repository, env) {
  const entries = nulRecords(git(repository, ["ls-files", "-v", "--stage", "-z"], env).toString("latin1"));
  const gitlinks = [];
  const files = new Set();
  const skippedPaths = [];
  let hasAssumedUnchanged = false;
  for (const entry of entries) {
    const match = /^([a-zA-Z?]) ([0-9]+) [0-9a-f]+ ([0-3])\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("Invalid index entry");
    const [, tag, mode, stage, file] = match;
    // Git lowercases -v tags for assume-unchanged entries, including gitlinks.
    if (tag >= "a" && tag <= "z") hasAssumedUnchanged = true;
    if (tag === "S") skippedPaths.push(file);
    if (mode === "160000") {
      if (stage === "0") gitlinks.push(file);
    } else {
      files.add(file);
    }
  }
  return { gitlinks, files: [...files], skippedPaths, hasAssumedUnchanged };
}

function lstatIfPresent(file) {
  try {
    return lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isBelow(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function gitDirectory(repository, args, env) {
  return realpathSync(git(repository, ["rev-parse", ...args], env).toString().replace(/\n$/, ""));
}

function relativeIndexPath(repository, indexedPath) {
  const relativePath = decoder.decode(Buffer.from(indexedPath, "latin1"));
  const worktree = path.resolve(repository, relativePath);
  if (!isBelow(repository, worktree) || path.relative(repository, worktree) !== relativePath) {
    throw new Error("Unsafe index path");
  }
  return relativePath;
}

function skippedPathIsAbsent(repository, indexedPath) {
  try {
    let currentPath = repository;
    for (const component of relativeIndexPath(repository, indexedPath).split(path.sep)) {
      currentPath = path.join(currentPath, component);
      const stat = lstatIfPresent(currentPath);
      if (!stat) return true;
      if (!stat.isDirectory()) return false;
    }
  } catch {
    return false;
  }
  return false;
}

function skippedPathsAreOmitted(repository, skippedPaths, env) {
  if (skippedPaths.length === 0) return true;
  try {
    if (gitConfig(repository, ["--type=bool", "--get", "core.sparseCheckout"], env).toString() !== "true\n") return false;
    if (!skippedPaths.every(file => skippedPathIsAbsent(repository, file))) return false;
    const input = Buffer.from(skippedPaths.join("\0") + "\0", "latin1");
    // check-rules outputs paths selected by the current sparse-checkout rules.
    return git(repository, ["sparse-checkout", "check-rules", "-z"], env, { input }).length === 0;
  } catch {
    return false;
  }
}

function populatedGitDir(repository, relativePath) {
  let part = repository;
  for (const component of relativePath.split(path.sep)) {
    part = path.join(part, component);
    const partStat = lstatIfPresent(part);
    if (!partStat) return null;
    if (!partStat.isDirectory() || realpathSync(part) !== part) throw new Error("Unsafe submodule worktree");
  }
  const worktree = part;
  const marker = path.join(worktree, ".git");
  const markerStat = lstatIfPresent(marker);
  if (!markerStat && readdirSync(worktree).length === 0) return null;
  if (markerStat?.isDirectory()) return { worktree, gitDir: marker };
  if (!markerStat?.isFile()) throw new Error("Missing submodule Git metadata");
  const gitfile = decoder.decode(readFileSync(marker)).replace(/\r?\n$/, "");
  const redirect = /^gitdir: ([^\r\n\0]+)$/.exec(gitfile)?.[1];
  if (!redirect) throw new Error("Malformed submodule Git metadata");
  return { worktree, gitDir: realpathSync(path.resolve(worktree, redirect)) };
}

function collectStatus(root) {
  const repositories = [{ worktree: root, env: localGitEnvironment }];
  const knownGitDirs = new Set();
  let rootCommonDir;
  const status = [];
  let complete = true;
  // Clear caller-specific index and worktree overrides before inspecting a child.
  const childEnv = { ...localGitEnvironment };
  const localVariables = git(root, ["rev-parse", "--local-env-vars"]).toString().trim().split("\n");
  for (const variable of localVariables) {
    if (variable === "GIT_CONFIG" || !variable.startsWith("GIT_CONFIG")) delete childEnv[variable];
  }
  for (const { worktree, env } of repositories) {
    let index;
    try {
      index = indexEntries(worktree, env);
    } catch {
      complete = false;
      continue;
    }
    if (complete && (index.hasAssumedUnchanged || !skippedPathsAreOmitted(worktree, index.skippedPaths, env))) complete = false;
    let canExcludeGitlinks = true;
    const excludedGitlinks = [];
    for (const indexedPath of index.gitlinks) {
      let relativePath;
      try {
        relativePath = relativeIndexPath(worktree, indexedPath);
        const child = populatedGitDir(worktree, relativePath);
        if (!child) continue;
        if (!rootCommonDir) {
          knownGitDirs.add(gitDirectory(root, ["--absolute-git-dir"]));
          rootCommonDir = gitDirectory(root, ["--path-format=absolute", "--git-common-dir"]);
        }
        const ownsMetadata = directory => isBelow(rootCommonDir, directory) || isBelow(child.worktree, directory);
        if (!ownsMetadata(child.gitDir) || knownGitDirs.has(child.gitDir) || !statSync(child.gitDir).isDirectory()) {
          throw new Error("Unsafe or shared submodule Git metadata");
        }
        if (gitDirectory(child.worktree, ["--show-toplevel"], childEnv) !== child.worktree ||
            !ownsMetadata(gitDirectory(child.worktree, ["--path-format=absolute", "--git-common-dir"], childEnv))) {
          throw new Error("Submodule worktree mismatch");
        }
        knownGitDirs.add(child.gitDir);
        repositories.push({ worktree: child.worktree, env: childEnv });
      } catch {
        complete = false;
        if (relativePath) excludedGitlinks.push(`:(exclude,literal)${relativePath}`);
        else canExcludeGitlinks = false;
      }
    }
    try {
      const options = verifiedStatusArgs(worktree, index.files, env);
      // A rejected, representable gitlink can be excluded without hiding valid siblings.
      const ignoreSubmodules = canExcludeGitlinks ? "dirty" : "all";
      const pathspec = canExcludeGitlinks && excludedGitlinks.length ? ["--", ...excludedGitlinks] : [];
      const statusEnv = pathspec.length ? {
        ...env,
        GIT_LITERAL_PATHSPECS: "0",
        GIT_GLOB_PATHSPECS: "0",
        GIT_NOGLOB_PATHSPECS: "0",
        GIT_ICASE_PATHSPECS: "0",
      } : env;
      const output = git(worktree, [...options, "status", "--short", "--ignored", "--untracked-files=normal", `--ignore-submodules=${ignoreSubmodules}`, ...pathspec], statusEnv).toString();
      status.push(worktree === root ? output : output.replace(/^\?\? /gm, "?? submodule/"));
    } catch {
      complete = false;
    }
  }
  return [complete ? "VERIFIED" : "PARTIAL", ...status].join("\n");
}

try {
  process.stdout.write(collectStatus(realpathSync(process.argv[2])));
} catch {
  process.exitCode = 1;
}
