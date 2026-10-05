/**
 * @aiyoplane/openai-agents (Node)
 *
 * AEAP Composition Boundary Adapter for the OpenAI Agents SDK.
 *
 * Wraps the `execute` function of an Agents SDK `tool()` definition so the
 * AEAP Runtime Decision Point evaluates an Intent before the tool runs.
 *
 * Aiyoplane, Inc. — Apache 2.0 licensed.
 * https://aiyoplane.com
 *
 * Specification: https://github.com/aiyoplane/aeap
 */

import {
  AdapterConfigError,
  AiyoOpenAIAgentsError,
  BlockedByPolicy,
  EscalationRequired,
} from './errors.js';

export { AdapterConfigError, AiyoOpenAIAgentsError, BlockedByPolicy, EscalationRequired };

/**
 * Wrap an Agents SDK tool definition with an AEAP Composition Boundary.
 *
 * The Agents SDK's `tool()` factory takes `{ name, description, parameters, execute }`.
 * This adapter wraps `execute` so AEAP evaluation happens before the original
 * execute function runs.
 *
 * @param {object} toolDef - Tool definition object with at least `name` and `execute`.
 * @param {object} options
 * @param {object} options.authz - AiyoAuthz from @aiyoplane/mcp-authz
 * @param {function} options.intentBuilder - (toolArgs) => Intent payload (object)
 * @param {string} [options.toolNameForAuthz] - Override for authz.toolConfig key
 * @param {boolean} [options.returnReceipt=false] - If true, result on ALLOW is {result, aeapReceipt}
 * @returns {object} A new tool definition with the gated execute
 */
export function wrapTool(toolDef, { authz, intentBuilder, toolNameForAuthz, returnReceipt = false } = {}) {
  if (!toolDef || typeof toolDef.name !== 'string') {
    throw new AdapterConfigError(
      `wrapTool expected an Agents SDK tool definition object, got ${typeof toolDef}`
    );
  }
  const execute = toolDef.execute;
  if (typeof execute !== 'function') {
    throw new AdapterConfigError(
      `wrapTool expected tool.execute to be a function, got ${typeof execute}`
    );
  }
  if (typeof intentBuilder !== 'function') {
    throw new AdapterConfigError(
      'wrapTool requires an intentBuilder function; the adapter must fail closed.'
    );
  }

  const resolvedName = toolNameForAuthz || toolDef.name;

  return {
    ...toolDef,
    execute: async (toolArgs, runContext) => {
      const intent = _buildIntent(intentBuilder, toolArgs, toolDef.name);
      const ctx = await _evaluateRdp(authz, resolvedName, intent, toolDef.name);
      const result = await execute(toolArgs, runContext);
      if (returnReceipt) {
        return { result, aeapReceipt: ctx?.receipt ?? null };
      }
      return result;
    },
  };
}

/**
 * Convenience: wrap a plain function with an AEAP gate and return a function
 * suitable for use as a `tool.execute` body.
 */
export function wrapExecute(execute, { authz, toolName, intentBuilder, returnReceipt = false } = {}) {
  if (typeof execute !== 'function') {
    throw new AdapterConfigError('wrapExecute requires a callable execute');
  }
  if (typeof intentBuilder !== 'function') {
    throw new AdapterConfigError('wrapExecute requires an intentBuilder function');
  }
  if (typeof toolName !== 'string' || !toolName) {
    throw new AdapterConfigError('wrapExecute requires a non-empty toolName');
  }
  return async (toolArgs, runContext) => {
    const intent = _buildIntent(intentBuilder, toolArgs, toolName);
    const ctx = await _evaluateRdp(authz, toolName, intent, toolName);
    const result = await execute(toolArgs, runContext);
    if (returnReceipt) {
      return { result, aeapReceipt: ctx?.receipt ?? null };
    }
    return result;
  };
}

// --- Internals -------------------------------------------------------------

function _buildIntent(builder, toolArgs, toolName) {
  let intent;
  try {
    intent = builder(toolArgs);
  } catch (err) {
    throw new BlockedByPolicy(
      `intentBuilder for tool '${toolName}' raised: ${err?.message || err}`,
      { reasonCode: 'INTENT_BUILD_FAILED' }
    );
  }
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new BlockedByPolicy(
      `intentBuilder for tool '${toolName}' did not return a plain object`,
      { reasonCode: 'INTENT_SHAPE_INVALID' }
    );
  }
  return intent;
}

async function _evaluateRdp(authz, toolNameForAuthz, intent, toolDisplayName) {
  if (!authz || typeof authz.wrap !== 'function') {
    throw new AdapterConfigError(
      `received an invalid authz (missing .wrap); the adapter must fail closed`
    );
  }

  let wrapped;
  try {
    const passthrough = async (_args, ctx) => ctx;
    wrapped = authz.wrap(toolNameForAuthz, passthrough);
  } catch (err) {
    throw new BlockedByPolicy(
      `authz.wrap('${toolNameForAuthz}') failed: ${err?.message || err}`,
      { reasonCode: err?.name || 'AUTHZ_WRAP_FAILED' }
    );
  }

  try {
    return await wrapped(intent, null);
  } catch (err) {
    const msg = err?.message || String(err);
    if (/escalat/i.test(msg) || /ESCALATE/.test(msg)) {
      throw new EscalationRequired(
        `AEAP ESCALATE verdict for tool '${toolDisplayName}' (intent=${JSON.stringify(intent)}): ${msg}`,
        { extra: { innerException: err?.name, intent } }
      );
    }
    throw new BlockedByPolicy(
      `AEAP non-ALLOW verdict for tool '${toolDisplayName}' (intent=${JSON.stringify(intent)}): ${msg}`,
      { reasonCode: err?.name || 'RDP_NON_ALLOW', extra: { innerException: err?.name, intent } }
    );
  }
}
