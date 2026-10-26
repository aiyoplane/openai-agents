// Pattern 41 (Enforcement Before Irreversibility) ordering invariant —
// @aiyoplane/openai-agents conformance tests.
//
// Verifies the shipped @aiyoplane/openai-agents code does not permit a
// wrapped tool handler to run before the required authorization condition
// is satisfied.
//
// For the OpenAI Agents SDK composition, the ordering invariant is:
//
//   For a wrapped tool (produced by wrapTool or wrapExecute), the underlying
//   tool.execute function MUST NOT be invoked until the authorization
//   condition has succeeded for the specific Intent the dispatch would act on.
//   The authorization condition is:
//     (a) intentBuilder(args) resolved without throwing and returned a plain
//         object; AND
//     (b) authz.wrap(toolName, passthrough)(intent, null) resolved with the
//         ALLOW ctx shape (did not throw AiyoDenied, AiyoEscalation, or
//         AiyoUnreachable).
//
//   Any failure at (a) or (b) MUST prevent tool.execute from running and MUST
//   surface as BlockedByPolicy or EscalationRequired per the adapter's error
//   contract.
//
// Eight behavioral cases below. Each would fail LOUDLY if the invariant
// breaks — not from source inspection, but from observing whether the inner
// tool.execute's recorded invocation happened.
//
// Run: node --test test/pattern-41-ordering.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAiyoMcpAuthz, createLocalRdp } from '@aiyoplane/mcp-authz';

import {
  BlockedByPolicy,
  EscalationRequired,
  wrapExecute,
  wrapTool,
} from '../src/index.js';

// Helper: build an authz backed by createLocalRdp with a single-rule policy.
function makeAuthz(ruleEffect, extra = {}) {
  return createAiyoMcpAuthz({
    rdp: createLocalRdp({
      policy: {
        default_effect: 'deny',
        rules: [{
          id: 'pattern-41-vector',
          match: { action_type: 'payment' },
          effect: ruleEffect,
          ...extra,
        }],
      },
    }),
    toolConfig: {
      transfer_funds: { aiyo_gated: true, action: { type: 'payment' }, amount: (args) => args.amount },
    },
    verifyReceiptOnAllow: false,
  });
}

function makeAuthzWithRdp(rdpDouble) {
  return createAiyoMcpAuthz({
    rdp: rdpDouble,
    toolConfig: {
      transfer_funds: { aiyo_gated: true, action: { type: 'payment' }, amount: (args) => args.amount },
    },
    verifyReceiptOnAllow: false,
  });
}

const intentBuilder = (args) => ({ type: 'payment', amount: args.amount });

// ─── Case 1 — ALLOW happy path with latency ─────────────────────────────

test('[release-blocker] inner execute runs AFTER slow rdp.evaluate resolves (timing)', async () => {
  const events = [];
  const record = (name) => events.push({ name, t: process.hrtime.bigint() });

  const rdp = {
    async evaluate() {
      record('evaluate_called');
      await new Promise((r) => setTimeout(r, 50));
      record('evaluate_resolved');
      return {
        intentId: 'test-intent-1',
        receipt: { token: 'v2.fake.sig' },
        decision: { verdict: 'ALLOW' },
      };
    },
    async close() {},
    async verifyReceipt() { return { iid: 'test-intent-1' }; },
  };

  const tool = {
    name: 'transfer_funds',
    description: 'x',
    execute: async (args) => {
      record('inner_execute_called');
      return `transferred ${args.amount}`;
    },
  };

  const gated = wrapTool(tool, { authz: makeAuthzWithRdp(rdp), intentBuilder });

  const result = await gated.execute({ amount: 100 }, null);
  record('gated_returned');

  const t = (name) => events.find((e) => e.name === name)?.t;

  assert.ok(t('evaluate_called') !== undefined, 'evaluate must have been called');
  assert.ok(t('evaluate_resolved') !== undefined, 'evaluate must have resolved');
  assert.ok(t('inner_execute_called') !== undefined, 'inner execute must have been called on ALLOW');
  assert.ok(
    t('evaluate_resolved') < t('inner_execute_called'),
    'INVARIANT VIOLATION: inner execute ran before evaluate resolved.'
  );
  assert.equal(result, 'transferred 100');
});

// ─── Case 2 — DENY path via AiyoDenied ─────────────────────────────────

test('[release-blocker] inner execute does not run when evaluate throws AiyoDenied', async () => {
  let inner_called = false;

  const authz = makeAuthz('deny');
  const tool = {
    name: 'transfer_funds',
    description: 'x',
    execute: async () => { inner_called = true; return 'ran'; },
  };
  const gated = wrapTool(tool, { authz, intentBuilder });

  await assert.rejects(
    () => gated.execute({ amount: 100 }, null),
    (err) => err instanceof BlockedByPolicy
  );

  assert.equal(inner_called, false,
    'INVARIANT VIOLATION: inner execute ran despite DENY.');
});

// ─── Case 3 — Generic throw (fail-closed) ───────────────────────────────

test('[release-blocker] inner execute does not run when evaluate throws a generic error (fail closed)', async () => {
  let inner_called = false;

  const rdp = {
    async evaluate() { const err = new Error('network partition'); err.code = 'UNAVAILABLE'; throw err; },
    async close() {},
    async verifyReceipt() { throw new Error('unreachable'); },
  };

  const tool = {
    name: 'transfer_funds',
    description: 'x',
    execute: async () => { inner_called = true; return 'ran'; },
  };
  const gated = wrapTool(tool, { authz: makeAuthzWithRdp(rdp), intentBuilder });

  await assert.rejects(() => gated.execute({ amount: 100 }, null), () => true);
  assert.equal(inner_called, false,
    'INVARIANT VIOLATION: inner execute ran despite evaluate throwing. Fail-closed invariant breached.');
});

// ─── Case 4 — ESCALATE path via AiyoEscalation ──────────────────────────

test('[release-blocker] inner execute does not run when evaluate throws AiyoEscalation', async () => {
  let inner_called = false;

  const authz = makeAuthz('escalate', { escalation_id: 'approve-wf-1' });
  const tool = {
    name: 'transfer_funds',
    description: 'x',
    execute: async () => { inner_called = true; return 'ran'; },
  };
  const gated = wrapTool(tool, { authz, intentBuilder });

  await assert.rejects(
    () => gated.execute({ amount: 100 }, null),
    (err) => err instanceof EscalationRequired || err instanceof BlockedByPolicy
  );

  assert.equal(inner_called, false,
    'INVARIANT VIOLATION: inner execute ran despite ESCALATE.');
});

// ─── Case 5 — intentBuilder throws ──────────────────────────────────────

test('[release-blocker] inner execute does not run when intentBuilder throws', async () => {
  let inner_called = false;

  const tool = {
    name: 'transfer_funds',
    description: 'x',
    execute: async () => { inner_called = true; return 'ran'; },
  };
  const gated = wrapTool(tool, {
    authz: makeAuthz('allow'),
    intentBuilder: () => { throw new Error('intent build failed'); },
  });

  await assert.rejects(
    () => gated.execute({ amount: 100 }, null),
    (err) => err instanceof BlockedByPolicy
  );

  assert.equal(inner_called, false,
    'INVARIANT VIOLATION: inner execute ran despite intentBuilder throwing.');
});

// ─── Case 6 — intentBuilder returns a non-object ────────────────────────

test('[release-blocker] inner execute does not run when intentBuilder returns a non-object', async () => {
  for (const badReturn of ['not an object', ['array', 'not', 'object'], null, 42]) {
    let inner_called = false;

    const tool = {
      name: 'transfer_funds',
      description: 'x',
      execute: async () => { inner_called = true; return 'ran'; },
    };
    const gated = wrapTool(tool, {
      authz: makeAuthz('allow'),
      intentBuilder: () => badReturn,
    });

    await assert.rejects(
      () => gated.execute({ amount: 100 }, null),
      (err) => err instanceof BlockedByPolicy,
      `wrapped execute must reject when intentBuilder returns ${JSON.stringify(badReturn)}`
    );
    assert.equal(inner_called, false,
      `INVARIANT VIOLATION: inner execute ran when intentBuilder returned ${JSON.stringify(badReturn)}.`);
  }
});

// ─── Case 7 — concurrent gated calls each consult evaluate independently ─

test('[release-blocker] concurrent gated-tool invocations each consult evaluate independently', async () => {
  let evaluate_calls = 0;
  const rdp = {
    async evaluate() {
      const n = ++evaluate_calls;
      await new Promise((r) => setTimeout(r, 30));
      return {
        intentId: `test-intent-${n}`,
        receipt: { token: `v2.fake.sig.${n}` },
        decision: { verdict: 'ALLOW' },
      };
    },
    async close() {},
    async verifyReceipt() { return {}; },
  };

  let inner_count = 0;
  const tool = {
    name: 'transfer_funds',
    description: 'x',
    execute: async () => { const n = ++inner_count; return { ran: n }; },
  };
  const gated = wrapTool(tool, { authz: makeAuthzWithRdp(rdp), intentBuilder });

  const [r1, r2] = await Promise.all([
    gated.execute({ amount: 100 }, null),
    gated.execute({ amount: 200 }, null),
  ]);

  assert.equal(evaluate_calls, 2, 'INVARIANT: each gated invocation must call evaluate independently');
  assert.equal(inner_count, 2, 'INVARIANT: each gated invocation must run its own inner execute');
  assert.ok([r1.ran, r2.ran].includes(1) && [r1.ran, r2.ran].includes(2), 'both inner calls completed');
});

// ─── Case 8 — wrapExecute function form upholds the invariant ───────────

test('[release-blocker] wrapExecute form: inner execute does not run on DENY', async () => {
  let inner_called = false;

  const authz = makeAuthz('deny');
  const wrapped = wrapExecute(
    async () => { inner_called = true; return 'ran'; },
    { authz, toolName: 'transfer_funds', intentBuilder }
  );

  await assert.rejects(
    () => wrapped({ amount: 100 }),
    (err) => err instanceof BlockedByPolicy
  );
  assert.equal(inner_called, false,
    'INVARIANT: wrapExecute-produced wrapper must enforce Pattern 41 ordering identically to wrapTool.');
});
