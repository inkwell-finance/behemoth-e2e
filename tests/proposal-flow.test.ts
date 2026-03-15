/**
 * E2E Proposal Flow Test
 *
 * Validates the full proposal → coordinator pipeline as far as HTTP allows:
 *
 *   1. Schema discovery       — fetch slot schema, verify structure of every slot
 *   2. Proposal signing       — build and sign proposals using signTestProposal
 *   3. Proposal submit        — POST to /api/proposals/validate (the public HTTP
 *                               submission path; the actual backtest path is P2P)
 *   4. Response bounds        — validate that the coordinator's validation result
 *                               carries the expected fields and the proposal passes
 *   5. Full core-loop test    — schema → build → sign → submit → poll/verify
 *                               acceptance, covering the plan-09-testing/03 spec.
 *                               Because backtest results arrive over P2P (not HTTP),
 *                               the test submits via /api/proposals/validate and
 *                               asserts 200 + valid:true — the deepest observable
 *                               acceptance signal available over HTTP.
 *   6. Coordinator status     — verify the coordinator is still healthy after the
 *                               submissions and reports expected metadata
 *   7. Direct submit 401      — confirm /api/proposals requires auth (not open)
 *
 * NOTE: End-to-end backtest results (sharpe, drawdown, etc.) flow through P2P,
 * not HTTP.  There is no /api/proposals/{id}/status endpoint.  The acceptance
 * check in step 5 therefore covers the validation response fields, not backtest
 * scores.  If a status endpoint is added to the coordinator in future, wire a
 * poll loop here to wait for it (see pollForProposalStatus helper stub below).
 *
 * All proposal IDs use crypto.randomUUID() so the test is idempotent and can
 * run multiple times without interference.  Every created proposal is registered
 * via recordCreatedProposal() so teardown can log (and eventually clean up) the
 * Redis keys.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  safeFetch,
  globalSetup,
  serviceUrls,
  signTestProposal,
  testResearcherPubkey,
} from './setup';
import { recordCreatedProposal, globalTeardown } from './teardown';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SlotDefinition {
  slotId: string;
  range: { min: number; max: number };
  [key: string]: unknown;
}

interface SlotSchema {
  version: string;
  slots: SlotDefinition[];
}

interface ValidationResponse {
  valid: boolean;
  errors?: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the slot schema from the coordinator and assert it is well-formed.
 * Returns the parsed schema so callers can reuse it without a second fetch.
 */
async function fetchSlotSchema(coordinatorUrl: string): Promise<SlotSchema> {
  const res = await safeFetch(`${coordinatorUrl}/api/slots`);
  if (!res.ok) {
    throw new Error(`GET /api/slots failed with status ${res.status}`);
  }
  const schema = (await res.json()) as SlotSchema;
  if (typeof schema.version !== 'string' || !Array.isArray(schema.slots)) {
    throw new Error(`Malformed slot schema: ${JSON.stringify(schema)}`);
  }
  return schema;
}

/**
 * Submit a signed proposal to /api/proposals/validate and return the parsed
 * response.  Throws if the HTTP request itself fails (non-2xx).
 */
async function submitProposal(
  coordinatorUrl: string,
  proposal: Record<string, unknown>,
): Promise<ValidationResponse> {
  const res = await safeFetch(`${coordinatorUrl}/api/proposals/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(proposal),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `POST /api/proposals/validate returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as ValidationResponse;
}

/**
 * Stub for future polling behaviour.
 *
 * The coordinator currently has no /api/proposals/{id}/status endpoint —
 * backtest results are distributed over P2P (see coordinator/src/index.ts).
 * Impact scores land in Redis under "coordinator:impact:{proposalId}" after
 * the full P2P round-trip completes.
 *
 * When a status endpoint is added, replace this function with a real poll loop:
 *
 *   async function pollForProposalStatus(
 *     coordinatorUrl: string,
 *     proposalId: string,
 *     opts: { timeoutMs?: number; intervalMs?: number } = {},
 *   ): Promise<{ status: string; result?: unknown }> {
 *     const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
 *     const interval = opts.intervalMs ?? 1_000;
 *     while (Date.now() < deadline) {
 *       const res = await safeFetch(
 *         `${coordinatorUrl}/api/proposals/${proposalId}/status`,
 *       );
 *       if (res.ok) {
 *         const data = await res.json();
 *         if (data.status !== 'pending') return data;
 *       }
 *       await new Promise((r) => setTimeout(r, interval));
 *     }
 *     throw new Error(`Proposal ${proposalId} did not complete within timeout`);
 *   }
 */
function pollForProposalStatus(
  _coordinatorUrl: string,
  _proposalId: string,
): null {
  // No-op until a status endpoint exists.
  return null;
}

// Keep the import used — the function is the stub guard.
void pollForProposalStatus;

const COORDINATOR_URL = serviceUrls.coordinator;

describe('E2E Proposal Flow: proposal → validate → coordinator status', () => {
  beforeAll(async () => {
    await globalSetup();
  });

  afterAll(async () => {
    await globalTeardown();
  });

  it('fetches slot schema with real slot definitions', async () => {
    const res = await safeFetch(`${COORDINATOR_URL}/api/slots`);
    expect(res.ok).toBe(true);

    const schema = await res.json();
    expect(typeof schema.version).toBe('string');
    expect(schema.version.length).toBeGreaterThan(0);
    expect(Array.isArray(schema.slots)).toBe(true);
    expect(schema.slots.length).toBeGreaterThan(0);

    // Each slot must have the fields the validator and builder expect
    for (const slot of schema.slots) {
      expect(typeof slot.slotId).toBe('string');
      expect(slot.slotId.length).toBeGreaterThan(0);
      expect(slot.range).toBeDefined();
      expect(typeof slot.range.min).toBe('number');
      expect(typeof slot.range.max).toBe('number');
      expect(isFinite(slot.range.min)).toBe(true);
      expect(isFinite(slot.range.max)).toBe(true);
      expect(slot.range.max).toBeGreaterThanOrEqual(slot.range.min);
    }
  });

  it('builds, signs, and submits a valid single-slot proposal', async () => {
    // -------------------------------------------------------------------------
    // Step 1: Get schema
    // -------------------------------------------------------------------------
    const schemaRes = await safeFetch(`${COORDINATOR_URL}/api/slots`);
    expect(schemaRes.ok).toBe(true);
    const schema = await schemaRes.json();
    const slot = schema.slots[0];

    // Use midpoint to guarantee the value is in-range
    const midValue = (slot.range.min + slot.range.max) / 2;

    // -------------------------------------------------------------------------
    // Step 2: Build and sign the proposal
    // -------------------------------------------------------------------------
    const proposalId = crypto.randomUUID();
    const proposal = signTestProposal({
      proposalId,
      modifications: [
        { slotId: slot.slotId, proposedValue: midValue },
      ],
      hypothesis: 'E2E proposal-flow test: single-slot midpoint submission.',
    });

    // Signature fields must be populated
    expect(typeof proposal.researcher).toBe('string');
    expect(proposal.researcher.length).toBeGreaterThan(0);
    expect(typeof proposal.nonce).toBe('string');
    expect(proposal.nonce.length).toBeGreaterThan(0);
    expect(typeof proposal.timestamp).toBe('number');
    expect(isFinite(proposal.timestamp)).toBe(true);
    expect(typeof proposal.signature).toBe('string');
    expect(proposal.signature.length).toBeGreaterThan(0);

    // -------------------------------------------------------------------------
    // Step 3: Submit to coordinator validate endpoint
    // -------------------------------------------------------------------------
    const valRes = await safeFetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });
    expect(valRes.ok).toBe(true);

    const valResult = await valRes.json();

    // -------------------------------------------------------------------------
    // Step 4: Validate response bounds and shape
    // -------------------------------------------------------------------------
    expect(typeof valResult.valid).toBe('boolean');

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
    // errors array should be absent or empty on a valid proposal
    if (valResult.errors !== undefined) {
      expect(Array.isArray(valResult.errors)).toBe(true);
      expect(valResult.errors.length).toBe(0);
    }

    // Track for teardown logging
    recordCreatedProposal(proposalId, slot.slotId);
  });

  it('builds and signs a multi-slot proposal and validates it', async () => {
    // -------------------------------------------------------------------------
    // Fetch schema and use the first two slots (or one if only one exists)
    // -------------------------------------------------------------------------
    const schemaRes = await safeFetch(`${COORDINATOR_URL}/api/slots`);
    expect(schemaRes.ok).toBe(true);
    const schema = await schemaRes.json();

    const targetSlots = schema.slots.slice(0, 2);
    expect(targetSlots.length).toBeGreaterThan(0);

    const modifications = targetSlots.map(
      (slot: { slotId: string; range: { min: number; max: number } }) => ({
        slotId: slot.slotId,
        // Use 25th percentile to vary from single-slot test's midpoint
        proposedValue: slot.range.min + (slot.range.max - slot.range.min) * 0.25,
      })
    );

    const proposalId = crypto.randomUUID();
    const proposal = signTestProposal({
      proposalId,
      modifications,
      hypothesis: 'E2E proposal-flow test: multi-slot 25th-percentile submission.',
    });

    const valRes = await safeFetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });
    expect(valRes.ok).toBe(true);

    const valResult = await valRes.json();
    expect(typeof valResult.valid).toBe('boolean');

    if (!valResult.valid) {
      const errors = Array.isArray(valResult.errors)
        ? valResult.errors.join('; ')
        : JSON.stringify(valResult);
      throw new Error(`Multi-slot proposal validation failed: ${errors}`);
    }

    expect(valResult.valid).toBe(true);

    // Track for teardown logging
    for (const mod of modifications) {
      recordCreatedProposal(proposalId, mod.slotId);
    }
  });

  it('rejects a proposal with an out-of-range value', async () => {
    const schemaRes = await safeFetch(`${COORDINATOR_URL}/api/slots`);
    expect(schemaRes.ok).toBe(true);
    const schema = await schemaRes.json();
    const slot = schema.slots[0];

    // Deliberately exceed the max by a large margin
    const outOfRangeValue = slot.range.max + Math.abs(slot.range.max) + 1;

    const proposalId = crypto.randomUUID();
    const proposal = signTestProposal({
      proposalId,
      modifications: [
        { slotId: slot.slotId, proposedValue: outOfRangeValue },
      ],
      hypothesis: 'E2E proposal-flow test: out-of-range value should be rejected.',
    });

    const valRes = await safeFetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });
    // Endpoint itself returns 200; validity is in the body
    expect(valRes.ok).toBe(true);

    const valResult = await valRes.json();
    expect(valResult.valid).toBe(false);
    expect(Array.isArray(valResult.errors)).toBe(true);
    expect(valResult.errors.length).toBeGreaterThan(0);
  });

  it('rejects a proposal missing required fields', async () => {
    // No proposalId, no modifications, no signature
    const valRes = await safeFetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hypothesis: 'incomplete' }),
    });

    // Coordinator may return 200 with valid:false, or 400 — both are acceptable
    const isClientError = valRes.status >= 400 && valRes.status < 500;
    const isOk = valRes.ok;
    expect(isOk || isClientError).toBe(true);

    if (valRes.ok) {
      const valResult = await valRes.json();
      expect(valResult.valid).toBe(false);
    }
  });

  it('POST /api/proposals requires authorisation (returns 401)', async () => {
    // This endpoint is guarded and must NOT be open to unsigned submissions.
    // Confirm the gate is in place so a regression would be caught immediately.
    const schemaRes = await safeFetch(`${COORDINATOR_URL}/api/slots`);
    const schema = await schemaRes.json();
    const slot = schema.slots[0];
    const midValue = (slot.range.min + slot.range.max) / 2;

    const proposalId = crypto.randomUUID();
    const proposal = signTestProposal({
      proposalId,
      modifications: [{ slotId: slot.slotId, proposedValue: midValue }],
      hypothesis: 'E2E auth gate test.',
    });

    const submitRes = await safeFetch(`${COORDINATOR_URL}/api/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    expect(submitRes.status).toBe(401);
  });

  it('coordinator status is healthy after proposal submissions', async () => {
    const statusRes = await safeFetch(`${COORDINATOR_URL}/status`);
    expect(statusRes.ok).toBe(true);

    const status = await statusRes.json();
    expect(status.service).toBe('behemoth-coordinator');
    expect(typeof status.version).toBe('string');
    expect(typeof status.uptime).toBe('number');
    // uptime must be a finite positive number — not NaN/Infinity
    expect(isFinite(status.uptime)).toBe(true);
    expect(status.uptime).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Core-loop integration test — plan 09-testing/03-e2e-core-loop
  //
  // This test exercises every step of the researcher workflow that is
  // observable over HTTP:
  //
  //   1. Schema discovery  — fetch /api/slots, assert structure
  //   2. Valid proposal    — build modifications from real slot data
  //   3. Signing           — signTestProposal produces correct auth fields
  //   4. Submission        — POST to /api/proposals/validate
  //   5. Acceptance check  — assert HTTP 200 and valid:true
  //   6. Result polling    — no HTTP status endpoint exists yet; the test
  //                          asserts acceptance and documents the poll stub
  //   7. Response schema   — validate every field in the validation response
  //
  // Random proposalId ensures idempotency across repeated runs.
  // -------------------------------------------------------------------------
  it('core loop: schema → build → sign → submit → verify acceptance (plan 09-testing/03)', async () => {
    // -----------------------------------------------------------------------
    // Step 1: Fetch slot schema and assert its structure
    // -----------------------------------------------------------------------
    const schema = await fetchSlotSchema(COORDINATOR_URL);

    expect(typeof schema.version).toBe('string');
    expect(schema.version.length).toBeGreaterThan(0);
    expect(Array.isArray(schema.slots)).toBe(true);
    expect(schema.slots.length).toBeGreaterThan(0);

    // Every slot must carry the required fields
    for (const slot of schema.slots) {
      expect(typeof slot.slotId).toBe('string');
      expect(slot.slotId.length).toBeGreaterThan(0);
      expect(typeof slot.range).toBe('object');
      expect(typeof slot.range.min).toBe('number');
      expect(typeof slot.range.max).toBe('number');
      expect(isFinite(slot.range.min)).toBe(true);
      expect(isFinite(slot.range.max)).toBe(true);
      expect(slot.range.max).toBeGreaterThanOrEqual(slot.range.min);
      // currentValue must be null — internal values are hidden from researchers
      expect(slot.currentValue).toBeNull();
    }

    // -----------------------------------------------------------------------
    // Step 2: Build a valid proposal using multiple slots (up to 3)
    //
    // Use the 75th-percentile value so this test differs from the midpoint
    // and 25th-percentile used in other tests.
    // -----------------------------------------------------------------------
    const targetSlots = schema.slots.slice(0, Math.min(3, schema.slots.length));
    const modifications = targetSlots.map((slot: SlotDefinition) => ({
      slotId: slot.slotId,
      proposedValue: slot.range.min + (slot.range.max - slot.range.min) * 0.75,
    }));

    // -----------------------------------------------------------------------
    // Step 3: Sign the proposal — all auth fields must be populated
    // -----------------------------------------------------------------------
    const proposalId = crypto.randomUUID();
    const proposal = signTestProposal({
      proposalId,
      modifications,
      hypothesis:
        'E2E core-loop test (plan 09-testing/03): 75th-percentile multi-slot submission.',
    });

    // Verify the auth fields produced by signTestProposal
    expect(typeof proposal.researcher).toBe('string');
    expect(proposal.researcher.length).toBeGreaterThan(0);
    // researcher must match the shared test keypair's public key
    expect(proposal.researcher).toBe(testResearcherPubkey);

    expect(typeof proposal.nonce).toBe('string');
    expect(proposal.nonce.length).toBeGreaterThan(0);

    expect(typeof proposal.timestamp).toBe('number');
    expect(isFinite(proposal.timestamp)).toBe(true);
    // timestamp must be recent (within the last 10 seconds)
    expect(Date.now() - proposal.timestamp).toBeLessThan(10_000);

    expect(typeof proposal.signature).toBe('string');
    expect(proposal.signature.length).toBeGreaterThan(0);

    // proposalId must be a random UUID — not a static/colliding value
    expect(proposal.proposalId).toBe(proposalId);
    // Basic UUID format check (8-4-4-4-12 hex groups)
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(proposalId)).toBe(true);

    // Modifications must be correctly forwarded
    expect(Array.isArray(proposal.modifications)).toBe(true);
    expect(proposal.modifications.length).toBe(modifications.length);
    for (let i = 0; i < modifications.length; i++) {
      expect(proposal.modifications[i].slotId).toBe(modifications[i].slotId);
      expect(proposal.modifications[i].proposedValue).toBe(modifications[i].proposedValue);
    }

    // -----------------------------------------------------------------------
    // Step 4: Submit to /api/proposals/validate
    // -----------------------------------------------------------------------
    const valResult = await submitProposal(COORDINATOR_URL, proposal as Record<string, unknown>);

    // -----------------------------------------------------------------------
    // Step 5: Assert acceptance — HTTP 200 is guaranteed by submitProposal();
    //         assert that the coordinator accepted the proposal as valid.
    // -----------------------------------------------------------------------
    expect(typeof valResult.valid).toBe('boolean');

    if (!valResult.valid) {
      const errors = Array.isArray(valResult.errors)
        ? valResult.errors.join('; ')
        : JSON.stringify(valResult);
      throw new Error(
        `Core-loop proposal was rejected for slots [${modifications.map((m) => m.slotId).join(', ')}]: ${errors}`,
      );
    }

    expect(valResult.valid).toBe(true);

    // -----------------------------------------------------------------------
    // Step 6: Result availability
    //
    // The coordinator has no HTTP endpoint for backtest results — they arrive
    // over P2P and are stored in Redis under "coordinator:impact:{proposalId}".
    // A poll loop cannot be wired here without a status endpoint.  The
    // acceptance check above is the deepest signal available over HTTP.
    //
    // When the coordinator gains a /api/proposals/{id}/status endpoint, replace
    // this comment with a call to the pollForProposalStatus() helper in this
    // file to wait for status !== 'pending'.
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Step 7: Validate the response schema — every required field must be present
    // -----------------------------------------------------------------------

    // `valid` is boolean — already checked above
    // `errors` is either absent, null, or an empty array on a valid proposal
    if (valResult.errors !== undefined && valResult.errors !== null) {
      expect(Array.isArray(valResult.errors)).toBe(true);
      expect((valResult.errors as unknown[]).length).toBe(0);
    }

    // Track for teardown logging (Redis cleanup)
    for (const mod of modifications) {
      recordCreatedProposal(proposalId, mod.slotId);
    }
  });

  it('core loop: each run uses a unique random proposalId (collision guard)', async () => {
    // Generate two proposals back-to-back and confirm their IDs are distinct.
    // This guards against accidental use of a shared/static ID in helper code.
    const schema = await fetchSlotSchema(COORDINATOR_URL);
    const slot = schema.slots[0];
    const buildProposal = () =>
      signTestProposal({
        proposalId: crypto.randomUUID(),
        modifications: [
          { slotId: slot.slotId, proposedValue: (slot.range.min + slot.range.max) / 2 },
        ],
        hypothesis: 'E2E collision-guard test.',
      });

    const p1 = buildProposal();
    const p2 = buildProposal();

    expect(p1.proposalId).not.toBe(p2.proposalId);
    // nonces must also be unique
    expect(p1.nonce).not.toBe(p2.nonce);
    // signatures must differ even for the same slot/value because of unique nonce+proposalId
    expect(p1.signature).not.toBe(p2.signature);

    // Submit both and confirm both are accepted
    const r1 = await submitProposal(COORDINATOR_URL, p1 as Record<string, unknown>);
    const r2 = await submitProposal(COORDINATOR_URL, p2 as Record<string, unknown>);

    expect(r1.valid).toBe(true);
    expect(r2.valid).toBe(true);

    recordCreatedProposal(p1.proposalId, slot.slotId);
    recordCreatedProposal(p2.proposalId, slot.slotId);
  });
});
