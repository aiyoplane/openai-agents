# Changelog

## 1.0.0 (2026-10-05)

- Initial release.
- AEAP Composition Boundary Adapter for the OpenAI Agents SDK (Node).
- Wraps `tool.execute` from `@openai/agents` with the AEAP RDP via `@aiyoplane/mcp-authz`.
- Entry points: `wrapTool`, `wrapExecute`.
- Fail-closed defaults per AEAP §2.2 invariant 5.
- Apache 2.0.
