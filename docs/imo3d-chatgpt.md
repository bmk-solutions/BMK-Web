# ChatGPT photo analysis connection

IMO 3D exposes a project-scoped MCP server at `/api/imo3d-chatgpt/mcp`. Analysis runs in the user's ChatGPT conversation. The server does not invoke an OpenAI model or require an OpenAI API key. ChatGPT account availability and limits still apply.

## Connect

1. In ChatGPT, enable Developer mode if available, then add a custom MCP connection from Plugins.
2. Enter the deployed MCP URL and select OAuth. OAuth clients are dynamically registered; no client secret is required.
3. Sign in to IMO 3D and explicitly select the project that ChatGPT may access.
4. Ask ChatGPT to inspect all photographs, reconcile visible doors and overlapping views, and save a floor-by-floor 2D draft.
5. Review drafts in the tour's photo-plan section. Revoke a connection from IMO 3D Settings when needed.

## Boundaries

- Each connection is restricted to one project. It can list its tours, inspect scenes, and append separate drafts. It has no tools for deleting data, editing credentials, publishing tours or replacing approved plans.
- A scene tool returns six perspective views from that scene's display panorama, plus a signed receipt tied to the scene set and connection. These are display derivatives, not the original full-resolution files.
- Draft submission requires observations and valid receipts for every scene on the selected floor, an audit covering the same scene IDs, and the current image fingerprint. Geometry validation rejects missing evidence, intersecting rooms, invalid polygons and doors that contradict shared walls.
- Receipts prove image retrieval, not correct visual interpretation. Photographic analysis cannot certify measurements, hidden walls, complete coverage, or a numerical accuracy percentage. Unresolved geometry must remain explicitly uncertain.
- Al Hamra is a style reference. A new apartment's layout must come from that apartment's own evidence.
- OAuth uses exact allowlisted ChatGPT callbacks, PKCE S256, resource binding, one-use codes, hashed access/refresh tokens, token rotation and explicit revocation. No public bucket or permanent image URLs are introduced.
- Existing project/tour data is not migrated or overwritten. The migration adds three isolated tables with RLS and service-role-only grants.

## Validation

Run `node scripts/test-imo3d-cloud-routes.mjs`, TypeScript checking, ESLint and a production build. OAuth and tool discovery can also be exercised with an MCP client. A real ChatGPT connection must be confirmed in the account UI; server-level tests alone do not establish that account installation or model analysis succeeded.
