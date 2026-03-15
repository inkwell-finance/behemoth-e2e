/**
 * Test Teardown
 *
 * Cleanup logic to run after all tests complete.
 *
 * Provides:
 * - In-process registry for proposal IDs created during the test run
 * - Structured logging of all created test artifacts for manual follow-up
 * - Service URL availability for any future API-based cleanup
 *
 * NOTE: The coordinator has no HTTP endpoint for deleting proposals or
 * clearing job-queue entries — those live in Redis and are keyed by proposal
 * ID.  This teardown therefore logs all created IDs so an operator can purge
 * them manually if needed (e.g. `DEL coordinator:impact:<proposalId>`).
 * If a cleanup endpoint is added to the coordinator in future, wire it up
 * inside globalTeardown() below.
 */

import { serviceUrls } from './setup';

// ---------------------------------------------------------------------------
// In-process registry — populated by test files via recordCreatedProposal()
// ---------------------------------------------------------------------------

interface CreatedProposal {
  proposalId: string;
  slotId: string;
  createdAt: number;
}

const createdProposals: CreatedProposal[] = [];

/**
 * Register a proposal ID that was created during a test.
 * Call this immediately after a successful submission so teardown can log
 * (and optionally clean up) the artifact.
 *
 * @param proposalId - The UUID used as the proposal's proposalId
 * @param slotId     - The slot that was targeted (for diagnostic context)
 */
export function recordCreatedProposal(proposalId: string, slotId: string): void {
  createdProposals.push({ proposalId, slotId, createdAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to delete a test artifact via a coordinator API endpoint.
 * Currently a no-op because the coordinator exposes no delete endpoint;
 * this is the hook to fill in when one is added.
 */
async function tryDeleteProposal(
  coordinatorUrl: string,
  proposalId: string,
): Promise<void> {
  // Future: DELETE /api/proposals/:proposalId
  // const res = await fetch(`${coordinatorUrl}/api/proposals/${proposalId}`, {
  //   method: 'DELETE',
  //   signal: AbortSignal.timeout(5_000),
  // });
  // if (!res.ok && res.status !== 404) {
  //   console.warn(`  Teardown: could not delete proposal ${proposalId}: ${res.status}`);
  // }
  void coordinatorUrl;
  void proposalId;
}

// ---------------------------------------------------------------------------
// Global teardown
// ---------------------------------------------------------------------------

/**
 * Global teardown function called after all tests complete.
 *
 * Logs every proposal created during the run.  If a coordinator cleanup
 * endpoint becomes available, replace the log-only block with an API call
 * via tryDeleteProposal().
 *
 * Usage — add to each test file's afterAll hook:
 *   import { globalTeardown } from './teardown';
 *   afterAll(async () => { await globalTeardown(); });
 */
export async function globalTeardown(): Promise<void> {
  console.log('\nE2E Test Teardown: Cleaning up...');

  if (createdProposals.length === 0) {
    console.log('  No test proposals were created during this run.');
  } else {
    console.log(
      `  ${createdProposals.length} test proposal(s) created during this run:`,
    );

    for (const entry of createdProposals) {
      const age = Date.now() - entry.createdAt;
      console.log(
        `    proposalId=${entry.proposalId}  slot=${entry.slotId}  age=${age}ms`,
      );

      // Attempt API cleanup (currently a no-op; see tryDeleteProposal above)
      await tryDeleteProposal(serviceUrls.coordinator, entry.proposalId);
    }

    console.log(
      '  NOTE: Coordinator stores proposal impact in Redis under keys ' +
      '"coordinator:impact:<proposalId>".  ' +
      'To purge manually: redis-cli DEL <key>',
    );
  }

  console.log('E2E Test Teardown: Complete.\n');
}
