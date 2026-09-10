import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type {
	IDataObject,
	IHookFunctions,
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

const AGENTS_API_BASE = 'https://api.agents.slng.ai/v1';

/** Compare two strings in constant time. */
function safeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

/**
 * Pull the human-readable error out of a SLNG API error response. SLNG returns
 * `{ detail: "..." }` (or a FastAPI-style array of validation errors), which n8n
 * otherwise buries under a generic "Bad request" message.
 */
function slngErrorDetail(error: unknown): string | undefined {
	const err = error as IDataObject;
	const data = (((err?.context as IDataObject)?.data ??
		(err?.response as IDataObject)?.data ??
		((err?.cause as IDataObject)?.response as IDataObject)?.data) as IDataObject) ?? undefined;
	const detail = data?.detail;
	if (!detail) return undefined;
	if (typeof detail === 'string') return detail;
	if (Array.isArray(detail)) {
		return detail
			.map((entry) => {
				const item = entry as IDataObject;
				const loc = Array.isArray(item.loc) ? (item.loc as unknown[]).join('.') : '';
				return loc ? `${loc}: ${item.msg as string}` : ((item.msg as string) ?? JSON.stringify(item));
			})
			.join('; ');
	}
	return JSON.stringify(detail);
}

/** Wrapper around the authenticated Agents API request. */
async function agentRequest(
	ctx: IHookFunctions | ILoadOptionsFunctions,
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
	path: string,
	body?: IDataObject,
): Promise<IDataObject> {
	try {
		return (await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'slngApi', {
			method,
			url: `${AGENTS_API_BASE}${path}`,
			body,
			json: true,
		})) as IDataObject;
	} catch (error) {
		const detail = slngErrorDetail(error);
		throw new NodeApiError(ctx.getNode(), error as JsonObject, {
			...(detail ? { message: `SLNG: ${detail}` } : {}),
			description: `${method} ${path} failed`,
		});
	}
}

/**
 * Read-only fields returned by `GET /agents/{id}` that a full replace
 * (`PUT /agents/{id}`) rejects with `extra_forbidden`. Attaching a tool is a
 * read-modify-write of the whole agent, so we echo the GET body back minus these
 * fields (a denylist — more robust than an allowlist, which risks silently
 * dropping writable fields like `noise_cancellation_enabled` and resetting them).
 */
const AGENT_READONLY_FIELDS = new Set([
	'id',
	'organisation_id',
	'models_validation_error',
	'livekit_deployment',
	'template_variables',
	'created_at',
	'updated_at',
	'deleted_at',
]);

/** Build a full PUT-replace body from a GET response, dropping read-only fields. */
function pickAgentWriteBody(agent: IDataObject): IDataObject {
	const body: IDataObject = {};
	for (const [key, value] of Object.entries(agent)) {
		if (!AGENT_READONLY_FIELDS.has(key)) body[key] = value;
	}
	return body;
}

/**
 * Build a Vault secret name for a tool's shared secret. Vault names must be
 * SCREAMING_SNAKE_CASE and unique per org, so we derive one from the tool name and
 * append a random suffix. The `N8N_` prefix guarantees a leading letter.
 */
function makeSecretName(toolName: string): string {
	const base =
		(toolName || 'tool')
			.toUpperCase()
			.replace(/[^A-Z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '')
			.slice(0, 40) || 'TOOL';
	const suffix = randomBytes(4).toString('hex').toUpperCase();
	return `N8N_${base}_${suffix}`;
}

/**
 * Find an existing org tool by exact name. SLNG enforces unique live tool names, so
 * on (re)activation we reuse a same-named tool (update + republish) instead of
 * creating a duplicate — which would 409 ("a live tool named X already exists"), and
 * which we cannot delete-then-recreate while it is still attached to an agent
 * (`TOOL_DELETE_BLOCKED`). Returns the tool id, or undefined if none exists.
 */
async function findToolIdByName(
	ctx: IHookFunctions,
	name: string,
): Promise<string | undefined> {
	const res = (await agentRequest(ctx, 'GET', '/agents/tools')) as unknown;
	const list = Array.isArray(res)
		? (res as IDataObject[])
		: ((res as IDataObject)?.items as IDataObject[]) ?? [];
	const match = list.find((tool) => tool.name === name);
	return match ? (match.id as string) : undefined;
}

/** Best-effort delete of an org tool; never throws (used during cleanup). */
async function deleteToolQuietly(ctx: IHookFunctions, toolId: string): Promise<void> {
	try {
		await agentRequest(ctx, 'DELETE', `/agents/tools/${toolId}`);
	} catch {
		// ignore — cleanup is best-effort
	}
}

/** Best-effort delete of a Vault secret; never throws (used during cleanup). */
async function deleteSecretQuietly(ctx: IHookFunctions, name: string): Promise<void> {
	try {
		await agentRequest(ctx, 'DELETE', `/agents/secrets/${encodeURIComponent(name)}`);
	} catch {
		// ignore — cleanup is best-effort
	}
}

/**
 * n8n blocks expression access to `$json.arguments` because `arguments` is a
 * restricted JavaScript property name. SLNG webhook envelopes can use that key,
 * so expose it to workflows as `toolArguments` instead.
 */
function normalizeWebhookBody(body: IDataObject): IDataObject {
	if (!Object.prototype.hasOwnProperty.call(body, 'arguments')) return body;

	const { arguments: toolArguments, ...rest } = body as IDataObject & {
		arguments?: IDataObject[string];
	};
	return { ...rest, toolArguments };
}

/**
 * Everything parsed from the node parameters needed to create the org-level tool
 * and its agent attachment. Collected once so the create body and the attachment
 * body stay consistent.
 */
interface ToolSpec {
	name: string;
	description: string;
	toolType: 'contextual' | 'system';
	authentication: 'none' | 'bearer' | 'hmac';
	httpMethod: string;
	options: IDataObject;
	/** JSON-schema for the tool's arguments (config.parameters). */
	parameters: IDataObject;
	/** LLM-facing hint for how to use the tool result (contextual only). */
	responseInstructions?: string;
	/** Spoken filler while the tool runs (contextual only). */
	preActionMessage?: string;
	/** Attachment-level system config { triggers, arguments } (system only). */
	systemConfig?: IDataObject;
}

/** Parse the node parameters into a ToolSpec. */
function collectToolSpec(ctx: IHookFunctions): ToolSpec {
	const toolType = ctx.getNodeParameter('toolType', 'contextual') as 'contextual' | 'system';
	const spec: ToolSpec = {
		name: ctx.getNodeParameter('toolName', '') as string,
		description: ctx.getNodeParameter('toolDescription', '') as string,
		toolType,
		authentication: ctx.getNodeParameter('authentication', 'none') as ToolSpec['authentication'],
		httpMethod: ctx.getNodeParameter('httpMethod', 'POST') as string,
		options: ctx.getNodeParameter('options', {}) as IDataObject,
		parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
	};

	if (toolType === 'system') {
		const triggers = (
			(ctx.getNodeParameter('systemTriggers', {}) as IDataObject).trigger as IDataObject[]
		)?.map((t) => {
			const trigger: IDataObject = { event: t.event };
			if ((t.event === 'tool_succeeded' || t.event === 'tool_failed') && t.sourceToolId) {
				trigger.source_tool_id = t.sourceToolId;
			}
			return trigger;
		});

		if (!triggers || triggers.length === 0) {
			throw new NodeOperationError(
				ctx.getNode(),
				'A System tool requires at least one trigger event',
			);
		}

		const argRows =
			((ctx.getNodeParameter('systemArguments', {}) as IDataObject).argument as IDataObject[]) ??
			[];

		const argumentsList: IDataObject[] = [];
		const properties: IDataObject = {};
		const required: string[] = [];

		for (const row of argRows) {
			const name = row.name as string;
			const argType = row.type as string;
			let source: IDataObject;
			switch (row.sourceType) {
				case 'constant':
					source = { type: 'constant', value: row.sourceValue ?? '' };
					break;
				case 'template':
					source = { type: 'template', template: row.sourceTemplate ?? '' };
					break;
				case 'transcript_messages':
					source = {
						type: 'transcript_messages',
						max_messages: row.sourceMaxMessages ?? 200,
					};
					break;
				default:
					source = { type: row.sourceType };
			}

			argumentsList.push({
				name,
				type: argType,
				required: Boolean(row.required),
				...(row.description ? { description: row.description } : {}),
				source,
			});

			properties[name] = {
				type: argType === 'transcript_messages' ? 'array' : argType,
				...(row.description ? { description: row.description } : {}),
			};
			if (row.required) required.push(name);
		}

		spec.parameters = { type: 'object', properties, required, additionalProperties: false };
		spec.systemConfig = { triggers, arguments: argumentsList };
	} else {
		// contextual (LLM-invoked)
		const paramRows =
			((ctx.getNodeParameter('contextualParameters', {}) as IDataObject)
				.parameter as IDataObject[]) ?? [];
		const properties: IDataObject = {};
		const required: string[] = [];
		for (const row of paramRows) {
			const name = row.name as string;
			if (!name) continue;
			properties[name] = {
				type: row.type as string,
				...(row.description ? { description: row.description } : {}),
			};
			if (row.required) required.push(name);
		}
		spec.parameters = { type: 'object', properties, required, additionalProperties: false };

		const llmResultInstructions = ctx.getNodeParameter('llmResultInstructions', '') as string;
		if (llmResultInstructions) spec.responseInstructions = llmResultInstructions;

		const preActionMessage = ctx.getNodeParameter('preActionMessage', '') as string;
		if (preActionMessage) spec.preActionMessage = preActionMessage;
	}

	return spec;
}

/**
 * Build the `POST /agents/tools` body for an `api_request` (webhook) tool. Because
 * we create a dedicated tool per workflow, its `config.url` is the n8n webhook URL
 * directly (no per-attachment override needed). `auth` references a Vault secret by
 * name — the actual secret value is stored in the Vault, never inlined here.
 */
function buildToolCreateBody(
	spec: ToolSpec,
	webhookUrl: string,
	secretName: string | undefined,
): IDataObject {
	const config: IDataObject = {
		type: 'api_request',
		url: webhookUrl,
		http_method: spec.httpMethod,
		parameters: spec.parameters,
	};

	if (spec.authentication === 'none' || !secretName) {
		config.auth = { type: 'none' };
	} else {
		config.auth = { type: spec.authentication, secret_name: secretName };
	}

	if (spec.options.webhookFormat) config.webhook_format = spec.options.webhookFormat;
	if (spec.options.timeoutSeconds) config.timeout_seconds = spec.options.timeoutSeconds;
	if (typeof spec.options.waitForResponse === 'boolean') {
		config.wait_for_response = spec.options.waitForResponse;
	}

	const response: IDataObject = {};
	if (typeof spec.options.showResultsToLlm === 'boolean') {
		response.show_to_llm = spec.options.showResultsToLlm;
	}
	if (spec.responseInstructions) response.instructions = spec.responseInstructions;
	if (Object.keys(response).length > 0) config.response = response;

	return {
		name: spec.name,
		description: spec.description,
		tool_type: 'api_request',
		config,
	};
}

/**
 * Build a `tool_ref` attachment linking a published tool version to the agent.
 * Contextual tools attach with `invocation: 'model'`; system tools attach with
 * `invocation: 'system'` plus their `system` config (triggers + argument sources).
 */
function buildAttachment(spec: ToolSpec, toolId: string, version: number): IDataObject {
	const attachment: IDataObject = {
		attachment_id: randomUUID(),
		tool_id: toolId,
		version,
		invocation: spec.toolType === 'system' ? 'system' : 'model',
	};

	if (spec.systemConfig) attachment.system = spec.systemConfig;
	if (spec.preActionMessage) {
		attachment.execution_policy = {
			pre_action_message: { enabled: true, text: spec.preActionMessage },
		};
	}

	return attachment;
}

/**
 * Build a placeholder sample input for the publish green-run from the tool's
 * parameter JSON-schema. Every declared property gets a type-appropriate stub so
 * the required-field validation passes.
 */
function buildSampleInput(parameters: IDataObject): IDataObject {
	const properties = (parameters.properties as IDataObject) ?? {};
	const sample: IDataObject = {};
	for (const [name, schema] of Object.entries(properties)) {
		const type = ((schema as IDataObject)?.type as string) ?? 'string';
		switch (type) {
			case 'boolean':
				sample[name] = true;
				break;
			case 'integer':
			case 'number':
				sample[name] = 0;
				break;
			case 'array':
				sample[name] = [];
				break;
			case 'object':
				sample[name] = {};
				break;
			default:
				sample[name] = 'sample';
		}
	}
	return sample;
}

export class SlngTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SLNG Trigger',
		name: 'slngTrigger',
		icon: 'file:slng.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["toolName"]}}',
		description:
			'Start workflows from SLNG voice agents by registering a secure webhook tool for agent calls',
		defaults: {
			name: 'SLNG Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'slngApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: '={{$parameter["httpMethod"] || "POST"}}',
				responseMode: '={{$parameter["responseMode"] || "lastNode"}}',
				path: '={{$parameter["path"] || "slng-tool"}}',
			},
		],
		properties: [
			{
				displayName: 'Agent',
				name: 'agentId',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				description: 'The existing SLNG agent to attach this tool to',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'searchAgents',
							searchable: true,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. 550e8400-e29b-41d4-a716-446655440000',
					},
				],
			},
			{
				displayName: 'Tool Name',
				name: 'toolName',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'lookup_order',
				description:
					'Name the agent uses for this tool. Use lowercase letters, numbers and underscores.',
			},
			{
				displayName: 'Tool Description',
				name: 'toolDescription',
				type: 'string',
				typeOptions: { rows: 2 },
				default: '',
				required: true,
				description: 'What the tool does. The agent uses this to decide when to call it.',
			},
			{
				displayName: 'Tool Type',
				name: 'toolType',
				type: 'options',
				default: 'contextual',
				description: 'How the tool is invoked during a call',
				options: [
					{
						name: 'LLM Tool (Contextual)',
						value: 'contextual',
						description: 'The agent decides when to call the tool based on the conversation',
					},
					{
						name: 'System Tool',
						value: 'system',
						description: 'Fires automatically on a call lifecycle event (e.g. call end)',
					},
				],
			},
			{
				displayName: 'Show Advanced Settings',
				name: 'advancedSettings',
				type: 'boolean',
				default: false,
				description:
					'Whether to show advanced settings (webhook path, authentication, HTTP method, response handling and more). When off, secure defaults are used: HMAC auth with an auto-generated secret.',
			},

			// Contextual (LLM) tool fields
			{
				displayName: 'Parameters',
				name: 'contextualParameters',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Parameter',
				description: 'The arguments the agent fills in and sends to the webhook',
				displayOptions: {
					show: { toolType: ['contextual'] },
				},
				options: [
					{
						name: 'parameter',
						displayName: 'Parameter',
						values: [
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
								placeholder: 'order_id',
							},
							{
								displayName: 'Type',
								name: 'type',
								type: 'options',
								default: 'string',
								options: [
									{ name: 'Array', value: 'array' },
									{ name: 'Boolean', value: 'boolean' },
									{ name: 'Integer', value: 'integer' },
									{ name: 'Number', value: 'number' },
									{ name: 'Object', value: 'object' },
									{ name: 'String', value: 'string' },
								],
							},
							{
								displayName: 'Description',
								name: 'description',
								type: 'string',
								default: '',
								description: 'Tells the agent what to put in this parameter',
							},
							{
								displayName: 'Required',
								name: 'required',
								type: 'boolean',
								default: false,
							},
						],
					},
				],
			},
			{
				displayName: 'Result Instructions',
				name: 'llmResultInstructions',
				type: 'string',
				typeOptions: { rows: 2 },
				default: '',
				description:
					'How the agent should interpret and communicate the webhook result to the caller',
				displayOptions: {
					show: { toolType: ['contextual'], advancedSettings: [true] },
				},
			},
			{
				displayName: 'Pre-Action Message',
				name: 'preActionMessage',
				type: 'string',
				default: '',
				placeholder: 'Let me look that up for you...',
				description: 'Optional message the agent speaks while the webhook runs',
				displayOptions: {
					show: { toolType: ['contextual'], advancedSettings: [true] },
				},
			},

			// System tool fields
			{
				displayName: 'Triggers',
				name: 'systemTriggers',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Trigger',
				description: 'Call lifecycle events that fire this tool',
				displayOptions: {
					show: { toolType: ['system'] },
				},
				options: [
					{
						name: 'trigger',
						displayName: 'Trigger',
						values: [
							{
								displayName: 'Event',
								name: 'event',
								type: 'options',
								default: 'call_end',
								options: [
									{ name: 'Call End', value: 'call_end' },
									{ name: 'Call Start', value: 'call_start' },
									{ name: 'First User Message', value: 'first_user_message' },
									{ name: 'Tool Failed', value: 'tool_failed' },
									{ name: 'Tool Succeeded', value: 'tool_succeeded' },
								],
							},
							{
								displayName: 'Source Tool ID',
								name: 'sourceToolId',
								type: 'string',
								default: '',
								description: 'Required for Tool Succeeded / Tool Failed events',
								displayOptions: {
									show: { event: ['tool_succeeded', 'tool_failed'] },
								},
							},
						],
					},
				],
			},
			{
				displayName: 'Arguments',
				name: 'systemArguments',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Argument',
				description: 'Values the worker populates and sends to the webhook',
				displayOptions: {
					show: { toolType: ['system'] },
				},
				options: [
					{
						name: 'argument',
						displayName: 'Argument',
						values: [
							{
								displayName: 'Constant Value',
								name: 'sourceValue',
								type: 'string',
								default: '',
							},
							{
								displayName: 'Description',
								name: 'description',
								type: 'string',
								default: '',
							},
							{
								displayName: 'Max Messages',
								name: 'sourceMaxMessages',
								type: 'number',
								default: 200,
							},
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
							},
							{
								displayName: 'Required',
								name: 'required',
								type: 'boolean',
								default: false,
							},
							{
								displayName: 'Source',
								name: 'sourceType',
								type: 'options',
								default: 'call_id',
								description: 'Where the worker pulls this value from',
								options: [
									{
										name: 'Agent ID',
										value: 'agent_id',
									},
									{
										name: 'Agent Name',
										value: 'agent_name',
									},
									{
										name: 'Call End Reason',
										value: 'call_end_reason',
									},
									{
										name: 'Call ID',
										value: 'call_id',
									},
									{
										name: 'Constant',
										value: 'constant',
									},
									{
										name: 'First User Message',
										value: 'first_user_message',
									},
									{
										name: 'Job ID',
										value: 'job_id',
									},
									{
										name: 'Phone Number',
										value: 'phone_number',
									},
									{
										name: 'Room Name',
										value: 'room_name',
									},
									{
										name: 'Template',
										value: 'template',
									},
									{
										name: 'Transcript Messages',
										value: 'transcript_messages',
									},
									{
										name: 'Trigger Event',
										value: 'trigger_event',
									},
								],
							},
							{
								displayName: 'Template',
								name: 'sourceTemplate',
								type: 'string',
								default: '',
								placeholder: 'Hello	{{customer_name}}',
							},
							{
								displayName: 'Type',
								name: 'type',
								type: 'options',
								default: 'string',
								options: [
									{
										name: 'Boolean',
										value: 'boolean',
									},
									{
										name: 'Boolean Array',
										value: 'boolean[]',
									},
									{
										name: 'Integer',
										value: 'integer',
									},
									{
										name: 'Integer Array',
										value: 'integer[]',
									},
									{
										name: 'Number',
										value: 'number',
									},
									{
										name: 'Number Array',
										value: 'number[]',
									},
									{
										name: 'String',
										value: 'string',
									},
									{
										name: 'String Array',
										value: 'string[]',
									},
									{
										name: 'Transcript Messages',
										value: 'transcript_messages',
									},
								],
							},
						],
					},
				],
			},

			// Advanced setup
			{
				displayName: 'Webhook Path',
				name: 'path',
				type: 'string',
				default: 'slng-tool',
				required: true,
				description: 'The path segment of the webhook URL that the agent will call',
				displayOptions: {
					show: { advancedSettings: [true] },
				},
			},
			{
				displayName: 'Webhook Authentication',
				name: 'authentication',
				type: 'options',
				default: 'hmac',
				description: 'How SLNG authenticates its calls to this webhook',
				displayOptions: {
					show: { advancedSettings: [true] },
				},
				options: [
					{
						name: 'Bearer Token',
						value: 'bearer',
						description: 'SLNG sends an Authorization: Bearer header',
					},
					{
						name: 'HMAC Signature',
						value: 'hmac',
						description: 'SLNG signs the body and sends an X-Signature-256 header',
					},
					{ name: 'None', value: 'none' },
				],
			},
			{
				displayName: 'Secret',
				name: 'secret',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				description:
					'Shared secret used for Bearer/HMAC. Leave empty to auto-generate one on activation.',
				displayOptions: {
					show: { advancedSettings: [true] },
					hide: { authentication: ['none'] },
				},
			},

			// HTTP / response
			{
				displayName: 'HTTP Method',
				name: 'httpMethod',
				type: 'options',
				default: 'POST',
				description: 'HTTP method SLNG uses to call the webhook',
				displayOptions: {
					show: { advancedSettings: [true] },
				},
				options: [
					{ name: 'DELETE', value: 'DELETE' },
					{ name: 'PATCH', value: 'PATCH' },
					{ name: 'POST', value: 'POST' },
					{ name: 'PUT', value: 'PUT' },
				],
			},
			{
				displayName: 'Respond',
				name: 'responseMode',
				type: 'options',
				default: 'lastNode',
				description: 'What SLNG receives back when it calls the tool',
				displayOptions: {
					show: { advancedSettings: [true] },
				},
				options: [
					{
						name: 'Immediately',
						value: 'onReceived',
						description: 'Acknowledge right away (fire-and-forget)',
					},
					{
						name: 'Using Last Node',
						value: 'lastNode',
						description: "Return the last node's output to the agent",
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: { advancedSettings: [true] },
				},
				options: [
					{
						displayName: 'Webhook Format',
						name: 'webhookFormat',
						type: 'options',
						default: 'envelope',
						options: [
							{
								name: 'Envelope',
								value: 'envelope',
								description: 'Send SLNG metadata plus the arguments',
							},
							{
								name: 'Raw',
								value: 'raw',
								description: 'Send only the tool arguments object',
							},
						],
					},
					{
						displayName: 'Timeout (Seconds)',
						name: 'timeoutSeconds',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 60 },
						default: 10,
					},
					{
						displayName: 'Wait for Response',
						name: 'waitForResponse',
						type: 'boolean',
						default: true,
						description: 'Whether the call waits for the webhook to respond before proceeding',
					},
					{
						displayName: 'Show Results to LLM',
						name: 'showResultsToLlm',
						type: 'boolean',
						default: true,
						description: 'Whether the webhook result is shown to the agent',
					},
				],
			},
		],
		usableAsTool: true,
	};

	methods = {
		listSearch: {
			async searchAgents(this: ILoadOptionsFunctions): Promise<INodeListSearchResult> {
				const agents = (await this.helpers.httpRequestWithAuthentication.call(this, 'slngApi', {
					method: 'GET',
					url: `${AGENTS_API_BASE}/agents`,
					json: true,
				})) as IDataObject[];

				const results = (Array.isArray(agents) ? agents : []).map((agent) => ({
					name: (agent.name as string) || (agent.id as string),
					value: agent.id as string,
				}));

				return { results };
			},
		},
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const attachmentId = staticData.attachmentId as string | undefined;
				const toolId = staticData.toolId as string | undefined;
				if (!attachmentId && !toolId) return false;

				const agentId = this.getNodeParameter('agentId', '', { extractValue: true }) as string;

				try {
					const agent = await agentRequest(this, 'GET', `/agents/${agentId}`);
					const refs = Array.isArray(agent.tool_refs) ? (agent.tool_refs as IDataObject[]) : [];
					return refs.some(
						(ref) => ref.attachment_id === attachmentId || ref.tool_id === toolId,
					);
				} catch {
					return false;
				}
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default');
				if (!webhookUrl) {
					throw new NodeOperationError(this.getNode(), 'Could not resolve the webhook URL');
				}

				const agentId = this.getNodeParameter('agentId', '', { extractValue: true }) as string;
				const staticData = this.getWorkflowStaticData('node');
				const spec = collectToolSpec(this);

				// Keep the existing secret UX: use the configured secret, else the stored one,
				// else auto-generate. Store it in the Vault and reference it by name from the
				// tool's auth; keep the plaintext locally so webhook() can verify signatures.
				let secret = '';
				let secretName: string | undefined;
				const priorSecretName = staticData.secretName as string | undefined;
				if (spec.authentication !== 'none') {
					secret =
						(this.getNodeParameter('secret', '') as string) ||
						(staticData.secret as string) ||
						randomBytes(32).toString('hex');
					secretName = makeSecretName(spec.name);
					await agentRequest(this, 'POST', '/agents/secrets', {
						name: secretName,
						value: secret,
						description: `SLNG Trigger (n8n) secret for tool "${spec.name}"`,
					});
				}
				// Drop the previous activation's secret once a new one is in place.
				if (priorSecretName && priorSecretName !== secretName) {
					await deleteSecretQuietly(this, priorSecretName);
				}

				const toolBody = buildToolCreateBody(spec, webhookUrl, secretName);
				const priorToolId = staticData.toolId as string | undefined;

				// Resolve the tool by its CURRENT name (authoritative). Reusing a same-named
				// tool makes re-activation idempotent and self-heals orphans from test runs;
				// resolving by name (not the stored id) makes a rename take effect — the old
				// tool is detached and deleted below. We never delete-then-recreate the same
				// tool here: an attached tool can't be deleted and a duplicate name is rejected.
				let toolId = await findToolIdByName(this, spec.name);
				if (toolId) {
					await agentRequest(this, 'PATCH', `/agents/tools/${toolId}`, {
						description: toolBody.description,
						config: toolBody.config,
					});
				} else {
					const created = await agentRequest(this, 'POST', '/agents/tools', toolBody);
					toolId = created.id as string;
				}

				// Publishing an api_request tool requires the `green_run` gate to pass, which
				// means a successful test run first. NOTE: the run makes a real HTTP call to
				// the tool URL (the n8n webhook), so activation fires the webhook once with
				// sample input — the workflow will execute a single time on activation.
				await agentRequest(this, 'POST', `/agents/tools/${toolId}/run`, {
					sample_input: buildSampleInput(spec.parameters),
					confirm_side_effects: true,
				});

				const published = await agentRequest(this, 'POST', `/agents/tools/${toolId}/publish`, {});
				const version = (published.version_number ?? published.version) as number;

				// Attach the published version to the agent via a full replace, round-tripping
				// the agent's other config and tool/MCP attachments so nothing is wiped.
				const agent = await agentRequest(this, 'GET', `/agents/${agentId}`);

				// Only `shared`-mode agents accept tool attachments; legacy agents reject them
				// ("legacy agents cannot contain shared tool or MCP attachments") with no
				// documented way to switch modes. Fail early with a clear message.
				if (agent.tool_mode && agent.tool_mode !== 'shared') {
					throw new NodeOperationError(
						this.getNode(),
						`Agent "${(agent.name as string) || agentId}" is in "${agent.tool_mode as string}" tool mode and cannot accept tools. Use an agent in "shared" tool mode.`,
					);
				}

				const existingRefs = Array.isArray(agent.tool_refs)
					? (agent.tool_refs as IDataObject[])
					: [];
				const priorAttachmentId = staticData.attachmentId as string | undefined;
				// Drop our previous attachment, any existing attachment of this same tool (an
				// older pinned version), and any attachment of the prior (e.g. renamed) tool so
				// re-activation replaces rather than stacks.
				const toolRefs = existingRefs.filter(
					(ref) =>
						ref.attachment_id !== priorAttachmentId &&
						ref.tool_id !== toolId &&
						ref.tool_id !== priorToolId,
				);
				const attachment = buildAttachment(spec, toolId, version);
				toolRefs.push(attachment);

				await agentRequest(this, 'PUT', `/agents/${agentId}`, {
					...pickAgentWriteBody(agent),
					tool_refs: toolRefs,
				});

				// If the tool was renamed, the old tool is now detached — delete it so it does
				// not linger as an orphan.
				if (priorToolId && priorToolId !== toolId) {
					await deleteToolQuietly(this, priorToolId);
				}

				staticData.toolId = toolId;
				staticData.version = version;
				staticData.attachmentId = attachment.attachment_id as string;
				staticData.agentId = agentId;
				if (secretName) staticData.secretName = secretName;
				if (secret) staticData.secret = secret;

				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const toolId = staticData.toolId as string | undefined;
				const attachmentId = staticData.attachmentId as string | undefined;
				const secretName = staticData.secretName as string | undefined;
				const agentId =
					(staticData.agentId as string) ||
					(this.getNodeParameter('agentId', '', { extractValue: true }) as string);

				// Detach from the agent (full replace without our attachment), then remove the
				// org tool and its Vault secret. All best-effort: never block deactivation.
				if (attachmentId && agentId) {
					try {
						const agent = await agentRequest(this, 'GET', `/agents/${agentId}`);
						const existingRefs = Array.isArray(agent.tool_refs)
							? (agent.tool_refs as IDataObject[])
							: [];
						const toolRefs = existingRefs.filter(
							(ref) => ref.attachment_id !== attachmentId && ref.tool_id !== toolId,
						);
						await agentRequest(this, 'PUT', `/agents/${agentId}`, {
							...pickAgentWriteBody(agent),
							tool_refs: toolRefs,
						});
					} catch {
						// Best-effort: never block deactivation if the agent is gone or unreachable.
					}
				}

				if (toolId) await deleteToolQuietly(this, toolId);
				if (secretName) await deleteSecretQuietly(this, secretName);

				delete staticData.toolId;
				delete staticData.version;
				delete staticData.attachmentId;
				delete staticData.agentId;
				delete staticData.secretName;
				delete staticData.secret;

				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const authentication = this.getNodeParameter('authentication', 'none') as string;

		if (authentication !== 'none') {
			const staticData = this.getWorkflowStaticData('node');
			const secret =
				(staticData.secret as string) || (this.getNodeParameter('secret', '') as string);
			const headers = this.getHeaderData();
			let valid = false;

			if (authentication === 'bearer') {
				const provided = ((headers.authorization as string) || '').replace(/^Bearer\s+/i, '');
				valid = Boolean(secret) && safeEqual(provided, secret);
			} else if (authentication === 'hmac') {
				const req = this.getRequestObject();
				const rawBody =
					(req as unknown as { rawBody?: Buffer }).rawBody ??
					Buffer.from(JSON.stringify(this.getBodyData()));
				const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
				const provided = ((headers['x-signature-256'] as string) || '').replace(/^sha256=/i, '');
				valid = Boolean(secret) && safeEqual(provided, expected);
			}

			if (!valid) {
				const res = this.getResponseObject();
				res.status(401).json({ error: 'Invalid webhook authentication' });
				return { noWebhookResponse: true };
			}
		}

		const body = this.getBodyData() as IDataObject;

		return {
			workflowData: [this.helpers.returnJsonArray(normalizeWebhookBody(body))],
		};
	}
}
