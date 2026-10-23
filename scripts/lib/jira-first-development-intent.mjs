// Advisory-only Jira-first detection; never authorizes a Skill or remote mutation.
const DEVELOPMENT_ACTION = /(?:시작하자|시작해|개발해|구현해|수정해|고쳐줘|개선해|리팩터링해|리팩토링해|작업해|이어(?:서)?\\s*(?:개발|구현|수정|작업)해|\\b(?:fix|implement|refactor|build|develop)\\b)/i;
const DEVELOPMENT_TARGET = /(?:\\b(?:RPL-\\d+|PR\\s*#?\\d+|carelog|finance|oauth|api|backend|frontend)\\b|로그인|결제|이체|서비스|기능|버그|오류|장애|인증|백엔드|프론트엔드|엔드포인트|이슈)/i;
const NO_IMPLEMENTATION = /(?:개발|구현|수정|고치|개선|작업|리팩터링|리팩토링)(?:하)?지\\s*(?:마|말|않)|\\b(?:do\\s+not|don't|never)\\s+(?:fix|implement|refactor|build|develop)\\b/i;
const EXPLANATION_ONLY = /(?:설명만|개념만|예시만|뭐야|뭔지|무엇인지|알려줘|\\b(?:what\\s+is|explain|concept\\s+of)\\b)/i;

export function needsJiraFirstDevelopmentPreflight(prompt) {
  if (typeof prompt !== "string") return false;
  const limited = prompt.trim().slice(0, 2000);
  if (!limited || NO_IMPLEMENTATION.test(limited) || EXPLANATION_ONLY.test(limited)) {
    return false;
  }
  return DEVELOPMENT_ACTION.test(limited) && DEVELOPMENT_TARGET.test(limited);
}
