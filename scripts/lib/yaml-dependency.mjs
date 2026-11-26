// Skill metadata 검사가 쓰는 고정 YAML 파서(.github/ci/yaml, yaml@2.9.1)의 설치 여부를 확인한다.
// 미설치면 generic FAIL 대신 DEPENDENCY_MISSING 으로 끝내고 설치 명령을 한 줄로 알려준다.

import fs from "node:fs";
import path from "node:path";

export const YAML_DEPENDENCY_FIX = "npm ci --prefix .github/ci/yaml --ignore-scripts";
export const DEPENDENCY_MISSING_EXIT_CODE = 3;

export function missingYamlDependency(repoRoot) {
  const rel = ".github/ci/yaml/node_modules/yaml";
  if (fs.existsSync(path.join(repoRoot, rel, "package.json"))) return null;
  return `DEPENDENCY_MISSING: ${rel} not installed; fix: ${YAML_DEPENDENCY_FIX}`;
}
