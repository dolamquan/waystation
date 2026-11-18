# Hosted agent platform

The hosted deployment adds organization identity, role enforcement and one isolated worker per organization to the agent builder. It is a separate entry point at `/hosted`; the local desktop continues to work. Hosted workers run API agents, not native coding CLIs or desktop consoles.

Hosted integrations use configured HTTP tools, externally reachable MCP servers and scoped service credentials. The desktop's **App access** account/bridge UI is not exposed in the hosted workspace; its local OAuth callback and loopback MCP bridge are not a hosted integration mechanism.

## Execution contract

- An agent connection hands its response to the next agent as that agent's task. Each agent uses its own saved role, model, tools, memory and pinned capability versions. Deploying an entry agent snapshots the entire reachable workflow, including downstream capabilities.
- Router rules select the connected destination. Edge labels are descriptions. Approval connections explicitly select **Approved** or **Rejected or expired**; an omitted outcome means approved. Rejection with no matching branch fails the run.
- Multiple branches execute sequentially in connection order. Each receives the same source response. A shared downstream node executes once for each incoming activation. This is not a parallel fan-in/join engine.
- The entry agent bounds the whole workflow: default 32 steps, 900 seconds and 100,000 reported input/output tokens. Limits are configurable and persisted. Time limits include approvals. Token accounting stops additional work when reported usage reaches the budget; a response already requested can exceed that budget. These are not a hard dollar-spend guarantee.
- Each agent, memory write, decision, route and output has a persisted checkpoint. **Resume unfinished steps** reuses completed checkpoints and the immutable saved definition. A possibly completed external action requires acknowledgement before replay. Webhook deliveries carry a stable `Idempotency-Key` across resume attempts. The recipient must implement deduplication; this is not an exactly-once delivery guarantee.
- **Start a fresh attempt** intentionally repeats model/tool execution and deliveries. It has a separate warning. Restarted active work is marked interrupted, rather than silently re-executed.
- Production-following triggers refuse work until a production version exists. Pinned triggers remain explicit version-specific executions. Promotions require evidence for the current complete dataset and current evaluator versions. Regression blocking requires comparable evidence on the existing production version, or an audited override.

## Trust boundaries

The public TLS edge sends interactive traffic through OAuth2 Proxy using OIDC authorization code flow with PKCE. The proxy overwrites the subject header and supplies a separately mounted gateway secret. The gateway accepts neither a browser-supplied worker token nor an identity header without that secret. Configure one trusted issuer and use its immutable `sub` claim, not email addresses, as membership keys.

Memberships grant `viewer`, `operator` or `admin` in each organization. Viewers read definitions, runs and results. Operators run saved workflows and decide approvals. Administrators manage definitions, credentials, integrations, release policy and promotion. New/unrecognized API routes are denied. Desktop, terminal, arbitrary filesystem, pairing and general MCP-bridge routes are not exposed. Administrators are trusted to define agents and their tool permissions.

Each organization has its own worker container, network, SQLite state volume, project volume, token and credential-encryption key. The gateway joins each private worker network. Workers have no published host ports, host mounts, Docker socket or native CLI execution API. They run without root, with a read-only root filesystem, dropped capabilities, process/memory/CPU limits, and separate writable state/workspace volumes. This is container isolation, not a separate kernel or microVM per tenant.

Hosted credential files and their rolling backups use AES-256-GCM with a key mounted separately from the state volume. A wrong key or failed authentication makes the store read-only and does not replace the encrypted file. Keys must be backed up separately and access-controlled by the operator. The local deployment can opt into the same encryption with `WAYSTATION_SECRETS_KEY_FILE`; local installations without that setting retain their existing storage behavior.

The gateway records authenticated identity, organization, request id, route, method and result in durable JSONL. Mutations require an audit intent to be written before forwarding. Configure collection, retention, access controls and log rotation in the hosting environment. Never log authorization headers or request/response bodies.

## Prepare a deployment

1. Install Docker with Linux containers. From the repository root run `node scripts/init-hosted.mjs`. It creates ignored local configuration and distinct random secret files, without printing or replacing existing secrets.
2. Set `PUBLIC_HOST`, `OIDC_ISSUER` and `OIDC_CLIENT_ID` in `deploy/hosted/.env`. Register `https://<PUBLIC_HOST>/oauth2/callback` as the OIDC redirect URL. Write the client secret, without a trailing newline, to `deploy/hosted/secrets/oidc-client-secret`.
3. Edit `deploy/hosted/organizations.json`: use the same public HTTPS origin, name organizations, and replace the placeholder membership with the provider's actual immutable subject. The sample defines two isolated workers. Add another worker, network, state/project volumes, token and encryption key for every additional organization. Do not point two organizations at the same worker or reuse tokens/keys.
4. Run `docker compose -f deploy/hosted/compose.yaml config --quiet`, then `docker compose -f deploy/hosted/compose.yaml build` and `docker compose -f deploy/hosted/compose.yaml up -d`. Route DNS and TCP 80/443 to the TLS edge. No gateway/worker port should be published. For externally managed TLS, replace the edge with the hosting platform's equivalent private routing.
5. Open `/hosted`, sign in and choose an organization. Add an LLM connection, create a workflow, configure its agents and run a representative task. The API architect proposes schema-validated edits for review; applying a proposal checks the revision again.
6. Publish a candidate, create a representative dataset/evaluators, evaluate that candidate, set its release policy, and promote it. Verify that users from another organization cannot read or operate its objects, and that viewers cannot mutate them.

OAuth2 Proxy's versioned [header-injection and OIDC configuration reference](https://oauth2-proxy.github.io/oauth2-proxy/7.14.x/configuration/alpha-config/) documents the configuration used here. The provided configuration enables nonce verification explicitly and preserves neither incoming subject nor gateway-secret headers. Keep the proxy current and review migrations before upgrading its alpha configuration.

Membership configuration is managed by the deployment operator. Restart the gateway after changing it; memberships are checked on every request. This implementation does not provide SCIM provisioning, invitations, SAML, billing, or an organization-administration UI.

If your build environment uses an organization-managed TLS inspection CA, supply its public PEM certificate bundle as a BuildKit secret instead of disabling TLS verification:

```sh
docker build -f deploy/hosted/Dockerfile --secret id=additional_ca,src=/path/to/organization-ca.pem -t waystation-hosted:local .
docker compose -f deploy/hosted/compose.yaml up -d --no-build
```

The CA is available only to the dependency-install step and is not copied into the runtime image.

## Machine triggers

Interactive APIs require OIDC login. Machine webhooks use the narrower route `POST https://<PUBLIC_HOST>/hooks/<organization-id>/<trigger-id>` with the trigger's generated bearer token. This route bypasses interactive login but forwards only to that organization's trigger-invocation endpoint, where the worker verifies the token, enabled state and production release. It cannot select arbitrary API routes. The configured trigger supplies the task; request bodies are not interpreted as agent instructions. Rotate/revoke trigger keys from the organization UI. Use the hosted URL above rather than the worker-local path returned by older clients.

## Operations and acceptance

Pin tested container image digests before a production rollout. The development Compose recipe uses tags; its Node base can be overridden with `NODE_IMAGE`. Set CPU, memory and concurrency limits for expected traffic, use independent worker pools for untrusted customers, and apply infrastructure egress controls. Application hostname checks are defense in depth, not a network firewall; DNS check/connect races are not eliminated.

Back up each organization's SQLite database consistently with its WAL and project artifacts, and back up the encryption key separately. Test restore into a separate worker before relying on it. Keep the gateway audit volume durable. Configure health monitoring, alerting for failed runs and release errors, certificate renewal, disk limits, dependency scanning, and a log/data retention policy. This is a single-host reference deployment; it does not provide multi-region failover or transparent failover of in-flight model/tool execution. SQLite workers should not share a writable database volume across replicas.

Validation commands:

```sh
npm run typecheck
npm test -- tests/agentWorkflow.test.ts tests/hostedGateway.test.ts tests/secretEncryption.test.ts tests/apiArchitect.test.ts --maxWorkers=2
npm run build
docker compose -f deploy/hosted/compose.yaml config --quiet
node scripts/verify-hosted-identity.mjs
```

The identity verification requires the built `waystation-hosted:local` image and the pinned OAuth2 Proxy image. It creates a private temporary Docker network, simulated issuer and protected endpoint, then tests a signed login, nonce, PKCE S256 and replacement of forged identity headers. It publishes no host ports and removes its containers/network when finished. The browser workflow verification is `node --import tsx scripts/verify-production-workflows.mjs`.

The tests use local simulated model endpoints and authenticated proxy identities. Live issuer login, DNS/TLS, real provider billing, restore drills, load testing and independent security review require the target hosting environment. Passing these tests is not compliance certification or proof that an arbitrary agent is safe to operate unattended.
