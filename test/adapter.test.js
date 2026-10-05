import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAiyoMcpAuthz, createLocalRdp } from '@aiyoplane/mcp-authz';

import {
  AdapterConfigError,
  BlockedByPolicy,
  EscalationRequired,
  wrapExecute,
  wrapTool,
} from '../src/index.js';

function makeAuthz(rules) {
  return createAiyoMcpAuthz({
    rdp: createLocalRdp({ policy: { rules } }),
    toolConfig: { transfer: { aiyoGated: true, action: { type: 'payment' } } },
  });
}

function makeTool() {
  return {
    name: 'transfer',
    description: 'Transfer funds.',
    execute: async ({ amount, toAccount }) =>
      `Transferred $${amount} to ${toAccount}`,
  };
}

test('ALLOW runs the inner execute', async () => {
  const authz = makeAuthz([{ action_type: 'payment', effect: 'allow' }]);
  const gated = wrapTool(makeTool(), {
    authz,
    intentBuilder: (args) => ({ type: 'payment', amount: args.amount }),
  });
  const result = await gated.execute({ amount: 500, toAccount: 'acct_A' });
  assert.match(result, /Transferred \$500/);
});

test('BLOCK prevents execute', async () => {
  const authz = makeAuthz([{ action_type: 'payment', effect: 'block' }]);
  const gated = wrapTool(makeTool(), {
    authz,
    intentBuilder: (args) => ({ type: 'payment' }),
  });
  await assert.rejects(
    gated.execute({ amount: 500, toAccount: 'acct_A' }),
    (err) => err instanceof BlockedByPolicy
  );
});

test('ESCALATE raises EscalationRequired or BlockedByPolicy', async () => {
  const authz = makeAuthz([{ action_type: 'payment', effect: 'escalate' }]);
  const gated = wrapTool(makeTool(), {
    authz,
    intentBuilder: (args) => ({ type: 'payment' }),
  });
  await assert.rejects(
    gated.execute({ amount: 500, toAccount: 'acct_A' }),
    (err) => err instanceof EscalationRequired || err instanceof BlockedByPolicy
  );
});

test('Broken intentBuilder blocks', async () => {
  const authz = makeAuthz([{ action_type: 'payment', effect: 'allow' }]);
  const gated = wrapTool(makeTool(), {
    authz,
    intentBuilder: () => { throw new Error('broken'); },
  });
  await assert.rejects(
    gated.execute({ amount: 500, toAccount: 'acct_A' }),
    (err) => err instanceof BlockedByPolicy
  );
});

test('Non-object Intent blocks', async () => {
  const authz = makeAuthz([{ action_type: 'payment', effect: 'allow' }]);
  const gated = wrapTool(makeTool(), {
    authz,
    intentBuilder: () => 'not an object',
  });
  await assert.rejects(
    gated.execute({ amount: 500, toAccount: 'acct_A' }),
    (err) => err instanceof BlockedByPolicy
  );
});

test('Non-tool input raises AdapterConfigError', () => {
  const authz = makeAuthz([{ action_type: 'payment', effect: 'allow' }]);
  assert.throws(
    () => wrapTool(null, { authz, intentBuilder: () => ({ type: 'payment' }) }),
    (err) => err instanceof AdapterConfigError
  );
});

test('Tool without execute function raises AdapterConfigError', () => {
  const authz = makeAuthz([{ action_type: 'payment', effect: 'allow' }]);
  assert.throws(
    () => wrapTool({ name: 'bad' }, { authz, intentBuilder: () => ({ type: 'payment' }) }),
    (err) => err instanceof AdapterConfigError
  );
});

test('wrapExecute function form works', async () => {
  const authz = makeAuthz([{ action_type: 'payment', effect: 'allow' }]);
  const execute = wrapExecute(
    async ({ amount, toAccount }) => `Transferred $${amount}`,
    { authz, toolName: 'transfer', intentBuilder: (args) => ({ type: 'payment' }) }
  );
  const result = await execute({ amount: 500, toAccount: 'acct_A' });
  assert.match(result, /Transferred \$500/);
});
