REPO    := $(shell pwd)
PROFILE ?=
# Completion Notification management commands require Python 3.11+ (tomllib).
# Override when the default python3 resolves to an older interpreter, e.g.:
#   make install-completion-notify PYTHON=/opt/homebrew/bin/python3.11
PYTHON  ?= python3

.PHONY: install install-shared install-completion-notify completion-notify-status test-completion-notify doctor-completion-notify uninstall-completion-notify init-profile install-profile doctor doctor-strict instructions update work-start test-install-fixtures test-completion-notify-fixtures test-routing-fixtures test-work-start-fixtures test-notice-fixtures test-capability-fixtures test-result-fixtures test-truthfulness-fixtures test-jira-ticket-fixtures test-jira-work-fixtures test-git-work-preflight-fixtures test-context-checkpoint-codex-fixtures test-context-checkpoint-fixtures test-pending-handoff-core-fixtures test-pending-handoff-identity-fixtures test-pending-handoff-secret-provider-fixtures test-pending-handoff-identity-composition-fixtures test-pending-handoff-candidate-fixtures test-pending-handoff-store-fixtures test-pending-handoff-integrity-fixtures test-pending-handoff-revision-cas-fixtures test-pending-handoff-claim-lease-fixtures test-pending-handoff-delivery-consumption-fixtures test-pending-handoff-session-resolution-fixtures test-pending-handoff-manual-resume-fixtures test-pending-handoff-codex-runtime-adapter-fixtures test-pending-handoff-claude-runtime-adapter-fixtures test-pending-handoff-manual-resume-runtime-composition-fixtures test-v1-fixtures test-v1x-fixtures

instructions:
	./scripts/render-instructions.sh

doctor:
	./setup.sh --doctor

doctor-strict:
	./setup.sh --doctor --strict

work-start:
	./scripts/work-start.sh

test-routing-fixtures:
	./scripts/test-routing-fixtures.sh

test-work-start-fixtures:
	./scripts/test-work-start-fixtures.sh

test-notice-fixtures:
	./scripts/test-notice-fixtures.sh

test-capability-fixtures:
	./scripts/test-capability-fixtures.sh

test-result-fixtures:
	./scripts/test-result-fixtures.sh

test-truthfulness-fixtures:
	./scripts/test-truthfulness-fixtures.sh

test-jira-ticket-fixtures:
	./scripts/test-jira-ticket-fixtures.sh

.PHONY: test-jira-ticket-g3-integrations
test-jira-ticket-g3-integrations:
	node scripts/test-jira-ticket-g3-jira-connector.mjs
	node scripts/test-jira-ticket-g3-trusted-gate.mjs
	node scripts/test-jira-ticket-g3-ledger-recovery.mjs
	node scripts/test-jira-ticket-g3-authority-reader.mjs
	node scripts/test-jira-ticket-g3-integration.mjs

test-jira-work-fixtures:
	./scripts/test-jira-work-fixtures.sh

test-git-work-preflight-fixtures:
	./scripts/test-git-work-preflight-fixtures.sh

test-install-fixtures:
	./scripts/test-install-fixtures.sh

test-context-checkpoint-codex-fixtures:
	node ./scripts/test-context-checkpoint-codex-fixtures.mjs

test-context-checkpoint-fixtures:
	node ./scripts/test-context-checkpoint-fixtures.mjs
	node ./scripts/test-context-checkpoint-codex-fixtures.mjs

test-pending-handoff-core-fixtures:
	node ./scripts/test-pending-handoff-core-fixtures.mjs

test-pending-handoff-identity-fixtures:
	node ./scripts/test-pending-handoff-identity-fixtures.mjs

test-pending-handoff-secret-provider-fixtures:
	node ./scripts/test-pending-handoff-secret-provider-fixtures.mjs

test-pending-handoff-identity-composition-fixtures:
	node ./scripts/test-pending-handoff-identity-composition-fixtures.mjs

test-pending-handoff-candidate-fixtures:
	node ./scripts/test-pending-handoff-candidate-fixtures.mjs

test-pending-handoff-store-fixtures:
	node ./scripts/test-pending-handoff-store-fixtures.mjs

test-pending-handoff-integrity-fixtures:
	node ./scripts/test-pending-handoff-integrity-fixtures.mjs

test-pending-handoff-revision-cas-fixtures:
	node ./scripts/test-pending-handoff-revision-cas-fixtures.mjs

test-pending-handoff-claim-lease-fixtures:
	node ./scripts/test-pending-handoff-claim-lease-fixtures.mjs

test-pending-handoff-delivery-consumption-fixtures:
	node ./scripts/test-pending-handoff-delivery-consumption-fixtures.mjs

test-pending-handoff-session-resolution-fixtures:
	node ./scripts/test-pending-handoff-session-resolution-fixtures.mjs

test-pending-handoff-manual-resume-fixtures:
	node ./scripts/test-pending-handoff-manual-resume-fixtures.mjs

test-pending-handoff-codex-runtime-adapter-fixtures:
	node ./scripts/test-pending-handoff-codex-runtime-adapter-fixtures.mjs

test-pending-handoff-claude-runtime-adapter-fixtures:
	node ./scripts/test-pending-handoff-claude-runtime-adapter-fixtures.mjs

test-pending-handoff-manual-resume-runtime-composition-fixtures:
	node ./scripts/test-pending-handoff-manual-resume-runtime-composition-fixtures.mjs

test-v1-fixtures: test-install-fixtures test-completion-notify-fixtures test-routing-fixtures test-work-start-fixtures test-notice-fixtures test-capability-fixtures test-result-fixtures test-truthfulness-fixtures

test-v1x-fixtures: \
	test-v1-fixtures \
	test-context-checkpoint-fixtures \
	test-pending-handoff-core-fixtures \
	test-pending-handoff-identity-fixtures \
	test-pending-handoff-secret-provider-fixtures \
	test-pending-handoff-identity-composition-fixtures \
	test-pending-handoff-candidate-fixtures \
	test-pending-handoff-store-fixtures \
	test-pending-handoff-integrity-fixtures \
	test-pending-handoff-revision-cas-fixtures \
	test-pending-handoff-claim-lease-fixtures \
	test-pending-handoff-delivery-consumption-fixtures \
	test-pending-handoff-session-resolution-fixtures \
	test-pending-handoff-manual-resume-fixtures \
	test-pending-handoff-codex-runtime-adapter-fixtures \
	test-pending-handoff-claude-runtime-adapter-fixtures \
	test-pending-handoff-manual-resume-runtime-composition-fixtures

install: install-shared
	@if [ "$(ENABLE_COMPLETION_NOTIFY)" = "1" ]; then ENABLE_COMPLETION_NOTIFY=1 $(PYTHON) ./scripts/completion-notify.py install --yes; else printf '%s\n' 'completion notify: skipped (explicit ENABLE_COMPLETION_NOTIFY=1 required)'; fi

install-shared: instructions
	./setup.sh --install-shared

install-completion-notify:
	@if [ "$(ENABLE_COMPLETION_NOTIFY)" = "1" ]; then ENABLE_COMPLETION_NOTIFY=1 $(PYTHON) ./scripts/completion-notify.py install --yes; else printf '%s\n' 'completion notify: consent required; rerun with ENABLE_COMPLETION_NOTIFY=1' >&2; exit 2; fi

completion-notify-status:
	$(PYTHON) ./scripts/completion-notify.py status

test-completion-notify:
	$(PYTHON) ./scripts/completion-notify.py test

doctor-completion-notify:
	$(PYTHON) ./scripts/completion-notify.py doctor

uninstall-completion-notify:
	$(PYTHON) ./scripts/completion-notify.py uninstall

test-completion-notify-fixtures:
	PYTHON="$(PYTHON)" ./scripts/test-completion-notify-fixtures.sh

init-profile:
	@if [ -z "$(PROFILE)" ]; then echo "usage: make init-profile PROFILE=<name>" >&2; exit 2; fi
	./setup.sh --init-profile --profile "$(PROFILE)"

install-profile:
	@if [ -z "$(PROFILE)" ]; then echo "usage: make install-profile PROFILE=<name>" >&2; exit 2; fi
	./setup.sh --install-profile --profile "$(PROFILE)"

update:
	git pull
	$(MAKE) install-shared
