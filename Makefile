# Repo task shortcuts. Assumes the project venv is active (source .venv/bin/activate).

# Content pin to vendor; pass an explicit SHA in real use: make sync-content REF=<sha>
REF ?= main

.PHONY: sync-content sync-content-check

## Vendor the pinned aptitude-course ref into backend/content/ (issue #391)
sync-content:
	cd backend && python -m scripts.sync_content --ref $(REF)

## CI drift gate: verify backend/content/ matches CONTENT_VERSION without mutating
sync-content-check:
	cd backend && python -m scripts.sync_content --check
