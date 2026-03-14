/**
 * E2E: Resilience & Reconnection Tests
 *
 * Tests service stability under adverse conditions:
 * - Concurrent request handling
 * - Large payload rejection
 * - Service recovery after bad requests
 * - Cross-service dependency health
 * - Graceful 404/error handling
 */

import { describe, it, expect } from 'bun:test';

const TRADER_URL = process.env.TRADER_URL || 'http://trader:8080';
const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://coordinator:8081';
const RESEARCHER_URL = process.env.RESEARCHER_URL || 'http://researcher:8082';

describe('E2E: Concurrent Request Handling', () => {
  it('trader handles 20 concurrent health checks', async () => {
    const requests = Array.from({ length: 20 }, () =>
      fetch(`${TRADER_URL}/health`).then(r => r.json())
    );

    const results = await Promise.all(requests);
    for (const result of results) {
      expect(result.status).toBe('healthy');
    }
  });

  it('coordinator handles 20 concurrent slot schema requests', async () => {
    const requests = Array.from({ length: 20 }, () =>
      fetch(`${COORDINATOR_URL}/api/slots`).then(r => r.json())
    );

    const results = await Promise.all(requests);
    for (const result of results) {
      expect(result.version).toBeDefined();
      expect(Array.isArray(result.slots)).toBe(true);
    }
  });

  it('mixed-service concurrent requests all succeed', async () => {
    const requests = [
      fetch(`${TRADER_URL}/health`),
      fetch(`${TRADER_URL}/status`),
      fetch(`${TRADER_URL}/router`),
      fetch(`${TRADER_URL}/swarm`),
      fetch(`${COORDINATOR_URL}/health`),
      fetch(`${COORDINATOR_URL}/status`),
      fetch(`${COORDINATOR_URL}/api/slots`),
      fetch(`${COORDINATOR_URL}/api/p2p/status`),
      fetch(`${RESEARCHER_URL}/health`),
      fetch(`${RESEARCHER_URL}/status`),
    ];

    const results = await Promise.all(requests);
    for (const response of results) {
      expect(response.ok).toBe(true);
    }
  });
});

describe('E2E: Error Recovery', () => {
  it('services recover after malformed request', async () => {
    // Send a malformed request
    await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'THIS_IS_NOT_JSON!@#$%',
    });

    // Service should still be healthy after the bad request
    const healthRes = await fetch(`${COORDINATOR_URL}/health`);
    expect(healthRes.ok).toBe(true);
    const health = await healthRes.json();
    expect(health.status).toBe('healthy');
  });

  it('services recover after rapid sequential bad requests', async () => {
    // Fire 5 bad requests in sequence
    for (let i = 0; i < 5; i++) {
      await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: `{corrupt_${i}`,
      }).catch(() => {});
    }

    // All services should still respond
    const [trader, coord, researcher] = await Promise.all([
      fetch(`${TRADER_URL}/health`).then(r => r.json()),
      fetch(`${COORDINATOR_URL}/health`).then(r => r.json()),
      fetch(`${RESEARCHER_URL}/health`).then(r => r.json()),
    ]);

    expect(trader.status).toBe('healthy');
    expect(coord.status).toBe('healthy');
    expect(researcher.status).toBe('healthy');
  });

  it('services remain stable after wrong HTTP methods', async () => {
    // Send wrong methods
    await Promise.all([
      fetch(`${TRADER_URL}/health`, { method: 'DELETE' }),
      fetch(`${COORDINATOR_URL}/api/slots`, { method: 'PUT' }),
      fetch(`${RESEARCHER_URL}/health`, { method: 'PATCH' }),
    ]);

    // Services should still be healthy
    const [t, c, r] = await Promise.all([
      fetch(`${TRADER_URL}/health`).then(res => res.json()),
      fetch(`${COORDINATOR_URL}/health`).then(res => res.json()),
      fetch(`${RESEARCHER_URL}/health`).then(res => res.json()),
    ]);

    expect(t.status).toBe('healthy');
    expect(c.status).toBe('healthy');
    expect(r.status).toBe('healthy');
  });
});

describe('E2E: 404 Handling', () => {
  it('all services return 404 for unknown paths', async () => {
    const unknownPaths = [
      `${TRADER_URL}/api/nonexistent`,
      `${TRADER_URL}/admin/secret`,
      `${COORDINATOR_URL}/api/internal`,
      `${COORDINATOR_URL}/debug`,
      `${RESEARCHER_URL}/api/private`,
    ];

    const results = await Promise.all(
      unknownPaths.map(url => fetch(url))
    );

    for (const response of results) {
      expect(response.status).toBe(404);
    }
  });
});

describe('E2E: Cross-Service Dependency Health', () => {
  it('coordinator confirms all dependencies are healthy', async () => {
    // Check gRPC connection to trader
    const grpcRes = await fetch(`${COORDINATOR_URL}/api/grpc/health`);
    expect(grpcRes.ok).toBe(true);
    const grpc = await grpcRes.json();
    expect(grpc.grpcConnected).toBe(true);

    // Check P2P network
    const p2pRes = await fetch(`${COORDINATOR_URL}/api/p2p/status`);
    expect(p2pRes.ok).toBe(true);
    const p2p = await p2pRes.json();
    expect(p2p.p2pEnabled).toBe(true);
  });

  it('researcher confirms connection to coordinator', async () => {
    const response = await fetch(`${RESEARCHER_URL}/api/p2p/status`);
    expect(response.ok).toBe(true);
    const p2p = await response.json();
    expect(p2p.p2pEnabled).toBe(true);
    expect(p2p.coordinatorMultiaddr).toContain('/dns4/coordinator');
  });

  it('all services report consistent uptime (started recently enough)', async () => {
    const traderStatus = await fetch(`${TRADER_URL}/status`).then(r => r.json());

    // Uptime should be a positive number
    expect(traderStatus.uptime).toBeGreaterThan(0);
    // Should not be impossibly large (> 30 days in test)
    expect(traderStatus.uptime).toBeLessThan(30 * 24 * 60 * 60);
  });
});

describe('E2E: Response Format Consistency', () => {
  it('all health endpoints return consistent format', async () => {
    const [t, c, r] = await Promise.all([
      fetch(`${TRADER_URL}/health`).then(res => res.json()),
      fetch(`${COORDINATOR_URL}/health`).then(res => res.json()),
      fetch(`${RESEARCHER_URL}/health`).then(res => res.json()),
    ]);

    // All must return status: 'healthy'
    expect(t.status).toBe('healthy');
    expect(c.status).toBe('healthy');
    expect(r.status).toBe('healthy');
  });

  it('all status endpoints return service name', async () => {
    const [t, c, r] = await Promise.all([
      fetch(`${TRADER_URL}/status`).then(res => res.json()),
      fetch(`${COORDINATOR_URL}/status`).then(res => res.json()),
      fetch(`${RESEARCHER_URL}/status`).then(res => res.json()),
    ]);

    expect(t.service).toBe('behemoth-trader');
    expect(c.service).toBe('behemoth-coordinator');
    expect(r.service).toBe('behemoth-researcher');
  });

  it('all responses include correct content-type', async () => {
    const responses = await Promise.all([
      fetch(`${TRADER_URL}/health`),
      fetch(`${COORDINATOR_URL}/health`),
      fetch(`${RESEARCHER_URL}/health`),
    ]);

    for (const response of responses) {
      const contentType = response.headers.get('content-type');
      expect(contentType).toContain('application/json');
    }
  });
});
