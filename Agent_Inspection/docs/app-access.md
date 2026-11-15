# App access and MCP delegation

Architecture → **App access** connects an operator's service accounts and grants selected tools to a workflow agent. Connecting an account alone grants no agent access.

1. Choose a project and service. Follow the linked provider setup guide. OAuth services need your own registered client; Waystation does not ship shared OAuth credentials.
2. Select the tools to authorize. OAuth uses authorization code + S256 PKCE, a ten-minute, single-use state, and a localhost callback on the daemon's actual port. Register the exact URL shown in App access. Slack must have PKCE enabled and uses user scopes. The provider sign-in opens in a separate tab.
3. For Discord, save an installed bot's token. For WhatsApp, save a WhatsApp Business API token. Saving a service token does not verify it with the provider; the first call checks its permissions. Personal Discord tokens and personal WhatsApp inboxes are unsupported.
4. Choose **Grant to an agent**, select its workflow and agent, choose a subset of authorized tools, and set expiry (1 hour–30 days). Writes require individual operator approval by default; direct writes require explicitly disabling that option.
5. Tools become versioned HTTP capabilities on that agent's draft. Existing instructions, runtime policy, graph nodes and edges are preserved. Deploy a new version to change an existing deployment. Chat-only agents remain chat-only. Environments restricting network access must allow `127.0.0.1` for the broker endpoint.
6. A non-default HTTP MCP server is saved in Library → Integrations for coding-agent loadouts. Select that server when launching a coding session. App access also displays a copyable MCP configuration once after grant creation. It contains a grant bearer token, so keep it private. The endpoint is local to this machine.

## Included adapters

| Service | Authentication | Tools |
| --- | --- | --- |
| Gmail | Google Desktop OAuth client | Search, read, send plain-text email |
| Google Drive | Google Desktop OAuth client | Search, file metadata, plain-text export of Google documents |
| Slack | Public-client OAuth + PKCE, user scopes | List public channels, public channel history, send messages |
| Discord | Installed bot token | Channel message history, send messages with mentions disabled |
| WhatsApp Business | Meta access token | Send an approved template without variable parameters |
| Canva | Public/private integration OAuth + PKCE | List designs, get design details, create a document design |

Permissions still depend on the provider: Google may require consent-screen verification for distribution, Slack workspaces can require installation approval, Discord needs channel permissions and potentially Message Content intent, and WhatsApp needs a registered business phone and approved templates. Incoming WhatsApp messages require a future webhook receiver. Drive binary downloads and spreadsheet export, Canva editing/export, pagination beyond the first page, and Outlook email are not included in this first adapter set.

Provider references: [Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [Drive authorization](https://developers.google.com/drive/api/guides/about-auth), [Slack PKCE and desktop restrictions](https://docs.slack.dev/authentication/using-pkce/), [Discord authentication](https://discord.com/developers/docs/topics/oauth2), [WhatsApp setup](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started), [Canva OAuth](https://www.canva.dev/docs/connect/authentication/).

## Authority and credential handling

Provider access, refresh and client-secret values remain in the existing daemon SecretStore, outside workflow JSON and agent prompts. This reuses Waystation's local secret-file protection; it does **not** introduce OS-keychain encryption. Do not expose that file or its backups. OAuth access tokens refresh on demand, concurrent refreshes share one exchange, and rotating refresh tokens replace previous values. A disconnect racing with refresh cannot restore deleted credentials. Pending OAuth verifier/state pairs live only in daemon memory and expire after ten minutes; restart requires a new sign-in.

Each grant has its own random bearer token; only its hash is stored in the broker. The generated architecture resource credential and saved MCP server hold the bearer token. Agents never receive provider tokens or the operator API token. Capability metadata includes only the local endpoint and credential reference. Tool names, schemas, scopes, fixed provider hosts, paths and verbs are allowlisted. Redirect following is disabled, inputs are validated, and provider responses are bounded and stripped of known connector secrets. Audit events contain grant IDs, tool names and outcomes, without message bodies or credentials. Approval payloads are stored locally in the database for operator review and may contain sensitive content.

Grants limit tools, not individual channels, recipients, folders or files: a read tool can reach resources allowed by the provider account's scopes. Account connections and capability credentials are project-scoped. The grant records its intended workflow agent, but possession of the bearer token is the authorization mechanism; this is not yet a cryptographically authenticated agent identity. Only give the saved MCP connection to intended sessions.

Revoke a grant to block subsequent calls, including existing deployments with the old credential reference. Disconnecting an account revokes all its grants and deletes its local provider credentials. Revoked MCP entries/capabilities remain as references and fail closed. Disconnect is local revocation; it does not revoke the app installation at the provider. Use the provider's account settings to revoke that installation too. A request already sent upstream cannot be recalled.

Write calls needing approval return `approval_required` with an approval ID and do not run. The operator reviews the exact arguments and approves or denies under App access. Approval expires after fifteen minutes or grant expiry, whichever comes first. The broker claims the approval before awaiting network work, preventing replay or concurrent double execution. MCP clients can check `connector_approval_status`; HTTP capability calls return the queue result directly. Approval completion does not automatically resume the agent's conversation. Provider timeouts are not automatically retried: check the service before repeating a write. A daemon crash while executing leaves the decision marked `executing`; reconcile with the provider rather than replaying it.

## Extension points

Public schemas and adapter metadata: `shared/connectors.ts`. Fixed upstream request builders: `daemon/connectors/providers.ts`. Credential exchange, grants and approval enforcement: `daemon/connectors/broker.ts`. Stateless MCP dispatch: `daemon/connectors/rpc.ts`. Operator and grant-authenticated routes: `daemon/api/routes/connectors.ts`. This uses the existing capability publisher and architecture revision checks, without changing the agent runtime or adding connector fields to graph schemas.

An additional provider should define a bounded set of named operations, explicit read/write classification and scopes, provider-specific authentication and refresh behavior, fixed upstream destinations, and tests for denied access. Avoid generic “fetch any URL” or “call any provider method” operations.
