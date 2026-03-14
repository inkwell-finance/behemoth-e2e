/**
 * E2E: Learning System Integration Tests
 *
 * Tests the learning and backtesting pipeline:
 * - Backtest engine accessibility via gRPC bridge
 * - Strategy evaluation pipeline
 * - Paper trade tracking
 * - Strategy promotion gates
 */

import { describe, it, expect } from 'bun:test';

const TRADER_URL = process.env.TRADER_URL || 'http://trader:8080';
const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://coordinator:8081';

describe('E2E: Backtest Pipeline', () => {
  it('trader exposes backtest capability via gRPC', async () => {
    // The coordinator's gRPC health endpoint confirms backtest methods are available
    const response = await fetch(`${COORDINATOR_URL}/api/grpc/health`);
    expect(response.ok).toBe(true);
    const data = await response.json();

    // gRPC service must be connected and healthy for backtests to work
    expect(data.grpcConnected).toBe(true);
    expect(data.trader.healthy).toBe(true);
  });

  it('swarm tracks strategy evaluation state', async () => {
    const response = await fetch(`${TRADER_URL}/swarm`);
    expect(response.ok).toBe(true);
    const swarm = await response.json();

    if (swarm.enabled) {
      // Worker pool manages backtest job execution
      expect(swarm.workerPool).toBeDefined();
      expect(swarm.workerPool.activeJobs).toBeGreaterThanOrEqual(0);
      expect(swarm.workerPool.queuedJobs).toBeGreaterThanOrEqual(0);

      // Strategy stages reflect the promotion pipeline
      const stages = swarm.strategies.byStage;
      const total = stages.research + stages.paper + stages.live + stages.deprecated;
      expect(total).toBe(swarm.strategies.total);
    }
  });
});

describe('E2E: Slot-Based Parameter Learning', () => {
  it('slot schema exposes learnable parameters', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/slots`);
    expect(response.ok).toBe(true);
    const schema = await response.json();

    expect(schema.slots.length).toBeGreaterThan(0);

    // Each slot must have learning-relevant metadata
    for (const slot of schema.slots) {
      expect(slot.slotId).toBeDefined();
      expect(slot.description).toBeDefined();
      expect(slot.type).toBeDefined();
      // Range defines the parameter search space
      if (slot.type === 'number') {
        expect(slot.range).toBeDefined();
        expect(typeof slot.range.min).toBe('number');
        expect(typeof slot.range.max).toBe('number');
        expect(slot.range.max).toBeGreaterThan(slot.range.min);
      }
    }
  });

  it('proposals with valid slot modifications pass validation', async () => {
    // First get the slot schema to know valid slotIds
    const schemaRes = await fetch(`${COORDINATOR_URL}/api/slots`);
    const schema = await schemaRes.json();

    if (schema.slots.length === 0) return; // Skip if no slots configured

    const slot = schema.slots[0];
    const validValue = slot.type === 'number'
      ? (slot.range.min + slot.range.max) / 2
      : slot.range?.min ?? 0.5;

    const proposal = {
      proposalId: `e2e-learning-test-${Date.now()}`,
      modifications: [
        { slotId: slot.slotId, proposedValue: validValue },
      ],
    };

    const response = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    const result = await response.json();
    expect(result.valid).toBe(true);
  });

  it('proposals with out-of-range values fail validation', async () => {
    const schemaRes = await fetch(`${COORDINATOR_URL}/api/slots`);
    const schema = await schemaRes.json();

    if (schema.slots.length === 0) return;

    const slot = schema.slots[0];
    // Use a value far outside the valid range
    const invalidValue = slot.type === 'number'
      ? slot.range.max * 1000
      : 'INVALID_VALUE';

    const proposal = {
      proposalId: `e2e-learning-invalid-${Date.now()}`,
      modifications: [
        { slotId: slot.slotId, proposedValue: invalidValue },
      ],
    };

    const response = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    const result = await response.json();
    expect(result.valid).toBe(false);
  });
});
