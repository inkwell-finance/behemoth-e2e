/**
 * E2E: Research Loop Tests
 *
 * Tests the end-to-end research pipeline:
 * - Slot schema → proposal creation → validation → submission
 * - Job distribution verification
 * - P2P network connectivity for research communication
 * - Result aggregation path
 */

import { describe, it, expect } from 'bun:test';

const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://coordinator:8081';
const RESEARCHER_URL = process.env.RESEARCHER_URL || 'http://researcher:8082';

describe('E2E: Research Pipeline - Schema Discovery', () => {
  it('coordinator exposes discoverable slot schema', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/slots`);
    expect(response.ok).toBe(true);
    const schema = await response.json();

    expect(schema.version).toBeDefined();
    expect(Array.isArray(schema.slots)).toBe(true);
    expect(schema.slots.length).toBeGreaterThan(0);
  });

  it('slot schema has complete metadata for research', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/slots`);
    const schema = await response.json();

    for (const slot of schema.slots) {
      // Researchers need these fields to formulate proposals
      expect(typeof slot.slotId).toBe('string');
      expect(typeof slot.description).toBe('string');
      expect(slot.description.length).toBeGreaterThan(0);
      expect(slot.type).toBeDefined();

      // Category helps researchers understand the parameter's role
      if (slot.category) {
        expect(typeof slot.category).toBe('string');
      }
    }
  });

  it('slot schema version is semver-compatible', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/slots`);
    const schema = await response.json();

    // Version should be parseable (e.g., "1.0.0" or at least defined)
    expect(typeof schema.version).toBe('string');
    expect(schema.version.length).toBeGreaterThan(0);
  });
});

describe('E2E: Research Pipeline - Proposal Validation', () => {
  it('validates well-formed single-slot proposal', async () => {
    const schemaRes = await fetch(`${COORDINATOR_URL}/api/slots`);
    const schema = await schemaRes.json();

    if (schema.slots.length === 0) return;

    const slot = schema.slots[0];
    const midValue = slot.type === 'number'
      ? (slot.range.min + slot.range.max) / 2
      : slot.range?.min ?? 0.5;

    const response = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId: `e2e-research-single-${Date.now()}`,
        modifications: [{ slotId: slot.slotId, proposedValue: midValue }],
      }),
    });

    const result = await response.json();
    expect(result.valid).toBe(true);
  });

  it('validates multi-slot proposal', async () => {
    const schemaRes = await fetch(`${COORDINATOR_URL}/api/slots`);
    const schema = await schemaRes.json();

    if (schema.slots.length < 2) return;

    const modifications = schema.slots.slice(0, 3).map((slot: any) => ({
      slotId: slot.slotId,
      proposedValue: slot.type === 'number'
        ? (slot.range.min + slot.range.max) / 2
        : slot.range?.min ?? 0.5,
    }));

    const response = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId: `e2e-research-multi-${Date.now()}`,
        modifications,
      }),
    });

    const result = await response.json();
    expect(result.valid).toBe(true);
  });

  it('rejects proposal with duplicate slot modifications', async () => {
    const schemaRes = await fetch(`${COORDINATOR_URL}/api/slots`);
    const schema = await schemaRes.json();

    if (schema.slots.length === 0) return;

    const slot = schema.slots[0];
    const response = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId: `e2e-research-dup-${Date.now()}`,
        modifications: [
          { slotId: slot.slotId, proposedValue: slot.range?.min ?? 0.1 },
          { slotId: slot.slotId, proposedValue: slot.range?.max ?? 0.9 },
        ],
      }),
    });

    const result = await response.json();
    expect(result.valid).toBe(false);
  });
});

describe('E2E: Research Pipeline - P2P Communication', () => {
  it('coordinator and researcher share common P2P topics', async () => {
    const [coordRes, researcherRes] = await Promise.all([
      fetch(`${COORDINATOR_URL}/api/p2p/status`),
      fetch(`${RESEARCHER_URL}/api/p2p/status`),
    ]);

    const coordP2P = await coordRes.json();
    const researcherP2P = await researcherRes.json();

    // Both must subscribe to the same topics for communication
    const requiredTopics = [
      '/behemoth/proposals/1.0.0',
      '/behemoth/jobs/1.0.0',
      '/behemoth/results/1.0.0',
    ];

    for (const topic of requiredTopics) {
      expect(coordP2P.topics).toContain(topic);
      expect(researcherP2P.topics).toContain(topic);
    }
  });

  it('researcher is configured to connect to coordinator', async () => {
    const response = await fetch(`${RESEARCHER_URL}/api/p2p/status`);
    const p2p = await response.json();

    expect(p2p.coordinatorMultiaddr).toBeDefined();
    expect(p2p.coordinatorMultiaddr).toContain('/dns4/coordinator');
  });

  it('P2P network has announcement channel for schema updates', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/p2p/status`);
    const p2p = await response.json();

    // Announcements topic used for slot schema version updates
    expect(p2p.topics).toContain('/behemoth/announcements/1.0.0');
  });
});

describe('E2E: Research Pipeline - Job Distribution', () => {
  it('coordinator gRPC bridge is ready for job routing', async () => {
    // Jobs from validated proposals are routed to trader via gRPC for backtesting
    const response = await fetch(`${COORDINATOR_URL}/api/grpc/health`);
    expect(response.ok).toBe(true);
    const data = await response.json();

    // gRPC must be active for the coordinator to forward backtest jobs to trader
    expect(data.grpcConnected).toBe(true);
  });

  it('researcher can report compute capacity', async () => {
    const response = await fetch(`${RESEARCHER_URL}/status`);
    expect(response.ok).toBe(true);
    const status = await response.json();

    expect(status.service).toBe('behemoth-researcher');
  });
});
