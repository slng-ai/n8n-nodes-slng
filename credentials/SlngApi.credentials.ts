import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class SlngApi implements ICredentialType {
	name = 'slngApi';

	displayName = 'SLNG API';

	icon: Icon = 'file:slng.svg';

	documentationUrl = 'https://docs.slng.ai';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Your SLNG API key. Used as a Bearer token for both the Voice API and the Agents API.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.slng.ai',
			url: '/v1/me',
			method: 'GET',
		},
	};
}
