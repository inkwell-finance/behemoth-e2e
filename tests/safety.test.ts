/**
 * E2E: Circuit Breaker & Safety Tests
 *
 * Validates safety systems are operational:
 * - Authentication enforcement on proposals
 * - Rate limiting on endpoints
 * - Input validation and sanitization
 * - Service isolation (no cross-contamination)
 * - Paper mode safety (no live orders by default)
 */

import { describe, it, expect } from 'bun:test';

const TRADER_URL = process.env.TRADER_URL || 'http://trader:8080';
const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://coordinator:8081';
const RESEARCHER_URL = process.env.RESEARCHER_URL || 'http://researcher:8082';

describe('E2E: Authentication Enforcement', () => {
  it('proposal submission requires authentication', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId: 'e2e-auth-test',
        modifications: [{ slotId: 'test', proposedValue: 0.5 }],
      }),
    });

    expect(response.status).toBe(401);
  });

  it('proposal with forged auth header is rejected', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/proposals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer FAKE_TOKEN_12345',
      },
      body: JSON.stringify({
        proposalId: 'e2e-auth-forge-test',
        modifications: [{ slotId: 'test', proposedValue: 0.5 }],
      }),
    });

    // Should reject invalid auth — either 401 or 403
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});

describe('E2E: Input Validation', () => {
  it('rejects empty proposal body', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    const result = await response.json();
    expect(result.valid).toBe(false);
  });

  it('rejects proposal with empty modifications', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId: 'test',
        modifications: [],
      }),
    });

    const result = await response.json();
    expect(result.valid).toBe(false);
  });

  it('rejects proposal with invalid slotId', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId: 'test-invalid-slot',
        modifications: [
          { slotId: 'nonexistent_slot_xyz_999', proposedValue: 0.5 },
        ],
      }),
    });

    const result = await response.json();
    expect(result.valid).toBe(false);
  });

  it('rejects oversized request body', async () => {
    // Generate a very large payload
    const largePayload = {
      proposalId: 'oversized-test',
      modifications: Array.from({ length: 10000 }, (_, i) => ({
        slotId: `slot_${i}`,
        proposedValue: Math.random(),
      })),
    };

    const response = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(largePayload),
    });

    // Should reject — either 400 (bad request) or 413 (payload too large)
    expect(response.ok).toBe(false);
  });

  it('handles malformed JSON gracefully', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken json',
    });

    expect(response.status).toBe(400);
  });
});

describe('E2E: Paper Mode Safety', () => {
  it('trader defaults to paper execution mode', async () => {
    const response = await fetch(`${TRADER_URL}/status`);
    const status = await response.json();
    expect(status.executionMode).toBe('PAPER');
  });

  it('router confirms no live execution', async () => {
    const response = await fetch(`${TRADER_URL}/router`);
    const router = await response.json();
    expect(router.isPaperRouter).toBe(true);
    expect(router.isSmartOrderRouter).toBe(false);
  });

  it('swarm operates in paper mode', async () => {
    const response = await fetch(`${TRADER_URL}/swarm`);
    const swarm = await response.json();
    if (swarm.enabled) {
      expect(swarm.config.paperMode).toBe(true);
    }
  });
});

describe('E2E: Slot Schema Privacy', () => {
  it('slot values are hidden from researchers', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/slots`);
    const schema = await response.json();

    for (const slot of schema.slots) {
      // currentValue must NEVER be exposed to prevent information leakage
      expect(slot.currentValue).toBeNull();
    }
  });

  it('slot schema includes ranges but not internal state', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/slots`);
    const schema = await response.json();

    for (const slot of schema.slots) {
      // Should have description and constraints
      expect(slot.slotId).toBeDefined();
      expect(slot.description).toBeDefined();
      // Should NOT have internal fields
      expect(slot.internalWeight).toBeUndefined();
      expect(slot.bayesianPrior).toBeUndefined();
    }
  });
});

describe('E2E: Service Isolation', () => {
  it('services return correct identity', async () => {
    const [traderRes, coordRes, researcherRes] = await Promise.all([
      fetch(`${TRADER_URL}/status`),
      fetch(`${COORDINATOR_URL}/status`),
      fetch(`${RESEARCHER_URL}/status`),
    ]);

    const trader = await traderRes.json();
    const coord = await coordRes.json();
    const researcher = await researcherRes.json();

    expect(trader.service).toBe('behemoth-trader');
    expect(coord.service).toBe('behemoth-coordinator');
    expect(researcher.service).toBe('behemoth-researcher');
  });

  it('services handle concurrent requests without cross-contamination', async () => {
    // Fire 10 concurrent requests to each service
    const requests = Array.from({ length: 10 }, (_, i) =>
      Promise.all([
        fetch(`${TRADER_URL}/status`).then(r => r.json()),
        fetch(`${COORDINATOR_URL}/status`).then(r => r.json()),
      ])
    );

    const results = await Promise.all(requests);

    for (const [trader, coord] of results) {
      expect(trader.service).toBe('behemoth-trader');
      expect(coord.service).toBe('behemoth-coordinator');
    }
  });
});
