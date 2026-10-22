import {
  applyJiraCreateResult,
  applyJiraIntentResult,
  applyJiraReadResult,
  applyJiraOriginResult,
  applyJiraPreviewApproval,
  applyJiraSearchResult,
  beginJiraTicketCreateWorkflow,
} from "./jira-ticket-create-workflow.mjs";

/** Canonical runtime bridge: JSON in/out, semantic Jira actions only. */
export function handleJiraTicketRuntimeInput(input) {
  switch (input?.event) {
    case "start":
      return beginJiraTicketCreateWorkflow(input);
    case "search_result":
      return applyJiraSearchResult(input.state, input.result);
    case "approval":
      return applyJiraPreviewApproval(input.state, input.approval);
    case "create_result":
      return applyJiraCreateResult(input.state, input.result);
    case "intent_result":
      return applyJiraIntentResult(input.state, input.result);
    case "read_result":
      return applyJiraReadResult(input.state, input.result);
    case "origin_result":
      return applyJiraOriginResult(input.state, input.result);
    default:
      throw new Error("jira-ticket event must be start, search_result, approval, intent_result, create_result, read_result, or origin_result");
  }
}
