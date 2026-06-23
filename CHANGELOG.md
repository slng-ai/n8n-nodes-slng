# Changelog

## 0.1.0

Initial release.

- **slng API credential** — Bearer-token authentication for the slng Voice and Agents APIs (validated against `GET /v1/me`).
- **slng node** — Text to Speech (text → audio binary) and Speech to Text (audio binary → transcript) via the slng Voice API. Model and voice are catalog-backed dropdowns (`GET /v1/catalog/models`, voices filtered to the selected TTS model) with a manual "By ID" override.
- **slng Trigger node** — registers a webhook tool on an existing slng agent when the workflow is activated and removes it on deactivation. Supports contextual (LLM-invoked) and system (lifecycle-triggered) tools, a Basic/Advanced setup toggle, Bearer or HMAC webhook authentication with an auto-generated secret, and response modes (return the last node's output to the agent, or acknowledge immediately).
