/**
 * P2P Message Flow Tests
 *
 * Verifies the P2P network is formed and operational between coordinator and
 * researcher by interrogating HTTP status endpoints — without injecting messages
 * directly from the test process (which would require spinning up a full libp2p
 * node).
 *
 * Coverage:
 * - Both services expose a valid peer ID
 * - Both services subscribe to the expected gossipsub topics
 * - Coordinator has at least one connected peer (the researcher)
 * - Researcher reports it is connected to the coordinator
 * - Cross-service peer visibility: each service lists the other as a peer
 * - Job handler on researcher is ready after P2P startup
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { globalSetup, safeFetch, serviceUrls } from './setup';

const COORDINATOR_URL = serviceUrls.coordinator;
const RESEARCHER_URL = serviceUrls.researcher;

/** All gossipsub topics that every node must subscribe to. */
const EXPECTED_TOPICS = [
  '/behemoth/proposals/1.0.0',
  '/behemoth/jobs/1.0.0',
  '/behemoth/results/1.0.0',
  '/behemoth/announcements/1.0.0',
];

/**
 * Polls `fn` until it returns a truthy value or `timeout` ms elapse.
 * Useful for waiting on eventually-consistent P2P state.
 */
async function waitFor(
  fn: () => Promise<boolean>,
  opts: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const timeout = opts.timeout ?? 15_000;
  const interval = opts.interval ?? 500;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(`waitFor: condition not met within ${timeout}ms`);
}

beforeAll(async () => {
  await globalSetup();
});

// ============================================================================
// Peer Identity
// ============================================================================

describe('E2E P2P: Peer Identity', () => {
  it('coordinator returns a non-null peerId', async () => {
    const res = await safeFetch(`${COORDINATOR_URL}/api/p2p/status`);
    expect(res.ok).toBe(true);
    const data = await res.json() as { peerId: string | null };
    expect(data.peerId).not.toBeNull();
    expect(typeof data.peerId).toBe('string');
    expect(data.peerId!.length).toBeGreaterThan(0);
  });

  it('researcher returns a non-null peerId', async () => {
    const res = await safeFetch(`${RESEARCHER_URL}/api/p2p/status`);
    expect(res.ok).toBe(true);
    const data = await res.json() as { peerId: string | null };
    expect(data.peerId).not.toBeNull();
    expect(typeof data.peerId).toBe('string');
    expect(data.peerId!.length).toBeGreaterThan(0);
  });

  it('coordinator and researcher have distinct peer IDs', async () => {
    const [cRes, rRes] = await Promise.all([
      safeFetch(`${COORDINATOR_URL}/api/p2p/status`),
      safeFetch(`${RESEARCHER_URL}/api/p2p/status`),
    ]);
    const coordinator = await cRes.json() as { peerId: string | null };
    const researcher = await rRes.json() as { peerId: string | null };

    expect(coordinator.peerId).not.toBeNull();
    expect(researcher.peerId).not.toBeNull();
    expect(coordinator.peerId).not.toBe(researcher.peerId);
  });
});

// ============================================================================
// Topic Subscriptions
// ============================================================================

describe('E2E P2P: Topic Subscriptions', () => {
  it('coordinator subscribes to all expected topics', async () => {
    const res = await safeFetch(`${COORDINATOR_URL}/api/p2p/status`);
    const data = await res.json() as { topics: string[] };
    expect(Array.isArray(data.topics)).toBe(true);
    for (const topic of EXPECTED_TOPICS) {
      expect(data.topics).toContain(topic);
    }
  });

  it('researcher subscribes to all expected topics', async () => {
    const res = await safeFetch(`${RESEARCHER_URL}/api/p2p/status`);
    const data = await res.json() as { topics: string[] };
    expect(Array.isArray(data.topics)).toBe(true);
    for (const topic of EXPECTED_TOPICS) {
      expect(data.topics).toContain(topic);
    }
  });
});

// ============================================================================
// Network Formation
// ============================================================================

describe('E2E P2P: Network Formation', () => {
  it('coordinator has at least one connected peer', async () => {
    // The researcher connects to the coordinator on startup; allow up to 15s for
    // the TCP dial + gossipsub handshake to complete.
    await waitFor(async () => {
      const res = await safeFetch(`${COORDINATOR_URL}/api/p2p/status`);
      const data = await res.json() as { connectedPeers: number };
      return data.connectedPeers >= 1;
    }, { timeout: 15_000 });

    const res = await safeFetch(`${COORDINATOR_URL}/api/p2p/status`);
    const data = await res.json() as { connectedPeers: number };
    expect(data.connectedPeers).toBeGreaterThanOrEqual(1);
  });

  it('researcher is connected to at least one peer (the coordinator)', async () => {
    await waitFor(async () => {
      const res = await safeFetch(`${RESEARCHER_URL}/api/p2p/status`);
      const data = await res.json() as { connectedPeers: number };
      return data.connectedPeers >= 1;
    }, { timeout: 15_000 });

    const res = await safeFetch(`${RESEARCHER_URL}/api/p2p/status`);
    const data = await res.json() as { connectedPeers: number; connectedToCoordinator: boolean };
    expect(data.connectedPeers).toBeGreaterThanOrEqual(1);
    expect(data.connectedToCoordinator).toBe(true);
  });

  it('researcher peer list includes the coordinator peer ID', async () => {
    // Fetch coordinator peer ID
    const cRes = await safeFetch(`${COORDINATOR_URL}/api/p2p/status`);
    const coordinator = await cRes.json() as { peerId: string | null };
    expect(coordinator.peerId).not.toBeNull();
    const coordinatorPeerId = coordinator.peerId!;

    // Wait for researcher to list coordinator as a peer
    await waitFor(async () => {
      const res = await safeFetch(`${RESEARCHER_URL}/api/p2p/status`);
      const data = await res.json() as { peers: string[] };
      return Array.isArray(data.peers) && data.peers.includes(coordinatorPeerId);
    }, { timeout: 15_000 });

    const rRes = await safeFetch(`${RESEARCHER_URL}/api/p2p/status`);
    const researcher = await rRes.json() as { peers: string[] };
    expect(researcher.peers).toContain(coordinatorPeerId);
  });

  it('coordinator peer list includes the researcher peer ID', async () => {
    // Fetch researcher peer ID
    const rRes = await safeFetch(`${RESEARCHER_URL}/api/p2p/status`);
    const researcher = await rRes.json() as { peerId: string | null };
    expect(researcher.peerId).not.toBeNull();
    const researcherPeerId = researcher.peerId!;

    // Wait for coordinator to list researcher as a peer
    await waitFor(async () => {
      const res = await safeFetch(`${COORDINATOR_URL}/api/p2p/status`);
      const data = await res.json() as { peers: string[] };
      return Array.isArray(data.peers) && data.peers.includes(researcherPeerId);
    }, { timeout: 15_000 });

    const cRes = await safeFetch(`${COORDINATOR_URL}/api/p2p/status`);
    const coordinator = await cRes.json() as { peers: string[] };
    expect(coordinator.peers).toContain(researcherPeerId);
  });

  it('researcher knows the correct coordinator multiaddr', async () => {
    const res = await safeFetch(`${RESEARCHER_URL}/api/p2p/status`);
    const data = await res.json() as { coordinatorMultiaddr: string };
    expect(data.coordinatorMultiaddr).toContain('/dns4/coordinator/tcp/4001');
  });
});

// ============================================================================
// Listen Addresses
// ============================================================================

describe('E2E P2P: Listen Addresses', () => {
  it('coordinator exposes at least one listen address', async () => {
    const res = await safeFetch(`${COORDINATOR_URL}/api/p2p/status`);
    const data = await res.json() as { listenAddresses: string[] };
    expect(Array.isArray(data.listenAddresses)).toBe(true);
    expect(data.listenAddresses.length).toBeGreaterThan(0);
  });

  it('researcher exposes at least one listen address', async () => {
    const res = await safeFetch(`${RESEARCHER_URL}/api/p2p/status`);
    const data = await res.json() as { listenAddresses: string[] };
    expect(Array.isArray(data.listenAddresses)).toBe(true);
    expect(data.listenAddresses.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Job Handler Readiness
// ============================================================================

describe('E2E P2P: Job Handler Readiness', () => {
  it('researcher job handler is ready after P2P startup', async () => {
    // Job handler initialises after P2P node starts, so allow some startup time.
    await waitFor(async () => {
      const res = await safeFetch(`${RESEARCHER_URL}/api/jobs/status`);
      if (!res.ok) return false;
      const data = await res.json() as { jobHandlerReady: boolean };
      return data.jobHandlerReady === true;
    }, { timeout: 20_000 });

    const res = await safeFetch(`${RESEARCHER_URL}/api/jobs/status`);
    expect(res.ok).toBe(true);
    const data = await res.json() as { jobHandlerReady: boolean; maxJobs: number };
    expect(data.jobHandlerReady).toBe(true);
    expect(data.maxJobs).toBeGreaterThan(0);
  });

  it('researcher job handler reports zero active jobs at startup', async () => {
    const res = await safeFetch(`${RESEARCHER_URL}/api/jobs/status`);
    expect(res.ok).toBe(true);
    const data = await res.json() as { currentJobs: number };
    expect(data.currentJobs).toBe(0);
  });
});

// ============================================================================
// P2P Enabled Flag
// ============================================================================

describe('E2E P2P: Configuration Flags', () => {
  it('coordinator reports P2P as enabled', async () => {
    const res = await safeFetch(`${COORDINATOR_URL}/api/p2p/status`);
    const data = await res.json() as { p2pEnabled: boolean };
    expect(data.p2pEnabled).toBe(true);
  });

  it('researcher reports P2P as enabled', async () => {
    const res = await safeFetch(`${RESEARCHER_URL}/api/p2p/status`);
    const data = await res.json() as { p2pEnabled: boolean };
    expect(data.p2pEnabled).toBe(true);
  });

  it('coordinator status endpoint reflects P2P peer ID', async () => {
    const [statusRes, p2pRes] = await Promise.all([
      safeFetch(`${COORDINATOR_URL}/status`),
      safeFetch(`${COORDINATOR_URL}/api/p2p/status`),
    ]);
    const status = await statusRes.json() as { p2pPeerId: string | null; p2pEnabled: boolean };
    const p2p = await p2pRes.json() as { peerId: string | null };

    // Both endpoints must agree on the peer ID
    expect(status.p2pEnabled).toBe(true);
    expect(status.p2pPeerId).toBe(p2p.peerId);
  });

  it('researcher status endpoint reflects P2P peer ID', async () => {
    const [statusRes, p2pRes] = await Promise.all([
      safeFetch(`${RESEARCHER_URL}/status`),
      safeFetch(`${RESEARCHER_URL}/api/p2p/status`),
    ]);
    const status = await statusRes.json() as { p2pPeerId: string | null; p2pEnabled: boolean };
    const p2p = await p2pRes.json() as { peerId: string | null };

    expect(status.p2pEnabled).toBe(true);
    expect(status.p2pPeerId).toBe(p2p.peerId);
  });
});
