import { publicAssetUrl } from './assets';

export interface ParcelIdentity {
  parcel_id: string | null;
  source_pin: string | null;
  source_field: string | null;
  source_value: string | null;
  canonical_source_available: boolean;
  warnings: string[];
}

export interface ParcelOverflightEvent {
  parcel_id: string;
  source_pin: string;
  event_id?: string;
  event_time?: string;
  breach_type?: string;
  [key: string]: unknown;
}

const DEFAULT_IDENTITY_INDEX_URL = publicAssetUrl('indexes/parcel-identity-index.json');

let identityIndexPromise: Promise<Map<string, ParcelIdentity>> | null = null;

function normalizeIndexKey(pin: string | null | undefined): string | null {
  const trimmed = pin?.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function fallbackIdentity(pin: string): ParcelIdentity {
  return {
    parcel_id: pin,
    source_pin: pin,
    source_field: 'pin',
    source_value: pin,
    canonical_source_available: false,
    warnings: ['identity mapping unavailable; using viewer pin fallback'],
  };
}

export async function loadParcelIdentityIndex(
  url = DEFAULT_IDENTITY_INDEX_URL
): Promise<Map<string, ParcelIdentity>> {
  if (!identityIndexPromise) {
    identityIndexPromise = fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
        const raw = (await res.json()) as Record<string, ParcelIdentity>;
        return new Map(Object.entries(raw));
      })
      .catch((err) => {
        console.warn('Parcel identity index unavailable:', err);
        return new Map<string, ParcelIdentity>();
      });
  }
  return identityIndexPromise;
}

export async function resolveParcelIdentityFromPin(pin: string): Promise<ParcelIdentity> {
  const key = normalizeIndexKey(pin);
  if (!key) return fallbackIdentity(pin);

  const index = await loadParcelIdentityIndex();
  return index.get(key) ?? fallbackIdentity(pin);
}

export function requireOverflightEventIdentity(event: Partial<ParcelOverflightEvent>): ParcelOverflightEvent {
  if (!event.parcel_id || !event.source_pin) {
    throw new Error('Overflight events must include both parcel_id and source_pin');
  }
  return event as ParcelOverflightEvent;
}
