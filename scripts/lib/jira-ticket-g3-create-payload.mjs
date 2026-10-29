function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Build the site-independent Jira Create tool payload. This is formatting only:
 * callers must not treat it as Gate authorization or a verified runtime session.
 */
export function buildG3JiraCreateToolPayload(request, localizedIssueTypeName) {
  if (!request || typeof request !== "object" || Array.isArray(request)
    || request.project !== "RPL" || !nonEmpty(localizedIssueTypeName)
    || !nonEmpty(request.summary) || !nonEmpty(request.description))
    throw new Error("cannot build a Jira Create payload from an incomplete G3 request");
  const additionalFields = {
    ...(nonEmpty(request.priority) ? { priority: { name: request.priority } } : {}),
    ...(Array.isArray(request.labels) && request.labels.length > 0 ? { labels: [...request.labels] } : {}),
    ...(request.fields ?? {}),
  };
  return {
    projectKey: request.project,
    issueTypeName: localizedIssueTypeName,
    summary: request.summary,
    description: request.description,
    ...(nonEmpty(request.assignee) ? { assignee_account_id: request.assignee } : {}),
    additional_fields: additionalFields,
  };
}
