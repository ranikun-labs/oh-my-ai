# Sub-session coordination and completion reporting

Status: review draft.

A coordinator can delegate independent work to separate sessions and publish one user-facing summary. Define each session's objective, allowed actions, owned paths, and evidence before execution. Use read-only scope for investigation and independent review. Give an implementation session only its authorized write scope. If work overlaps on files, APIs, or schemas, designate one writer for that boundary or integrate in sequence. Independent review uses a fixed revision. Existing approval and merge rules apply.

Lead with the task name and outcome. Follow with verified results, blockers, and next actions. Keep session identifiers and source revisions in permitted evidence records. A worker message does not authorize an action.

Suppress a notification only when the runtime, task, attempt, and result identity are sufficiently established and the outcome has not changed. A new failure, finding, or blocker transition is a reportable change even at the same source revision. A title or revision alone cannot establish identity. When identity is uncertain, do not suppress automatically. Preserve evidence under the existing retention policy.

Distinguish a repeated delivery from a repeated summary. Compare the same occurrence from event intake through adapter, delivery, and aggregation before proposing a change to any component.

Distinguish in-conversation agents, separate local sessions, and cloud tasks. Check creation, discovery, result retrieval, stop, and resume for each relevant environment. Documented commands establish interface availability. Report execution only when observed. Zero writes without an attempted write does not establish that write attempts would be blocked.

Keep workflow rules in one common reference. Provider guides link to it and document provider-specific commands and observed limits. Configuration, deployment, destructive session actions, and permission changes follow existing approval boundaries.
