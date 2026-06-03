import maplibregl from 'maplibre-gl';
import { publicAssetUrl } from './assets';
import { initMap, highlightParcel } from './map';
import { resolveParcelIdentityFromPin } from './parcelIdentity';
import './styles.css';

console.log('[App] Starting Niskayuna Parcel Viewer...');

type SearchHit = {
  id: string;
  pin: string;
  address: string;
  owner?: string;
};

const map = initMap('map');

const searchInput = document.getElementById('search') as HTMLInputElement;
const ownerToggle = document.getElementById('owner-toggle') as HTMLInputElement;
const resultsEl = document.getElementById('results') as HTMLDivElement;
const panelEl = document.getElementById('parcel-detail') as HTMLDivElement;

// --- Search worker -------------------------------------------------------

const searchWorker = new Worker(new URL('./search.worker.ts', import.meta.url), {
  type: 'module',
});

searchWorker.postMessage({
  type: 'init',
  payload: {
    addressIndexUrl: publicAssetUrl('indexes/address-index.json'),
    pinIndexUrl: publicAssetUrl('indexes/pin-index.json'),
    ownerIndexUrl: publicAssetUrl('indexes/owner-index.json'), // optional; worker fails open if missing
  },
});

searchWorker.onmessage = (e: MessageEvent) => {
  const { type, payload } = e.data ?? {};
  if (type === 'ready') {
    if (!payload?.ownerSearchAvailable) {
      ownerToggle.disabled = true;
      ownerToggle.parentElement?.setAttribute('title', 'Owner index not available.');
    }
  } else if (type === 'results') {
    renderResults(payload as SearchHit[]);
  } else if (type === 'error') {
    console.warn('Search worker error:', payload);
  }
};

// Debounce input → worker
let searchTimer: number | undefined;
searchInput.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  const query = searchInput.value.trim();
  if (query.length < 2) {
    resultsEl.innerHTML = '';
    resultsEl.classList.remove('open');
    return;
  }
  searchTimer = window.setTimeout(() => {
    searchWorker.postMessage({
      type: 'search',
      payload: { query, includeOwner: ownerToggle.checked },
    });
  }, 120);
});

ownerToggle.addEventListener('change', () => {
  // Re-run current query when owner toggle changes
  if (searchInput.value.trim().length >= 2) {
    searchInput.dispatchEvent(new Event('input'));
  }
});

// Dismiss dropdown on outside click
document.addEventListener('click', (e) => {
  if (!(e.target instanceof Node)) return;
  if (!resultsEl.contains(e.target) && e.target !== searchInput) {
    resultsEl.classList.remove('open');
  }
});

function renderResults(results: SearchHit[]): void {
  resultsEl.innerHTML = '';
  if (!results.length) {
    resultsEl.classList.remove('open');
    return;
  }
  for (const r of results.slice(0, 30)) {
    const div = document.createElement('div');
    div.className = 'result';
    div.setAttribute('role', 'option');
    const label = r.address || r.pin || '(no address)';
    div.innerHTML = `${escapeHtml(label)}<span class="pin">${escapeHtml(r.pin)}</span>`;
    div.addEventListener('click', () => {
      selectParcel(r);
      resultsEl.classList.remove('open');
      searchInput.value = label;
    });
    resultsEl.appendChild(div);
  }
  resultsEl.classList.add('open');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}

// --- Parcel selection / panel -------------------------------------------

function selectParcel(hit: SearchHit): void {
  const sourcePin = hit.pin;
  highlightParcel(map, sourcePin);
  renderPanel({ pin: sourcePin, source_pin: sourcePin, parcel_id: sourcePin, address: hit.address, owner: hit.owner });
  flyToPin(sourcePin);
  void resolveParcelIdentityFromPin(sourcePin).then((identity) => {
    renderPanel({
      pin: sourcePin,
      source_pin: identity.source_pin ?? sourcePin,
      parcel_id: identity.parcel_id ?? sourcePin,
      address: hit.address,
      owner: hit.owner,
      identity_warnings: identity.warnings,
    });
  });
}

/** Try to fly to a parcel by querying rendered features; falls back silently if not in view. */
function flyToPin(pin: string): void {
  const features = map.querySourceFeatures('parcels', {
    sourceLayer: 'parcels',
    filter: ['==', ['get', 'pin'], pin],
  });
  if (!features.length) return;
  const bounds = new maplibregl.LngLatBounds();
  for (const f of features) {
    const geom = (f.geometry ?? null) as GeoJSON.Geometry | null;
    if (!geom) continue;
    extendBounds(bounds, geom);
  }
  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, { padding: 60, maxZoom: 18, duration: 800 });
  }
}

function extendBounds(bounds: maplibregl.LngLatBounds, geom: GeoJSON.Geometry): void {
  const visit = (coord: number[] | number[][] | number[][][] | number[][][][]) => {
    if (typeof coord[0] === 'number') {
      bounds.extend(coord as [number, number]);
    } else {
      for (const c of coord as unknown[]) visit(c as number[]);
    }
  };
  if ('coordinates' in geom) visit(geom.coordinates as never);
}

function renderPanel(props: { pin?: string; address?: string; owner?: string; [k: string]: unknown }): void {
  panelEl.innerHTML = '';

  const rows: Array<[string, string | undefined]> = [
    ['Address', (props.address as string) || undefined],
    ['PIN', (props.pin as string) || undefined],
    ['Parcel ID', (props.parcel_id as string) || undefined],
    ['Owner', (props.owner as string) || undefined],
    ['Property class', props.prop_class as string | undefined],
    ['Acres', props.acres ? String(props.acres) : props.acreage ? String(props.acreage) : undefined],
    ['Frontage (ft)', props.front_feet ? String(props.front_feet) : undefined],
  ];

  for (const [k, v] of rows) {
    if (!v) continue;
    const row = document.createElement('div');
    row.className = 'panel-row';
    row.innerHTML = `<span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span>`;
    panelEl.appendChild(row);
  }

  // Valuation section (only if data present)
  const assessed = props.assessed_value ?? props.total_assessed;
  const fmv = props.full_market_value;
  if (assessed || fmv) {
    const section = document.createElement('div');
    section.className = 'panel-section';
    section.innerHTML = '<h3>2026 valuation</h3>';
    if (assessed) appendKV(section, 'Total assessed', formatMoney(assessed));
    if (fmv) appendKV(section, 'Full market value', formatMoney(fmv));
    panelEl.appendChild(section);
  }

  const trace = document.createElement('div');
  trace.className = 'panel-section';
  trace.innerHTML = '<h3>Source</h3>';
  appendKV(trace, 'Viewer PIN', (props.source_pin as string) || (props.pin as string) || '\u2014');
  appendKV(trace, 'Canonical parcel ID', (props.parcel_id as string) || '\u2014');
  panelEl.appendChild(trace);
}

function appendKV(parent: HTMLElement, k: string, v: string): void {
  const row = document.createElement('div');
  row.className = 'panel-row';
  row.innerHTML = `<span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span>`;
  parent.appendChild(row);
}

function formatMoney(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

// --- Map click → panel --------------------------------------------------

map.on('click', (e) => {
  const feats = map.queryRenderedFeatures(e.point, { layers: ['parcels-fill'] });
  if (!feats.length) return;
  const f = feats[0];
  const props = (f.properties ?? {}) as Record<string, unknown>;
  const sourcePin = (props.pin as string) ?? null;
  highlightParcel(map, sourcePin);
  renderPanel({ ...props, source_pin: sourcePin ?? undefined, parcel_id: sourcePin ?? undefined });
  if (sourcePin) {
    void resolveParcelIdentityFromPin(sourcePin).then((identity) => {
      renderPanel({
        ...props,
        source_pin: identity.source_pin ?? sourcePin,
        parcel_id: identity.parcel_id ?? sourcePin,
        identity_warnings: identity.warnings,
      });
    });
  }
});

map.on('mousemove', 'parcels-fill', () => {
  map.getCanvas().style.cursor = 'pointer';
});
map.on('mouseleave', 'parcels-fill', () => {
  map.getCanvas().style.cursor = '';
});

console.info('Niskayuna Parcel Viewer initialized.');
