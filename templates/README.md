# SLNG n8n workflow templates

These templates are example workflows for the SLNG community nodes. They are adoption assets in this repository and are not included in the npm package tarball.

Import them from n8n with **Workflows → Import from File** after installing `n8n-nodes-slng`.

## Required setup

- Install this community node package in your n8n instance.
- Create a **SLNG API** credential.
- Create the app credentials used by the template you import:
  - Notion integration token and database ID
  - Slack bot token and channel ID
  - Linkup API key
  - HubSpot private app token
  - Gmail OAuth credential
- Replace placeholders such as `YOUR_AGENT_ID`, `YOUR_NOTION_DATABASE_ID`, `YOUR_SLACK_CHANNEL_ID`, and `+15551234567`.
- Activate workflows with **SLNG Trigger** nodes so the webhook tool is registered on the selected SLNG agent.

## Templates

### `end-call-notion-slack.workflow.json`

Logs every completed call to Notion and posts a Slack summary.

- SLNG trigger type: system tool
- Trigger event: `call_end`
- Inputs from SLNG: `call_id`, `phone_number`, `call_end_reason`, `transcript_messages`
- Side effects: Notion page creation, Slack message
- Agent response: none; this template acknowledges immediately and runs in the background

### `mid-call-linkup-web-search.workflow.json`

Lets a voice agent search the web mid-call using Linkup.

- SLNG trigger type: contextual tool
- Tool name: `web_search`
- Inputs from agent: `query`, optional `topic`, optional `domain`
- Side effect: Linkup Search API request
- Agent response: `{ answer, sources }`
- Linkup Search API: <https://docs.linkup.so/pages/documentation/endpoints/search/reference>

### `mid-call-hubspot-lookup.workflow.json`

Lets a voice agent look up customer context in HubSpot during a call.

- SLNG trigger type: contextual tool
- Tool name: `lookup_customer`
- Inputs from agent: optional `email`, `phone`, `company`, `contact_name`
- Side effect: HubSpot contact search
- Agent response: `{ answer, customer, next_step }`

### `post-call-crm-email-slack.workflow.json`

Runs after a call to update CRM notes, send a follow-up email, and alert Slack.

- SLNG trigger type: system tool
- Trigger event: `call_end`
- Inputs from SLNG: call metadata, transcript messages, and template variables for customer name/email
- Side effects: HubSpot note creation, Gmail email, Slack message
- Agent response: none; this template acknowledges immediately and runs in the background

### `outbound-call-campaign.workflow.json`

Starts outbound calls from HubSpot contacts.

- Trigger: manual trigger or schedule trigger
- Data source: HubSpot contact search
- SLNG action: `Agent → Dispatch Call`
- Side effect: Slack message for each dispatch result
- Requires an agent with outbound telephony configured

## Mapping notes

SLNG trigger payloads expose tool inputs as `toolArguments`. Use expressions like `{{$json.toolArguments.query}}` rather than `$json.arguments`, because n8n blocks expression access to the JavaScript-reserved `arguments` name.

The templates include pinned sample data for mapping. After one real test call, pin the real SLNG trigger output and adjust downstream nodes against your actual payload.
