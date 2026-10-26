# Changelog

## 1.0.1 (2026-10-26)

Example and test-fixture repair against the `@aiyoplane/mcp-authz` 1.0+ public configuration contract. No change to the shipped adapter source (`src/`); the production adapter implementation is unchanged. The affected files were in the GitHub repository (`examples/minimal.js` and `test/adapter.test.js`) and were NOT included in the npm tarball — the `files` whitelist (`src/`, `README.md`, `LICENSE`, `NOTICE`) has never included `examples/` or `test/`. Adopters who installed `@aiyoplane/openai-agents` via `npm install` and wrote their own configuration are unaffected by the example-level issue; adopters who copied `examples/minimal.js` from GitHub as a starting template received a configuration whose shape the policy matcher does not read as intended, which could leave the amount-based discrimination ineffective: the handler could execute on calls the policy's author intended to deny or escalate.

### Changed (test and example fixtures only)

- `toolConfig.<tool>.aiyoGated: true` → `aiyo_gated: true`. mcp-authz checks the snake_case key; the camelCase form was silently ignored, causing the tool to be treated as ungated and the Runtime Decision Point to be bypassed.
- Policy rules: top-level `action_type` moved under `rule.match.action_type`. mcp-authz's matcher reads `rule.match.action_type` against `intent.action.type`.
- Policy rules: `effect: 'block'` → `effect: 'deny'` to match mcp-authz's canonical ternary (`allow` / `escalate` / `deny`).
- `examples/minimal.js`: `toolConfig.transfer_funds.amount: (args) => args.amount` function hook added. **This is the critical fix for amount-based policy discrimination.** Without the amount hook, mcp-authz's default intent builder sets `amount: 0` on every call; the lowest-threshold `amount_max` rule matches every call; the policy returns `allow` regardless of the actual transfer amount.
- `examples/minimal.js`: `default_effect: 'deny'` added to the policy as defense-in-depth.

### Added

- `test/policy-matching.test.js` — adapter-level behavioral conformance tests. ALLOW / DENY / ESCALATE path exercises plus amount boundary cases, effective-argument consistency check, regression trip-wire, and a baseline sanity test. All assertions use independent handler-ran flag observations.
- `test/pattern-41-ordering.test.js` — Pattern 41 ordering-invariant behavioral conformance. Eight vectors covering timing-ordering, DENY, fail-closed, ESCALATE, intentBuilder failure modes, concurrent-independent-decision, and the `wrapExecute` form.
- `docs/EVIDENCE_PATTERN_41.md` — evidence record documenting the scenarios, mechanisms, and explicit non-claims.
- `test/regression-trip-wire-pre-repair.test.js` — negative-control test documenting the historical failure modes of the pre-1.0.1 broken example configuration. Pure mock handler; no filesystem, network, or subprocess calls. Reproduces both the camelCase `aiyoGated` state (gate not engaged) and the flag-only partial-correction state (always allow via missing amount hook).
- `.github/workflows/ci.yml` — minimal CI running `node --test test/*.test.js` plus `npm pack --dry-run` on push/PR, matrix across Node 20.x / 22.x / 24.x. Node 18 is end-of-life as of April 2025 and is not included; the `engines.node` declaration remains `>=18.0.0` for this release.

### Not changed

- No change to `src/index.js`, `src/errors.js`, or any other shipped source file.
- No change to the npm tarball contents (`files` whitelist is unchanged: `src/`, `README.md`, `LICENSE`, `NOTICE`).
- No change to the published `@aiyoplane/openai-agents@1.0.0` artifact; adopters pinned to 1.0.0 continue to receive the exact same code.

## 1.0.0 (2026-10-05)

- Initial release.
- AEAP Composition Boundary Adapter for the OpenAI Agents SDK (Node).
- Wraps `tool.execute` from `@openai/agents` with the AEAP RDP via `@aiyoplane/mcp-authz`.
- Entry points: `wrapTool`, `wrapExecute`.
- Fail-closed defaults per AEAP §2.2 invariant 5.
- Apache 2.0.
