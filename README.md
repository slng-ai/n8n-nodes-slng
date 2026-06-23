# n8n-nodes-slng

This is an n8n community node. It lets you use [SLNG](https://slng.ai) in your n8n workflows.

SLNG is a unified voice AI platform offering text-to-speech, speech-to-text, and voice agents that can place and receive phone calls.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation)
[Operations](#operations)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[Resources](#resources)
[Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

## Operations

This package contains two nodes:

### SLNG

- **Text to Speech → Generate** — convert text into spoken audio. The audio is returned as a binary file on the item.
- **Speech to Text → Transcribe** — transcribe an audio file (from a binary field) into text.

The **Model** and (for TTS) **Voice** fields are dropdowns populated live from the SLNG catalog API (`GET /v1/catalog/models`); the voice list is filtered to the chosen TTS model. Switch any of them to **By ID** to hardcode a model path or voice ID.

### SLNG Trigger

Registers a webhook tool on an existing SLNG agent when the workflow is activated, and removes it on deactivation. When the agent calls the tool during a call, the workflow runs and (in `Using Last Node` mode) returns its output to the agent.

- **Tool type** — *LLM tool (contextual)*: the agent decides when to call it; you define the parameters it sends with a simple field builder (name, type, description, required). *System tool*: fires automatically on a call lifecycle event (call start, first user message, call end, tool succeeded/failed) with worker-populated arguments.
- **Show Advanced Settings** — a toggle. Off by default with secure defaults (HMAC auth + auto-generated secret, `POST`, return last node's output). Turn it on to expose webhook path, authentication, HTTP method, response handling, result instructions and more.
- **Webhook authentication** — *HMAC* (SLNG signs the body with `X-Signature-256`) or *Bearer* (`Authorization: Bearer`). Leave the secret empty to auto-generate one on activation; the node registers it with SLNG and validates incoming requests.
- **Respond** (advanced) — *Using Last Node* (default) returns the workflow's final node output to the agent; *Immediately* acknowledges and runs the workflow in the background. To shape the exact JSON the agent receives, keep *Using Last Node* and make the final node (e.g. a **Set / Edit Fields** node) emit the object you want. (n8n's built-in **Respond to Webhook** node only works with core trigger types, not community triggers, so it isn't supported here.)

If SLNG sends an envelope payload with an `arguments` field, the trigger exposes it to the workflow as `toolArguments`. n8n blocks expression access to `$json.arguments` for security reasons, so downstream nodes should use `{{$json.toolArguments}}` or `{{$json.toolArguments.fieldName}}`.

To reuse data from a previous test while mapping downstream nodes, use n8n's **Pin Data** feature on the SLNG Trigger output. A good setup flow is: run one real SLNG test call, pin the trigger output data, then build the rest of the workflow against `toolArguments`.

## Credentials

You need a SLNG API key. Create one in the SLNG dashboard, then add a **SLNG API** credential in n8n and paste the key. The key is sent as a Bearer token and is validated against `GET https://api.slng.ai/v1/me`. The same credential is used for both the Voice API (`api.slng.ai`) and the Agents API (`api.agents.slng.ai`).

## Compatibility

Built against the n8n nodes API version 1. Requires Node.js 18+.

## Usage

1. Add the **SLNG API** credential.
2. To expose a workflow to a voice agent, add a **SLNG Trigger** node, pick an existing agent, define the tool, and activate the workflow. The tool is added to the agent automatically.
3. To synthesize or transcribe audio inside any workflow, use the **SLNG** node.

## Resources

* [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
* [SLNG documentation](https://docs.slng.ai)

## Version history

### 0.1.0

Initial release: SLNG API credential, SLNG node (TTS/STT), and SLNG Trigger node.
