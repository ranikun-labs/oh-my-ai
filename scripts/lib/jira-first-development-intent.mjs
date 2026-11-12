// Advisory-only Jira-first detection; never authorizes a Skill or remote mutation.
// Do not treat a completed past action such as "추가해 줬어" as a request.
const DEVELOPMENT_ACTION = /(?:시작하자|시작해|개발해|구현해|수정해|고쳐\s*(?:줘|주세요|주십시오|줄래|주실래요|주실\s*수\s*(?:있나요|있을까요))|개선해|변경해|처리해|추가해|만들어\s*(?:줘|주세요|주십시오|주실래요|주실\s*수\s*(?:있나요|있을까요))|진행시켜|고쳐줄래|개선만\s*해줘|수정\s*좀\s*부탁해|리팩터링해|리팩토링해|작업해|이어(?:서)?\s*(?:개발|구현|수정|작업|처리)해|\b(?:fix|implement|refactor|build|develop)\b)(?!\s*(?:줬|주었|했)(?:어|어요|습니다|다|음))/i;
const DEVELOPMENT_TARGET = /(?:\b(?:RPL-\d+|PR\s*#?\d+|carelog|finance|oauth|api|backend|frontend)\b|로그인|결제|이체|서비스|기능|버그|오류|장애|인증|백엔드|프론트엔드|엔드포인트|이슈|토큰|검증|테스트|문서|설정)/i;
const NO_IMPLEMENTATION = /(?:추가해\s*주지\s*(?:마|말|않)|만들(?:어\s*주)?지\s*(?:마|말|않)|진행(?:시키|시켜\s*주|하)지\s*(?:마|말|않)|(?:개발|구현|수정|개선|작업|변경|처리|추가|리팩터링|리팩토링)(?:하|해\s*주)?지\s*(?:마|말|않)|고치(?:지\s*(?:마|말|않)|어\s*주지\s*(?:마|말|않))|고쳐\s*주지\s*(?:마|말|않)|\b(?:do\s+not|don't|never)\s+(?:fix|implement|refactor|build|develop)\b)/i;
const EXPLANATION_ONLY = /(?:설명만|개념만|예시만|뭐야|뭔지|무엇인지|알려줘|\b(?:what\s+is|explain|concept\s+of)\b)/i;

const QUESTION = /\?\s*$/;
const POLITE_REQUEST = /(?:줘|주세요|줄래|부탁해|부탁드려|주십시오|주실래요|주실\s*수\s*(?:있나요|있을까요))\s*\?\s*$/;
const SCOPE_PIVOT = /\s+(?:대신|말고|그리고|하지만|그런데)\s*,?\s+|\(\s*|,\s*(?=(?:다른\s*(?:건|것|부분|이슈)|나머지(?:는)?|그\s*외|(?:다만|단)\s*(?:테스트|문서|설정)(?:는|은|을|를)|(?:테스트|문서|설정)(?:는|은|을|를)|기존\s*(?:코드|테스트|문서|파일)(?:는|은|을|를)))/u;

function splitRequestClausesWithOffsets(text) {
  const clauses = [];
  const sentencePattern = /[^.!?。;]+[.!?。;]?/gu;
  for (const sentence of text.matchAll(sentencePattern)) {
    const sentenceText = sentence[0];
    const explicitPivots = [...sentenceText.matchAll(new RegExp(SCOPE_PIVOT.source, "gu"))]
      .filter(match => sentenceText.slice(0, match.index).trim())
      .map(match => ({
        start: match.index,
        end: match.index + match[0].length,
        explicit: true,
        continuation: /대신|말고/u.exec(match[0])?.[0] ?? "",
        requiresIndependent: /그리고|하지만|그런데|\(/u.test(match[0]),
      }));
    const commas = [...sentenceText.matchAll(/,\s*/gu)]
      .map(match => ({ start: match.index, end: match.index + match[0].length, explicit: false }));
    const candidates = [...explicitPivots, ...commas]
      .sort((left, right) => left.start - right.start || Number(right.explicit) - Number(left.explicit));
    const pivots = [];
    let boundaryCursor = 0;
    for (const candidate of candidates) {
      if (candidate.explicit) {
        if (candidate.requiresIndependent && !areIndependentRequestScopes(
          sentenceText.slice(boundaryCursor, candidate.start),
          sentenceText.slice(candidate.end),
        )) continue;
        pivots.push(candidate);
        boundaryCursor = candidate.end;
        continue;
      }
      if (explicitPivots.some(pivot => candidate.start >= pivot.start && candidate.start < pivot.end)) continue;
      const left = sentenceText.slice(boundaryCursor, candidate.start);
      const right = sentenceText.slice(candidate.end);
      if (areIndependentRequestScopes(left, right)) {
        pivots.push(candidate);
        boundaryCursor = candidate.end;
      }
    }
    pivots.sort((left, right) => left.start - right.start);
    let cursor = 0;
    for (const pivot of pivots) {
      clauses.push({
        text: sentenceText.slice(cursor, pivot.start),
        start: sentence.index + cursor,
        end: sentence.index + pivot.start,
      });
      // Keep an explicit "instead / rather than" connector with the new
      // clause so an omitted target can inherit its preceding task context.
      cursor = pivot.continuation ? pivot.start : pivot.end;
    }
    clauses.push({
      text: sentenceText.slice(cursor),
      start: sentence.index + cursor,
      end: sentence.index + sentenceText.length,
    });
  }
  return clauses;
}

function requestScopeDetails(clause) {
  const request = clause.trim();
  const action = DEVELOPMENT_ACTION.exec(request);
  const withdrawal = NO_IMPLEMENTATION.exec(request);
  const marker = action ?? withdrawal;
  if (!marker) return null;
  const scope = scopeAroundAction(request, marker);
  const references = extractScopeReferences(scope);
  const normalized = normalizeScope(scope);
  if (!DEVELOPMENT_TARGET.test(scope) && references.size === 0) return null;
  return { scope, references, normalized };
}

function areIndependentRequestScopes(leftClause, rightClause) {
  const leftPositive = positiveRequestScope(leftClause);
  const rightPositive = positiveRequestScope(rightClause);
  if (rightPositive && !leftPositive) return true;
  if (!leftPositive && clauseHasTarget(leftClause) && hasDevelopmentAction(rightClause)) return true;
  if (hasPositiveAction(leftClause) && !clauseHasTarget(leftClause) &&
      clauseHasTarget(rightClause) && !rightPositive) return true;

  const left = requestScopeDetails(leftClause);
  const right = requestScopeDetails(rightClause);
  if (!left || !right) return false;
  if (left.references.size && right.references.size &&
      (left.references.size !== right.references.size ||
       [...left.references].some(reference => !right.references.has(reference)))) return true;
  return left.normalized !== right.normalized;
}

function clauseHasTarget(clause) {
  return DEVELOPMENT_TARGET.test(clause) || extractScopeReferences(clause).size > 0;
}

function hasPositiveAction(clause) {
  const request = clause.trim();
  return Boolean(request && !NO_IMPLEMENTATION.test(request) && !EXPLANATION_ONLY.test(request) &&
    !(QUESTION.test(request) && !POLITE_REQUEST.test(request)) && DEVELOPMENT_ACTION.test(request));
}

function hasDevelopmentAction(clause) {
  return DEVELOPMENT_ACTION.test(clause);
}

function positiveRequestScope(clause) {
  const request = clause.trim();
  if (!request || NO_IMPLEMENTATION.test(request) || EXPLANATION_ONLY.test(request)) return null;
  if (QUESTION.test(request) && !POLITE_REQUEST.test(request)) return null;
  const action = DEVELOPMENT_ACTION.exec(request);
  if (!action) return null;
  const references = extractScopeReferences(request);
  if (!DEVELOPMENT_TARGET.test(request) && references.size === 0) return null;
  const scope = scopeAroundAction(request, action);
  return { scope, references };
}

function scopeAroundAction(request, action) {
  const before = request.slice(0, action.index).trim();
  if (DEVELOPMENT_TARGET.test(before) || extractScopeReferences(before).size > 0) return before;
  return request.slice(action.index + action[0].length).trim();
}

function matchesWithdrawalScope(prior, correctionScope) {
  const priorReferences = extractScopeReferences(prior.scope);
  const correctionReferences = extractScopeReferences(correctionScope);
  if (correctionReferences.size && !priorReferences.size) return false;
  if (priorReferences.size && correctionReferences.size &&
      (priorReferences.size !== correctionReferences.size ||
       [...priorReferences].some(reference => !correctionReferences.has(reference)))) return false;
  const correctionTokens = new Set(normalizedScopeTokens(correctionScope));
  if (!correctionTokens.size) return true;
  const priorTokens = new Set(normalizedScopeTokens(prior.scope));
  if (!priorTokens.size) return false;

  // A broader correction withdraws an earlier request. A narrower correction
  // (for example, "don't fix the error" after "build the feature") is a
  // separate subtask and must not erase the earlier action.
  return [...correctionTokens].every(token => priorTokens.has(token));
}

function removeFinalWithdrawnRequest(prompt) {
  const correction = prompt.match(/[,.!?。;]\s*아니[,]?\s*([^.!?。;]+?)[.!?。;]?\s*$/u);
  if (!correction) return prompt;
  const text = correction[1].trim();
  let genericWithdrawal = /(?:취소할게|그냥\s*설명해줘)\s*$/u.test(text);
  const withdrawal = NO_IMPLEMENTATION.exec(text);
  if (!genericWithdrawal && !withdrawal) return prompt;

  const correctionScope = genericWithdrawal ? "" : text.slice(0, withdrawal.index);
  if (!DEVELOPMENT_TARGET.test(correctionScope) && extractScopeReferences(correctionScope).size === 0) {
    genericWithdrawal = true;
  }
  const correctionStart = correction.index + correction[0].indexOf("아니");
  const priorClauses = splitRequestClausesWithOffsets(prompt.slice(0, correctionStart));
  const targets = [];
  for (const clause of [...priorClauses].reverse()) {
    const prior = positiveRequestScope(clause.text);
    if (!prior) continue;
    if (genericWithdrawal) {
      const remaining = `${prompt.slice(0, clause.start)}${prompt.slice(clause.end, correction.index)}`;
      // The unscoped cancellation applies to the nearest request. Remove its
      // final connector as well, so it cannot suppress an earlier independent
      // request when clauses are evaluated again.
      return remaining.replace(/[\s,;]+$/u, "");
    }
    if (matchesWithdrawalScope(prior, correctionScope)) targets.push(clause);
  }
  if (!targets.length) return prompt;

  // Withdraw every earlier request in the explicitly named scope. Unrelated
  // requests remain active and must still trigger the advisory preflight.
  let result = prompt;
  for (const target of targets) {
    result = `${result.slice(0, target.start)} ${result.slice(target.end)}`;
  }
  return result;
}

function removeFinalExampleOnlyRequest(prompt) {
  const exampleOnly = prompt.match(/\s*\(\s*(?:실행|적용)하지\s*말고\s*예시만\s*\)[.!?。;]?\s*$/u);
  if (!exampleOnly) return prompt;
  const priorClauses = splitRequestClausesWithOffsets(prompt.slice(0, exampleOnly.index));
  const finalClause = priorClauses.at(-1);
  if (finalClause && positiveRequestScope(finalClause.text)) {
    const clause = finalClause;
    const remaining = `${prompt.slice(0, clause.start)}${prompt.slice(clause.end, exampleOnly.index)}`;
    return remaining.replace(/[\s,;]+$/u, "");
  }
  return prompt.slice(0, exampleOnly.index).replace(/[\s,;]+$/u, "");
}

function extractScopeReferences(text) {
  return new Set((text.match(/\b(?:RPL-\d+|PR\s*#?\d+)\b/giu) ?? [])
    .map(reference => reference.toLowerCase().replace(/[\s#]+/g, "")));
}

function normalizedScopeTokens(text) {
  return text.toLowerCase()
    .replace(/\b(?:rpl-\d+|pr\s*#?\d+)\b/giu, " ")
    // These words identify a correction or refer back to an existing scope;
    // they must not make a same-target cancellation look like a new target.
    .replace(/(?:^|\s)(?:그|해당|사실|실은)(?=\s|$)/gu, " ")
    .replace(/[^\p{L}\p{N}#-]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .map(token => token.replace(/(?:은|는|이|가|을|를|에서|에|으로|로|와|과|도|만)$/u, ""))
    .filter(Boolean);
}

function normalizeScope(text) {
  const tokens = normalizedScopeTokens(text);

  // "기능" is a generic descriptor only when a concrete scope token remains.
  // Keep it when it is the sole target (e.g. "기능 만들어줘. 아니 기능 만들지 마").
  return (tokens.some(token => token !== "기능")
    ? tokens.filter(token => token !== "기능")
    : tokens).join(" ");
}

export function needsJiraFirstDevelopmentPreflight(prompt) {
  if (typeof prompt !== "string") return false;
  let limited = prompt.trim().slice(0, 2000);
  if (!limited || !DEVELOPMENT_TARGET.test(limited)) return false;

  // Remove only the nearest request explicitly withdrawn by the final correction
  // or marked as example-only. Independent earlier actions remain eligible.
  limited = removeFinalExampleOnlyRequest(limited);
  limited = removeFinalWithdrawnRequest(limited);

  // Negation or explanation only suppresses its own clause, not a later
  // explicit development request in the same user message.
  return splitRequestClausesWithOffsets(limited)
    .some(clause => positiveRequestScope(clause.text) !== null);
}
