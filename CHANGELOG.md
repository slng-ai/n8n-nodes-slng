## [0.2.3](https://github.com/slng-ai/n8n-nodes-slng/compare/v0.2.2...v0.2.3) (2026-09-10)

## [0.2.2](https://github.com/slng-ai/n8n-nodes-slng/compare/v0.2.1...v0.2.2) (2026-06-25)

## [0.2.1](https://github.com/slng-ai/n8n-nodes-slng/compare/v0.2.0...v0.2.1) (2026-06-25)

## [0.2.0](https://github.com/slng-ai/n8n-nodes-slng/compare/v0.1.0...v0.2.0) (2026-06-25)

### Features

* add agent dispatch action and workflow templates ([98c48c0](https://github.com/slng-ai/n8n-nodes-slng/commit/98c48c001102e8d630031a6ccc0ba04b7b392ff2))

# Changelog

## 0.1.0

Initial release.

- **SLNG API credential** — Bearer-token authentication for the SLNG Voice and Agents APIs (validated against `GET /v1/me`).
- **SLNG node** — Text to Speech (text → audio binary) and Speech to Text (audio binary → transcript) via the SLNG Voice API. Model and voice are catalog-backed dropdowns (`GET /v1/catalog/models`, voices filtered to the selected TTS model) with a manual "By ID" override.
- **SLNG Trigger node** — registers a webhook tool on an existing SLNG agent when the workflow is activated and removes it on deactivation. Supports contextual (LLM-invoked) and system (lifecycle-triggered) tools, a Show Advanced Settings toggle, Bearer or HMAC webhook authentication with an auto-generated secret, and response modes (return the last node's output to the agent, or acknowledge immediately).
