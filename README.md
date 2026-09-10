<p align="center">
  <a href="https://slng.ai">
    <img src="https://www.datocms-assets.com/182222/1763142213-logo-lg.svg" alt="slng.ai" height="64" />
  </a>
</p>

<h1 align="center">n8n-nodes-slng</h1>

This is an n8n community node. It lets you use [SLNG](https://slng.ai) in your n8n workflows.

SLNG is a unified voice AI platform offering text-to-speech, speech-to-text, and voice agents that can place and receive phone calls.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation)
[Operations](#operations)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[Templates](#templates)
[Resources](#resources)
[Version history](#version-history)

## Installation

In your n8n instance, go to **Settings → Community Nodes → Install**, enter the package name `n8n-nodes-slng`, and confirm. See the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) for details.

For a self-hosted instance you can also install it manually:

```bash
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install n8n-nodes-slng
```

Restart n8n after installing or upgrading.

## Operations

This package contains two nodes:

### SLNG

- **Text to Speech → Generate** — convert text into spoken audio. The audio is returned as a binary file on the item.
- **Speech to Text → Transcribe** — transcribe an audio file (from a binary field) into text.
- **Agent → Dispatch Call** — place an outbound phone call from a SLNG voice agent. The node checks that the selected agent has outbound telephony configured before dispatching.

The **Model** and (for TTS) **Voice** fields are dropdowns populated live from the SLNG catalog API (`GET /v1/catalog/models`); the voice list is filtered to the chosen TTS model. Switch any of them to **By ID** to hardcode a model path or voice ID.

### SLNG Trigger

Registers a webhook tool on an existing SLNG agent when the workflow is activated, and removes it on deactivation. When the agent calls the tool during a call, the workflow runs and (in `Using Last Node` mode) returns its output to the agent.

On activation the node creates an org-level SLNG tool, publishes it, and attaches the published version to the agent. Two things to know:

- **The agent must be in `shared` tool mode.** Legacy-mode agents cannot accept shared tool attachments; activation fails with a clear error if you pick one.
- **Activation runs the workflow once with sample data.** Publishing an API-request tool requires SLNG's publish "green run", which sends one test call to the webhook URL. Your workflow therefore executes a single time with placeholder arguments when you activate it.

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
3. To synthesize, transcribe, or dispatch outbound agent calls inside any workflow, use the **SLNG** node.

## Templates

Multi-node workflow templates live in [`templates/`](templates/). They demonstrate practical SLNG voice-agent automations:

- End-of-call logging to Notion and Slack.
- Mid-call Linkup web search.
- Mid-call HubSpot customer lookup.
- Post-call CRM note, Gmail follow-up, and Slack notification.
- Outbound call campaign from HubSpot contacts.

Import them into n8n with **Workflows → Import from File**, then replace placeholder IDs and assign your credentials.

## Resources

* [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
* [n8n community node packages on npm](https://www.npmjs.com/search?q=keywords%3An8n-community-node-package)
* [SLNG documentation](https://docs.slng.ai)

## Version history

See [CHANGELOG.md](CHANGELOG.md) for the full release history.

## Contributing

Development and release instructions live in [CONTRIBUTING.md](CONTRIBUTING.md).
