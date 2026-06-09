// ─── In-memory boutique config cache ──────────────────────────────────────────
//
// The WhatsApp webhook reads the boutique (by phoneNumberId) on every incoming
// message. That config rarely changes, so we cache the full boutique document —
// including the decrypted accessToken, which the model's post-find hook already
// decrypts on read — for a short TTL to avoid a DB round-trip per message.
//
// Process-local Map (not Redis): SALO runs a single Railway instance today, and
// the TTL bounds staleness. Config edits via the owner app call
// invalidateBoutiqueCache so the next message picks up the change immediately.

import type { BoutiqueLean } from "#/modules/boutiques/boutique.service.js";

const TTL_MS = 5 * 60 * 1000; // 5 minutes

const cache = new Map<string, { boutique: BoutiqueLean; expiresAt: number }>();

// Keyed by phoneNumberId — the lookup key used by the webhook handler.
export function getCachedBoutique(phoneNumberId: string): BoutiqueLean | null {
  const entry = cache.get(phoneNumberId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(phoneNumberId);
    return null;
  }
  return entry.boutique;
}

export function setCachedBoutique(
  phoneNumberId: string,
  boutique: BoutiqueLean,
): void {
  cache.set(phoneNumberId, { boutique, expiresAt: Date.now() + TTL_MS });
}

// Invalidates by boutiqueId (not phoneNumberId): after an agentConfig update we
// know the boutiqueId from the JWT but not the phoneNumberId. Iterate entries
// and delete any whose boutique._id matches.
export function invalidateBoutiqueCache(boutiqueId: string): void {
  for (const [key, entry] of cache.entries()) {
    if (entry.boutique._id.toString() === boutiqueId) {
      cache.delete(key);
    }
  }
}

// Drops every entry. Used by the test harness for isolation between tests, since
// the cache is module-level state that otherwise survives across them.
export function clearBoutiqueCache(): void {
  cache.clear();
}
