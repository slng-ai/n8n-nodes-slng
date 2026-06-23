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
	method: 'GET' | 'PATCH',
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
 * Existing tools read via GET come back with a read-only `auth_type` (secrets are
 * write-only). To preserve them on a read-modify-write PATCH, convert `auth_type`
 * back into an `auth` object without a secret — the API keeps the existing secret
 * when the secret is omitted on update.
 */
function normalizeExistingTool(tool: IDataObject): IDataObject {
	if (tool.type !== 'webhook' || !tool.auth_type) return tool;
	const { auth_type, ...rest } = tool;
	return { ...rest, auth: { type: auth_type } };
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

/** Build the webhook tool object from the node parameters. */
function buildTool(ctx: IHookFunctions, webhookUrl: string, secret: string): IDataObject {
	const toolType = ctx.getNodeParameter('toolType', 'contextual') as string;
	const authentication = ctx.getNodeParameter('authentication', 'none') as string;
	const httpMethod = ctx.getNodeParameter('httpMethod', 'POST') as string;
	const options = ctx.getNodeParameter('options', {}) as IDataObject;

	const tool: IDataObject = {
		type: 'webhook',
		id: randomUUID(),
		name: ctx.getNodeParameter('toolName', '') as string,
		description: ctx.getNodeParameter('toolDescription', '') as string,
		url: webhookUrl,
		source: toolType,
		http_method: httpMethod,
	};

	if (options.webhookFormat) tool.webhook_format = options.webhookFormat;
	if (options.timeoutSeconds) tool.timeout_seconds = options.timeoutSeconds;
	if (typeof options.waitForResponse === 'boolean')
		tool.wait_for_response = options.waitForResponse;
	if (typeof options.showResultsToLlm === 'boolean') {
		tool.show_results_to_llm = options.showResultsToLlm;
	}

	if (authentication === 'bearer') {
		tool.auth = { type: 'bearer', token: secret };
	} else if (authentication === 'hmac') {
		tool.auth = { type: 'hmac', secret };
	}

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

		tool.parameters = { type: 'object', properties, required, additionalProperties: false };
		tool.system = { triggers, arguments: argumentsList };
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
		tool.parameters = { type: 'object', properties, required, additionalProperties: false };

		const llmResultInstructions = ctx.getNodeParameter('llmResultInstructions', '') as string;
		if (llmResultInstructions) tool.llm_result_instructions = llmResultInstructions;

		const preActionMessage = ctx.getNodeParameter('preActionMessage', '') as string;
		if (preActionMessage) {
			tool.execution_policy = {
				pre_action_message: { enabled: true, text: preActionMessage },
			};
		}
	}

	return tool;
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
				const toolId = staticData.toolId as string | undefined;
				if (!toolId) return false;

				const agentId = this.getNodeParameter('agentId', '', { extractValue: true }) as string;
				const webhookUrl = this.getNodeWebhookUrl('default');

				try {
					const agent = await agentRequest(this, 'GET', `/agents/${agentId}`);
					const tools = Array.isArray(agent.tools) ? (agent.tools as IDataObject[]) : [];
					return tools.some((tool) => tool.id === toolId || tool.url === webhookUrl);
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
				const authentication = this.getNodeParameter('authentication', 'none') as string;
				const staticData = this.getWorkflowStaticData('node');

				let secret = '';
				if (authentication !== 'none') {
					secret =
						(this.getNodeParameter('secret', '') as string) ||
						(staticData.secret as string) ||
						randomBytes(32).toString('hex');
				}

				const tool = buildTool(this, webhookUrl, secret);

				const agent = await agentRequest(this, 'GET', `/agents/${agentId}`);
				const existing = Array.isArray(agent.tools) ? (agent.tools as IDataObject[]) : [];
				const priorToolId = staticData.toolId as string | undefined;

				// Drop any tool that is "ours" so re-registering replaces it instead of
				// appending a duplicate. SLNG enforces unique tool names, so a leftover tool
				// from a previous activation/test (same name, same URL, or our stored id)
				// must be removed first — otherwise the agent rejects the update.
				const tools = existing
					.filter((existingTool) => {
						if (priorToolId && existingTool.id === priorToolId) return false;
						if (existingTool.name === tool.name) return false;
						if (existingTool.url === webhookUrl) return false;
						return true;
					})
					.map(normalizeExistingTool);
				tools.push(tool);

				await agentRequest(this, 'PATCH', `/agents/${agentId}`, { tools });

				staticData.toolId = tool.id as string;
				staticData.agentId = agentId;
				if (secret) staticData.secret = secret;

				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const toolId = staticData.toolId as string | undefined;
				const agentId =
					(staticData.agentId as string) ||
					(this.getNodeParameter('agentId', '', { extractValue: true }) as string);

				if (toolId && agentId) {
					try {
						const agent = await agentRequest(this, 'GET', `/agents/${agentId}`);
						const existing = Array.isArray(agent.tools) ? (agent.tools as IDataObject[]) : [];
						const tools = existing.filter((tool) => tool.id !== toolId).map(normalizeExistingTool);
						await agentRequest(this, 'PATCH', `/agents/${agentId}`, { tools });
					} catch {
						// Best-effort cleanup: never block deactivation if the agent is gone or
						// unreachable. A leftover tool is replaced by create()'s idempotent dedup.
					}
				}

				delete staticData.toolId;
				delete staticData.agentId;
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
