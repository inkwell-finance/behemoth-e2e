/**
 * gRPC Integration Tests
 *
 * Tests the gRPC communication between coordinator and trader:
 * 1. Health check connectivity via gRPC
 * 2. Coordinator can reach trader via gRPC
 * 3. Backtest request/response flow via HTTP proxy endpoints
 * 4. Proper response structure validation
 */

import { describe, it, expect } from 'bun:test';
import { safeFetch, serviceUrls } from './setup';

const TRADER_URL = serviceUrls.trader;
const COORDINATOR_URL = serviceUrls.coordinator;

describe('E2E: gRPC Integration - Health Checks', () => {
  it('coordinator gRPC health endpoint returns connected status', async () => {
    const response = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.grpcConnected).toBe(true);
  });

  it('gRPC health response has trader metadata', async () => {
    const response = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    const data = await response.json();
    expect(data.trader).toBeDefined();
    expect(typeof data.trader).toBe('object');
  });

  it('trader health metadata contains healthy status', async () => {
    const response = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    const data = await response.json();
    expect(data.trader.healthy).toBe(true);
  });

  it('trader health metadata contains version', async () => {
    const response = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    const data = await response.json();
    expect(typeof data.trader.version).toBe('string');
    expect(data.trader.version.length).toBeGreaterThan(0);
  });

  it('trader health metadata contains uptime', async () => {
    const response = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    const data = await response.json();
    expect(typeof data.trader.uptimeSeconds).toBe('number');
    expect(data.trader.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('trader health metadata contains paper trade count', async () => {
    const response = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    const data = await response.json();
    expect(typeof data.trader.activePaperTrades).toBe('number');
    expect(data.trader.activePaperTrades).toBeGreaterThanOrEqual(0);
  });
});

describe('E2E: gRPC Integration - Connectivity', () => {
  it('coordinator can reach trader via gRPC', async () => {
    const response = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
  });

  it('gRPC health call completes within timeout', async () => {
    const startTime = Date.now();
    const response = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    const duration = Date.now() - startTime;
    expect(response.ok).toBe(true);
    // gRPC call should complete reasonably fast (less than 5 seconds)
    expect(duration).toBeLessThan(5000);
  });

  it('gRPC health returns consistent data on multiple calls', async () => {
    const response1 = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    const data1 = await response1.json();

    const response2 = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    const data2 = await response2.json();

    // Both should be connected
    expect(data1.grpcConnected).toBe(true);
    expect(data2.grpcConnected).toBe(true);

    // Trader info should match
    expect(data1.trader.version).toBe(data2.trader.version);
    expect(data1.trader.healthy).toBe(data2.trader.healthy);
  });
});

describe('E2E: gRPC Integration - Response Structure', () => {
  it('gRPC health response has correct structure', async () => {
    const response = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    const data = await response.json();

    // Top-level fields
    expect('grpcConnected' in data).toBe(true);
    expect('trader' in data).toBe(true);

    // Trader object structure
    expect('healthy' in data.trader).toBe(true);
    expect('version' in data.trader).toBe(true);
    expect('uptimeSeconds' in data.trader).toBe(true);
    expect('activePaperTrades' in data.trader).toBe(true);
  });

  it('gRPC health response types are correct', async () => {
    const response = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    const data = await response.json();

    // Type checks
    expect(typeof data.grpcConnected).toBe('boolean');
    expect(typeof data.trader).toBe('object');
    expect(typeof data.trader.healthy).toBe('boolean');
    expect(typeof data.trader.version).toBe('string');
    expect(typeof data.trader.uptimeSeconds).toBe('number');
    expect(typeof data.trader.activePaperTrades).toBe('number');
  });

  it('gRPC health response values are in expected ranges', async () => {
    const response = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    const data = await response.json();

    // Sanity checks on value ranges
    expect(data.trader.activePaperTrades).toBeGreaterThanOrEqual(0);
    expect(data.trader.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(data.trader.version).toMatch(/^\d+\.\d+\.\d+/); // Semantic versioning
  });
});

describe('E2E: gRPC Integration - Error Handling', () => {
  it('handles gRPC connection errors gracefully', async () => {
    // Test with invalid coordinator URL
    try {
      const response = await safeFetch('http://invalid-host:9999/api/grpc/health');
      expect(response.ok).toBe(false);
    } catch (e) {
      // Expected to throw or return error
      expect(e).toBeDefined();
    }
  });

  it('coordinator returns error when gRPC is disconnected', async () => {
    // This test assumes normal operation - we're just verifying the error case is handled
    const response = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    // Should either be ok with connected=true, or return error gracefully
    if (!response.ok) {
      expect(response.status).toBe(503); // Service Unavailable
      const data = await response.json();
      expect(data.grpcConnected).toBe(false);
      expect(data.error).toBeDefined();
    }
  });
});

describe('E2E: gRPC Integration - Proposal Validation Flow', () => {
  it('coordinator validates proposal structure', async () => {
    const validProposal = {
      proposalId: 'test-proposal-001',
      modifications: [
        {
          slotId: 'param_alpha',
          proposedValue: 0.5,
        },
      ],
    };

    const response = await safeFetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validProposal),
    });

    expect(response.ok).toBe(true);
    const result = await response.json();
    expect('valid' in result).toBe(true);
  });

  it('proposal validation returns correct response structure', async () => {
    const proposal = {
      proposalId: 'test-proposal-002',
      modifications: [
        {
          slotId: 'param_beta',
          proposedValue: 0.75,
        },
      ],
    };

    const response = await safeFetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    const result = await response.json();
    expect('valid' in result).toBe(true);
    expect(typeof result.valid).toBe('boolean');

    // If invalid, should have errors array
    if (!result.valid) {
      expect(Array.isArray(result.errors)).toBe(true);
    }
  });

  it('rejects proposal with no modifications', async () => {
    const invalidProposal = {
      proposalId: 'test-proposal-003',
      modifications: [], // Invalid: empty
    };

    const response = await safeFetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invalidProposal),
    });

    const result = await response.json();
    expect(result.valid).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects proposal with missing required fields', async () => {
    const missingProposal = {
      modifications: [
        {
          slotId: 'param_gamma',
          proposedValue: 0.5,
        },
      ],
      // Missing: proposalId
    };

    const response = await safeFetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(missingProposal),
    });

    const result = await response.json();
    expect(result.valid).toBe(false);
  });
});

describe('E2E: gRPC Integration - Slot Schema Access', () => {
  it('coordinator returns slot schema for validation', async () => {
    const response = await safeFetch(`${COORDINATOR_URL}/api/slots`);
    expect(response.ok).toBe(true);
    const schema = await response.json();
    expect(schema.version).toBeDefined();
    expect(Array.isArray(schema.slots)).toBe(true);
  });

  it('slot schema has structure compatible with gRPC backtest', async () => {
    const response = await safeFetch(`${COORDINATOR_URL}/api/slots`);
    const schema = await response.json();

    expect(schema.slots.length).toBeGreaterThan(0);

    // Each slot should have basic properties
    for (const slot of schema.slots) {
      expect('slotId' in slot).toBe(true);
      expect('name' in slot).toBe(true);
      expect('type' in slot).toBe(true);
      expect('currentValue' in slot).toBe(true);
    }
  });

  it('slot schema hides currentValue (hidden for researchers)', async () => {
    const response = await safeFetch(`${COORDINATOR_URL}/api/slots`);
    const schema = await response.json();

    // All currentValue fields should be null (hidden from researchers)
    for (const slot of schema.slots) {
      expect(slot.currentValue).toBeNull();
    }
  });
});

describe('E2E: gRPC Integration - Service Status', () => {
  it('trader service status is accessible', async () => {
    const response = await safeFetch(`${TRADER_URL}/status`);
    expect(response.ok).toBe(true);
    const status = await response.json();
    expect(status.service).toBe('behemoth-trader');
  });

  it('coordinator service status is accessible', async () => {
    const response = await safeFetch(`${COORDINATOR_URL}/status`);
    expect(response.ok).toBe(true);
    const status = await response.json();
    expect(status.service).toBe('behemoth-coordinator');
  });

  it('coordinator status shows gRPC connection details', async () => {
    const response = await safeFetch(`${COORDINATOR_URL}/status`);
    const status = await response.json();
    expect('traderGrpcUrl' in status).toBe(true);
    expect(typeof status.traderGrpcUrl).toBe('string');
    expect(status.traderGrpcUrl.length).toBeGreaterThan(0);
  });

  it('coordinator status shows trader gRPC URL is configured', async () => {
    const response = await safeFetch(`${COORDINATOR_URL}/status`);
    const status = await response.json();
    // Should contain port 50051 (default gRPC port) or be configured
    expect(status.traderGrpcUrl).toMatch(/:\d+$/);
  });
});

describe('E2E: gRPC Integration - End-to-End Flow', () => {
  it('complete health check flow works', async () => {
    // 1. Check coordinator is healthy
    const coordHealth = await safeFetch(`${COORDINATOR_URL}/health`);
    expect(coordHealth.ok).toBe(true);

    // 2. Check trader is healthy (via HTTP)
    const traderHealth = await safeFetch(`${TRADER_URL}/health`);
    expect(traderHealth.ok).toBe(true);

    // 3. Check gRPC connection from coordinator to trader
    const grpcHealth = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    expect(grpcHealth.ok).toBe(true);
    const data = await grpcHealth.json();
    expect(data.grpcConnected).toBe(true);
  });

  it('proposal validation can proceed when gRPC is connected', async () => {
    // 1. Verify gRPC is connected
    const grpcCheck = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    expect(grpcCheck.ok).toBe(true);
    const grpcData = await grpcCheck.json();
    expect(grpcData.grpcConnected).toBe(true);

    // 2. Validate a proposal (would use gRPC for backtest if submitted)
    const proposal = {
      proposalId: 'test-flow-001',
      modifications: [
        {
          slotId: 'param_delta',
          proposedValue: 0.6,
        },
      ],
    };

    const response = await safeFetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(typeof result.valid).toBe('boolean');
  });

  it('gRPC health remains consistent across multiple operations', async () => {
    // Get initial health
    const health1 = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    const data1 = await health1.json();
    const initialVersion = data1.trader.version;

    // Perform other operations
    await safeFetch(`${COORDINATOR_URL}/api/slots`);
    const proposal = {
      proposalId: 'test-flow-002',
      modifications: [
        { slotId: 'param_epsilon', proposedValue: 0.7 },
      ],
    };
    await safeFetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    // Check health again
    const health2 = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    const data2 = await health2.json();

    // gRPC should still be connected
    expect(data2.grpcConnected).toBe(true);
    // Trader version should match
    expect(data2.trader.version).toBe(initialVersion);
  });
});
