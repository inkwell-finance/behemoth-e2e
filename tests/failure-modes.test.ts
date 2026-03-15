/**
 * E2E: Failure Mode & Input Validation Tests
 *
 * Tests HTTP hardening, input validation, and graceful error handling
 * without killing or restarting services (safe for CI).
 *
 * Covered scenarios:
 * - Malformed JSON → 400
 * - Oversized payload → 413
 * - Wrong Content-Type → 415
 * - Missing required proposal fields → validation errors
 * - Boundary slot values (min-1, max+1) → rejected
 * - 50 concurrent requests to /health → all succeed
 * - Client-side abort with very short timeout → aborts cleanly
 * - Unknown endpoints → 404
 * - Empty body POST → error, not crash
 * - Duplicate proposalId submitted twice → second handled gracefully
 */

import { describe, it, expect } from 'bun:test';
import { signTestProposal } from './setup';

const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://coordinator:8081';
const TRADER_URL = process.env.TRADER_URL || 'http://trader:8080';
const RESEARCHER_URL = process.env.RESEARCHER_URL || 'http://researcher:8082';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a well-formed, structurally valid proposal for a given proposalId.
 * The slot value is within range so validation passes unless we purposely
 * push it out of bounds.
 *
 * Uses a real Ed25519 signature via signTestProposal() so the coordinator's
 * signature check passes and slot-specific errors are exercised directly.
 */
function buildValidProposal(proposalId: string) {
  return signTestProposal({
    proposalId,
    modifications: [
      { slotId: 'allocation_momentum_class', proposedValue: 0.25 },
    ],
    hypothesis: 'Increasing momentum allocation improves Sharpe ratio in trending markets.',
  });
}

// ---------------------------------------------------------------------------
// 1. Malformed JSON
// ---------------------------------------------------------------------------

describe('E2E: Malformed Request Handling', () => {
  it('POST invalid JSON → 400, not 500', async () => {
    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"this is": not valid json!!!',
    });

    expect(res.status).toBe(400);

    const body = await res.json();
    // Response must include some error indication — not an internal stack trace
    expect(body).toBeDefined();
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain('stack');
  });

  it('service remains healthy after malformed request', async () => {
    // Fire a bad request first
    await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '<<<GARBAGE>>>',
    }).catch(() => {});

    const health = await fetch(`${COORDINATOR_URL}/health`);
    expect(health.ok).toBe(true);
    const data = await health.json();
    expect(data.status).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------
// 2. Oversized payload
// ---------------------------------------------------------------------------

describe('E2E: Oversized Payload Rejection', () => {
  it('POST 2 MB body → 413', async () => {
    // Coordinator enforces a 1 MB limit — 2 MB must be rejected
    const twoMegabytes = 'x'.repeat(2 * 1024 * 1024);

    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: twoMegabytes,
      // Give the server time to read and reject the stream
      signal: AbortSignal.timeout(15_000),
    });

    expect(res.status).toBe(413);
  });

  it('service remains healthy after oversized request', async () => {
    const health = await fetch(`${COORDINATOR_URL}/health`);
    expect(health.ok).toBe(true);
    const data = await health.json();
    expect(data.status).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------
// 3. Wrong Content-Type
// ---------------------------------------------------------------------------

describe('E2E: Content-Type Enforcement', () => {
  it('POST with text/plain → 415', async () => {
    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'some plain text',
    });

    expect(res.status).toBe(415);
  });

  it('POST with no Content-Type header → 415', async () => {
    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      body: '{"proposalId":"test"}',
      // Deliberately omit Content-Type
    });

    expect(res.status).toBe(415);
  });

  it('POST with application/x-www-form-urlencoded → 415', async () => {
    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'proposalId=test&modifications=',
    });

    expect(res.status).toBe(415);
  });
});

// ---------------------------------------------------------------------------
// 4. Invalid proposal structure — missing required fields
// ---------------------------------------------------------------------------

describe('E2E: Proposal Validation — Missing Required Fields', () => {
  it('completely empty object → validation errors', async () => {
    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    // The server returns 200 with valid:false, or 400 — either is acceptable
    // but the body must signal failure
    expect([200, 400]).toContain(res.status);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it('missing modifications array → validation error', async () => {
    // Sign with a placeholder modification, then strip modifications from the
    // submitted payload so the coordinator sees a structurally invalid proposal
    // rather than a signature error.
    const signed = signTestProposal({
      proposalId: `prop-${Date.now()}-abc123`,
      modifications: [{ slotId: 'allocation_momentum_class', proposedValue: 0.25 }],
      hypothesis: 'Testing without modifications field.',
    });
    const { modifications: _omitted, ...proposalWithoutMods } = signed;

    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposalWithoutMods),
    });

    expect([200, 400]).toContain(res.status);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it('empty modifications array → validation error', async () => {
    // Sign with empty modifications array — coordinator must reject this after
    // signature verification because at least one modification is required.
    const proposal = signTestProposal({
      proposalId: `prop-${Date.now()}-abc123`,
      modifications: [],   // invalid: must have at least one
      hypothesis: 'Testing with zero modifications.',
    });

    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    expect([200, 400]).toContain(res.status);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });

  it('missing hypothesis → validation error', async () => {
    // hypothesis is not part of the signed payload so omitting it is safe;
    // the coordinator must still reject proposals with no hypothesis.
    const signed = signTestProposal({
      proposalId: `prop-${Date.now()}-abc123`,
      modifications: [{ slotId: 'allocation_momentum_class', proposedValue: 0.25 }],
      hypothesis: 'placeholder — will be removed below',
    });
    const { hypothesis: _omitted, ...proposalWithoutHypothesis } = signed;

    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposalWithoutHypothesis),
    });

    expect([200, 400]).toContain(res.status);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });

  it('unknown slot ID → validation error naming the slot', async () => {
    const proposal = buildValidProposal(`prop-${Date.now()}-unknownslot`);
    proposal.modifications = [{ slotId: 'nonexistent_slot_xyz', proposedValue: 0.5 }];

    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    expect([200, 400]).toContain(res.status);
    const body = await res.json();
    expect(body.valid).toBe(false);
    const errorText = body.errors.join(' ');
    expect(errorText.toLowerCase()).toContain('nonexistent_slot_xyz');
  });
});

// ---------------------------------------------------------------------------
// 5. Boundary values
// ---------------------------------------------------------------------------

describe('E2E: Slot Boundary Value Validation', () => {
  // allocation_momentum_class: range [0, 0.5], step 0.01

  it('value below minimum (min-1 = -1) → rejected', async () => {
    const proposal = buildValidProposal(`prop-${Date.now()}-belowmin`);
    proposal.modifications = [{ slotId: 'allocation_momentum_class', proposedValue: -1 }];

    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    expect([200, 400]).toContain(res.status);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors.some((e: string) => e.includes('allocation_momentum_class'))).toBe(true);
  });

  it('value above maximum (max+1 = 1.5) → rejected', async () => {
    const proposal = buildValidProposal(`prop-${Date.now()}-abovemax`);
    proposal.modifications = [{ slotId: 'allocation_momentum_class', proposedValue: 1.5 }];

    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    expect([200, 400]).toContain(res.status);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors.some((e: string) => e.includes('allocation_momentum_class'))).toBe(true);
  });

  it('value at exact minimum (0) → accepted', async () => {
    const proposal = buildValidProposal(`prop-${Date.now()}-atmin`);
    proposal.modifications = [{ slotId: 'allocation_momentum_class', proposedValue: 0 }];

    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    const body = await res.json();
    expect(body.valid).toBe(true);
  });

  it('value at exact maximum (0.5) → accepted', async () => {
    const proposal = buildValidProposal(`prop-${Date.now()}-atmax`);
    proposal.modifications = [{ slotId: 'allocation_momentum_class', proposedValue: 0.5 }];

    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    const body = await res.json();
    expect(body.valid).toBe(true);
  });

  it('value not aligned to step (0.005) → rejected', async () => {
    const proposal = buildValidProposal(`prop-${Date.now()}-badstep`);
    // step is 0.01; 0.005 is between steps
    proposal.modifications = [{ slotId: 'allocation_momentum_class', proposedValue: 0.005 }];

    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    expect([200, 400]).toContain(res.status);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });

  it('risk_drawdown_limit below min (0.001) → rejected', async () => {
    // range: [0.02, 0.15]
    const proposal = buildValidProposal(`prop-${Date.now()}-risk-belowmin`);
    proposal.modifications = [{ slotId: 'risk_drawdown_limit', proposedValue: 0.001 }];

    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    expect([200, 400]).toContain(res.status);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });

  it('sizing_max_position above max (0.99) → rejected', async () => {
    // range: [0.01, 0.20]
    const proposal = buildValidProposal(`prop-${Date.now()}-sizing-abovemax`);
    proposal.modifications = [{ slotId: 'sizing_max_position', proposedValue: 0.99 }];

    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    expect([200, 400]).toContain(res.status);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Concurrent load on /health
// ---------------------------------------------------------------------------

describe('E2E: Concurrent Load', () => {
  it('50 simultaneous GET /health requests to coordinator all succeed', async () => {
    const requests = Array.from({ length: 50 }, () =>
      fetch(`${COORDINATOR_URL}/health`, {
        signal: AbortSignal.timeout(10_000),
      })
    );

    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
    }
  });

  it('50 simultaneous GET /health requests to trader all succeed', async () => {
    const requests = Array.from({ length: 50 }, () =>
      fetch(`${TRADER_URL}/health`, {
        signal: AbortSignal.timeout(10_000),
      })
    );

    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
    }
  });

  it('50 simultaneous GET /health requests to researcher all succeed', async () => {
    const requests = Array.from({ length: 50 }, () =>
      fetch(`${RESEARCHER_URL}/health`, {
        signal: AbortSignal.timeout(10_000),
      })
    );

    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
    }
  });

  it('services stay healthy after concurrent load burst', async () => {
    // Fire 50 concurrent requests then verify all three services are still up
    await Promise.all(
      Array.from({ length: 50 }, () =>
        fetch(`${COORDINATOR_URL}/health`).catch(() => null)
      )
    );

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

// ---------------------------------------------------------------------------
// 7. Client-side timeout / abort
// ---------------------------------------------------------------------------

describe('E2E: Client Abort Behavior', () => {
  it('request aborted by client with 1 ms timeout does not throw uncaught error', async () => {
    // The client aborts; the test verifies this is handled cleanly (throws
    // a DOMException / AbortError on the client side — not a server crash).
    let caughtError: unknown = null;

    try {
      await fetch(`${COORDINATOR_URL}/health`, {
        signal: AbortSignal.timeout(1),  // abort after 1 ms
      });
    } catch (err) {
      caughtError = err;
    }

    // The error must be an AbortError or TimeoutError — not a generic crash
    if (caughtError !== null) {
      expect(caughtError).toBeInstanceOf(Error);
      const name = (caughtError as Error).name;
      expect(['AbortError', 'TimeoutError']).toContain(name);
    }
    // If the server is local enough to reply in 1 ms, caughtError may be null — also fine
  });

  it('coordinator remains healthy after client-aborted requests', async () => {
    // Fire several rapidly-aborted requests
    await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        fetch(`${COORDINATOR_URL}/health`, { signal: AbortSignal.timeout(1) })
      )
    );

    // Service must still respond
    const res = await fetch(`${COORDINATOR_URL}/health`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.status).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------
// 8. Invalid (non-existent) endpoints
// ---------------------------------------------------------------------------

describe('E2E: Invalid Endpoint Handling', () => {
  it('GET /api/nonexistent on coordinator → 404', async () => {
    const res = await fetch(`${COORDINATOR_URL}/api/nonexistent`);
    expect(res.status).toBe(404);
  });

  it('GET /api/nonexistent on trader → 404', async () => {
    const res = await fetch(`${TRADER_URL}/api/nonexistent`);
    expect(res.status).toBe(404);
  });

  it('GET /api/nonexistent on researcher → 404', async () => {
    const res = await fetch(`${RESEARCHER_URL}/api/nonexistent`);
    expect(res.status).toBe(404);
  });

  it('GET /admin/secret on coordinator → 404', async () => {
    const res = await fetch(`${COORDINATOR_URL}/admin/secret`);
    expect(res.status).toBe(404);
  });

  it('GET deeply nested unknown path → 404', async () => {
    const res = await fetch(`${COORDINATOR_URL}/api/v99/internal/admin/debug/dump`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 9. Empty body POST
// ---------------------------------------------------------------------------

describe('E2E: Empty Body POST Handling', () => {
  it('POST with empty string body → error response, not crash', async () => {
    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });

    // Must not be a 5xx
    expect(res.status).toBeLessThan(500);
    // Should be a client error (4xx)
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('POST with null-like JSON body ("null") → error, not crash', async () => {
    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });

    // null parses as valid JSON but is not an object — should yield validation errors
    expect(res.status).toBeLessThan(500);
    const body = await res.json();
    // Either valid:false or an error key
    const isErrorResponse = body.valid === false || typeof body.error === 'string';
    expect(isErrorResponse).toBe(true);
  });

  it('service remains healthy after empty-body requests', async () => {
    await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    }).catch(() => {});

    const health = await fetch(`${COORDINATOR_URL}/health`);
    expect(health.ok).toBe(true);
    const data = await health.json();
    expect(data.status).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------
// 10. Duplicate proposal submission
// ---------------------------------------------------------------------------

describe('E2E: Duplicate Proposal Handling', () => {
  it('submitting same proposalId twice → second call handled gracefully (not crash)', async () => {
    const proposalId = `prop-${Date.now()}-dup`;
    const proposal = buildValidProposal(proposalId);
    const body = JSON.stringify(proposal);

    // The validate endpoint is stateless — both calls should return valid:true.
    // The important thing is neither call crashes the service.
    const [first, second] = await Promise.all([
      fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
      fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
    ]);

    // Neither response must be a server error
    expect(first.status).toBeLessThan(500);
    expect(second.status).toBeLessThan(500);

    const firstBody = await first.json();
    const secondBody = await second.json();

    // Both must have a well-formed response
    expect(typeof firstBody.valid).toBe('boolean');
    expect(typeof secondBody.valid).toBe('boolean');
  });

  it('duplicate slot modifications in one proposal → rejected', async () => {
    const proposal = buildValidProposal(`prop-${Date.now()}-dupslot`);
    // Add the same slotId twice in the modifications array
    proposal.modifications = [
      { slotId: 'allocation_momentum_class', proposedValue: 0.1 },
      { slotId: 'allocation_momentum_class', proposedValue: 0.2 },
    ];

    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    expect([200, 400]).toContain(res.status);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(
      body.errors.some((e: string) => e.toLowerCase().includes('duplicate'))
    ).toBe(true);
  });

  it('service stays healthy after duplicate submissions', async () => {
    const health = await fetch(`${COORDINATOR_URL}/health`);
    expect(health.ok).toBe(true);
    const data = await health.json();
    expect(data.status).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------
// 11. Signature Validation
// ---------------------------------------------------------------------------

describe('E2E: Signature Validation', () => {
  it('rejects proposal with corrupted signature', async () => {
    const proposal = buildValidProposal(`prop-${Date.now()}-corruptsig`);
    // Corrupt the last 2 characters of the signature by replacing with 'XX'
    proposal.signature = proposal.signature.slice(0, -2) + 'XX';

    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    expect([200, 400]).toContain(res.status);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });

  it('rejects proposal modified after signing', async () => {
    const proposal = buildValidProposal(`prop-${Date.now()}-modifiedafter`);
    // Modify a slot value after signing by adding a small amount
    // This changes the payload but keeps the original (now-invalid) signature
    proposal.modifications[0].proposedValue += 0.01;

    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    expect([200, 400]).toContain(res.status);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });

  it('rejects proposal with missing signature', async () => {
    const proposal = buildValidProposal(`prop-${Date.now()}-nosig`);
    // Delete the signature field entirely
    const { signature: _omitted, ...proposalWithoutSig } = proposal;

    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposalWithoutSig),
    });

    expect([200, 400]).toContain(res.status);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });

  it('accepts proposal with valid signature (regression check)', async () => {
    const proposal = buildValidProposal(`prop-${Date.now()}-validsig`);
    // This proposal has a valid signature and has not been modified

    const res = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });

    const body = await res.json();
    expect(body.valid).toBe(true);
  });

  it('service stays healthy after signature validation attempts', async () => {
    const health = await fetch(`${COORDINATOR_URL}/health`);
    expect(health.ok).toBe(true);
    const data = await health.json();
    expect(data.status).toBe('healthy');
  });
});
