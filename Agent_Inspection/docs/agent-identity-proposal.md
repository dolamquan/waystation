# Agent identity: proposed next step

This is a design proposal, not an implemented identity system. App access currently delegates bearer-token authority to an intended workflow agent. It provides a useful permission boundary, but a holder can copy that authority to another process.

Give each logical agent a stable principal ID, separate from its display name, workflow node, deployment version, model provider, and temporary running session. A deployment defines what the agent should do; a principal defines who is acting. A run receives a short-lived session identity under that principal. Replacing a model or deploying new instructions should not silently create a new identity or inherit new permissions.

Represent delegation as **human owner → agent principal → deployment → run → tool call**. The owner explicitly grants a capability for a purpose, duration, environment and resource boundary. For example: “Support agent may read the support mailbox and draft replies; sending requires my approval.” Provider identities remain distinct: Gmail actions may use an authorized human mailbox, Discord a bot, Slack an authorized user or service bot. The audit record should identify both the agent principal and the upstream account that actually acted.

The next implementation should add:

- A principal registry with owner, stable ID, display name, purpose, lifecycle and suspension state. Treat names and personality as presentation, not authentication.
- Per-run credentials minted only by the daemon after verifying principal, deployment and launch ownership. Prefer short-lived, audience-bound tokens and proof of possession or an authenticated process channel, so a copied bearer token alone cannot impersonate an agent.
- Delegation policies with exact tool grants and resource limits: mailbox, Drive folder, Slack/Discord channel, WhatsApp sender/recipient, plus budgets and rate limits. A subagent receives an explicit subset and cannot expand or forward authority by default.
- A policy check at every tool call, resolving the live principal status and current delegation. Bind approvals to the exact arguments, grant, principal and expiry. Show “Agent X, acting for owner Y, using account Z” in the approval surface.
- An audit trail linking principal, owner, run, deployment, grant, tool, approval and provider request ID. Use minimal payload retention with user-controlled deletion. Consider signing receipts once tamper evidence has a defined threat model and key-management plan.
- A single suspension action that stops new runs, revokes sessions and blocks tools. Rotation, account disconnection and deployment changes should have explicit effects on delegated authority.

Start with a local principal registry and per-run credential issuance; then add channel/folder/recipient restrictions before unattended external actions. Use dedicated provider bot or service accounts when available and appropriate, with clear disclosure that actions came from an agent. Avoid fabricating human identities or creating accounts autonomously. External legal identity, billing authority, provider verification and contractual authority remain separate human decisions.

Open decisions: single-owner versus team-owned principals; whether a deployment change must reauthorize high-impact grants; who can approve when the owner is unavailable; how delegated identity maps to provider accounts that cannot represent agents; which receipts and sensitive payloads should be retained, and for how long.
