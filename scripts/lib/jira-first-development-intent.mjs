// Advisory-only Jira-first detection; never authorizes a Skill or remote mutation.
const DEVELOPMENT_ACTION = /(?:시작하자|시작해|개발해|구현해|수정해|고쳐줘|개선해|변경해|처리해|수정\s*좀\s*부탁해|리팩터링해|리팩토링해|작업해|이어(?:서)?\s*(?:개발|구현|수정|작업|처리)해|\b(?:fix|implement|refactor|build|develop)\b)/i;
const DEVELOPMENT_TARGET = /(?:\b(?:RPL-\d+|PR\s*#?\d+|carelog|finance|oauth|api|backend|frontend)\b|로그인|결제|이체|서비스|기능|버그|오류|장애|인증|백엔드|프론트엔드|엔드포인트|이슈)/i;
const NO_IMPLEMENTATION = /(?:개발|구현|수정|고치|개선|작업|변경|처리|리팩터링|리팩토링)(?:하)?지\s*(?:마|말|않)|\b(?:do\s+not|don't|never)\s+(?:fix|implement|refactor|build|develop)\b/i;
const EXPLANATION_ONLY = /(?:설명만|개념만|예시만|뭐야|뭔지|무엇인지|알려줘|\b(?:what\s+is|explain|concept\s+of)\b)/i;

const QUESTION = /\?\s*$/;
const POLITE_REQUEST = /(?:줘|주세요|줄래|부탁해|부탁드려)\s*\?\s*$/;

export function needsJiraFirstDevelopmentPreflight(prompt) {
  if (typeof prompt !== "string") return false;
  const limited = prompt.trim().slice(0, 2000);
  if (!limited || !DEVELOPMENT_TARGET.test(limited)) return false;

  // Negation or explanation only suppresses its own clause, not a later
  // explicit development request in the same user message.
  const sentences = limited.match(/[^.!?。]+[.!?。]?/gu) ?? [];
  return sentences.flatMap(sentence => sentence.split(/\s+대신\s+/u)).some(clause => {
    const request = clause.trim();
    if (!request || NO_IMPLEMENTATION.test(request) || EXPLANATION_ONLY.test(request)) return false;
    // A bare question ("개발해?") is not an imperative; a polite
    // question asking for implementation ("고쳐줘?") still counts.
    if (QUESTION.test(request) && !POLITE_REQUEST.test(request)) return false;
    return DEVELOPMENT_ACTION.test(request);
  });
}
