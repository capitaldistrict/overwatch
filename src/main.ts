import maplibregl from 'maplibre-gl';
import { publicAssetUrl } from './assets';
import { getParcelOverflightImpact, initMap, highlightParcel } from './map';
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
const mainShell = document.getElementById('main-shell') as HTMLElement;
const drawerEl = document.getElementById('panel') as HTMLElement;
const drawerHandle = document.getElementById('drawer-handle') as HTMLButtonElement | null;
const drawerStateLabel = document.getElementById('drawer-state-label') as HTMLSpanElement | null;

type DrawerState = 'peek' | 'medium' | 'expanded';

const mobileDrawerQuery = window.matchMedia('(max-width: 720px)');
let drawerState: DrawerState = 'medium';
let drawerDragStartY = 0;
let drawerDragStartHeight = 0;
let drawerDragActive = false;
let suppressNextDrawerClick = false;
let lastPanelProps: { pin?: string; address?: string; owner?: string; [k: string]: unknown } | null = null;

initMobileDrawer();

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
  revealDrawerForDetails();
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
  lastPanelProps = props;
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

  appendOverflightSection(props);
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

function appendOverflightSection(props: { pin?: string; [k: string]: unknown }): void {
  const pin = (props.source_pin as string) || (props.pin as string) || (props.parcel_id as string);
  const impact = getParcelOverflightImpact(pin);
  if (!impact) return;

  const section = document.createElement('div');
  section.className = 'panel-section overflight-section';
  section.innerHTML = '<h3>Overflights</h3>';
  appendKV(section, 'Observed points', formatCount(impact.count));
  appendKV(section, 'Unique flights', formatCount(impact.flight_count));
  appendKV(section, 'Lowest altitude', formatFeet(impact.min_altitude_ft));
  appendKV(section, 'Latest altitude', formatFeet(impact.latest_altitude_ft));
  appendKV(section, 'Impact band', impactBandLabel(impact.altitude_severity));
  appendKV(section, 'Latest observed', formatPanelTime(impact.last_observed_at));
  panelEl.appendChild(section);
}

function formatCount(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number).toLocaleString('en-US') : '0';
}

function formatFeet(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number).toLocaleString('en-US')} ft` : '\u2014';
}

function formatPanelTime(value: unknown): string {
  if (typeof value !== 'string') return '\u2014';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '\u2014';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function impactBandLabel(value: unknown): string {
  if (value === 'low') return 'low altitude';
  if (value === 'medium') return 'under 5,000 ft';
  if (value === 'elevated') return 'under 10,000 ft';
  if (value === 'subtle') return '10,000+ ft';
  return 'unknown';
}

document.addEventListener('parcel-overflights-updated', () => {
  if (lastPanelProps) renderPanel(lastPanelProps);
});

// --- Map click → panel --------------------------------------------------

map.on('click', (e) => {
  const feats = map.queryRenderedFeatures(e.point, { layers: ['parcels-fill'] });
  if (!feats.length) return;
  const f = feats[0];
  const props = (f.properties ?? {}) as Record<string, unknown>;
  const sourcePin = (props.pin as string) ?? null;
  highlightParcel(map, sourcePin);
  renderPanel({ ...props, source_pin: sourcePin ?? undefined, parcel_id: sourcePin ?? undefined });
  revealDrawerForDetails();
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

// --- Mobile drawer ------------------------------------------------------

function initMobileDrawer(): void {
  if (!drawerHandle) return;

  setDrawerState('medium', { immediate: true });

  drawerHandle.addEventListener('click', () => {
    if (suppressNextDrawerClick) {
      suppressNextDrawerClick = false;
      return;
    }
    if (!isMobileDrawer()) return;
    setDrawerState(nextDrawerState(drawerState));
  });

  drawerHandle.addEventListener('pointerdown', (event) => {
    if (!isMobileDrawer()) return;
    drawerDragActive = true;
    suppressNextDrawerClick = false;
    drawerDragStartY = event.clientY;
    drawerDragStartHeight = drawerEl.getBoundingClientRect().height;
    drawerEl.dataset.dragging = 'true';
    drawerHandle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  drawerHandle.addEventListener('pointermove', (event) => {
    if (!drawerDragActive) return;
    const delta = drawerDragStartY - event.clientY;
    if (Math.abs(delta) > 8) suppressNextDrawerClick = true;
    const { peek, expanded } = getDrawerHeights();
    const nextHeight = clamp(drawerDragStartHeight + delta, peek, expanded);
    setDrawerHeight(nextHeight);
  });

  const endDrag = (event: PointerEvent) => {
    if (!drawerDragActive) return;
    drawerDragActive = false;
    delete drawerEl.dataset.dragging;
    drawerHandle.releasePointerCapture(event.pointerId);
    setDrawerState(nearestDrawerState(drawerEl.getBoundingClientRect().height));
  };

  drawerHandle.addEventListener('pointerup', endDrag);
  drawerHandle.addEventListener('pointercancel', endDrag);

  window.addEventListener('resize', () => setDrawerState(drawerState, { immediate: true }));
  mobileDrawerQuery.addEventListener('change', () => setDrawerState(drawerState, { immediate: true }));
}

function revealDrawerForDetails(): void {
  if (isMobileDrawer()) setDrawerState('expanded');
}

function isMobileDrawer(): boolean {
  return mobileDrawerQuery.matches;
}

function nextDrawerState(current: DrawerState): DrawerState {
  if (current === 'medium') return 'expanded';
  if (current === 'expanded') return 'peek';
  return 'medium';
}

function nearestDrawerState(height: number): DrawerState {
  const heights = getDrawerHeights();
  const candidates: DrawerState[] = ['peek', 'medium', 'expanded'];
  return candidates.reduce((best, candidate) => {
    const bestDistance = Math.abs(height - heights[best]);
    const candidateDistance = Math.abs(height - heights[candidate]);
    return candidateDistance < bestDistance ? candidate : best;
  }, 'medium' as DrawerState);
}

function setDrawerState(state: DrawerState, options: { immediate?: boolean } = {}): void {
  drawerState = state;
  mainShell.dataset.drawerState = state;
  drawerEl.dataset.drawerState = state;
  drawerEl.style.removeProperty('--drawer-drag-height');
  setDrawerHeight(getDrawerHeights()[state]);

  if (drawerHandle) {
    drawerHandle.setAttribute('aria-expanded', String(state === 'expanded'));
    drawerHandle.setAttribute('aria-label', drawerLabelForState(state));
    drawerHandle.dataset.drawerState = state;
  }
  if (drawerStateLabel) {
    drawerStateLabel.textContent = drawerVisibleLabelForState(state);
  }

  const resizeMap = () => map.resize();
  if (options.immediate) {
    resizeMap();
  } else {
    window.setTimeout(resizeMap, 220);
  }
}

function setDrawerHeight(height: number): void {
  const rounded = `${Math.round(height)}px`;
  mainShell.style.setProperty('--drawer-overlay-height', rounded);
  drawerEl.style.setProperty('--drawer-drag-height', rounded);
}

function getDrawerHeights(): Record<DrawerState, number> {
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const mainHeight = mainShell.getBoundingClientRect().height || viewportHeight;
  const compact = window.matchMedia('(max-width: 420px)').matches;
  const peek = clamp(viewportHeight * 0.15, 108, 136);
  const medium = clamp(viewportHeight * (compact ? 0.32 : 0.35), 210, compact ? 304 : 352);
  const expanded = Math.max(medium, mainHeight - 52);
  return { peek, medium, expanded };
}

function drawerLabelForState(state: DrawerState): string {
  if (state === 'expanded') return 'Collapse overflight drawer';
  if (state === 'peek') return 'Open overflight drawer';
  return 'Expand overflight drawer';
}

function drawerVisibleLabelForState(state: DrawerState): string {
  if (state === 'expanded') return 'Drawer fully open';
  if (state === 'peek') return 'Drawer minimized';
  return 'Drawer half open';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
