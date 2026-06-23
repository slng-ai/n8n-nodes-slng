# n8n-nodes-slng

This is an n8n community node. It lets you use [SLNG](https://slng.ai) in your n8n workflows.

SLNG is a unified voice AI platform offering text-to-speech, speech-to-text, and voice agents that can place and receive phone calls.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation)
[Packaging and internal release](#packaging-and-internal-release)
[Operations](#operations)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[Resources](#resources)
[Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

## Packaging and internal release

This package can be distributed internally as a normal n8n community node. Private or unverified community nodes require a self-hosted n8n instance.

### Create a release artifact

From the repository root:

```bash
npm install
npm run lint
npm run build
npm pack
```

`npm pack` creates a tarball such as `n8n-nodes-slng-0.1.0.tgz`. The package only ships the `dist/` folder, as configured by the `files` entry in `package.json`.

### Install from a tarball

Use this for a quick internal test or for Docker images that copy the package artifact directly:

```bash
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install /path/to/n8n-nodes-slng-0.1.0.tgz
```

Restart n8n after installing or upgrading the package.

### Publish to a private registry

Use this for repeatable internal distribution through GitHub Packages, npm private packages, Verdaccio, Artifactory, or another private npm registry.

```bash
npm version patch
npm run lint
npm run build
npm publish --registry <private-registry-url>
```

If you change the package version, update `CHANGELOG.md` in the same change. Consumers can then install the versioned package:

```bash
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install n8n-nodes-slng@0.1.0 --registry <private-registry-url>
```

### Bake into an n8n Docker image

For production, prefer a custom n8n image with the package installed at build time:

```dockerfile
FROM n8nio/n8n:latest

USER root

COPY n8n-nodes-slng-0.1.0.tgz /tmp/
RUN mkdir -p /home/node/.n8n/nodes \
	&& cd /home/node/.n8n/nodes \
	&& npm install /tmp/n8n-nodes-slng-0.1.0.tgz \
	&& rm /tmp/n8n-nodes-slng-0.1.0.tgz

USER node
```

Build and deploy the image:

```bash
docker build -t slng/n8n:with-slng-nodes .
```

When releasing an update, bump the package version, build a new tarball or publish to the private registry, rebuild the n8n image, and redeploy. Existing workflows keep using the same node type names (`slng` and `slngTrigger`), so updates should be backward-compatible unless the node schema changes.

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
