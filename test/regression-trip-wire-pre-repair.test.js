// NEGATIVE-CONTROL test for the pre-1.0.1 broken example configuration.
//
// PURPOSE
// -------
// This file documents the historical failure modes of the example shipped in
// the GitHub repository before 1.0.1. It is NOT a specification of desired
// current behavior. Reading this test as "we want the handler to run on
// amount=50000" is a misreading — the test asserts the handler DID run under
// the historical broken config, which is precisely why that config was unsafe.
//
// A reader modifying this test should ask: "am I preserving the documentation
// of an historical defect, or am I changing current behavior?" If current
// behavior, you are in the wrong file; the current-behavior conformance tests
// live in test/policy-matching.test.js (ALLOW/DENY/ESCALATE for the repaired
// configuration) and test/pattern-41-ordering.test.js (Pattern 41 ordering
// invariant).
//
// SAFETY CLAIM
// ------------
// The execute function used throughout this file is a PURE MOCK. It:
//   - sets a boolean flag on an in-memory object
//   - records the arguments it was called with on an in-memory object
//   - returns a FORMATTED STRING describing what a real handler WOULD have done
//
// It does NOT:
//   - call fs.*, child_process.*, net/http/https.*
//   - import or require any of the above modules
//
// DEPENDENCY ASSUMPTIONS
// ----------------------
// Depends on observable behavior of @aiyoplane/mcp-authz at version 1.1.0:
//   - mcp-authz reads `toolDef.aiyo_gated` (snake_case). The camelCase form
//     `aiyoGated` is NOT read and therefore evaluates to falsy, causing
//     mcp-authz to treat the tool as UNGATED (the RDP is not consulted).
//   - mcp-authz's default intent builder sets `amount: 0` when `toolDef.amount`
//     is absent. amount=0 matches rule.amount_max=1000, so the first "allow"
//     rule matches on every call, regardless of the actual transfer amount.
//
// Pinning: package.json pins @aiyoplane/mcp-authz: ^1.0.0. Behavior documented
// here was observed against 1.0.0 and 1.1.0. If adopters install a later
// major version that behaves differently, this test's job is to fail loudly
// so the discrepancy is caught before shipping.
//
// Run: node --test test/regression-trip-wire-pre-repair.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAiyoMcpAuthz, createLocalRdp } from '@aiyoplane/mcp-authz';

import { wrapTool } from '../src/index.js';

function makeMockTool() {
  const log = { invoked: false, received: null, calls: 0 };
  const tool = {
    name: 'transfer_funds',
    description: 'Transfer funds between accounts.',
    execute: async (args) => {
      log.invoked = true;
      log.received = args;
      log.calls += 1;
      return `[MOCK; NOT A REAL TRANSFER] execute was called with amount=${args.amount}, toAccount=${args.toAccount}`;
    },
  };
  return { tool, log };
}

// The pre-1.0.1 broken example configuration, reproduced verbatim.
const PRE_REPAIR_BROKEN_POLICY = {
  rules: [
    { action_type: 'payment', amount_max: 1000,  effect: 'allow' },
    { action_type: 'payment', amount_max: 10000, effect: 'escalate' },
    { action_type: 'payment',                      effect: 'block' },
  ],
};

function makePreRepairBrokenAuthz() {
  return createAiyoMcpAuthz({
    rdp: createLocalRdp({ policy: PRE_REPAIR_BROKEN_POLICY }),
    toolConfig: {
      // camelCase gating flag — the historical defect
      transfer_funds: { aiyoGated: true, action: { type: 'payment' } },
    },
  });
}

// ─── Historical failure mode 1 (gate not engaged): any amount reaches handler ─

test('[negative-control] pre-1.0.1 broken config: $50,000 transfer reaches the mock handler', async () => {
  const authz = makePreRepairBrokenAuthz();
  const { tool, log } = makeMockTool();

  const gated = wrapTool(tool, {
    authz,
    intentBuilder: (args) => ({ type: 'payment', amount: args.amount }),
  });

  const result = await gated.execute({ amount: 50000, toAccount: 'adversary' }, null);

  assert.equal(log.invoked, true,
    'NEGATIVE CONTROL: under the pre-1.0.1 camelCase aiyoGated config, mcp-authz did not read the gating flag and execute was invoked. If this flipped to false, mcp-authz has changed its gating-flag read behavior; re-audit before updating.');
  assert.equal(log.calls, 1);
  assert.deepEqual(log.received, { amount: 50000, toAccount: 'adversary' });
  assert.match(result, /\[MOCK; NOT A REAL TRANSFER\]/,
    'SAFETY: the mock explicitly identifies itself; no actual funds transfer occurred.');
});

test('[negative-control] pre-1.0.1 broken config: $5,000 transfer also reaches the handler (no escalation)', async () => {
  const authz = makePreRepairBrokenAuthz();
  const { tool, log } = makeMockTool();

  const gated = wrapTool(tool, {
    authz,
    intentBuilder: (args) => ({ type: 'payment', amount: args.amount }),
  });

  await gated.execute({ amount: 5000, toAccount: 'acct_B' }, null);

  assert.equal(log.invoked, true,
    'NEGATIVE CONTROL: the broken config did not escalate; execute ran. This is the failure mode the 1.0.1 repair closes.');
});

// ─── Historical failure mode 2 (always allow via missing amount hook) ─────

test('[negative-control] partial-repair state (flag only, no amount hook): $50,000 silently allowed', async () => {
  // Simulates a partial remediation where the application corrected the flag
  // but did not add the amount function hook. Default amount=0 matches
  // amount_max=1000, so the first ALLOW rule matches every call.
  const partialAuthz = createAiyoMcpAuthz({
    rdp: createLocalRdp({
      policy: {
        default_effect: 'deny',
        rules: [
          { match: { action_type: 'payment' }, amount_max: 1000,  effect: 'allow' },
          { match: { action_type: 'payment' }, amount_max: 10000, effect: 'escalate' },
          { match: { action_type: 'payment' },                      effect: 'deny' },
        ],
      },
    }),
    toolConfig: {
      transfer_funds: { aiyo_gated: true, action: { type: 'payment' } /* NO amount hook */ },
    },
  });

  const { tool, log } = makeMockTool();
  const gated = wrapTool(tool, {
    authz: partialAuthz,
    intentBuilder: (args) => ({ type: 'payment', amount: args.amount }),
  });

  await gated.execute({ amount: 50000, toAccount: 'adversary' }, null);

  assert.equal(log.invoked, true,
    'NEGATIVE CONTROL: the partial-repair state (flag fixed, amount hook absent) silently allows all calls because default amount=0 matches amount_max=1000. This documents why the amount hook is load-bearing.');
});

// ─── Contrast assertion: the FULLY repaired config does the right thing ──

test('[contrast] fully repaired config: $50,000 transfer is rejected and execute does NOT run', async () => {
  const repairedAuthz = createAiyoMcpAuthz({
    rdp: createLocalRdp({
      policy: {
        default_effect: 'deny',
        rules: [
          { match: { action_type: 'payment' }, amount_max: 1000,  effect: 'allow' },
          { match: { action_type: 'payment' }, amount_max: 10000, effect: 'escalate' },
          { match: { action_type: 'payment' },                      effect: 'deny' },
        ],
      },
    }),
    toolConfig: {
      transfer_funds: {
        aiyo_gated: true,
        action: { type: 'payment' },
        amount: (args) => args.amount,
      },
    },
  });

  const { tool, log } = makeMockTool();
  const gated = wrapTool(tool, {
    authz: repairedAuthz,
    intentBuilder: (args) => ({ type: 'payment', amount: args.amount }),
  });

  await assert.rejects(
    gated.execute({ amount: 50000, toAccount: 'adversary' }, null),
    (err) => err && (err.name === 'BlockedByPolicy' || err.name === 'EscalationRequired'),
    'repaired config must reject $50,000 transfer'
  );

  assert.equal(log.invoked, false,
    'RELEASE GUARD: under the fully repaired config, execute MUST NOT run for amount=50000. If this flips to true, the repair has regressed.');
});
