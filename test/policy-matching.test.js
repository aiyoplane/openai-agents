// Policy-matching behavioral conformance tests for @aiyoplane/openai-agents.
//
// Verifies the composition pattern in examples/minimal.js correctly plumbs
// per-call tool arguments through to the policy matcher for amount-based
// discrimination. Every assertion checks BOTH the thrown error type AND
// whether a boolean handler-ran flag flipped. Checking only the error type
// is not sufficient: a composition that silently bypassed the gate could
// still throw an error from the handler itself and look like a policy
// denial from outside.
//
// Run: node --test test/policy-matching.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAiyoMcpAuthz, createLocalRdp } from '@aiyoplane/mcp-authz';

import {
  BlockedByPolicy,
  EscalationRequired,
  wrapTool,
} from '../src/index.js';

// ─── Shared authz builder (mirrors examples/minimal.js) ─────────────────────

const DEFAULT_POLICY = {
  default_effect: 'deny',
  rules: [
    { match: { action_type: 'payment' }, amount_max: 1000,  effect: 'allow' },
    { match: { action_type: 'payment' }, amount_max: 10000, effect: 'escalate' },
    { match: { action_type: 'payment' },                      effect: 'deny' },
  ],
};

function makeAuthz(policy = DEFAULT_POLICY) {
  return createAiyoMcpAuthz({
    rdp: createLocalRdp({ policy }),
    toolConfig: {
      transfer_funds: {
        aiyo_gated: true,
        action: { type: 'payment' },
        amount: (args) => args.amount,
      },
    },
  });
}

// Factory for a gated tool that records every invocation.
function makeGatedTool(authz) {
  const log = { invoked: false, received: null, calls: 0 };
  const tool = {
    name: 'transfer_funds',
    description: 'Transfer funds between accounts.',
    execute: async (args) => {
      log.invoked = true;
      log.received = args;
      log.calls += 1;
      return `Transferred $${args.amount} to ${args.toAccount}`;
    },
  };
  const gated = wrapTool(tool, {
    authz,
    intentBuilder: (args) => ({ type: 'payment', amount: args.amount, target: args.toAccount }),
  });
  return { gated, log };
}

// ─── Section A — primary verdicts: ALLOW, DENY, ESCALATE ────────────────────

test('[allow] amount=500 → handler executes with the exact args', async () => {
  const authz = makeAuthz();
  const { gated, log } = makeGatedTool(authz);

  const result = await gated.execute({ amount: 500, toAccount: 'acct_A' });

  assert.equal(log.invoked, true, 'handler must execute on ALLOW');
  assert.equal(log.calls, 1, 'handler must execute exactly once');
  assert.deepEqual(log.received, { amount: 500, toAccount: 'acct_A' });
  assert.match(result, /Transferred \$500 to acct_A/);
});

test('[deny] amount=50000 → BlockedByPolicy thrown; handler never runs', async () => {
  const authz = makeAuthz();
  const { gated, log } = makeGatedTool(authz);

  await assert.rejects(
    gated.execute({ amount: 50000, toAccount: 'adversary' }),
    (err) => err instanceof BlockedByPolicy,
    'wrapped execute must reject with BlockedByPolicy on DENY'
  );

  assert.equal(log.invoked, false,
    'INVARIANT: protected handler MUST NOT run on DENY. If this flipped true, the policy matcher returned deny but something downstream still invoked the handler.');
});

test('[escalate] amount=5000 → EscalationRequired thrown; handler never runs', async () => {
  const authz = makeAuthz();
  const { gated, log } = makeGatedTool(authz);

  await assert.rejects(
    gated.execute({ amount: 5000, toAccount: 'acct_B' }),
    (err) => err instanceof EscalationRequired || err instanceof BlockedByPolicy,
    'wrapped execute must reject with EscalationRequired (or BlockedByPolicy via regex-detection) on ESCALATE'
  );

  assert.equal(log.invoked, false,
    'INVARIANT: protected handler MUST NOT run while ESCALATE is unresolved.');
});

// ─── Section B — amount boundary cases ──────────────────────────────────────

test('[boundary] amount=1000 (exactly at ALLOW ceiling) → ALLOW; handler runs', async () => {
  const authz = makeAuthz();
  const { gated, log } = makeGatedTool(authz);
  await gated.execute({ amount: 1000, toAccount: 'acct_A' });
  assert.equal(log.invoked, true, 'amount at the ceiling of amount_max=1000 must still ALLOW');
});

test('[boundary] amount=1001 (just over ALLOW ceiling) → ESCALATE; handler does not run', async () => {
  const authz = makeAuthz();
  const { gated, log } = makeGatedTool(authz);
  await assert.rejects(
    gated.execute({ amount: 1001, toAccount: 'acct_A' }),
    (err) => err instanceof EscalationRequired || err instanceof BlockedByPolicy
  );
  assert.equal(log.invoked, false, 'amount just above ALLOW ceiling must escalate, not allow');
});

test('[boundary] amount=10001 (just over ESCALATE ceiling) → DENY; handler does not run', async () => {
  const authz = makeAuthz();
  const { gated, log } = makeGatedTool(authz);
  await assert.rejects(
    gated.execute({ amount: 10001, toAccount: 'acct_A' }),
    (err) => err instanceof BlockedByPolicy
  );
  assert.equal(log.invoked, false, 'amount just above ESCALATE ceiling must deny, not escalate');
});

test('[boundary] amount=0 → still ALLOW (zero is within amount_max=1000)', async () => {
  const authz = makeAuthz();
  const { gated, log } = makeGatedTool(authz);
  await gated.execute({ amount: 0, toAccount: 'acct_A' });
  assert.equal(log.invoked, true, 'amount 0 is within the ALLOW threshold');
});

// ─── Section C — effective-argument consistency ─────────────────────────────

test('[effective-args] handler receives the exact args that were authorized', async () => {
  const authz = makeAuthz();
  const { gated, log } = makeGatedTool(authz);

  const cases = [
    { amount: 100, toAccount: 'acct_X' },
    { amount: 999, toAccount: 'acct Y with spaces' },
    { amount: 500, toAccount: 'acct_$pecial-chars' },
  ];
  for (const args of cases) {
    log.invoked = false; log.received = null; log.calls = 0;
    await gated.execute(args);
    assert.equal(log.invoked, true, `handler must execute for ${JSON.stringify(args)}`);
    assert.deepEqual(log.received, args,
      `INVARIANT: handler receives the EXACT args authorized. Observed ${JSON.stringify(log.received)}, expected ${JSON.stringify(args)}.`);
  }
});

// ─── Section D — regression trip-wire ────────────────────────────────────────
//
// Verifies the critical two-component fix is load-bearing. Removing the
// amount function hook from toolConfig should cause policy to devolve to
// "always allow" (every amount matches amount_max=1000 because default amount=0).

test('[regression-trip-wire] without the amount function hook, amount=50000 would silently execute', async () => {
  // DELIBERATELY misconfigured authz — no toolConfig.transfer_funds.amount hook.
  const brokenAuthz = createAiyoMcpAuthz({
    rdp: createLocalRdp({ policy: DEFAULT_POLICY }),
    toolConfig: {
      transfer_funds: {
        aiyo_gated: true,
        action: { type: 'payment' },
        // NO amount: (args) => args.amount
      },
    },
  });

  const { gated, log } = makeGatedTool(brokenAuthz);

  // Under the broken config: default amount=0 matches amount_max=1000 → first rule
  // allows every call. amount=50000 should ALLOW the handler to run (which is the
  // defect — the policy's author intended BLOCK). The trip-wire asserts this
  // historical failure mode so a regression that re-introduces it is caught.
  await gated.execute({ amount: 50000, toAccount: 'adversary' });

  assert.equal(log.invoked, true,
    'TRIP-WIRE: without the amount hook, the handler SHOULD run (incorrectly) on amount=50000. If this starts failing — if the handler does NOT run under this broken config — then mcp-authz has changed its default amount handling and this trip-wire needs re-examination.');
});

// ─── Section E — default behavior when policy is wide open ──────────────────

test('[baseline] default_effect: allow + no rules → every amount allowed (sanity for policy framework)', async () => {
  const openPolicy = { default_effect: 'allow', rules: [] };
  const authz = makeAuthz(openPolicy);
  const { gated, log } = makeGatedTool(authz);

  await gated.execute({ amount: 999999, toAccount: 'anywhere' });
  assert.equal(log.invoked, true, 'default_effect: allow with no rules must permit any amount');
});
