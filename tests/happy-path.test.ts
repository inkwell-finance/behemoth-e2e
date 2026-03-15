/**
 * E2E Happy Path Test
 *
 * Validates the full research loop in a single sequential flow:
 *   1. Schema discovery  — coordinator exposes a valid, non-empty slot schema
 *   2. Proposal building — construct a valid proposal from the first real slot
 *   3. Proposal validation — coordinator accepts the proposal
 *   4. gRPC bridge health — coordinator can reach trader via gRPC
 *   5. Trader readiness  — trader HTTP endpoint is healthy
 *
 * This test is intentionally end-to-end and sequential: each step depends on
 * the previous one succeeding, mirroring the real researcher workflow.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { safeFetch, globalSetup, serviceUrls, signTestProposal } from './setup';

const COORDINATOR_URL = serviceUrls.coordinator;
const TRADER_URL = serviceUrls.trader;

describe('E2E Happy Path: Full Research Loop', () => {
  beforeAll(async () => {
    await globalSetup();
  });

  it('schema → validate → gRPC → trader', async () => {
    // -------------------------------------------------------------------------
    // Step 1: Fetch slot schema from coordinator
    // -------------------------------------------------------------------------
    const schemaRes = await safeFetch(`${COORDINATOR_URL}/api/slots`);
    expect(schemaRes.ok).toBe(true);

    const schema = await schemaRes.json();
    expect(typeof schema.version).toBe('string');
    expect(schema.version.length).toBeGreaterThan(0);
    expect(Array.isArray(schema.slots)).toBe(true);
    expect(schema.slots.length).toBeGreaterThan(0);

    // -------------------------------------------------------------------------
    // Step 2: Build a valid proposal using the first available slot
    //
    // The coordinator's ProposalValidator requires:
    //   - proposalId: non-empty string
    //   - modifications: array with at least one entry, each having a known
    //     slotId and a proposedValue within [range.min, range.max]
    //
    // Slots use `slotId` (not `id`) and `valueType` (not `type`).
    // -------------------------------------------------------------------------
    const slot = schema.slots[0];
    expect(typeof slot.slotId).toBe('string');
    expect(slot.slotId.length).toBeGreaterThan(0);
    expect(slot.range).toBeDefined();
    expect(typeof slot.range.min).toBe('number');
    expect(typeof slot.range.max).toBe('number');

    // Use the midpoint so the value is guaranteed in-range
    const midValue = (slot.range.min + slot.range.max) / 2;

    const proposalId = `e2e-happy-path-${Date.now()}`;
    const proposal = signTestProposal({
      proposalId,
      modifications: [
        {
          slotId: slot.slotId,
          proposedValue: midValue,
        },
      ],
      hypothesis: 'E2E happy-path test proposal using slot midpoint value.',
    });

    // -------------------------------------------------------------------------
    // Step 3: Validate the proposal — coordinator must accept it
    // -------------------------------------------------------------------------
    const valRes = await safeFetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });
    expect(valRes.ok).toBe(true);

    const valResult = await valRes.json();
    expect(typeof valResult.valid).toBe('boolean');

    // If validation failed, surface the errors to aid debugging
    if (!valResult.valid) {
      const errors = Array.isArray(valResult.errors)
        ? valResult.errors.join('; ')
        : JSON.stringify(valResult);
      throw new Error(
        `Proposal validation failed for slot "${slot.slotId}" ` +
        `with value ${midValue}: ${errors}`
      );
    }

    expect(valResult.valid).toBe(true);

    // -------------------------------------------------------------------------
    // Step 4: Verify gRPC bridge is connected (coordinator → trader)
    //
    // The endpoint returns HTTP 200 + { grpcConnected: true } when healthy,
    // or HTTP 503 + { grpcConnected: false, error } when the trader is
    // unreachable. Both shapes are handled gracefully here.
    // -------------------------------------------------------------------------
    const grpcRes = await safeFetch(`${COORDINATOR_URL}/api/grpc/health`);
    const grpcData = await grpcRes.json();

    expect(typeof grpcData.grpcConnected).toBe('boolean');

    if (!grpcData.grpcConnected) {
      throw new Error(
        `gRPC bridge is not connected to trader: ${grpcData.error ?? 'unknown error'}`
      );
    }

    expect(grpcRes.ok).toBe(true);
    expect(grpcData.grpcConnected).toBe(true);

    // Trader metadata is present when the gRPC connection succeeded
    expect(grpcData.trader).toBeDefined();
    expect(typeof grpcData.trader).toBe('object');
    expect(grpcData.trader.healthy).toBe(true);

    // -------------------------------------------------------------------------
    // Step 5: Verify trader HTTP endpoint is healthy
    //
    // This confirms the trader process itself is alive, independently of gRPC.
    // -------------------------------------------------------------------------
    const traderRes = await safeFetch(`${TRADER_URL}/health`);
    expect(traderRes.ok).toBe(true);

    const traderHealth = await traderRes.json();
    expect(traderHealth.status).toBe('healthy');
  });
});
