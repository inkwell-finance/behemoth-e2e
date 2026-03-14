/**
 * E2E: Trading Flow Tests
 *
 * Validates the complete trading pipeline:
 * - Execution mode configuration (paper/live)
 * - Router setup and mode detection
 * - Swarm worker pool lifecycle
 * - Strategy stage distribution
 * - Signal-to-order flow via gRPC bridge
 */

import { describe, it, expect } from 'bun:test';

const TRADER_URL = process.env.TRADER_URL || 'http://trader:8080';
const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://coordinator:8081';

describe('E2E: Execution Configuration', () => {
  it('trader is in paper mode by default', async () => {
    const response = await fetch(`${TRADER_URL}/status`);
    expect(response.ok).toBe(true);
    const status = await response.json();
    expect(status.executionMode).toBe('PAPER');
    expect(status.paperMode).toBe(true);
  });

  it('router returns paper mode configuration', async () => {
    const response = await fetch(`${TRADER_URL}/router`);
    expect(response.ok).toBe(true);
    const router = await response.json();
    expect(router.mode).toBe('PAPER');
    expect(router.isPaperRouter).toBe(true);
    expect(router.isSmartOrderRouter).toBe(false);
    expect(router.paperMode).toBe(true);
  });

  it('status includes all required fields', async () => {
    const response = await fetch(`${TRADER_URL}/status`);
    const status = await response.json();

    expect(status.service).toBe('behemoth-trader');
    expect(status.version).toBeDefined();
    expect(typeof status.uptime).toBe('number');
    expect(status.uptime).toBeGreaterThan(0);
    expect(typeof status.grpcPort).toBe('number');
    expect(typeof status.httpPort).toBe('number');
    expect(status.configEnv).toBeDefined();
    expect(typeof status.swarmEnabled).toBe('boolean');
  });
});

describe('E2E: Swarm Worker Pool', () => {
  it('swarm is enabled', async () => {
    const response = await fetch(`${TRADER_URL}/swarm`);
    expect(response.ok).toBe(true);
    const swarm = await response.json();
    expect(swarm.enabled).toBe(true);
  });

  it('worker pool has valid configuration', async () => {
    const response = await fetch(`${TRADER_URL}/swarm`);
    const swarm = await response.json();

    if (swarm.enabled) {
      expect(swarm.workerPool).toBeDefined();
      expect(typeof swarm.workerPool.maxWorkers).toBe('number');
      expect(swarm.workerPool.maxWorkers).toBeGreaterThan(0);
      expect(typeof swarm.workerPool.activeJobs).toBe('number');
      expect(typeof swarm.workerPool.queuedJobs).toBe('number');
    }
  });

  it('strategy stages are tracked', async () => {
    const response = await fetch(`${TRADER_URL}/swarm`);
    const swarm = await response.json();

    if (swarm.enabled) {
      expect(swarm.strategies).toBeDefined();
      expect(typeof swarm.strategies.total).toBe('number');
      expect(swarm.strategies.byStage).toBeDefined();
      expect(typeof swarm.strategies.byStage.research).toBe('number');
      expect(typeof swarm.strategies.byStage.paper).toBe('number');
      expect(typeof swarm.strategies.byStage.live).toBe('number');
      expect(typeof swarm.strategies.byStage.deprecated).toBe('number');
    }
  });

  it('swarm respects paper mode', async () => {
    const response = await fetch(`${TRADER_URL}/swarm`);
    const swarm = await response.json();

    if (swarm.enabled) {
      expect(swarm.config).toBeDefined();
      expect(swarm.config.paperMode).toBe(true);
    }
  });
});

describe('E2E: gRPC Backtest Bridge', () => {
  it('coordinator gRPC connection to trader is active', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/grpc/health`);
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.grpcConnected).toBe(true);
    expect(data.trader.healthy).toBe(true);
  });

  it('trader gRPC reports version and uptime', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/grpc/health`);
    const data = await response.json();
    expect(data.trader.version).toBeDefined();
    expect(typeof data.trader.uptimeSeconds).toBe('number');
    expect(data.trader.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
