/**
 * Minimal example of @aiyoplane/openai-agents.
 * Runs the AEAP gate without a full OpenAI API call.
 *
 * Run: node examples/minimal.js
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
  rules: [
    { action_type: 'payment', amount_max: 1000, effect: 'allow' },
    { action_type: 'payment', amount_max: 10000, effect: 'escalate' },
    { action_type: 'payment', effect: 'block' },
  ],
};

const authz = createAiyoMcpAuthz({
  rdp: createLocalRdp({ policy }),
  toolConfig: {
    transfer_funds: { aiyoGated: true, action: { type: 'payment' } },
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

  console.log('\nBLOCK case ($50,000):');
  try {
    await guardedTransfer.execute({ amount: 50000, toAccount: 'acct_C' });
  } catch (err) {
    if (err instanceof BlockedByPolicy) console.log('  Blocked:', err.message);
    else throw err;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
