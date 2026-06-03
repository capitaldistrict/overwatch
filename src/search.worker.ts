/// <reference lib="webworker" />
import MiniSearch from 'minisearch';

/**
 * Search worker for the Niskayuna parcel viewer.
 *
 * Privacy model:
 *   - Address & PIN search are always available.
 *   - Owner search is OFF by default; enabled only when the main thread asks for it
 *     AND the owner index URL was provided at init.
 *   - Owner search uses EXACT-MATCH ONLY (no fuzzy, no prefix) to prevent enumeration.
 */

interface AddressDoc {
  id: string;       // PIN (unique key)
  address: string;
  city?: string;
  zip?: string;
}
interface PinDoc {
  id: string;       // PIN (unique key)
  display: string;
}
interface OwnerDoc {
  id: string;       // PIN (unique key)
  owner: string;    // redacted form only ("Lastname, F.")
}

interface ParcelDoc {
  id: string;       // unique within MiniSearch
  pin: string;
  address: string;
  owner?: string;
}

let parcelSearch: MiniSearch<ParcelDoc> | null = null;
let ownerSearch: MiniSearch<ParcelDoc> | null = null;
let ownerEnabled = false;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

self.onmessage = async (event: MessageEvent) => {
  const { type, payload } = event.data ?? {};

  try {
    if (type === 'init') {
      const { addressIndexUrl, pinIndexUrl, ownerIndexUrl } = payload as {
        addressIndexUrl: string;
        pinIndexUrl: string;
        ownerIndexUrl?: string;
      };

      const [addresses, pins] = await Promise.all([
        fetchJson<AddressDoc[]>(addressIndexUrl),
        fetchJson<PinDoc[]>(pinIndexUrl),
      ]);

      // Merge by PIN so each parcel has one MiniSearch document.
      const byPin = new Map<string, ParcelDoc>();
      for (const a of addresses) {
        byPin.set(a.id, { id: a.id, pin: a.id, address: a.address });
      }
      for (const p of pins) {
        if (!byPin.has(p.id)) {
          byPin.set(p.id, { id: p.id, pin: p.id, address: p.display });
        }
      }

      parcelSearch = new MiniSearch<ParcelDoc>({
        fields: ['address', 'pin'],
        storeFields: ['pin', 'address'],
        searchOptions: {
          boost: { address: 2, pin: 1.5 },
          fuzzy: 0.2,
          prefix: true,
        },
      });
      parcelSearch.addAll(Array.from(byPin.values()));

      // Owner index is OPTIONAL and kept in a separate MiniSearch instance.
      // Exact-match only — prevents fuzzy/prefix enumeration of owner names.
      if (ownerIndexUrl) {
        try {
          const owners = await fetchJson<OwnerDoc[]>(ownerIndexUrl);
          ownerSearch = new MiniSearch<ParcelDoc>({
            fields: ['owner'],
            storeFields: ['pin', 'address', 'owner'],
            searchOptions: {
              fuzzy: false,
              prefix: false,
              combineWith: 'AND',
            },
          });
          ownerSearch.addAll(
            owners.map((o) => {
              const parcel = byPin.get(o.id);
              return {
                id: o.id,
                pin: o.id,
                address: parcel?.address ?? '',
                owner: o.owner,
              };
            })
          );
          ownerEnabled = true;
        } catch (err) {
          // Owner index optional — fail open without blocking address search.
          console.warn('Owner index not available:', err);
        }
      }

      self.postMessage({ type: 'ready', payload: { ownerSearchAvailable: ownerEnabled } });
      return;
    }

    if (type === 'search') {
      if (!parcelSearch) {
        self.postMessage({ type: 'results', payload: [] });
        return;
      }
      const { query, includeOwner = false } = payload as {
        query: string;
        includeOwner?: boolean;
      };

      const trimmed = (query ?? '').trim();
      if (!trimmed) {
        self.postMessage({ type: 'results', payload: [] });
        return;
      }

      const results = parcelSearch.search(trimmed).slice(0, 50);

      // Owner search is additive, exact-match only, capped low.
      if (includeOwner && ownerEnabled && ownerSearch) {
        const ownerHits = ownerSearch.search(trimmed).slice(0, 20);
        for (const hit of ownerHits) {
          if (!results.find((r) => r.id === hit.id)) results.push(hit);
        }
      }

      self.postMessage({ type: 'results', payload: results });
      return;
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      payload: { message: err instanceof Error ? err.message : String(err) },
    });
  }
};
