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

const VOICE_API_BASE = 'https://api.slng.ai/v1';

/**
 * Pull the human-readable error out of a slng API error response. slng returns
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

/** List catalog models for a service type via the SLNG catalog API (paginated). */
async function listCatalogModels(
	ctx: ILoadOptionsFunctions,
	serviceType: 'tts' | 'stt',
	filter?: string,
): Promise<INodeListSearchResult> {
	const results: Array<{ name: string; value: string }> = [];
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
		for (const item of items) {
			const value = item.code as string;
			if (!value) continue;
			const name = `${(item.name as string) || value} (${value})`;
			if (matchesFilter(name, value, filter)) results.push({ name, value });
		}

		const meta = (response.meta as IDataObject) ?? {};
		pages = (meta.pages as number) || 1;
		page += 1;
	} while (page <= pages && page <= 20);

	return { results };
}

/** List the voices of the currently-selected TTS model via the catalog detail endpoint. */
async function listModelVoices(
	ctx: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const model = ctx.getNodeParameter('ttsModel', undefined, { extractValue: true }) as string;
	if (!model) return { results: [] };

	// The model code contains '/' and ':' and maps to a multi-segment path — append it raw.
	const response = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'slngApi', {
		method: 'GET',
		url: `${VOICE_API_BASE}/catalog/models/${model}`,
		json: true,
	})) as IDataObject;

	const voices = (response.voices as IDataObject[]) ?? [];
	const results: Array<{ name: string; value: string }> = [];
	for (const voice of voices) {
		const value = voice.voice_id as string;
		if (!value) continue;
		const language = voice.language ? ` (${voice.language as string})` : '';
		const name = `${(voice.name as string) || value}${language} — ${value}`;
		if (matchesFilter(name, value, filter)) results.push({ name, value });
	}

	return { results };
}

export class Slng implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'slng',
		name: 'slng',
		icon: 'file:slng.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Generate speech and transcribe audio with the slng Voice API',
		defaults: {
			name: 'slng',
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
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				if (resource === 'textToSpeech' && operation === 'generate') {
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
					...(detail ? { message: `slng: ${detail}` } : {}),
				});
			}
		}

		return [returnData];
	}
}
