/** Typed errors raised by the AEAP Composition Boundary Adapter for the OpenAI Agents SDK. */

export class AiyoOpenAIAgentsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AiyoOpenAIAgentsError';
  }
}

export class AdapterConfigError extends AiyoOpenAIAgentsError {
  constructor(message) {
    super(message);
    this.name = 'AdapterConfigError';
  }
}

export class BlockedByPolicy extends AiyoOpenAIAgentsError {
  constructor(message, { reasonCode, intentId, extra } = {}) {
    super(message);
    this.name = 'BlockedByPolicy';
    this.reasonCode = reasonCode;
    this.intentId = intentId;
    this.extra = extra || {};
  }
}

export class EscalationRequired extends AiyoOpenAIAgentsError {
  constructor(message, { escalationId, intentId, extra } = {}) {
    super(message);
    this.name = 'EscalationRequired';
    this.escalationId = escalationId;
    this.intentId = intentId;
    this.extra = extra || {};
  }
}
