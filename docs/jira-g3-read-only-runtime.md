# G3 read-only runtime smoke

The read-only Runner exercises the existing G3 Jira Connector against one existing RPL issue. It performs one exact-summary Search and one GET, requests only project, issue type, status, and summary, and exposes no Create method.

```bash
node scripts/jira-ticket-g3-read-only-runtime.mjs \
  --runtime-module <approved-host-runtime-module> \
  --issue RPL-<existing-key> \
  --summary '<exact-existing-summary>'
```

The Host module must export `createG3ReadOnlyRuntime()` and provide the real authenticated `session`, canonical `siteOrigin`, UUID `cloudId`, a `verifySession` implementation bound to trusted Host evidence, and `invokeTool`. The module must not synthesize proof from a tool response, create a Jira issue, modify Jira, or write credentials and raw responses to logs.

`--runtime-module` is imported by Node with the process's full permissions and is not sandboxed. Only a module provisioned and reviewed by the Runtime Owner may be used. The Runner's tool allowlist constrains calls made through its own Connector wrapper; it does not constrain side effects inside the imported module.

`READ_ONLY_CONNECTOR_SMOKE_PASSED` means only that the Connector accepted the bridge's Search/Read capability proofs and normalized the specified Search and GET responses. It is **not** evidence that the bridge is trusted, that a production credential or durable Ledger is connected, or that a G3 Pilot is authorized. A missing bridge, failed proof, expiry, site/cloud mismatch, or response mismatch returns `BLOCKED`; raw Jira responses and bridge errors are not emitted by the Runner.

The current Codex Cloud Rovo session is not automatically available inside a Node process. Offline fixtures validate the Runner boundary only. Jira Create, Admin changes, Gate activation, Cutover, and Merge require their separate existing approvals.
