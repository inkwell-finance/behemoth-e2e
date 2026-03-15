/**
 * Test Setup
 *
 * Provides:
 * - Service readiness checks with retry and backoff
 * - Fetch wrapper with timeout
 * - Environment validation
 * - Global setup function
 * - Ed25519 test proposal signing helper
 */

import { generateKeyPairSync, sign as cryptoSign } from 'crypto';

/**
 * Waits for a service to be ready by polling its health endpoint.
 * Uses exponential backoff with configurable timeout and interval.
 *
 * @param url - The service URL to check (typically /health endpoint)
 * @param opts - Configuration options
 * @param opts.timeout - Maximum time to wait in milliseconds (default: 30000)
 * @param opts.interval - Polling interval in milliseconds (default: 1000)
 * @throws Error if service is not ready after timeout
 */
export async function waitForService(
  url: string,
  opts: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const timeout = opts.timeout ?? 30_000;
  const interval = opts.interval ?? 1_000;
  const deadline = Date.now() + timeout;

  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) {
        return;
      }
      lastError = new Error(`Service returned ${res.status}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(
    `Service ${url} not ready after ${timeout}ms${lastError ? `: ${lastError.message}` : ''}`
  );
}

/**
 * Safe fetch wrapper with 10-second timeout.
 * Prevents tests from hanging indefinitely on stuck requests.
 *
 * @param url - The URL to fetch
 * @param opts - Fetch options (signal will be overridden with 10s timeout)
 * @returns Response from the server
 * @throws Error if request times out or fails
 */
export async function safeFetch(
  url: string,
  opts?: RequestInit
): Promise<Response> {
  const signal = AbortSignal.timeout(10_000);
  return fetch(url, { ...opts, signal });
}

/**
 * Validates that all required environment variables are set.
 * Called during global setup to fail fast with clear error messages.
 *
 * @throws Error if any required env var is missing
 */
function validateEnvironment(): void {
  const required = [
    'TRADER_URL',
    'COORDINATOR_URL',
    'RESEARCHER_URL',
  ];

  const missing: string[] = [];

  for (const key of required) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`
    );
  }
}

/**
 * Global setup function called before all tests.
 * Validates environment and waits for all services to be ready.
 *
 * This should be called in a setup hook by the test runner.
 * Example for bun test: use a beforeAll hook at the test file level.
 */
export async function globalSetup(): Promise<void> {
  console.log('E2E Test Setup: Validating environment...');
  validateEnvironment();

  const services = [
    { name: 'Trader', url: `${process.env.TRADER_URL!}/health` },
    { name: 'Coordinator', url: `${process.env.COORDINATOR_URL!}/health` },
    { name: 'Researcher', url: `${process.env.RESEARCHER_URL!}/health` },
  ];

  console.log('E2E Test Setup: Waiting for services to be ready...');
  for (const service of services) {
    console.log(`  Waiting for ${service.name}...`);
    await waitForService(service.url, {
      timeout: 30_000,
      interval: 1_000,
    });
    console.log(`  ${service.name} is ready!`);
  }

  console.log('E2E Test Setup: All services ready. Starting tests.\n');
}

/**
 * Get service URLs from environment with defaults.
 * Used by individual tests.
 */
export const serviceUrls = {
  trader: process.env.TRADER_URL || 'http://trader:8080',
  coordinator: process.env.COORDINATOR_URL || 'http://coordinator:8081',
  researcher: process.env.RESEARCHER_URL || 'http://researcher:8082',
};

// ---------------------------------------------------------------------------
// Ed25519 test keypair — generated once per process, shared across tests
// ---------------------------------------------------------------------------

const { privateKey: TEST_PRIVATE_KEY, publicKey: TEST_PUBLIC_KEY } =
  generateKeyPairSync('ed25519');

/**
 * The base64-encoded public key used by signTestProposal().
 * Stable for the lifetime of the test process; can be used as the
 * `researcher` field in manually constructed proposals.
 */
export const testResearcherPubkey = TEST_PUBLIC_KEY
  .export({ type: 'spki', format: 'der' })
  .toString('base64');

/**
 * Produce the canonical JSON string for a proposal's signable fields,
 * matching the coordinator's canonicalizeProposalPayload exactly:
 *   Keys in sorted order: modifications (sorted by slotId), nonce,
 *   proposalId, researcher, timestamp.
 */
function canonicalizeProposalPayload(fields: {
  modifications: Array<{ slotId: string; proposedValue: number | string }>;
  nonce: string;
  proposalId: string;
  researcher: string;
  timestamp: number;
}): string {
  const sortedMods = [...fields.modifications].sort((a, b) =>
    a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0
  );
  const payload = {
    modifications: sortedMods,
    nonce: fields.nonce,
    proposalId: fields.proposalId,
    researcher: fields.researcher,
    timestamp: fields.timestamp,
  };
  return JSON.stringify(payload);
}

/**
 * Sign a proposal using a fresh Ed25519 keypair and return a new object
 * with `signature`, `nonce`, `researcher`, and `timestamp` filled in.
 *
 * The signature covers the canonical payload (sorted-key JSON) so it will
 * pass the coordinator's proposal-validator.
 *
 * @param proposal - Partial proposal; must have `proposalId` and
 *   `modifications`.  Any existing nonce/timestamp/researcher are replaced.
 * @returns A copy of `proposal` with authentication fields populated.
 */
export function signTestProposal<
  T extends {
    proposalId: string;
    modifications: Array<{ slotId: string; proposedValue: number | string }>;
    [key: string]: unknown;
  }
>(proposal: T): T & {
  researcher: string;
  timestamp: number;
  nonce: string;
  signature: string;
} {
  const nonce = crypto.randomUUID();
  const timestamp = Date.now();
  const researcher = testResearcherPubkey;

  const canonical = canonicalizeProposalPayload({
    modifications: proposal.modifications,
    nonce,
    proposalId: proposal.proposalId,
    researcher,
    timestamp,
  });

  const sigBuffer = cryptoSign(
    null,                                // Ed25519 — no digest algorithm
    Buffer.from(canonical, 'utf8'),
    TEST_PRIVATE_KEY
  );

  return {
    ...proposal,
    researcher,
    timestamp,
    nonce,
    signature: sigBuffer.toString('base64'),
  };
}
