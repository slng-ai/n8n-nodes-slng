# Changelog

## 0.1.0

Initial release.

- **SLNG API credential** — Bearer-token authentication for the SLNG Voice and Agents APIs (validated against `GET /v1/me`).
- **SLNG node** — Text to Speech (text → audio binary) and Speech to Text (audio binary → transcript) via the SLNG Voice API. Model and voice are catalog-backed dropdowns (`GET /v1/catalog/models`, voices filtered to the selected TTS model) with a manual "By ID" override.
- **SLNG Trigger node** — registers a webhook tool on an existing SLNG agent when the workflow is activated and removes it on deactivation. Supports contextual (LLM-invoked) and system (lifecycle-triggered) tools, a Show Advanced Settings toggle, Bearer or HMAC webhook authentication with an auto-generated secret, and response modes (return the last node's output to the agent, or acknowledge immediately).
