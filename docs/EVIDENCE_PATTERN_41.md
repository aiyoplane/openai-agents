# Pattern 41 Behavioral Conformance Evidence — `@aiyoplane/openai-agents`

This document records the behavioral conformance of `@aiyoplane/openai-agents` against two properties:

1. **Pattern 41 — Enforcement Before Irreversibility.** The gated tool handler MUST NOT be invoked until the authorization condition has succeeded for the specific Intent that the dispatch would act on.
2. **Policy-matching correctness.** The policy's discrimination fields (`amount` via `rule.amount_max`) actually change the verdict at the intended boundary — not just the matcher-returned verdict, but the inner handler's execution state.

Both suites exercise the shipped `src/index.js` directly. No mocks of the module under test; the `rdp` collaborator is either a real `createLocalRdp` + `createAiyoMcpAuthz` (for the policy-driven cases) or a bespoke RDP test double (for the timing and fail-closed cases).

**Dependency:** `@aiyoplane/mcp-authz` `^1.0.0`.

**Reproducer:**

```
node --test test/adapter.test.js             # existing adapter tests
node --test test/policy-matching.test.js     # behavioral conformance
node --test test/pattern-41-ordering.test.js # ordering invariant
node --test test/*.test.js                   # full suite
```

---

## Context — baseline configuration shape repaired alongside this evidence

Before the behavioral conformance tests could run reliably, the existing `test/adapter.test.js` and `examples/minimal.js` were discovered to use configuration shapes inconsistent with the `@aiyoplane/mcp-authz` public contract:

1. **`aiyoGated: true` vs. `aiyo_gated: true`.** mcp-authz checks `toolDef.aiyo_gated !== true` (snake_case). The camelCase form was silently ignored, causing the tool to be treated as *ungated* and the RDP bypassed entirely.
2. **Top-level `rule.action_type` vs. `rule.match.action_type`.** mcp-authz's `evaluatePolicy` requires `match.action_type` for action-type matching.
3. **`effect: 'block'` vs. canonical `effect: 'deny'`.** mcp-authz's canonical ternary is `allow` / `escalate` / `deny`.
4. **Missing `toolDef.amount` function hook.** This is the critical defect for amount-based policy discrimination. Without the hook, mcp-authz's default intent builder sets `amount: 0` for every call. `rule.amount_max: 1000` matches `amount: 0`, so the first `allow` rule in the shipped policy matches every call regardless of the actual transfer amount.

Impact of the baseline configuration shape: an application that copied the shipped `examples/minimal.js` and expected amount-based discrimination to work would observe its policy's `escalate` and `deny` rules silently fail. A $50,000 transfer the policy's author intended to block would execute. This is documented in `test/regression-trip-wire-pre-repair.test.js` as a negative-control test.

**Repair shipped in 1.0.1:** test-and-example-fixture-only. No change to `src/`, `package.json`'s functional fields, or the published 1.0.0 tarball's shipped files. The example now demonstrates the correct composition pattern for amount-based discrimination: snake_case `aiyo_gated`, canonical rule shape, canonical effects, and the required `toolConfig[toolName].amount: (args) => <number>` function hook.

---

## Pattern 41 ordering invariant for `@aiyoplane/openai-agents`

**Statement.** For a wrapped tool (produced by `wrapTool` or `wrapExecute`), the inner `tool.execute` function MUST NOT be invoked until the authorization condition has succeeded for the specific Intent that the dispatch would act on. The authorization condition is:

(a) `intentBuilder(args)` resolved without throwing and returned a plain object; AND
(b) `authz.wrap(toolName, passthrough)(intent, null)` resolved with the ALLOW ctx shape (did not throw `AiyoDenied`, `AiyoEscalation`, or `AiyoUnreachable`).

Any failure at (a) or (b) MUST prevent the inner `execute` from running and MUST surface as `BlockedByPolicy` or `EscalationRequired` per the adapter's error contract.

### Scenario table

| # | Name | What it proves | Mechanism of proof |
|---|------|----------------|--------------------|
| 1 | inner execute runs AFTER slow `rdp.evaluate` resolves (timing) | Timing ordering is observable | `process.hrtime.bigint()` timestamps on `evaluate_called`, `evaluate_resolved`, `inner_execute_called`; asserts `evaluate_resolved < inner_execute_called` |
| 2 | inner execute does not run when `evaluate` throws `AiyoDenied` | DENY policy prevents execution and surfaces as `BlockedByPolicy` | Boolean inner-called flag asserted false |
| 3 | inner execute does not run when `evaluate` throws a generic error | Fail-closed on indeterminate / unreachable RDP (AEAP §2.2 invariant 5) | Boolean flag mechanism |
| 4 | inner execute does not run when `evaluate` throws `AiyoEscalation` | ESCALATE verdict surfaces as `EscalationRequired` (or `BlockedByPolicy` via message-regex) | Boolean flag |
| 5 | inner execute does not run when `intentBuilder` throws | `intentBuilder` throw fails closed with `BlockedByPolicy` before the RDP is called | Boolean flag |
| 6 | inner execute does not run when `intentBuilder` returns a non-object | A string, array, null, or primitive return fails closed with `BlockedByPolicy` | Loop over four bad-return shapes |
| 7 | concurrent gated-tool invocations each consult `evaluate` independently | Concurrent dispatches cannot share a cached decision | `evaluate_calls` counter equals 2; `inner_count` equals 2 |
| 8 | `wrapExecute` form: inner execute does not run on DENY | The decorator helper upholds the same invariant as direct `wrapTool` | Boolean flag |

---

## Policy-matching behavioral conformance

### Primary verdicts

| # | Case | Expected | Verified by |
|---|------|----------|-------------|
| 1 | `amount=500` → ALLOW; execute runs with the exact args | handler runs once; `received` equals input args | deep-equal on `received` |
| 2 | `amount=50000` → DENY; execute never runs | `BlockedByPolicy` thrown; flag false | assert both |
| 3 | `amount=5000` → ESCALATE; execute never runs | `EscalationRequired` thrown; flag false | assert both |

### Amount boundary cases

| # | Case | Expected | Why it matters |
|---|------|----------|-----------------|
| 4 | `amount=1000` (exactly at ALLOW ceiling) | ALLOW; execute runs | Inclusive boundary |
| 5 | `amount=1001` (just over ALLOW ceiling) | ESCALATE; execute does not run | Exclusive boundary |
| 6 | `amount=10001` (just over ESCALATE ceiling) | DENY; execute does not run | Catch-all behavior |
| 7 | `amount=0` | ALLOW; execute runs | Confirms the default-amount pathology does not apply when amount is explicit |

### Effective-argument consistency

| # | Case | Expected |
|---|------|----------|
| 8 | execute receives the exact args that were authorized | `received` deeply equals input across three arg shapes (numeric, spaces, special characters) |

### Regression trip-wire

| # | Case | Expected | Why it matters |
|---|------|----------|-----------------|
| 9 | Authz without the amount function hook → amount=50000 silently executes | handler runs | Proves the amount hook is load-bearing. If this test stops passing (handler no longer runs), mcp-authz has changed its default amount handling; re-examine. |

### Baseline sanity

| # | Case | Expected |
|---|------|----------|
| 10 | `default_effect: 'allow'` + no rules → any amount allowed | handler runs on amount=999999 |

Total policy-matching suite: 10 tests. Full suite across all four test files: 30 tests (8 adapter + 10 policy-matching + 8 pattern-41 + 4 regression trip-wire).

---

## What this suite does NOT establish

- **Not operation-binding against a cryptographic receipt claim.** The effective-args consistency check compares what the handler receives with what the policy saw; it does not bind a per-call `ophash` into the receipt payload. Future receipt-format work would carry such a claim.
- **Not a proof against hostile composition above `wrapTool`.** A caller that mutates `args` between `gated` being produced and being invoked is outside this suite's scope.
- **Not a proof that the Python sibling (`aiyoplane-openai-agents`) satisfies Pattern 41.** The Python adapter is maintained separately.
- **Not a cross-adapter claim.** This evidence covers `@aiyoplane/openai-agents` only.

---

## Cross-cutting notes

- The suite runs with no network, no RDP server, no signing material. `createLocalRdp` signs receipts in-process with a per-call key; test doubles bypass signing entirely. The properties under test are entirely local to `wrapTool`'s control flow and its composition above `createAiyoMcpAuthz.wrap`.
- The adapter's current ESCALATE detection path matches on the thrown error's message text (`/escalat/i`) in `src/index.js`. `@aiyoplane/mcp-authz@1.1.0` provides `AiyoEscalation` as a first-class error class; migrating this adapter to `instanceof AiyoEscalation` is a non-breaking forward improvement.
- Every behavioral assertion checks BOTH the thrown error type AND whether the inner `execute`'s recorded invocation state flipped. Checking only the error type is not sufficient: a composition that silently bypassed the gate could still throw an error from the handler itself and look like a policy denial from outside.
