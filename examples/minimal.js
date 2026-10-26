/**
 * Minimal example of @aiyoplane/openai-agents.
 * Simulates an Agents SDK tool call that moves money.
 *
 * Run: node examples/minimal.js
 *
 * The example demonstrates the full composition pattern against mcp-authz's
 * policy matcher for AMOUNT-based discrimination:
 *
 *   1. The adapter-level `intentBuilder` (passed to `wrapTool`) returns the
 *      raw per-call payload the adapter needs.
 *
 *   2. `toolConfig.<tool>.amount` is a function `(args) => <number>`. This
 *      function hook is REQUIRED for amount-based policy discrimination —
 *      without it, mcp-authz's default intent builder sets `amount: 0` for
 *      every call and the lowest-threshold `amount_max` rule matches every
 *      call, which silently devolves the policy to "always allow."
 *
 *   3. Policy rules use canonical `match.action_type` and canonical effects
 *      `'allow' | 'escalate' | 'deny'`. `rule.amount_max` is read at the
 *      rule top level by mcp-authz's matcher.
 *
 *   4. `default_effect: 'deny'` is explicit as defense-in-depth. The matcher
 *      defaults to deny when no rule matches, but stating it in the policy
 *      is a maintenance aid.
 */

import { createAiyoMcpAuthz, createLocalRdp } from '@aiyoplane/mcp-authz';
import {
  BlockedByPolicy,
  EscalationRequired,
  wrapTool,
} from '../src/index.js';

const transferTool = {
  name: 'transfer_funds',
  description: 'Transfer funds between accounts.',
  execute: async ({ amount, toAccount }) =>
    `Transferred $${amount} to ${toAccount}`,
};

const policy = {
  default_effect: 'deny',
  rules: [
    { match: { action_type: 'payment' }, amount_max: 1000,  effect: 'allow' },
    { match: { action_type: 'payment' }, amount_max: 10000, effect: 'escalate' },
    { match: { action_type: 'payment' },                      effect: 'deny' },
  ],
};

const authz = createAiyoMcpAuthz({
  rdp: createLocalRdp({ policy }),
  toolConfig: {
    transfer_funds: {
      aiyo_gated: true,                   // snake_case — required by mcp-authz
      action: { type: 'payment' },
      amount: (args) => args.amount,       // function hook — required for amount discrimination
    },
  },
});

const guardedTransfer = wrapTool(transferTool, {
  authz,
  intentBuilder: (args) => ({
    type: 'payment',
    amount: args.amount,
    target: args.toAccount,
  }),
});

async function main() {
  console.log('ALLOW case ($500):');
  console.log('  ', await guardedTransfer.execute({ amount: 500, toAccount: 'acct_A' }));

  console.log('\nESCALATE case ($5,000):');
  try {
    await guardedTransfer.execute({ amount: 5000, toAccount: 'acct_B' });
  } catch (err) {
    if (err instanceof EscalationRequired) console.log('  Held:', err.message);
    else throw err;
  }

  console.log('\nDENY case ($50,000):');
  try {
    await guardedTransfer.execute({ amount: 50000, toAccount: 'acct_C' });
  } catch (err) {
    if (err instanceof BlockedByPolicy) console.log('  Blocked:', err.message);
    else throw err;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
