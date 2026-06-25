import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

const AGENTS_API_BASE = 'https://api.agents.slng.ai/v1';
const VOICE_API_BASE = 'https://api.slng.ai/v1';

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

/** Case-insensitive substring filter on a resource-locator result's name/value. */
function matchesFilter(name: string, value: string, filter?: string): boolean {
	if (!filter) return true;
	const needle = filter.toLowerCase();
	return name.toLowerCase().includes(needle) || value.toLowerCase().includes(needle);
}

/** Wrapper around authenticated SLNG Agents API requests. */
async function agentRequest(
	ctx: IExecuteFunctions | ILoadOptionsFunctions,
	method: 'GET' | 'POST',
	path: string,
	body?: IDataObject,
): Promise<IDataObject | IDataObject[]> {
	try {
		return (await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'slngApi', {
			method,
			url: `${AGENTS_API_BASE}${path}`,
			body,
			json: true,
		})) as IDataObject | IDataObject[];
	} catch (error) {
		const detail = slngErrorDetail(error);
		throw new NodeApiError(ctx.getNode(), error as JsonObject, {
			...(detail ? { message: `SLNG: ${detail}` } : {}),
			description: `${method} ${path} failed`,
		});
	}
}

/** Convert n8n key/value rows into the API's per-call arguments object. */
function buildDispatchArguments(dispatchArguments: IDataObject): IDataObject {
	const rows = (dispatchArguments.argument as IDataObject[]) ?? [];
	const args: IDataObject = {};

	for (const row of rows) {
		const name = String(row.name ?? '').trim();
		if (!name) continue;
		args[name] = String(row.value ?? '');
	}

	return args;
}

/** Fetch catalog models for a service type via the SLNG catalog API (paginated). */
async function fetchCatalogModels(
	ctx: ILoadOptionsFunctions,
	serviceType: 'tts' | 'stt',
): Promise<IDataObject[]> {
	const models: IDataObject[] = [];
	let page = 1;
	let pages = 1;
	do {
		const response = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'slngApi', {
			method: 'GET',
			url: `${VOICE_API_BASE}/catalog/models`,
			qs: { service_type: serviceType, page, page_size: 100 },
			json: true,
		})) as IDataObject;

		const items = (response.items as IDataObject[]) ?? [];
		models.push(...items);

		const meta = (response.meta as IDataObject) ?? {};
		pages = (meta.pages as number) || 1;
		page += 1;
	} while (page <= pages && page <= 20);

	return models;
}

/** List catalog models for a service type. */
async function listCatalogModels(
	ctx: ILoadOptionsFunctions,
	serviceType: 'tts' | 'stt',
	filter?: string,
): Promise<INodeListSearchResult> {
	const models = await fetchCatalogModels(ctx, serviceType);
	const results: Array<{ name: string; value: string }> = [];
	for (const item of models) {
		const value = item.code as string;
		if (!value) continue;
		const name = `${(item.name as string) || value} (${value})`;
		if (matchesFilter(name, value, filter)) results.push({ name, value });
	}

	return { results };
}

/** List the voices of the currently-selected TTS model from the catalog list response. */
async function listModelVoices(
	ctx: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const model = ctx.getCurrentNodeParameter('ttsModel', { extractValue: true }) as string;
	if (!model) return { results: [] };

	const models = await fetchCatalogModels(ctx, 'tts');
	const selectedModel = models.find((item) => item.code === model);
	const voices = (selectedModel?.voices as IDataObject[]) ?? [];
	const results: Array<{ name: string; value: string }> = [];
	for (const voice of voices) {
		const value = (voice.voice_id ?? voice.voiceId ?? voice.id ?? voice.code) as string;
		if (!value) continue;
		const language = voice.language ? ` (${voice.language as string})` : '';
		const name = `${(voice.name as string) || value}${language} — ${value}`;
		if (matchesFilter(name, value, filter)) results.push({ name, value });
	}

	return { results };
}

export class Slng implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SLNG',
		name: 'slng',
		icon: 'file:slng.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Use SLNG voice AI to generate text-to-speech audio or transcribe speech-to-text from audio files',
		defaults: {
			name: 'SLNG',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'slngApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Agent',
						value: 'agent',
					},
					{
						name: 'Speech to Text',
						value: 'speechToText',
					},
					{
						name: 'Text to Speech',
						value: 'textToSpeech',
					},
				],
				default: 'textToSpeech',
			},

			// Agent
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: { resource: ['agent'] },
				},
				options: [
					{
						name: 'Dispatch Call',
						value: 'dispatchCall',
						action: 'Dispatch an outbound call',
						description: 'Dispatch a phone call from a SLNG voice agent',
					},
				],
				default: 'dispatchCall',
			},
			{
				displayName: 'Agent',
				name: 'agentId',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				description: 'The SLNG voice agent that will place the outbound call',
				displayOptions: {
					show: { resource: ['agent'], operation: ['dispatchCall'] },
				},
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
				displayName: 'Phone Number',
				name: 'phoneNumber',
				type: 'string',
				default: '',
				required: true,
				placeholder: '+15551234567',
				description: 'The E.164 phone number to call',
				displayOptions: {
					show: { resource: ['agent'], operation: ['dispatchCall'] },
				},
			},
			{
				displayName: 'Arguments',
				name: 'dispatchArguments',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, maxValue: 32 },
				default: {},
				placeholder: 'Add Argument',
				description:
					'Per-call template arguments. Argument values are sent to SLNG as strings.',
				displayOptions: {
					show: { resource: ['agent'], operation: ['dispatchCall'] },
				},
				options: [
					{
						name: 'argument',
						displayName: 'Argument',
						values: [
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
								placeholder: 'customer_name',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								placeholder: 'Ada',
							},
						],
					},
				],
			},

			// Text to Speech
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: { resource: ['textToSpeech'] },
				},
				options: [
					{
						name: 'Generate',
						value: 'generate',
						action: 'Generate speech from text',
						description: 'Convert text into spoken audio',
					},
				],
				default: 'generate',
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 4 },
				required: true,
				default: '',
				placeholder: 'The text to convert to speech',
				displayOptions: {
					show: { resource: ['textToSpeech'], operation: ['generate'] },
				},
			},
			{
				displayName: 'Model',
				name: 'ttsModel',
				type: 'resourceLocator',
				default: { mode: 'list', value: 'slng/deepgram/aura:2-en' },
				required: true,
				description: 'The TTS model to use. Pick from the catalog or enter a model path by ID.',
				hint:
					'See the <a href="https://docs.slng.ai/models/tts" target="_blank">SLNG TTS models documentation</a> for the full model list.',
				displayOptions: {
					show: { resource: ['textToSpeech'], operation: ['generate'] },
				},
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'searchTtsModels',
							searchable: true,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. slng/deepgram/aura:2-en',
					},
				],
			},
			{
				displayName: 'Voice',
				name: 'voice',
				type: 'resourceLocator',
				default: { mode: 'list', value: 'aura-2-thalia-en' },
				description:
					'The voice for the selected TTS model. Pick from the catalog or enter a voice ID.',
				hint:
					'See the <a href="https://docs.slng.ai/models" target="_blank">SLNG model catalog</a> and the Voices section for model-specific voice lists.',
				displayOptions: {
					show: { resource: ['textToSpeech'], operation: ['generate'] },
				},
				// Reload the voice list whenever the selected TTS model changes.
				typeOptions: {
					loadOptionsDependsOn: ['ttsModel.value'],
				},
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'searchVoices',
							searchable: true,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. aura-2-thalia-en',
					},
				],
			},
			{
				displayName: 'Put Output in Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				hint: 'The name of the output binary field to put the audio file in',
				displayOptions: {
					show: { resource: ['textToSpeech'], operation: ['generate'] },
				},
			},
			{
				displayName: 'Options',
				name: 'ttsOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: { resource: ['textToSpeech'], operation: ['generate'] },
				},
				options: [
					{
						displayName: 'File Name',
						name: 'fileName',
						type: 'string',
						default: 'speech.wav',
						description: 'Name of the generated audio file',
					},
					{
						displayName: 'Language',
						name: 'language',
						type: 'string',
						default: '',
						placeholder: 'en',
						description: 'Optional language hint (ISO code) passed to the model',
					},
				],
			},

			// Speech to Text
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: { resource: ['speechToText'] },
				},
				options: [
					{
						name: 'Transcribe',
						value: 'transcribe',
						action: 'Transcribe audio to text',
						description: 'Convert an audio file into text',
					},
				],
				default: 'transcribe',
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				hint: 'The name of the input binary field containing the audio file to transcribe',
				displayOptions: {
					show: { resource: ['speechToText'], operation: ['transcribe'] },
				},
			},
			{
				displayName: 'Model',
				name: 'sttModel',
				type: 'resourceLocator',
				default: { mode: 'list', value: 'slng/deepgram/nova:3-en' },
				required: true,
				description: 'The STT model to use. Pick from the catalog or enter a model path by ID.',
				hint:
					'See the <a href="https://docs.slng.ai/models/stt" target="_blank">SLNG STT models documentation</a> for the full model list.',
				displayOptions: {
					show: { resource: ['speechToText'], operation: ['transcribe'] },
				},
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'searchSttModels',
							searchable: true,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. slng/deepgram/nova:3-en',
					},
				],
			},
		],
	};

	methods = {
		listSearch: {
			async searchTtsModels(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				return listCatalogModels(this, 'tts', filter);
			},
			async searchSttModels(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				return listCatalogModels(this, 'stt', filter);
			},
			async searchVoices(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				return listModelVoices(this, filter);
			},
			async searchAgents(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				const agents = (await agentRequest(this, 'GET', '/agents')) as IDataObject[];
				const results = (Array.isArray(agents) ? agents : [])
					.map((agent) => {
						const value = agent.id as string;
						const name = ((agent.name as string) || value) as string;
						return { name, value };
					})
					.filter((agent) => agent.value && matchesFilter(agent.name, agent.value, filter));

				return { results };
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				if (resource === 'agent' && operation === 'dispatchCall') {
					const agentId = this.getNodeParameter('agentId', i, '', {
						extractValue: true,
					}) as string;
					const phoneNumber = this.getNodeParameter('phoneNumber', i) as string;
					const dispatchArguments = this.getNodeParameter(
						'dispatchArguments',
						i,
						{},
					) as IDataObject;

					const agent = (await agentRequest(this, 'GET', `/agents/${agentId}`)) as IDataObject;
					if (!agent.sip_outbound_trunk_id) {
						throw new NodeOperationError(
							this.getNode(),
							'Outbound telephony is not configured for this SLNG agent. Configure an outbound SIP trunk before dispatching calls.',
							{ itemIndex: i },
						);
					}

					const body: IDataObject = {
						phone_number: phoneNumber,
					};
					const args = buildDispatchArguments(dispatchArguments);
					if (Object.keys(args).length > 0) body.arguments = args;

					const response = (await agentRequest(
						this,
						'POST',
						`/agents/${agentId}/calls`,
						body,
					)) as IDataObject;

					returnData.push({
						json: response,
						pairedItem: { item: i },
					});
				} else if (resource === 'textToSpeech' && operation === 'generate') {
					const text = this.getNodeParameter('text', i) as string;
					const model = this.getNodeParameter('ttsModel', i, '', { extractValue: true }) as string;
					const voice = this.getNodeParameter('voice', i, '', { extractValue: true }) as string;
					const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i) as string;
					const options = this.getNodeParameter('ttsOptions', i, {}) as IDataObject;
					const fileName = (options.fileName as string) || 'speech.wav';

					const body: IDataObject = { text };
					if (voice) body.model = voice;
					if (options.language) body.language = options.language;

					const requestOptions: IHttpRequestOptions = {
						method: 'POST',
						url: `${VOICE_API_BASE}/tts/${model}`,
						body,
						json: true,
						encoding: 'arraybuffer',
						returnFullResponse: true,
					};

					const response = await this.helpers.httpRequestWithAuthentication.call(
						this,
						'slngApi',
						requestOptions,
					);

					const headers = (response.headers ?? {}) as IDataObject;
					const mimeType = (headers['content-type'] as string) || 'audio/wav';
					const binaryData = await this.helpers.prepareBinaryData(
						Buffer.from(response.body as ArrayBuffer),
						fileName,
						mimeType,
					);

					returnData.push({
						json: { model, voice, fileName },
						binary: { [binaryPropertyName]: binaryData },
						pairedItem: { item: i },
					});
				} else if (resource === 'speechToText' && operation === 'transcribe') {
					const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i) as string;
					const model = this.getNodeParameter('sttModel', i, '', { extractValue: true }) as string;

					const binary = this.helpers.assertBinaryData(i, binaryPropertyName);
					const buffer = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);

					const formData = new FormData();
					formData.append(
						'audio',
						new Blob([buffer], { type: binary.mimeType || 'application/octet-stream' }),
						binary.fileName || 'audio.wav',
					);

					const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'slngApi', {
						method: 'POST',
						url: `${VOICE_API_BASE}/stt/${model}`,
						body: formData,
					})) as IDataObject;

					returnData.push({
						json: response,
						pairedItem: { item: i },
					});
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`The operation "${operation}" is not supported for resource "${resource}"`,
						{ itemIndex: i },
					);
				}
			} catch (error) {
				const detail = slngErrorDetail(error);
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: detail || (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				if (error instanceof NodeOperationError) {
					throw new NodeOperationError(this.getNode(), error, { itemIndex: i });
				}
				throw new NodeApiError(this.getNode(), error as JsonObject, {
					itemIndex: i,
					...(detail ? { message: `SLNG: ${detail}` } : {}),
				});
			}
		}

		return [returnData];
	}
}
