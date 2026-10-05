# @aiyoplane/openai-agents

**AEAP Composition Boundary Adapter for the OpenAI Agents SDK (Node).**

A thin wrapper that attaches the AEAP Runtime Decision Point (RDP) to the OpenAI Agents SDK's tool-invocation surface in JavaScript / TypeScript. Consequential tool executions produce independently verifiable Execution Receipts. The adapter composes with the Agents SDK's own guardrails, handoffs, and session machinery — it does not replace any of them.

```bash
npm install @aiyoplane/openai-agents
```

## Minimal usage

```javascript
import { Agent, tool } from '@openai/agents';
import { createAiyoMcpAuthz, createLocalRdp } from '@aiyoplane/mcp-authz';
import { wrapTool, BlockedByPolicy, EscalationRequired } from '@aiyoplane/openai-agents';

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

// Define the tool as you normally would.
const transferTool = tool({
  name: 'transfer_funds',
  description: 'Transfer funds between accounts.',
  parameters: { /* schema */ },
  execute: async ({ amount, toAccount }) => {
    return await actuallyTransfer(amount, toAccount);
  },
});

// Wrap it at its Composition Boundary.
const guardedTransfer = wrapTool(transferTool, {
  authz,
  intentBuilder: (args) => ({
    type: 'payment',
    amount: args.amount,
    target: args.toAccount,
  }),
});

// Register with your Agent the usual way.
const banker = new Agent({
  name: 'banker',
  instructions: 'Help the user manage their accounts.',
  tools: [guardedTransfer],
});
```

## Composition Boundary — what the adapter actually does

For each wrapped tool invocation:

1. **Intent construction.** `intentBuilder(toolArgs)` produces an AEAP Intent payload.
2. **RDP evaluation.** The Intent is passed to `@aiyoplane/mcp-authz`'s AiyoAuthz middleware.
3. **Verdict composition.**
   - **ALLOW** → `tool.execute` runs with original args; receipt available via `returnReceipt: true`.
   - **ESCALATE** → `EscalationRequired` is thrown.
   - **BLOCK** → `BlockedByPolicy` is thrown; the tool never executes.
4. **Fail-closed default** on every ambiguous condition.

## Composing with Agents SDK guardrails

Guardrails and AEAP are complementary. Guardrails run on input/output shape; AEAP runs on policy evaluation at the tool-invocation boundary.

```javascript
const banker = new Agent({
  name: 'banker',
  tools: [guardedTransfer],
  inputGuardrails: [validateShape],  // SDK-native input filter
  // AEAP already attached via wrapTool
});
```

## Convenience: wrap just the execute function

```javascript
import { wrapExecute } from '@aiyoplane/openai-agents';

const transferTool = tool({
  name: 'transfer_funds',
  description: 'Transfer funds between accounts.',
  parameters: { /* schema */ },
  execute: wrapExecute(
    async ({ amount, toAccount }) => actuallyTransfer(amount, toAccount),
    {
      authz,
      toolName: 'transfer_funds',
      intentBuilder: (args) => ({ type: 'payment', amount: args.amount }),
    }
  ),
});
```

## Local vs. hosted RDP

```javascript
// Development:
const authz = createAiyoMcpAuthz({ rdp: createLocalRdp({ policy }), toolConfig });

// Production:
const authz = createAiyoMcpAuthz({
  rdp: createHostedRdp({ apiKey: 'aiyo_live_...' }),
  toolConfig,
});
```

## API reference

### `wrapTool(toolDef, { authz, intentBuilder, toolNameForAuthz, returnReceipt })`

Wrap an Agents SDK tool definition. Returns a new tool definition.

### `wrapExecute(execute, { authz, toolName, intentBuilder, returnReceipt })`

Wrap just an `execute` function. Returns a function suitable for use as `tool.execute`.

### Exceptions

- `AiyoOpenAIAgentsError` — base class
- `AdapterConfigError` — adapter configuration is invalid
- `BlockedByPolicy` — RDP returned BLOCK
- `EscalationRequired` — RDP returned ESCALATE

## License

Apache License 2.0.

## Links

- **AEAP specification:** https://github.com/aiyoplane/aeap
- **Underlying implementation:** [`@aiyoplane/mcp-authz`](https://www.npmjs.com/package/@aiyoplane/mcp-authz)
- **Python sibling:** `aiyoplane-openai-agents` on PyPI
- **Trust surface:** https://aiyoplane.com/trust
- **Issues:** https://github.com/aiyoplane/openai-agents/issues

OpenAI and the OpenAI Agents SDK are trademarks of OpenAI, Inc. This package is an independent AEAP Composition Boundary Adapter and is not affiliated with or endorsed by OpenAI, Inc.

**Verify First. Execute Second.**
