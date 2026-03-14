/**
 * Integration Tests
 *
 * Tests cross-service integration
 */

import { describe, it, expect } from 'bun:test';

const TRADER_URL = process.env.TRADER_URL || 'http://trader:8080';
const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://coordinator:8081';

describe('Integration: Error Handling', () => {
  it('coordinator handles malformed JSON', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/proposals/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json{{{',
    });

    expect(response.status).toBe(400);
  });

  it('services return 404 for unknown endpoints', async () => {
    const traderResponse = await fetch(`${TRADER_URL}/nonexistent`);
    expect(traderResponse.status).toBe(404);

    const coordResponse = await fetch(`${COORDINATOR_URL}/nonexistent`);
    expect(coordResponse.status).toBe(404);
  });
});

describe('Integration: Data Consistency', () => {
  it('slot schema has required fields', async () => {
    const response = await fetch(`${COORDINATOR_URL}/api/slots`);
    expect(response.ok).toBe(true);
    const schema = await response.json();

    expect(schema.version).toBeDefined();
    expect(Array.isArray(schema.slots)).toBe(true);

    if (schema.slots.length > 0) {
      const slot = schema.slots[0];
      expect(slot.slotId).toBeDefined();
    }
  });
});

