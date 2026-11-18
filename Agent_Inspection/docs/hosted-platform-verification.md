# Hosted workflow verification

Verified locally on 2026-11-16/17. Deployment and execution contract:
[Hosted agent platform](hosted-agent-platform.md).

## Results

| Check | Result | Scope |
|---|---|---|
| TypeScript | Passed | `npm run typecheck` |
| Production frontend | Passed | `npm run build -- --logLevel error` |
| Focused regression | 136 passed, 0 failed | Workflow runtime, tool gateway, secrets, hosted gateway, API architect, evaluation, promotion, architecture APIs, insights, brains, model loop and internal-host guards |
| Browser verification | 4 passed | Draft persistence/reload, real two-agent handoff with approval and output, mobile navigation/overflow, hosted shell through the gateway |
| Linux image | Built successfully | Node 22, non-root worker/gateway image; corporate public CA supplied only as a BuildKit dependency-install secret |
| Compose configuration | Passed | Private organization networks, independent state/workspace/key/token, no published worker or gateway ports |
| Container smoke | 5 passed | Real gateway/worker HTTP paths, separate tenant state, credential response redaction, forged identity/desktop-route rejection and workspace containment |
| Stored credentials | Passed | Actual worker secret file uses AES-256-GCM and excludes the plaintext fixture credential |
| Real OIDC proxy | Passed | Pinned OAuth2 Proxy v7.14.0 with a simulated signed issuer: nonce, PKCE S256, immutable subject, forged-header replacement and denied anonymous access |

The OIDC test caught and corrected mismatched alpha configuration keys, the removed listener CLI option,
and URL-safe cookie-secret encoding. It tests the actual proxy binary, rather than only a mocked
authenticated gateway header. The deployment configuration follows the pinned
[official alpha configuration reference](https://oauth2-proxy.github.io/oauth2-proxy/7.14.x/configuration/alpha-config/).

The full repository suite was also attempted: 1,768 passed and 16 failed, with failures involving
timeouts in factory, team, worktree and desktop/browser integration tests. A serial recheck of those
seven files passed all 102 test assertions, but the runner still reported a browser-suite cleanup
failure. The full repository suite is therefore **not reported as green**. The focused 136-test
regression completed successfully with no failed suites.

## Reproduce

```sh
npm run typecheck
npm test -- tests/agentWorkflow.test.ts tests/agentRuns.test.ts tests/agentToolGateway.test.ts tests/secretEncryption.test.ts tests/secretStore.test.ts tests/hostedGateway.test.ts tests/apiArchitect.test.ts tests/agentEvaluation.test.ts tests/agentPlatform.test.ts tests/architectureApi.integration.test.ts tests/workflowInsights.test.ts tests/architectureBrains.test.ts tests/agentModelLoop.test.ts tests/urlGuardInternal.test.ts --maxWorkers=2
npm run build -- --logLevel error
node --import tsx scripts/verify-production-workflows.mjs
docker compose -f deploy/hosted/compose.yaml config --quiet
node scripts/verify-hosted-identity.mjs
```

The browser script uses an isolated local fixture with simulated model responses. The identity script
requires the built application image and pinned proxy image; it creates and cleans up a temporary
private Docker network without published ports. `scripts/verify-hosted-containers.mjs` runs inside a
private test gateway, writes explicitly named test objects and requires two disposable organization
workers. Do not run it against customer state.

Local JSON reports and screenshots are in `.impeccable/production-workflows/` (ignored build artifacts).
No paid model requests or real identity-provider credentials were used. Private Compose smoke-test
services and disposable state are removed after verification; the local image and ignored setup
configuration remain available.

## Production acceptance still required

This provides an executable, organization-isolated hosted foundation. It does not certify enterprise
readiness or guarantee that a generated agent performs its business task reliably. Before customer
traffic, configure the real OIDC client, immutable memberships, public domain/TLS and provider keys;
test representative datasets, adversarial tasks, backup/restore, sustained load and failure recovery;
configure monitoring, audit retention, infrastructure egress and deployment limits; and obtain an
independent security review.

The reference deployment is single-host with operator-managed memberships. It has no HA, SCIM,
invitations, billing or organization-administration UI. Native coding CLIs and the desktop's local
App access bridge are unavailable hosted. Branches execute sequentially without parallel joins.
Token limits rely on provider-reported usage, and webhook recipients must implement idempotency;
neither hard spend caps nor exactly-once external effects are promised.
