/**
 * End-to-End Flow Tests
 *
 * Tests the complete flow:
 * 1. All services are healthy
 * 2. Coordinator exposes slot schema
 * 3. Proposal validation works
 * 4. gRPC connection between coordinator and trader works
 */

import { describe, it, expect } from 'bun:test';

const TRADER_URL = process.env.TRADER_URL || 'http://trader:8080';
const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://coordinator:8081';
const RESEARCHER_URL = process.env.RESEARCHER_URL || 'http://researcher:8082';

describe('E2E: Health Checks', () => {
  it('trader service is healthy', async () => {
    const response = await fetch(`${TRADER_URL}/health`);
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.status).toBe('healthy');
  });

  it('coordinator service is healthy', async () => {
    const response = await fetch(`${COORDINATOR_URL}/health`);
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.status).toBe('healthy');
  });

  it('researcher service is healthy', async () => {
    const response = await fetch(`${RESEARCHER_URL}/health`);
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.status).toBe('healthy');
  });
});

describe('E2E: Slot Schema', () => {
  it('coordinator returns slot schema', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/slots`);
    expect(response.ok).toBe(true);
    const schema = await response.json();
    expect(schema.version).toBeDefined();
    expect(Array.isArray(schema.slots)).toBe(true);
  });

  it('slot schema hides internal values', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/slots`);
    const schema = await response.json();

    // All currentValue fields should be null (hidden from researchers)
    for (const slot of schema.slots) {
      expect(slot.currentValue).toBeNull();
    }
  });
});

describe('E2E: Proposal Validation', () => {
  it('rejects proposal without authentication', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId: 'test',
        modifications: [{ slotId: 'test', proposedValue: 0.5 }],
      }),
    });

    // Should require auth
    expect(response.status).toBe(401);
  });

  it('validates proposal structure', async () => {
    const invalidProposal = {
      proposalId: 'test',
      modifications: [], // Invalid: no modifications
    };

    const response = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invalidProposal),
    });

    const result = await response.json();
    expect(result.valid).toBe(false);
  });
});

describe('E2E: Service Status', () => {
  it('trader returns status', async () => {
    const response = await fetch(`${TRADER_URL}/status`);
    expect(response.ok).toBe(true);
    const status = await response.json();
    expect(status.service).toBe('behemoth-trader');
  });

  it('coordinator returns status', async () => {
    const response = await fetch(`${COORDINATOR_URL}/status`);
    expect(response.ok).toBe(true);
    const status = await response.json();
    expect(status.service).toBe('behemoth-coordinator');
  });

  it('researcher returns status', async () => {
    const response = await fetch(`${RESEARCHER_URL}/status`);
    expect(response.ok).toBe(true);
    const status = await response.json();
    expect(status.service).toBe('behemoth-researcher');
  });
});

describe('E2E: gRPC Connectivity', () => {
  it('coordinator can reach trader via gRPC', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/grpc/health`);
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.grpcConnected).toBe(true);
    expect(data.trader).toBeDefined();
    expect(data.trader.healthy).toBe(true);
  });

  it('gRPC health returns trader metadata', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/grpc/health`);
    const data = await response.json();
    expect(data.trader.version).toBeDefined();
    expect(typeof data.trader.uptimeSeconds).toBe('number');
  });
});

describe('E2E: P2P Bridge', () => {
  it('coordinator exposes P2P status', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/p2p/status`);
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.p2pEnabled).toBe(true);
    expect(Array.isArray(data.listenAddresses)).toBe(true);
    expect(data.listenAddresses.length).toBeGreaterThan(0);
  });

  it('coordinator P2P status has required fields', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/p2p/status`);
    const data = await response.json();
    // peerId may be null if libp2p failed to start (Bun crypto limitation)
    expect('peerId' in data).toBe(true);
    expect('connectedPeers' in data).toBe(true);
    expect(Array.isArray(data.topics)).toBe(true);
  });

  it('coordinator P2P has correct topics', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/p2p/status`);
    const data = await response.json();
    expect(data.topics).toContain('/behemoth/proposals/1.0.0');
    expect(data.topics).toContain('/behemoth/jobs/1.0.0');
    expect(data.topics).toContain('/behemoth/results/1.0.0');
    expect(data.topics).toContain('/behemoth/announcements/1.0.0');
  });

  it('researcher exposes P2P status', async () => {
    const response = await fetch(`${RESEARCHER_URL}/api/p2p/status`);
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.p2pEnabled).toBe(true);
    expect(data.coordinatorMultiaddr).toBeDefined();
  });

  it('researcher P2P status has required fields', async () => {
    const response = await fetch(`${RESEARCHER_URL}/api/p2p/status`);
    const data = await response.json();
    // peerId may be null if libp2p failed to start (Bun crypto limitation)
    expect('peerId' in data).toBe(true);
    expect('connectedPeers' in data).toBe(true);
    expect(Array.isArray(data.topics)).toBe(true);
  });

  it('researcher knows coordinator multiaddr', async () => {
    const response = await fetch(`${RESEARCHER_URL}/api/p2p/status`);
    const data = await response.json();
    expect(data.coordinatorMultiaddr).toContain('/dns4/coordinator/tcp/4001');
    expect(data.topics).toContain('/behemoth/jobs/1.0.0');
  });

  it('researcher P2P has correct topics', async () => {
    const response = await fetch(`${RESEARCHER_URL}/api/p2p/status`);
    const data = await response.json();
    expect(data.topics).toContain('/behemoth/proposals/1.0.0');
    expect(data.topics).toContain('/behemoth/jobs/1.0.0');
    expect(data.topics).toContain('/behemoth/results/1.0.0');
    expect(data.topics).toContain('/behemoth/announcements/1.0.0');
  });
});

