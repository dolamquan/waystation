/** Public connector metadata. Provider tokens never belong in these objects or workflow graphs. */
export type ConnectorProvider = 'gmail' | 'drive' | 'slack' | 'discord' | 'whatsapp' | 'canva';
export interface ConnectorTool {
  name: string; label: string; description: string; write: boolean; scopes: string[];
  inputSchema: Record<string, unknown>;
}
export interface ConnectorDefinition {
  id: ConnectorProvider; name: string; description: string; auth: 'oauth' | 'token'; docs: string;
  setup: string; tools: ConnectorTool[];
}
export interface ConnectorAccount {
  id: string; project: string; provider: ConnectorProvider; label: string; tools: string[];
  status: 'connected' | 'disconnected'; createdAt: number; expiresAt?: number;
}
export interface ConnectorGrant {
  id: string; accountId: string; project: string; architectureId: string; nodeId: string; agentName: string;
  tools: string[]; requireApproval: boolean; createdAt: number; expiresAt: number; revokedAt?: number;
}
export interface ConnectorApproval {
  id: string; grantId: string; project: string; agentName: string; tool: string; input: Record<string, unknown>;
  status: 'pending' | 'executing' | 'succeeded' | 'denied' | 'failed'; createdAt: number; expiresAt: number;
}
export interface ConnectorState { providers: ConnectorDefinition[]; accounts: ConnectorAccount[]; grants: ConnectorGrant[]; approvals: ConnectorApproval[] }
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = { type: 'string', minLength: 1, maxLength: 2000 };
const content = { type: 'string', minLength: 1, maxLength: 12000 };
const limit = { type: 'integer', minimum: 1, maximum: 50 };
const tool = (name: string, label: string, write: boolean, scopes: string[], inputSchema: Record<string, unknown>, description = label): ConnectorTool => ({ name, label, description, write, scopes, inputSchema });
const gmailRead = ['https://www.googleapis.com/auth/gmail.readonly'];
const driveRead = ['https://www.googleapis.com/auth/drive.readonly'];
export const CONNECTOR_PROVIDERS: ConnectorDefinition[] = [
  { id: 'gmail', name: 'Gmail', description: 'Find and read email; send with a separate permission.', auth: 'oauth', docs: 'https://developers.google.com/identity/protocols/oauth2/native-app', setup: 'Create a Google Desktop OAuth client, enable Gmail API, and add your account as a test user when the consent screen is in testing. Gmail scopes may require Google verification for distribution.', tools: [
    tool('gmail_search', 'Search email', false, gmailRead, schema({ query: str, limit }, ['query'])),
    tool('gmail_read', 'Read an email', false, gmailRead, schema({ messageId: str }, ['messageId'])),
    tool('gmail_send', 'Send an email', true, ['https://www.googleapis.com/auth/gmail.send'], schema({ to: str, subject: str, body: content }, ['to', 'subject', 'body'])),
  ] },
  { id: 'drive', name: 'Google Drive', description: 'Find files and read their metadata or export Google documents.', auth: 'oauth', docs: 'https://developers.google.com/drive/api/guides/about-auth', setup: 'Create a Google Desktop OAuth client and enable Drive API. Read-only Drive access may require verification for distribution.', tools: [
    tool('drive_search', 'Find files', false, driveRead, schema({ query: str, limit })),
    tool('drive_metadata', 'Read file metadata', false, driveRead, schema({ fileId: str }, ['fileId'])),
    tool('drive_export', 'Export document as text', false, driveRead, schema({ fileId: str }, ['fileId']), 'Export a Google document as plain text. Binary files and spreadsheets need a different export adapter.'),
  ] },
  { id: 'slack', name: 'Slack', description: 'Read public channels and send messages as the authorized user.', auth: 'oauth', docs: 'https://docs.slack.dev/authentication/using-pkce/', setup: 'Create a Slack app, enable PKCE, add the shown localhost redirect URL and requested user scopes. This uses user_scope, because Slack desktop redirects cannot request bot scopes.', tools: [
    tool('slack_channels', 'List public channels', false, ['channels:read'], schema({ limit })),
    tool('slack_history', 'Read public channel history', false, ['channels:history'], schema({ channel: str, limit }, ['channel'])),
    tool('slack_send', 'Send a message', true, ['chat:write'], schema({ channel: str, text: content }, ['channel', 'text'])),
  ] },
  { id: 'discord', name: 'Discord', description: 'Give an installed bot access to server channels.', auth: 'token', docs: 'https://discord.com/developers/docs/topics/oauth2', setup: 'Create a Discord bot, install it in your server with the needed channel permissions, and enter its bot token. Reading content may require the Message Content intent. Personal account tokens are not supported.', tools: [
    tool('discord_history', 'Read channel messages', false, [], schema({ channel: str, limit }, ['channel'])),
    tool('discord_send', 'Send a bot message', true, [], schema({ channel: str, text: { ...content, maxLength: 2000 } }, ['channel', 'text'])),
  ] },
  { id: 'whatsapp', name: 'WhatsApp Business', description: 'Send approved templates from a business phone number.', auth: 'token', docs: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started', setup: 'Use a Meta WhatsApp Business system-user access token with whatsapp_business_messaging and a registered phone number ID. This does not connect a personal WhatsApp inbox. Incoming messages need a separate webhook receiver.', tools: [
    tool('whatsapp_template', 'Send an approved template', true, ['whatsapp_business_messaging'], schema({ phoneNumberId: { type: 'string', pattern: '^[0-9]{1,30}$' }, to: { type: 'string', pattern: '^[0-9]{6,20}$' }, template: { type: 'string', pattern: '^[a-z0-9_]{1,512}$' }, language: { type: 'string', pattern: '^[a-zA-Z_]{2,15}$' } }, ['phoneNumberId', 'to', 'template', 'language']), 'Send an approved template without variable parameters. Template approval and WhatsApp business messaging policies apply.'),
  ] },
  { id: 'canva', name: 'Canva', description: 'Browse designs and create a new design.', auth: 'oauth', docs: 'https://www.canva.dev/docs/connect/authentication/', setup: 'Create a public or private Canva integration, enable the requested scopes, and register the exact redirect URL shown here. Use its client ID and client secret.', tools: [
    tool('canva_designs', 'List designs', false, ['design:meta:read'], schema({ query: str })),
    tool('canva_design', 'Get design details', false, ['design:meta:read'], schema({ designId: str }, ['designId'])),
    tool('canva_create', 'Create a document design', true, ['design:content:write'], schema({ title: { ...str, maxLength: 255 } }, ['title'])),
  ] },
];
