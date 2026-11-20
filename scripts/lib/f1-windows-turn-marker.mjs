import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXPIRE_MS = 24 * 60 * 60 * 1000;

// Node's POSIX mode projection on Windows cannot establish NTFS privacy.
const checkAcl = String.raw`
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $env:OH_MY_AI_F1_ACL_PATH -Force
if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { exit 1 }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($identity, 'S-1-5-18', 'S-1-5-32-544')
$acl = Get-Acl -LiteralPath $item.FullName
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity) { exit 1 }
$userAllowed = $false
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -ne 'Allow') { continue }
  if ($rule.IdentityReference.Value -notin $trusted) { exit 1 }
  if ($rule.IdentityReference.Value -eq $identity) { $userAllowed = $true }
}
if (!$userAllowed) { exit 1 }
exit 0
`;

function hasPrivateAcl(directory) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) return false;
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", checkAcl], {
    env: { ...process.env, OH_MY_AI_F1_ACL_PATH: directory },
    stdio: "ignore",
    windowsHide: true,
    timeout: 3000,
  });
  return result.status === 0;
}

export function updateWindowsF1TurnMarker(location, turnHash, phase, verifyAcl = hasPrivateAcl) {
  const hash = createHash("sha256").update(JSON.stringify([
    location.repositoryId, location.worktreeId, turnHash,
  ])).digest("hex");
  const directory = path.join(location.rootPath, "f1-turn-markers");
  if (phase === "submit") {
    fs.mkdirSync(location.rootPath, { recursive: true });
    if (!verifyAcl(location.rootPath)) return false;
    try { fs.mkdirSync(directory); } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  } else if (!verifyAcl(location.rootPath)) {
    return false;
  }
  if (!verifyAcl(directory)) return false;
  const pending = path.join(directory, hash + ".pending");
  const consumed = path.join(directory, hash + ".consumed");
  if (fs.existsSync(consumed)) return phase === "stop" ? "consumed" : false;

  if (phase === "submit") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.(pending|consumed)$/u.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      try {
        if (Date.now() - fs.lstatSync(file).mtimeMs > EXPIRE_MS) fs.unlinkSync(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    try { fs.writeFileSync(pending, "", { flag: "wx" }); } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    return false;
  }
  try {
    const marker = fs.lstatSync(pending);
    if (!marker.isFile() || marker.isSymbolicLink() || Date.now() - marker.mtimeMs > EXPIRE_MS) return false;
    // NTFS hard-link creation fails if another Stop already claimed the turn.
    fs.linkSync(pending, consumed);
    try { fs.unlinkSync(pending); } catch {}
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EEXIST" || error.code === "EPERM") {
      if (fs.existsSync(consumed)) return "consumed";
      if (error.code === "ENOENT") return false;
    }
    throw error;
  }
}
