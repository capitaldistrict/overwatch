import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { publicAssetUrl } from './assets';

// Configure the PMTiles URL via env var so we can swap R2/CDN/local without code changes.
// In dev, default to parcels.pmtiles served from /public.
const PMTILES_URL =
  (import.meta.env.VITE_PMTILES_URL as string | undefined)?.trim() || publicAssetUrl('parcels.pmtiles');

const EMPTY_FEATURE_COLLECTION: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

type Sparkline = {
  times?: Array<string | null>;
  altitude_ft?: Array<number | null>;
  speed_kt?: Array<number | null>;
  property_hits?: Array<number | null>;
};

type FlightSummary = {
  track_key: string;
  label?: string;
  flight?: string | null;
  aircraft_hex?: string | null;
  registration?: string | null;
  registration_source?: string | null;
  aircraft_type?: string | null;
  aircraft_type_description?: string | null;
  wake_turbulence_category?: string | null;
  operator_hint?: string | null;
  aircraft_class?: string | null;
  area?: string | null;
  active?: boolean;
  persisted?: boolean;
  geobounds_hit?: boolean;
  property_hits?: number;
  niskayuna_point_count?: number;
  corridor_point_count?: number;
  parcel_match_status?: string | null;
  first_observed_at?: string | null;
  last_observed_at?: string | null;
  first_geobounds_at?: string | null;
  last_geobounds_at?: string | null;
  altitude_ft?: number | null;
  speed_kt?: number | null;
  track_deg?: number | null;
  altitude_band_ft?: string | null;
  point_count?: number;
  impact_score?: number;
  sparkline?: Sparkline;
};

type FlightSummariesPayload = {
  updated_at?: string;
  active_count?: number;
  geobounds_count?: number;
  property_hit_count?: number;
  summaries: FlightSummary[];
};

type ParcelImpactSeverity = 'low' | 'medium' | 'elevated' | 'subtle' | 'unknown';
type MapLayerGroup = 'routes' | 'impact' | 'corridors' | 'aircraft' | 'parcels';
type AdsbRefreshMode = 'snapshot' | 'monitor';

type MapUiState = {
  layers: Record<MapLayerGroup, boolean>;
  selectedFlightKey: string | null;
  selectedFlightLabel: string | null;
};

export type ParcelOverflightImpact = {
  parcel_id?: string | null;
  source_pin?: string | null;
  count?: number | null;
  flight_count?: number | null;
  under_2500_count?: number | null;
  under_5000_count?: number | null;
  under_10000_count?: number | null;
  over_10000_count?: number | null;
  min_altitude_ft?: number | null;
  max_altitude_ft?: number | null;
  latest_altitude_ft?: number | null;
  latest_altitude_band_ft?: string | null;
  altitude_severity?: ParcelImpactSeverity | string | null;
  impact_score?: number | null;
  first_observed_at?: string | null;
  last_observed_at?: string | null;
  latest_flight?: string | null;
  latest_aircraft_hex?: string | null;
};

const ADSB_SOURCES = {
  aircraft: { id: 'adsb-aircraft-source', url: publicAssetUrl('adsb/live-aircraft.geojson') },
  trails: { id: 'adsb-trails-source', url: publicAssetUrl('adsb/live-trails.geojson') },
  historicalRoutes: { id: 'adsb-historical-routes-source', url: publicAssetUrl('adsb/historical-routes.geojson') },
  corridors: { id: 'adsb-corridors-source', url: publicAssetUrl('adsb/corridor-markers.geojson') },
  accumulated: { id: 'adsb-accumulated-source', url: publicAssetUrl('adsb/accumulated-corridors.geojson') },
  lowAltitudeBands: {
    id: 'adsb-low-altitude-corridor-bands-source',
    url: publicAssetUrl('adsb/low-altitude-corridor-bands.geojson'),
  },
  parcelOverflights: { id: 'adsb-parcel-overflights', url: publicAssetUrl('adsb/parcel-overflights.geojson') },
} as const;

const FLIGHT_SUMMARIES_URL = publicAssetUrl('adsb/flight-summaries.json');
const MOBILE_MAP_QUERY = '(max-width: 720px)';
const SNAPSHOT_REFRESH_MS = 60 * 1000;
const DEFAULT_MONITOR_REFRESH_MS = 5 * 1000;
const MIN_ACCUMULATED_REFRESH_MS = 60 * 1000;
const REFRESH_PREF_KEY = 'overwatch.adsbRefreshPreference';
const MONITOR_REFRESH_OPTIONS_MS = [5000, 15000, 30000, 60000];
const PARCEL_IMPACT_SEVERITIES: ParcelImpactSeverity[] = ['low', 'medium', 'elevated', 'subtle', 'unknown'];
const PARCEL_IMPACT_STYLES: Record<
  ParcelImpactSeverity,
  { fill: string; line: string; opacity: number; maxOpacity: number; lineOpacity: number }
> = {
  low: { fill: '#dc2626', line: '#991b1b', opacity: 0.3, maxOpacity: 0.46, lineOpacity: 0.74 },
  medium: { fill: '#f97316', line: '#c2410c', opacity: 0.21, maxOpacity: 0.34, lineOpacity: 0.6 },
  elevated: { fill: '#eab308', line: '#a16207', opacity: 0.12, maxOpacity: 0.22, lineOpacity: 0.42 },
  subtle: { fill: '#38bdf8', line: '#0284c7', opacity: 0.025, maxOpacity: 0.07, lineOpacity: 0.16 },
  unknown: { fill: '#94a3b8', line: '#475569', opacity: 0.08, maxOpacity: 0.14, lineOpacity: 0.3 },
};

const mapUiState: MapUiState = {
  layers: {
    routes: true,
    impact: true,
    corridors: true,
    aircraft: true,
    parcels: true,
  },
  selectedFlightKey: null,
  selectedFlightLabel: null,
};

const PROGRESSIVE_ZOOM = {
  lowAltitudeBands: 10.5,
  corridorMarkers: 10.75,
  parcelImpact: 12.6,
  parcelDetail: 13.4,
  highAltitudeParcelImpact: 14.3,
  aircraftLabels: 12.5,
} as const;

let selectedFlightFacet = 'all';
let lastFlightPayload: FlightSummariesPayload | null = null;
let activeMap: maplibregl.Map | null = null;
const adsbRefreshStarted = new WeakSet<maplibregl.Map>();
const parcelOverflightByPin = new Map<string, ParcelOverflightImpact>();
const parcelPinsBySeverity = new Map<ParcelImpactSeverity, string[]>(
  PARCEL_IMPACT_SEVERITIES.map((severity) => [severity, []])
);

let adsbRefreshMode: AdsbRefreshMode = 'snapshot';
let adsbMonitorRefreshMs = DEFAULT_MONITOR_REFRESH_MS;
let liveRefreshTimer: number | undefined;
let accumulatedRefreshTimer: number | undefined;

export function getParcelOverflightImpact(pin: string | null | undefined): ParcelOverflightImpact | null {
  const normalized = normalizePin(pin);
  return normalized ? parcelOverflightByPin.get(normalized) ?? null : null;
}

export function initMap(containerId: string): maplibregl.Map {
  // Register the pmtiles:// protocol with MapLibre.
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  console.log(`[Map] Registered PMTiles protocol. Loading from: ${PMTILES_URL}`);

  const map = new maplibregl.Map({
    container: containerId,
    // Minimal raster basemap. Swap for your own vector style if/when needed.
    style: {
      version: 8,
      sources: {
        basemap: {
          type: 'raster',
          tiles: [
            'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
            'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
            'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
          ],
          tileSize: 256,
          attribution: '\u00a9 OpenStreetMap contributors',
          maxzoom: 19,
        },
      },
      layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    },
    center: [-73.85, 42.82], // Niskayuna approx center
    zoom: 12,
    hash: true,
  });

  activeMap = map;
  setupMapUiControls(map);
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
  startAdsbRefresh(map);

  map.on('load', () => {
    console.log('[Map] Loaded. Adding parcels source and layers...');
    map.addSource('parcels', {
      type: 'vector',
      url: `pmtiles://${PMTILES_URL}`,
      promoteId: { parcels: 'pin' },
    });

    map.on('sourcedata', (e) => {
      if (e.sourceId === 'parcels' && (e as any).isSourceLoaded) {
        console.log('[Map] Parcels source loaded successfully.');
      }
    });

    map.addLayer({
      id: 'parcels-fill',
      type: 'fill',
      source: 'parcels',
      'source-layer': 'parcels',
      paint: {
        'fill-color': '#3b82f6',
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.025, 13, 0.055, 17, 0.1],
      },
    });

    map.addLayer({
      id: 'parcels-line',
      type: 'line',
      source: 'parcels',
      'source-layer': 'parcels',
      paint: {
        'line-color': '#1e40af',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.2, 16, 0.8, 19, 1.5],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.25, 15, 0.58, 19, 0.82],
      },
    });

    addParcelImpactLayers(map);
    addAdsbLayers(map);

    map.addLayer({
      id: 'parcels-highlight',
      type: 'line',
      source: 'parcels',
      'source-layer': 'parcels',
      paint: {
        'line-color': '#ef4444',
        'line-width': 2.5,
      },
      filter: ['==', ['get', 'pin'], '___none___'],
    });
    applyMapUiState(map);
  });

  console.log('[Map] initMap() complete. Map is ready.');
  return map;
}

/** Highlight a single parcel by PIN and fly to its location if geometry is in view. */
export function highlightParcel(map: maplibregl.Map, pin: string | null): void {
  if (!map.getLayer('parcels-highlight')) return;
  map.setFilter('parcels-highlight', ['==', ['get', 'pin'], pin ?? '___none___']);
}

function setupMapUiControls(map: maplibregl.Map): void {
  document.querySelectorAll<HTMLButtonElement>('[data-map-layer]').forEach((button) => {
    const group = button.dataset.mapLayer;
    if (!isMapLayerGroup(group)) return;
    button.addEventListener('click', () => {
      mapUiState.layers[group] = !mapUiState.layers[group];
      applyMapUiState(map);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-clear-flight-focus]').forEach((button) => {
    button.addEventListener('click', clearFlightFocus);
  });

  map.on('zoom', () => {
    renderProgressiveIndicator(map);
  });
  try {
    window.matchMedia(MOBILE_MAP_QUERY).addEventListener('change', () => {
      applyMapUiState(map);
      renderProgressiveIndicator(map);
    });
  } catch {
    // Older browsers can still use the static responsive CSS.
  }

  applyMapUiState(map);
}

function isMapLayerGroup(value: unknown): value is MapLayerGroup {
  return value === 'routes' || value === 'impact' || value === 'corridors' || value === 'aircraft' || value === 'parcels';
}

function applyMapUiState(map: maplibregl.Map): void {
  renderLayerControlState();
  renderFlightFocusState();
  renderProgressiveIndicator(map);
  applyLayerGroupVisibility(map);
  applyProgressiveZoomRanges(map);
  applyFocusPaint(map);
  applyParcelImpactFilters(map);
}

function renderLayerControlState(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-map-layer]').forEach((button) => {
    const group = button.dataset.mapLayer;
    if (!isMapLayerGroup(group)) return;
    const visible = mapUiState.layers[group];
    button.classList.toggle('selected', visible);
    button.setAttribute('aria-pressed', String(visible));
  });
}

function renderFlightFocusState(): void {
  const mapWrap = document.getElementById('map-wrap');
  const banner = document.getElementById('map-focus-banner');
  const label = document.getElementById('map-focus-label');
  const clearButtons = document.querySelectorAll<HTMLButtonElement>('[data-clear-flight-focus]');
  const focused = Boolean(mapUiState.selectedFlightKey);

  if (mapWrap) {
    if (mapUiState.selectedFlightKey) {
      mapWrap.dataset.flightFocus = mapUiState.selectedFlightKey;
    } else {
      delete mapWrap.dataset.flightFocus;
    }
  }
  if (label) {
    label.textContent = mapUiState.selectedFlightLabel
      ? `Focused on ${mapUiState.selectedFlightLabel}`
      : 'Focused flight';
  }
  if (banner) banner.hidden = !focused;
  clearButtons.forEach((button) => {
    button.hidden = !focused;
  });
}

function applyLayerGroupVisibility(map: maplibregl.Map): void {
  (Object.keys(mapUiState.layers) as MapLayerGroup[]).forEach((group) => {
    const visible = mapUiState.layers[group];
    for (const layerId of layerIdsForGroup(group)) {
      setLayerVisibility(map, layerId, visible);
    }
  });
}

function layerIdsForGroup(group: MapLayerGroup): string[] {
  if (group === 'routes') {
    return ['adsb-historical-routes-casing', 'adsb-historical-routes', 'adsb-trails-casing', 'adsb-trails'];
  }
  if (group === 'impact') {
    return [
      ...PARCEL_IMPACT_SEVERITIES.flatMap((severity) => [
        parcelImpactFillLayerId(severity),
        parcelImpactLineLayerId(severity),
      ]),
      'parcels-overflight-selected-fill',
      'parcels-overflight-selected-line',
    ];
  }
  if (group === 'corridors') {
    return [
      'adsb-low-altitude-corridor-bands-fill',
      'adsb-low-altitude-corridor-bands-line',
      'adsb-accumulated-corridors',
      'adsb-corridors',
    ];
  }
  if (group === 'aircraft') return ['adsb-aircraft', 'adsb-aircraft-labels'];
  return ['parcels-fill', 'parcels-line', 'parcels-highlight'];
}

function setLayerVisibility(map: maplibregl.Map, layerId: string, visible: boolean): void {
  if (!map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
}

function applyProgressiveZoomRanges(map: maplibregl.Map): void {
  const mobile = isMobileMap();
  const defaultRange: [number, number] = [0, 24];
  const setRange = (layerId: string, mobileMinZoom: number, desktopMinZoom = 0) => {
    const minZoom = mobile ? mobileMinZoom : desktopMinZoom;
    setLayerZoomRange(map, layerId, minZoom, defaultRange[1]);
  };

  setRange('parcels-fill', PROGRESSIVE_ZOOM.parcelDetail);
  setRange('parcels-line', PROGRESSIVE_ZOOM.parcelDetail);
  setRange('parcels-highlight', PROGRESSIVE_ZOOM.parcelImpact);
  setRange('parcels-overflight-selected-fill', PROGRESSIVE_ZOOM.parcelImpact);
  setRange('parcels-overflight-selected-line', PROGRESSIVE_ZOOM.parcelImpact);

  for (const severity of PARCEL_IMPACT_SEVERITIES) {
    const minZoom = severity === 'subtle'
      ? PROGRESSIVE_ZOOM.highAltitudeParcelImpact
      : PROGRESSIVE_ZOOM.parcelImpact;
    setRange(parcelImpactFillLayerId(severity), minZoom);
    setRange(parcelImpactLineLayerId(severity), minZoom);
  }

  setRange('adsb-low-altitude-corridor-bands-fill', PROGRESSIVE_ZOOM.lowAltitudeBands);
  setRange('adsb-low-altitude-corridor-bands-line', PROGRESSIVE_ZOOM.lowAltitudeBands);
  setRange('adsb-accumulated-corridors', PROGRESSIVE_ZOOM.corridorMarkers);
  setRange('adsb-corridors', PROGRESSIVE_ZOOM.corridorMarkers);
  setRange('adsb-historical-routes-casing', 0);
  setRange('adsb-historical-routes', 0);
  setRange('adsb-trails-casing', 0);
  setRange('adsb-trails', 0);
  setRange('adsb-aircraft', 0);
  setRange('adsb-aircraft-labels', PROGRESSIVE_ZOOM.aircraftLabels, 9);
}

function setLayerZoomRange(map: maplibregl.Map, layerId: string, minZoom: number, maxZoom: number): void {
  if (!map.getLayer(layerId)) return;
  map.setLayerZoomRange(layerId, minZoom, maxZoom);
}

function renderProgressiveIndicator(map: maplibregl.Map): void {
  const indicator = document.getElementById('mobile-progressive-indicator');
  if (!indicator) return;

  if (!isMobileMap()) {
    indicator.textContent = '';
    return;
  }

  const zoom = map.getZoom();
  if (mapUiState.selectedFlightLabel) {
    indicator.textContent = `Focused · ${mapUiState.selectedFlightLabel}`;
  } else if (zoom < PROGRESSIVE_ZOOM.lowAltitudeBands) {
    indicator.textContent = 'Overview · routes + aircraft';
  } else if (zoom < PROGRESSIVE_ZOOM.parcelImpact) {
    indicator.textContent = 'Routes · corridor bands';
  } else if (zoom < PROGRESSIVE_ZOOM.parcelDetail) {
    indicator.textContent = 'Impact · parcel signals';
  } else {
    indicator.textContent = 'Parcel detail';
  }
}

function isMobileMap(): boolean {
  return window.matchMedia(MOBILE_MAP_QUERY).matches;
}

function applyFocusPaint(map: maplibregl.Map): void {
  const selectedKey = mapUiState.selectedFlightKey;
  const selectedExpression = selectedKey ? selectedFlightExpression(selectedKey) : null;

  setPaintIfLayer(map, 'adsb-historical-routes-casing', 'line-opacity', selectedExpression
    ? ['case', selectedExpression, 0.3, 0.02]
    : historicalRouteCasingOpacityExpression());
  setPaintIfLayer(map, 'adsb-historical-routes-casing', 'line-width', selectedExpression
    ? ['case', selectedExpression, selectedTrailCasingWidthExpression(), dimTrailCasingWidthExpression()]
    : historicalRouteCasingWidthExpression());
  setPaintIfLayer(map, 'adsb-historical-routes', 'line-opacity', selectedExpression
    ? ['case', selectedExpression, 0.78, 0.035]
    : historicalRouteOpacityExpression());
  setPaintIfLayer(map, 'adsb-historical-routes', 'line-width', selectedExpression
    ? ['case', selectedExpression, selectedTrailWidthExpression(), dimTrailWidthExpression()]
    : historicalRouteWidthExpression());
  setPaintIfLayer(map, 'adsb-trails-casing', 'line-opacity', selectedExpression
    ? ['case', selectedExpression, 0.38, 0.035]
    : trailCasingOpacityExpression());
  setPaintIfLayer(map, 'adsb-trails-casing', 'line-width', selectedExpression
    ? ['case', selectedExpression, selectedTrailCasingWidthExpression(), dimTrailCasingWidthExpression()]
    : trailCasingWidthExpression());
  setPaintIfLayer(map, 'adsb-trails', 'line-opacity', selectedExpression
    ? ['case', selectedExpression, 0.96, 0.07]
    : trailOpacityExpression());
  setPaintIfLayer(map, 'adsb-trails', 'line-width', selectedExpression
    ? ['case', selectedExpression, selectedTrailWidthExpression(), dimTrailWidthExpression()]
    : trailWidthExpression());

  setPaintIfLayer(map, 'adsb-aircraft', 'circle-opacity', selectedExpression
    ? ['case', selectedExpression, 1, 0.16]
    : 0.92);
  setPaintIfLayer(map, 'adsb-aircraft', 'circle-radius', selectedExpression
    ? ['case', selectedExpression, selectedAircraftRadiusExpression(), dimAircraftRadiusExpression()]
    : defaultAircraftRadiusExpression());
  setPaintIfLayer(map, 'adsb-aircraft', 'circle-stroke-opacity', selectedExpression
    ? ['case', selectedExpression, 0.95, 0.24]
    : 0.86);
  setPaintIfLayer(map, 'adsb-aircraft-labels', 'text-opacity', selectedExpression
    ? ['case', selectedExpression, 1, 0.08]
    : 1);

  setPaintIfLayer(map, 'adsb-low-altitude-corridor-bands-fill', 'fill-opacity', lowAltitudeBandFillOpacityExpression(Boolean(selectedKey)));
  setPaintIfLayer(map, 'adsb-low-altitude-corridor-bands-line', 'line-opacity', selectedKey ? 0.045 : 0.18);
  setPaintIfLayer(map, 'adsb-accumulated-corridors', 'circle-opacity', accumulatedCorridorOpacityExpression(Boolean(selectedKey)));
  setPaintIfLayer(map, 'adsb-corridors', 'circle-opacity', liveCorridorOpacityExpression(Boolean(selectedKey)));

  for (const severity of PARCEL_IMPACT_SEVERITIES) {
    const style = PARCEL_IMPACT_STYLES[severity];
    setPaintIfLayer(map, parcelImpactFillLayerId(severity), 'fill-opacity', parcelImpactFillOpacityExpression(style, Boolean(selectedKey)));
    setPaintIfLayer(map, parcelImpactLineLayerId(severity), 'line-opacity', selectedKey ? style.lineOpacity * 0.28 : style.lineOpacity);
  }
}

function setPaintIfLayer(map: maplibregl.Map, layerId: string, property: string, value: unknown): void {
  if (!map.getLayer(layerId)) return;
  map.setPaintProperty(layerId, property, value as never);
}

function applyParcelImpactFilters(map: maplibregl.Map): void {
  for (const severity of PARCEL_IMPACT_SEVERITIES) {
    const pins = parcelPinsBySeverity.get(severity) ?? [];
    const fillLayer = parcelImpactFillLayerId(severity);
    const lineLayer = parcelImpactLineLayerId(severity);
    if (map.getLayer(fillLayer)) map.setFilter(fillLayer, parcelPinFilter(pins));
    if (map.getLayer(lineLayer)) map.setFilter(lineLayer, parcelPinFilter(pins));
  }

  const selectedPins = selectedParcelPins();
  if (map.getLayer('parcels-overflight-selected-fill')) {
    map.setFilter('parcels-overflight-selected-fill', parcelPinFilter(selectedPins));
  }
  if (map.getLayer('parcels-overflight-selected-line')) {
    map.setFilter('parcels-overflight-selected-line', parcelPinFilter(selectedPins));
  }
}

function selectedParcelPins(): string[] {
  if (!mapUiState.selectedFlightKey) return [];
  const pins: string[] = [];
  for (const [pin, impact] of parcelOverflightByPin) {
    if (parcelImpactMatchesFlight(impact, mapUiState.selectedFlightKey)) pins.push(pin);
  }
  return pins;
}

function focusFlightFromProperties(properties: Record<string, unknown>): void {
  const key = trackKeyFromProperties(properties);
  if (!key) return;
  const label = String(properties.flight || properties.registration || properties.aircraft_hex || key);
  setSelectedFlight(key, label);
}

function setSelectedFlight(key: string, label?: string | null): void {
  const summary = findSummaryByFlightKey(key);
  mapUiState.selectedFlightKey = key;
  mapUiState.selectedFlightLabel = label || (summary ? flightLabel(summary) : key);
  if (activeMap) applyMapUiState(activeMap);
  if (lastFlightPayload) renderFlightWatch(lastFlightPayload);
}

function clearFlightFocus(): void {
  if (!mapUiState.selectedFlightKey) return;
  mapUiState.selectedFlightKey = null;
  mapUiState.selectedFlightLabel = null;
  if (activeMap) applyMapUiState(activeMap);
  if (lastFlightPayload) renderFlightWatch(lastFlightPayload);
}

function findSummaryByFlightKey(key: string): FlightSummary | null {
  return lastFlightPayload?.summaries.find((summary) => flightMatchesSelectedFocus(summary, key)) ?? null;
}

function trackKeyFromProperties(properties: Record<string, unknown>): string | null {
  const trackKey = stringValue(properties.track_key);
  if (trackKey) return trackKey;
  const hex = stringValue(properties.aircraft_hex);
  if (hex) return `hex:${hex.toUpperCase()}`;
  return stringValue(properties.flight);
}

function selectedFlightExpression(key: string): any[] {
  const values = Array.from(selectedFlightCandidateValues(key));
  return ['in', ['coalesce', ['get', 'track_key'], ['get', 'aircraft_hex'], ['get', 'flight'], ''], ['literal', values]];
}

function selectedFlightCandidateValues(key: string): Set<string> {
  const values = new Set<string>([key]);
  const strippedHex = key.startsWith('hex:') ? key.slice(4) : null;
  if (strippedHex) {
    values.add(strippedHex);
    values.add(strippedHex.toUpperCase());
    values.add(strippedHex.toLowerCase());
  }

  const summary = lastFlightPayload?.summaries.find((candidate) => candidate.track_key === key);
  if (summary) {
    [summary.track_key, summary.flight, summary.label, summary.registration, summary.aircraft_hex].forEach((value) => {
      const normalized = stringValue(value);
      if (normalized) values.add(normalized);
    });
  }
  return values;
}

function parcelImpactMatchesFlight(impact: ParcelOverflightImpact, key: string): boolean {
  const values = selectedFlightCandidateValues(key);
  return [impact.latest_aircraft_hex, impact.latest_flight].some((value) => {
    const normalized = stringValue(value);
    return normalized ? values.has(normalized) || values.has(normalized.toUpperCase()) : false;
  });
}

function flightMatchesSelectedFocus(summary: FlightSummary, key: string | null): boolean {
  if (!key) return false;
  const values = selectedFlightCandidateValues(key);
  return [summary.track_key, summary.flight, summary.label, summary.registration, summary.aircraft_hex].some((value) => {
    const normalized = stringValue(value);
    return normalized ? values.has(normalized) || values.has(normalized.toUpperCase()) : false;
  });
}

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function addParcelImpactLayers(map: maplibregl.Map): void {
  for (const severity of PARCEL_IMPACT_SEVERITIES) {
    const style = PARCEL_IMPACT_STYLES[severity];
    map.addLayer({
      id: parcelImpactFillLayerId(severity),
      type: 'fill',
      source: 'parcels',
      'source-layer': 'parcels',
      paint: {
        'fill-color': style.fill,
        'fill-opacity': parcelImpactFillOpacityExpression(style, false),
      },
      filter: parcelPinFilter([]),
    });

    map.addLayer({
      id: parcelImpactLineLayerId(severity),
      type: 'line',
      source: 'parcels',
      'source-layer': 'parcels',
      paint: {
        'line-color': style.line,
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.35, 14, 0.9, 17, 1.6, 19, 2.3],
        'line-opacity': style.lineOpacity,
      },
      filter: parcelPinFilter([]),
    });
  }

  map.addLayer({
    id: 'parcels-overflight-selected-fill',
    type: 'fill',
    source: 'parcels',
    'source-layer': 'parcels',
    paint: {
      'fill-color': '#e11d48',
      'fill-opacity': [
        'interpolate',
        ['linear'],
        ['coalesce', ['feature-state', 'impactScore'], ['feature-state', 'overflightCount'], 1],
        1,
        0.22,
        20,
        0.34,
        100,
        0.48,
      ],
    },
    filter: parcelPinFilter([]),
  });

  map.addLayer({
    id: 'parcels-overflight-selected-line',
    type: 'line',
    source: 'parcels',
    'source-layer': 'parcels',
    paint: {
      'line-color': '#7f1d1d',
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.9, 14, 1.7, 17, 2.8, 19, 3.8],
      'line-opacity': 0.86,
    },
    filter: parcelPinFilter([]),
  });
}

function addAdsbLayers(map: maplibregl.Map): void {
  map.addSource(ADSB_SOURCES.accumulated.id, {
    type: 'geojson',
    data: EMPTY_FEATURE_COLLECTION,
  });
  map.addSource(ADSB_SOURCES.lowAltitudeBands.id, {
    type: 'geojson',
    data: EMPTY_FEATURE_COLLECTION,
  });
  map.addSource(ADSB_SOURCES.corridors.id, {
    type: 'geojson',
    data: EMPTY_FEATURE_COLLECTION,
  });
  map.addSource(ADSB_SOURCES.trails.id, {
    type: 'geojson',
    data: EMPTY_FEATURE_COLLECTION,
  });
  map.addSource(ADSB_SOURCES.historicalRoutes.id, {
    type: 'geojson',
    data: EMPTY_FEATURE_COLLECTION,
  });
  map.addSource(ADSB_SOURCES.aircraft.id, {
    type: 'geojson',
    data: EMPTY_FEATURE_COLLECTION,
  });

  map.addLayer({
    id: 'adsb-low-altitude-corridor-bands-fill',
    type: 'fill',
    source: ADSB_SOURCES.lowAltitudeBands.id,
    paint: {
      'fill-color': [
        'match',
        ['get', 'altitude_severity'],
        'low',
        '#dc2626',
        'medium',
        '#f97316',
        'elevated',
        '#facc15',
        '#facc15',
      ],
      'fill-opacity': lowAltitudeBandFillOpacityExpression(false),
    },
  });

  map.addLayer({
    id: 'adsb-low-altitude-corridor-bands-line',
    type: 'line',
    source: ADSB_SOURCES.lowAltitudeBands.id,
    paint: {
      'line-color': [
        'match',
        ['get', 'altitude_severity'],
        'low',
        '#991b1b',
        'medium',
        '#c2410c',
        'elevated',
        '#a16207',
        '#a16207',
      ],
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.25, 12, 0.65, 16, 1.15],
      'line-opacity': 0.18,
    },
  });

  map.addLayer({
    id: 'adsb-accumulated-corridors',
    type: 'circle',
    source: ADSB_SOURCES.accumulated.id,
    paint: {
      'circle-color': [
        'match',
        ['get', 'proximity_band'],
        'parcel edge',
        '#dc2626',
        'near',
        '#f97316',
        'approach',
        '#eab308',
        'regional',
        '#0284c7',
        'outer',
        '#64748b',
        '#94a3b8',
      ],
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['coalesce', ['get', 'impact_score'], ['get', 'count'], 1],
        1,
        1.4,
        20,
        3,
        100,
        6,
        500,
        10,
      ],
      'circle-opacity': accumulatedCorridorOpacityExpression(false),
      'circle-stroke-color': '#0f172a',
      'circle-stroke-width': 0.8,
      'circle-stroke-opacity': 0.24,
    },
  });

  map.addLayer({
    id: 'adsb-corridors',
    type: 'circle',
    source: ADSB_SOURCES.corridors.id,
    paint: {
      'circle-color': '#64748b',
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1.1, 12, 2.4, 16, 4.2],
      'circle-opacity': liveCorridorOpacityExpression(false),
      'circle-stroke-color': '#f8fafc',
      'circle-stroke-width': 0.8,
      'circle-stroke-opacity': 0.24,
    },
    filter: under10000AltitudeFilter(),
  });

  map.addLayer({
    id: 'adsb-historical-routes-casing',
    type: 'line',
    source: ADSB_SOURCES.historicalRoutes.id,
    paint: {
      'line-color': '#0f172a',
      'line-width': historicalRouteCasingWidthExpression(),
      'line-opacity': historicalRouteCasingOpacityExpression(),
      'line-blur': ['interpolate', ['linear'], ['zoom'], 8, 0.25, 14, 0.55, 17, 0.8],
    },
  });

  map.addLayer({
    id: 'adsb-historical-routes',
    type: 'line',
    source: ADSB_SOURCES.historicalRoutes.id,
    paint: {
      'line-color': [
        'match',
        ['get', 'altitude_band_ft'],
        '0-2499',
        '#b91c1c',
        '2500-4999',
        '#ea580c',
        '5000-9999',
        '#ca8a04',
        '10000+',
        '#0284c7',
        '#64748b',
      ],
      'line-width': historicalRouteWidthExpression(),
      'line-opacity': historicalRouteOpacityExpression(),
    },
  });

  map.addLayer({
    id: 'adsb-trails-casing',
    type: 'line',
    source: ADSB_SOURCES.trails.id,
    paint: {
      'line-color': '#0f172a',
      'line-width': trailCasingWidthExpression(),
      'line-opacity': trailCasingOpacityExpression(),
      'line-blur': ['interpolate', ['linear'], ['zoom'], 8, 0.2, 14, 0.45, 17, 0.7],
    },
  });

  map.addLayer({
    id: 'adsb-trails',
    type: 'line',
    source: ADSB_SOURCES.trails.id,
    paint: {
      'line-color': [
        'match',
        ['get', 'altitude_band_ft'],
        '0-2499',
        '#dc2626',
        '2500-4999',
        '#f97316',
        '5000-9999',
        '#facc15',
        '10000+',
        '#38bdf8',
        '#cbd5e1',
      ],
      'line-width': trailWidthExpression(),
      'line-opacity': trailOpacityExpression(),
    },
  });

  map.addLayer({
    id: 'adsb-aircraft',
    type: 'circle',
    source: ADSB_SOURCES.aircraft.id,
    paint: {
      'circle-color': [
        'match',
        ['get', 'altitude_band_ft'],
        '0-2499',
        '#b91c1c',
        '2500-4999',
        '#ea580c',
        '5000-9999',
        '#ca8a04',
        '10000+',
        '#0284c7',
        '#64748b',
      ],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 13, 6, 17, 9],
      'circle-stroke-color': '#f8fafc',
      'circle-stroke-width': 1.5,
      'circle-opacity': 0.95,
    },
  });

  map.addLayer({
    id: 'adsb-aircraft-labels',
    type: 'symbol',
    source: ADSB_SOURCES.aircraft.id,
    minzoom: 9,
    layout: {
      'text-field': ['coalesce', ['get', 'flight'], ['get', 'aircraft_hex'], 'aircraft'],
      'text-font': ['Open Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 15, 12],
      'text-offset': [0, 1.15],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#f8fafc',
      'text-halo-color': '#020617',
      'text-halo-width': 1.2,
    },
  });

  const hoverPopup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    className: 'adsb-hover-popup',
    maxWidth: '18rem',
    offset: 12,
  });
  const showHoverPopup = (event: maplibregl.MapLayerMouseEvent, html: string) => {
    map.getCanvas().style.cursor = 'pointer';
    hoverPopup.setLngLat(event.lngLat).setHTML(html).addTo(map);
  };
  const clearHoverPopup = () => {
    map.getCanvas().style.cursor = '';
    hoverPopup.remove();
  };
  const bindHoverPopup = (
    layerId: string,
    render: (properties: Record<string, unknown>) => string
  ) => {
    map.on('mousemove', layerId, (event) => {
      const feature = event.features?.[0];
      if (!feature) return;
      showHoverPopup(event, render(feature.properties ?? {}));
    });
    map.on('mouseleave', layerId, clearHoverPopup);
  };

  map.on('click', 'adsb-aircraft', (event) => {
    const feature = event.features?.[0];
    const coordinates = feature?.geometry.type === 'Point'
      ? (feature.geometry.coordinates.slice() as [number, number])
      : null;
    if (!feature || !coordinates) return;
    focusFlightFromProperties(feature.properties ?? {});
    new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(coordinates)
      .setHTML(renderAdsbPopup(feature.properties ?? {}))
      .addTo(map);
  });

  map.on('click', 'adsb-trails', (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    focusFlightFromProperties(feature.properties ?? {});
  });
  map.on('click', 'adsb-historical-routes', (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    focusFlightFromProperties(feature.properties ?? {});
  });

  map.on('click', 'adsb-accumulated-corridors', (event) => {
    const feature = event.features?.[0];
    const coordinates = feature?.geometry.type === 'Point'
      ? (feature.geometry.coordinates.slice() as [number, number])
      : null;
    if (!feature || !coordinates) return;
    new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(coordinates)
      .setHTML(renderCorridorPopup(feature.properties ?? {}, 'Accumulated band'))
      .addTo(map);
  });

  map.on('click', 'adsb-corridors', (event) => {
    const feature = event.features?.[0];
    const coordinates = feature?.geometry.type === 'Point'
      ? (feature.geometry.coordinates.slice() as [number, number])
      : null;
    if (!feature || !coordinates) return;
    new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(coordinates)
      .setHTML(renderCorridorPopup(feature.properties ?? {}, 'Monitor band center'))
      .addTo(map);
  });

  map.on('click', 'adsb-low-altitude-corridor-bands-fill', (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(event.lngLat)
      .setHTML(renderCorridorPopup(feature.properties ?? {}, 'Under 10k corridor band'))
      .addTo(map);
  });

  map.on('mousemove', 'adsb-aircraft', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'adsb-aircraft', () => {
    map.getCanvas().style.cursor = '';
  });
  bindHoverPopup('adsb-trails', renderRouteHoverPopup);
  bindHoverPopup('adsb-historical-routes', renderRouteHoverPopup);
  bindHoverPopup('adsb-accumulated-corridors', (properties) =>
    renderCorridorPopup(properties, 'Accumulated route band')
  );
  bindHoverPopup('adsb-corridors', (properties) =>
    renderCorridorPopup(properties, 'Monitor corridor point')
  );
  bindHoverPopup('adsb-low-altitude-corridor-bands-fill', (properties) =>
    renderCorridorPopup(properties, 'Under 10k corridor band')
  );

  void refreshAdsbSources(map);
  void refreshAccumulatedAdsbLayer(map);
}

function startAdsbRefresh(map: maplibregl.Map): void {
  if (adsbRefreshStarted.has(map)) return;
  adsbRefreshStarted.add(map);
  loadRefreshPreference();

  const refreshLive = () => {
    void refreshAdsbSources(map);
  };
  const refreshAccumulated = () => {
    void refreshAccumulatedAdsbLayer(map);
  };
  const applySchedule = () => {
    window.clearInterval(liveRefreshTimer);
    window.clearInterval(accumulatedRefreshTimer);
    const liveRefreshMs = currentLiveRefreshMs();
    const accumulatedRefreshMs = currentAccumulatedRefreshMs();
    refreshLive();
    refreshAccumulated();
    liveRefreshTimer = window.setInterval(refreshLive, liveRefreshMs);
    accumulatedRefreshTimer = window.setInterval(refreshAccumulated, accumulatedRefreshMs);
    renderRefreshControls();
  };

  setupRefreshControls(applySchedule);
  applySchedule();
}

function currentLiveRefreshMs(): number {
  return adsbRefreshMode === 'monitor' ? adsbMonitorRefreshMs : SNAPSHOT_REFRESH_MS;
}

function currentAccumulatedRefreshMs(): number {
  return adsbRefreshMode === 'monitor'
    ? Math.max(MIN_ACCUMULATED_REFRESH_MS, adsbMonitorRefreshMs)
    : SNAPSHOT_REFRESH_MS;
}

function loadRefreshPreference(): void {
  try {
    const raw = window.localStorage.getItem(REFRESH_PREF_KEY);
    if (!raw) return;
    const payload = JSON.parse(raw) as { mode?: string; liveRefreshMs?: number; monitorRefreshMs?: number };
    adsbRefreshMode = payload.mode === 'monitor' || payload.mode === 'live' ? 'monitor' : 'snapshot';
    adsbMonitorRefreshMs = normalizeRefreshMs(payload.monitorRefreshMs ?? payload.liveRefreshMs);
  } catch {
    adsbRefreshMode = 'snapshot';
    adsbMonitorRefreshMs = DEFAULT_MONITOR_REFRESH_MS;
  }
}

function saveRefreshPreference(): void {
  try {
    window.localStorage.setItem(
      REFRESH_PREF_KEY,
      JSON.stringify({ mode: adsbRefreshMode, monitorRefreshMs: adsbMonitorRefreshMs })
    );
  } catch {
    // Preference persistence is optional.
  }
}

function normalizeRefreshMs(value: unknown): number {
  const numeric = Number(value);
  return MONITOR_REFRESH_OPTIONS_MS.includes(numeric) ? numeric : DEFAULT_MONITOR_REFRESH_MS;
}

function setupRefreshControls(applySchedule: () => void): void {
  const snapshotButton = document.getElementById('adsb-refresh-snapshot') as HTMLButtonElement | null;
  const monitorButton = document.getElementById('adsb-refresh-monitor') as HTMLButtonElement | null;
  const rateSelect = document.getElementById('adsb-refresh-rate') as HTMLSelectElement | null;
  if (!snapshotButton || !monitorButton || !rateSelect) return;

  snapshotButton.addEventListener('click', () => {
    adsbRefreshMode = 'snapshot';
    saveRefreshPreference();
    applySchedule();
  });

  monitorButton.addEventListener('click', () => {
    adsbRefreshMode = 'monitor';
    saveRefreshPreference();
    applySchedule();
  });

  rateSelect.addEventListener('change', () => {
    adsbMonitorRefreshMs = normalizeRefreshMs(rateSelect.value);
    if (adsbRefreshMode !== 'monitor') adsbRefreshMode = 'monitor';
    saveRefreshPreference();
    applySchedule();
  });
}

function renderRefreshControls(): void {
  const snapshotButton = document.getElementById('adsb-refresh-snapshot') as HTMLButtonElement | null;
  const monitorButton = document.getElementById('adsb-refresh-monitor') as HTMLButtonElement | null;
  const rateSelect = document.getElementById('adsb-refresh-rate') as HTMLSelectElement | null;
  if (!snapshotButton || !monitorButton || !rateSelect) return;

  const monitorSelected = adsbRefreshMode === 'monitor';
  snapshotButton.classList.toggle('selected', !monitorSelected);
  monitorButton.classList.toggle('selected', monitorSelected);
  snapshotButton.setAttribute('aria-pressed', String(!monitorSelected));
  monitorButton.setAttribute('aria-pressed', String(monitorSelected));
  rateSelect.value = String(adsbMonitorRefreshMs);
  rateSelect.disabled = !monitorSelected;
}

async function refreshAdsbSources(map: maplibregl.Map): Promise<void> {
  try {
    const [aircraft, trails, corridors, parcelOverflights, flightPayload] = await Promise.all([
      fetchFeatureCollection(ADSB_SOURCES.aircraft.url),
      fetchFeatureCollection(ADSB_SOURCES.trails.url),
      fetchFeatureCollection(ADSB_SOURCES.corridors.url),
      fetchFeatureCollection(ADSB_SOURCES.parcelOverflights.url),
      fetchFlightSummaries(FLIGHT_SUMMARIES_URL),
    ]);
    setGeoJsonSourceData(map, ADSB_SOURCES.aircraft.id, aircraft);
    setGeoJsonSourceData(map, ADSB_SOURCES.trails.id, trails);
    setGeoJsonSourceData(map, ADSB_SOURCES.corridors.id, corridors);
    updateParcelImpactLayers(map, parcelOverflights);
    updateAdsbStatus(aircraft.features.length, trails.features.length);
    renderAdsbLivePanel(aircraft, trails, corridors, parcelOverflights, flightPayload.updated_at);
    renderFlightWatch(flightPayload);
  } catch (error) {
    updateAdsbStatus(null, null);
    updateParcelImpactLayers(map, EMPTY_FEATURE_COLLECTION);
    renderAdsbLivePanel(null, null, null, null);
    renderFlightWatch(null);
    console.warn('[ADS-B] published layer refresh failed:', error);
  }
}

async function refreshAccumulatedAdsbLayer(map: maplibregl.Map): Promise<void> {
  try {
    const [accumulated, lowAltitudeBands, historicalRoutes] = await Promise.all([
      fetchFeatureCollection(ADSB_SOURCES.accumulated.url),
      fetchFeatureCollection(ADSB_SOURCES.lowAltitudeBands.url),
      fetchFeatureCollection(ADSB_SOURCES.historicalRoutes.url),
    ]);
    setGeoJsonSourceData(map, ADSB_SOURCES.accumulated.id, accumulated);
    setGeoJsonSourceData(map, ADSB_SOURCES.lowAltitudeBands.id, lowAltitudeBands);
    setGeoJsonSourceData(map, ADSB_SOURCES.historicalRoutes.id, historicalRoutes);
  } catch (error) {
    console.warn('[ADS-B] accumulated layer refresh failed:', error);
  }
}

async function fetchFeatureCollection(url: string): Promise<GeoJSON.FeatureCollection> {
  const response = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) return EMPTY_FEATURE_COLLECTION;
  const payload = (await response.json()) as GeoJSON.FeatureCollection;
  if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
    return EMPTY_FEATURE_COLLECTION;
  }
  return payload;
}

async function fetchFlightSummaries(url: string): Promise<FlightSummariesPayload> {
  const response = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) return { summaries: [] };
  const payload = (await response.json()) as Partial<FlightSummariesPayload>;
  return {
    updated_at: payload.updated_at,
    active_count: Number(payload.active_count ?? 0),
    geobounds_count: Number(payload.geobounds_count ?? 0),
    property_hit_count: Number(payload.property_hit_count ?? 0),
    summaries: Array.isArray(payload.summaries) ? payload.summaries : [],
  };
}

function setGeoJsonSourceData(
  map: maplibregl.Map,
  sourceId: string,
  data: GeoJSON.FeatureCollection
): void {
  const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
  source?.setData(data);
}

function updateParcelImpactLayers(map: maplibregl.Map, parcelOverflights: GeoJSON.FeatureCollection): void {
  parcelOverflightByPin.clear();
  for (const severity of PARCEL_IMPACT_SEVERITIES) {
    parcelPinsBySeverity.set(severity, []);
  }

  for (const feature of parcelOverflights.features) {
    const properties = (feature.properties ?? {}) as ParcelOverflightImpact;
    const pin = normalizePin(properties.source_pin ?? properties.parcel_id);
    if (!pin) continue;

    const severity = normalizeSeverity(properties.altitude_severity);
    parcelOverflightByPin.set(pin, { ...properties, source_pin: pin });
    parcelPinsBySeverity.get(severity)?.push(pin);
    try {
      map.setFeatureState(
        { source: 'parcels', sourceLayer: 'parcels', id: pin },
        {
          hasOverflight: true,
          overflightCount: Number(properties.count ?? 1),
          impactScore: Number(properties.impact_score ?? 0),
          altitudeSeverity: severity,
        }
      );
    } catch {
      // Feature state is opportunistic; filters still mark impacted parcels.
    }
  }

  applyParcelImpactFilters(map);
  document.dispatchEvent(new CustomEvent('parcel-overflights-updated'));
}

function parcelPinFilter(pins: string[]): maplibregl.FilterSpecification {
  if (!pins.length) return ['==', ['get', 'pin'], '___none___'] as maplibregl.FilterSpecification;
  return ['in', ['get', 'pin'], ['literal', pins]] as maplibregl.FilterSpecification;
}

function parcelImpactFillLayerId(severity: ParcelImpactSeverity): string {
  return `parcels-overflight-${severity}-fill`;
}

function parcelImpactLineLayerId(severity: ParcelImpactSeverity): string {
  return `parcels-overflight-${severity}-line`;
}

function normalizePin(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const pin = String(value).trim();
  return pin || null;
}

function normalizeSeverity(value: unknown): ParcelImpactSeverity {
  return PARCEL_IMPACT_SEVERITIES.includes(value as ParcelImpactSeverity)
    ? (value as ParcelImpactSeverity)
    : 'unknown';
}

function parcelImpactFillOpacityExpression(
  style: { opacity: number; maxOpacity: number },
  focused: boolean
): any {
  const multiplier = focused ? 0.28 : 1;
  return [
    'interpolate',
    ['linear'],
    ['coalesce', ['feature-state', 'overflightCount'], 1],
    1,
    roundOpacity(style.opacity * multiplier),
    10,
    roundOpacity(Math.min(style.maxOpacity, style.opacity + 0.05) * multiplier),
    50,
    roundOpacity(style.maxOpacity * multiplier),
  ];
}

function lowAltitudeBandFillOpacityExpression(focused: boolean): any {
  if (focused) return 0.018;
  return [
    'interpolate',
    ['linear'],
    ['coalesce', ['get', 'impact_score'], ['get', 'under_10000_count'], ['get', 'count'], 1],
    1,
    0.018,
    20,
    0.04,
    100,
    0.085,
  ];
}

function accumulatedCorridorOpacityExpression(focused: boolean): any {
  if (focused) return 0.018;
  return [
    'case',
    ['==', ['get', 'altitude_band_ft'], '10000+'],
    0.025,
    [
      'interpolate',
      ['linear'],
      ['coalesce', ['get', 'impact_score'], ['get', 'count'], 1],
      1,
      0.055,
      30,
      0.1,
      120,
      0.16,
    ],
  ];
}

function liveCorridorOpacityExpression(focused: boolean): any {
  if (focused) return 0.018;
  return [
    'interpolate',
    ['linear'],
    ['coalesce', ['get', 'count'], 1],
    1,
    0.07,
    10,
    0.12,
    40,
    0.2,
  ];
}

function altitudeBandCase(highAltitudeValue: number, lowerAltitudeValue: number): any[] {
  return [
    'case',
    ['==', ['get', 'altitude_band_ft'], '10000+'],
    highAltitudeValue,
    lowerAltitudeValue,
  ];
}

function historicalRouteOpacityExpression(): any {
  return [
    'interpolate',
    ['linear'],
    ['coalesce', ['get', 'impact_score'], ['get', 'point_count'], 1],
    1,
    altitudeBandCase(0.1, 0.28),
    20,
    altitudeBandCase(0.16, 0.42),
    80,
    altitudeBandCase(0.24, 0.58),
  ];
}

function historicalRouteWidthExpression(): any {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    8,
    altitudeBandCase(0.38, 0.68),
    13,
    altitudeBandCase(0.8, 1.45),
    17,
    altitudeBandCase(1.15, 2.45),
  ];
}

function historicalRouteCasingOpacityExpression(): any {
  return [
    'interpolate',
    ['linear'],
    ['coalesce', ['get', 'impact_score'], ['get', 'point_count'], 1],
    1,
    altitudeBandCase(0.04, 0.12),
    20,
    altitudeBandCase(0.07, 0.19),
    80,
    altitudeBandCase(0.1, 0.27),
  ];
}

function historicalRouteCasingWidthExpression(): any {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    8,
    altitudeBandCase(1, 1.35),
    13,
    altitudeBandCase(1.7, 2.45),
    17,
    altitudeBandCase(2.35, 3.6),
  ];
}

function trailOpacityExpression(): any {
  return [
    'match',
    ['get', 'altitude_band_ft'],
    '0-2499',
    0.82,
    '2500-4999',
    0.66,
    '5000-9999',
    0.48,
    '10000+',
    0.24,
    0.42,
  ];
}

function trailWidthExpression(): any {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    8,
    altitudeBandCase(0.65, 1.05),
    13,
    altitudeBandCase(1.15, 2.1),
    17,
    altitudeBandCase(1.65, 3.35),
  ];
}

function trailCasingOpacityExpression(): any {
  return [
    'match',
    ['get', 'altitude_band_ft'],
    '0-2499',
    0.34,
    '2500-4999',
    0.28,
    '5000-9999',
    0.2,
    '10000+',
    0.12,
    0.18,
  ];
}

function trailCasingWidthExpression(): any {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    8,
    altitudeBandCase(1.4, 1.8),
    13,
    altitudeBandCase(2.15, 3.1),
    17,
    altitudeBandCase(2.8, 4.55),
  ];
}

function selectedTrailWidthExpression(): any {
  return ['interpolate', ['linear'], ['zoom'], 9, 1.5, 13, 2.8, 17, 4.4];
}

function dimTrailWidthExpression(): any {
  return ['interpolate', ['linear'], ['zoom'], 9, 0.35, 13, 0.7, 17, 1.1];
}

function selectedTrailCasingWidthExpression(): any {
  return ['interpolate', ['linear'], ['zoom'], 9, 2.5, 13, 4, 17, 5.8];
}

function dimTrailCasingWidthExpression(): any {
  return ['interpolate', ['linear'], ['zoom'], 9, 1, 13, 1.55, 17, 2.1];
}

function defaultAircraftRadiusExpression(): any {
  return ['interpolate', ['linear'], ['zoom'], 8, 4, 13, 6, 17, 9];
}

function selectedAircraftRadiusExpression(): any {
  return ['interpolate', ['linear'], ['zoom'], 8, 5.5, 13, 8, 17, 11.5];
}

function dimAircraftRadiusExpression(): any {
  return ['interpolate', ['linear'], ['zoom'], 8, 2.5, 13, 3.5, 17, 5];
}

function under10000AltitudeFilter(): maplibregl.FilterSpecification {
  return ['!=', ['get', 'altitude_band_ft'], '10000+'] as maplibregl.FilterSpecification;
}

function roundOpacity(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function updateAdsbStatus(aircraftCount: number | null, trailCount: number | null): void {
  const el = document.getElementById('adsb-status');
  if (!el) return;
  el.classList.remove('live', 'error');
  if (aircraftCount === null || trailCount === null) {
    el.textContent = 'ADS-B error';
    el.classList.add('error');
    return;
  }
  el.textContent = `ADS-B ${aircraftCount} / ${trailCount}`;
  if (aircraftCount > 0 || trailCount > 0) el.classList.add('live');
}

function renderAdsbLivePanel(
  aircraft: GeoJSON.FeatureCollection | null,
  trails: GeoJSON.FeatureCollection | null,
  corridors: GeoJSON.FeatureCollection | null,
  parcelOverflights: GeoJSON.FeatureCollection | null,
  publishedAt?: string
): void {
  const updatedEl = document.getElementById('adsb-live-updated');
  const summaryEl = document.getElementById('adsb-live-summary');
  const listEl = document.getElementById('adsb-live-list');
  const legendUpdatedEl = document.getElementById('map-legend-updated');
  if (!updatedEl || !summaryEl || !listEl) return;

  if (!aircraft || !trails || !corridors || !parcelOverflights) {
    updatedEl.textContent = 'error';
    if (legendUpdatedEl) legendUpdatedEl.textContent = 'Published snapshot unavailable.';
    summaryEl.textContent = 'Published ADS-B snapshot unavailable.';
    listEl.innerHTML = '';
    return;
  }

  const aircraftFeatures = aircraft.features;
  updatedEl.textContent = publishedAt ? `published ${formatShortTime(publishedAt)}` : 'snapshot';
  if (legendUpdatedEl) {
    legendUpdatedEl.textContent = publishedAt
      ? `Snapshot published ${formatShortTime(publishedAt)}. Monitor mode only checks for newer files.`
      : 'Waiting for published snapshot.';
  }
  summaryEl.innerHTML = `
    <span><strong>${aircraftFeatures.length}</strong> aircraft</span>
    <span><strong>${trails.features.length}</strong> trails</span>
    <span><strong>${corridors.features.length}</strong> corridors</span>
    <span><strong>${parcelOverflights.features.length}</strong> parcels</span>
  `;

  if (!aircraftFeatures.length) {
    listEl.innerHTML = '<div class="adsb-live-row"><span class="adsb-live-id">No aircraft in published view</span><span class="adsb-live-meta">snapshot</span></div>';
    return;
  }

  listEl.innerHTML = aircraftFeatures
    .slice()
    .sort(compareAircraftFeatures)
    .slice(0, 4)
    .map((feature) => renderAdsbLiveRow(feature.properties ?? {}))
    .join('');
}

function renderFlightWatch(payload: FlightSummariesPayload | null): void {
  const updatedEl = document.getElementById('flight-watch-updated');
  const modeEl = document.getElementById('flight-watch-mode');
  const facetsEl = document.getElementById('flight-watch-facets');
  const listEl = document.getElementById('flight-watch-list');
  if (!updatedEl || !modeEl || !facetsEl || !listEl) return;

  lastFlightPayload = payload;
  if (!payload) {
    updatedEl.textContent = 'snapshot unavailable';
    modeEl.textContent = 'error';
    facetsEl.innerHTML = '';
    listEl.innerHTML = '<div class="panel-empty">Published ADS-B summaries unavailable.</div>';
    return;
  }

  const summaries = payload.summaries.slice().sort(compareFlightSummaries);
  updatedEl.textContent = payload.updated_at ? `Snapshot ${formatShortTime(payload.updated_at)}` : 'waiting';
  modeEl.textContent = `${payload.active_count ?? 0} active at publish`;
  renderFlightFacets(facetsEl, summaries);
  renderFlightFocusState();

  const filtered = summaries.filter((summary) => flightMatchesFacet(summary, selectedFlightFacet));
  if (!filtered.length) {
    listEl.innerHTML = '<div class="panel-empty">No matching overflights yet.</div>';
    return;
  }

  const featuredKeys = new Set(
    [
      ...filtered
        .filter((summary) => flightMatchesSelectedFocus(summary, mapUiState.selectedFlightKey))
        .map((summary) => summary.track_key),
      ...filtered
        .filter((summary) => summary.active || summary.geobounds_hit)
        .slice(0, 3)
        .map((summary) => summary.track_key),
    ].filter(Boolean)
  );
  const featured = filtered.filter((summary) => featuredKeys.has(summary.track_key));
  const rows = filtered.filter((summary) => !featuredKeys.has(summary.track_key)).slice(0, 14);

  listEl.innerHTML = [
    ...featured.map(renderFlightCard),
    rows.length ? '<div class="flight-row-group">' : '',
    ...rows.map(renderFlightRow),
    rows.length ? '</div>' : '',
  ].join('');
  setupFlightSelectionControls(listEl);
}

function renderFlightFacets(container: HTMLElement, summaries: FlightSummary[]): void {
  const definitions = [
    { id: 'all', label: 'All', count: summaries.length },
    { id: 'active', label: 'Active', count: summaries.filter((summary) => summary.active).length },
    {
      id: 'niskayuna',
      label: 'Niskayuna',
      count: summaries.filter((summary) => summary.geobounds_hit).length,
    },
    {
      id: 'low',
      label: 'Low alt',
      count: summaries.filter(isLowAltitudeSummary).length,
    },
    {
      id: 'commercial',
      label: 'Commercial',
      count: summaries.filter((summary) => summary.aircraft_class === 'commercial').length,
    },
    {
      id: 'ga',
      label: 'GA',
      count: summaries.filter((summary) => summary.aircraft_class === 'general aviation').length,
    },
    {
      id: 'helicopter',
      label: 'Heli',
      count: summaries.filter((summary) => summary.aircraft_class === 'helicopter').length,
    },
    {
      id: 'unknown',
      label: 'Unknown',
      count: summaries.filter((summary) => !summary.aircraft_class || summary.aircraft_class === 'unknown').length,
    },
  ];

  container.innerHTML = definitions
    .map(
      (facet) => `
        <button
          type="button"
          class="flight-facet ${facet.id === selectedFlightFacet ? 'selected' : ''}"
          data-flight-facet="${escapeHtml(facet.id)}"
        >
          ${escapeHtml(facet.label)} <span>${facet.count}</span>
        </button>
      `
    )
    .join('');

  container.querySelectorAll<HTMLButtonElement>('[data-flight-facet]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedFlightFacet = button.dataset.flightFacet ?? 'all';
      if (lastFlightPayload) renderFlightWatch(lastFlightPayload);
    });
  });
}

function flightMatchesFacet(summary: FlightSummary, facet: string): boolean {
  if (facet === 'active') return Boolean(summary.active);
  if (facet === 'niskayuna') return Boolean(summary.geobounds_hit);
  if (facet === 'low') return isLowAltitudeSummary(summary);
  if (facet === 'commercial') return summary.aircraft_class === 'commercial';
  if (facet === 'ga') return summary.aircraft_class === 'general aviation';
  if (facet === 'helicopter') return summary.aircraft_class === 'helicopter';
  if (facet === 'unknown') return !summary.aircraft_class || summary.aircraft_class === 'unknown';
  return true;
}

function compareFlightSummaries(a: FlightSummary, b: FlightSummary): number {
  const aRank = flightPriority(a);
  const bRank = flightPriority(b);
  if (aRank !== bRank) return aRank - bRank;
  const aImpact = Number(a.impact_score ?? 0);
  const bImpact = Number(b.impact_score ?? 0);
  if (aImpact !== bImpact) return bImpact - aImpact;
  return timestampMs(b.last_observed_at) - timestampMs(a.last_observed_at);
}

function flightPriority(summary: FlightSummary): number {
  if (summary.active && summary.geobounds_hit) return 0;
  if (summary.active) return 1;
  if (summary.geobounds_hit) return 2;
  if (summary.persisted) return 3;
  return 4;
}

function renderFlightCard(summary: FlightSummary): string {
  const label = flightLabel(summary);
  const status = summary.active ? 'active at publish' : summary.persisted ? 'persisted' : 'history';
  const meta = flightMeta(summary);
  const selected = flightMatchesSelectedFocus(summary, mapUiState.selectedFlightKey);
  return `
    <article
      class="flight-card ${summary.geobounds_hit ? 'hit' : ''} ${selected ? 'selected' : ''}"
      data-flight-key="${escapeHtml(summary.track_key)}"
      role="button"
      tabindex="0"
      aria-pressed="${selected ? 'true' : 'false'}"
    >
      <div class="flight-card-top">
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(status)}</span>
      </div>
      <div class="flight-meta-line">${escapeHtml(meta)}</div>
      <div class="flight-metrics">
        <span><strong>${escapeHtml(formatOptional(summary.altitude_ft, ' ft'))}</strong><em>alt</em></span>
        <span><strong>${escapeHtml(formatOptional(summary.speed_kt, ' kt'))}</strong><em>speed</em></span>
        <span><strong>${Math.round(Number(summary.property_hits ?? 0)).toLocaleString('en-US')}</strong><em>hits</em></span>
      </div>
      ${renderSparklineSet(summary)}
      <div class="flight-foot">
        <span>${escapeHtml(summary.area || 'receiver')}</span>
        <span>${Math.round(Number(summary.impact_score ?? 0)).toLocaleString('en-US')} impact</span>
        <span>${Math.round(Number(summary.point_count ?? 0)).toLocaleString('en-US')} pts</span>
      </div>
    </article>
  `;
}

function renderFlightRow(summary: FlightSummary): string {
  const selected = flightMatchesSelectedFocus(summary, mapUiState.selectedFlightKey);
  return `
    <article
      class="flight-row-compact ${summary.active ? 'active' : ''} ${selected ? 'selected' : ''}"
      data-flight-key="${escapeHtml(summary.track_key)}"
      role="button"
      tabindex="0"
      aria-pressed="${selected ? 'true' : 'false'}"
    >
      <div class="flight-row-main">
        <strong>${escapeHtml(flightLabel(summary))}</strong>
        <span>${escapeHtml(flightMeta(summary))}</span>
      </div>
      <div class="flight-row-metrics">
        <span>${escapeHtml(formatOptional(summary.altitude_ft, ' ft'))}</span>
        <span>${escapeHtml(formatOptional(summary.speed_kt, ' kt'))}</span>
        <span>${Math.round(Number(summary.property_hits ?? 0)).toLocaleString('en-US')} hits</span>
      </div>
      ${renderSparklineSet(summary)}
    </article>
  `;
}

function setupFlightSelectionControls(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>('[data-flight-key]').forEach((row) => {
    const select = () => {
      const key = row.dataset.flightKey;
      if (!key) return;
      const summary = findSummaryByFlightKey(key);
      setSelectedFlight(key, summary ? flightLabel(summary) : row.textContent?.trim().split(/\s+/)[0] ?? key);
    };
    row.addEventListener('click', select);
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      select();
    });
  });
}

function isLowAltitudeSummary(summary: FlightSummary): boolean {
  const altitude = Number(summary.altitude_ft);
  return (
    altitudeBandUnder10000(summary.altitude_band_ft) ||
    (Number.isFinite(altitude) && altitude < 10000) ||
    Number(summary.property_hits ?? 0) > 0
  );
}

function altitudeBandUnder10000(value: string | null | undefined): boolean {
  return value === '0-2499' || value === '2500-4999' || value === '5000-9999';
}

function flightLabel(summary: FlightSummary): string {
  return String(summary.label || summary.flight || summary.registration || summary.aircraft_hex || 'Aircraft');
}

function flightMeta(summary: FlightSummary): string {
  const values = [
    summary.operator_hint,
    summary.registration,
    summary.aircraft_type,
    summary.wake_turbulence_category ? `WTC ${summary.wake_turbulence_category}` : null,
    summary.aircraft_class,
  ].filter(Boolean);
  return values.length ? values.join(' · ') : 'unclassified aircraft';
}

function renderSparklineSet(summary: FlightSummary): string {
  return `
    <div class="flight-sparklines">
      ${renderSparkline('Alt', summary.sparkline?.altitude_ft, 'alt')}
      ${renderSparkline('Speed', summary.sparkline?.speed_kt, 'speed')}
      ${renderSparkline('Hits', summary.sparkline?.property_hits, 'hits')}
    </div>
  `;
}

function renderSparkline(label: string, values: Array<number | null> | undefined, kind: string): string {
  const points = sparklinePath(values ?? []);
  return `
    <div class="flight-spark">
      <span>${escapeHtml(label)}</span>
      <svg viewBox="0 0 84 22" preserveAspectRatio="none" aria-hidden="true">
        <path class="spark-baseline" d="M0 20 L84 20"></path>
        <path class="spark-line spark-${escapeHtml(kind)}" d="${points}"></path>
      </svg>
    </div>
  `;
}

function sparklinePath(values: Array<number | null>): string {
  const clean = values
    .map((value) => Number(value))
    .map((value) => (Number.isFinite(value) ? value : null));
  const finite = clean.filter((value): value is number => value !== null);
  if (!finite.length) return 'M0 11 L84 11';
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const range = max - min || 1;
  const denom = Math.max(clean.length - 1, 1);
  const points = clean.map((value, index) => {
    const normalized = value === null ? 0.5 : (value - min) / range;
    const x = (index / denom) * 84;
    const y = 20 - normalized * 18;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  if (points.length === 1) return `M0 ${points[0].split(',')[1]} L84 ${points[0].split(',')[1]}`;
  return `M${points.join(' L')}`;
}

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function formatShortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'waiting';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function compareAircraftFeatures(a: GeoJSON.Feature, b: GeoJSON.Feature): number {
  const aAlt = Number(a.properties?.alt_baro_ft ?? a.properties?.alt_geom_ft);
  const bAlt = Number(b.properties?.alt_baro_ft ?? b.properties?.alt_geom_ft);
  if (Number.isFinite(aAlt) && Number.isFinite(bAlt)) return aAlt - bAlt;
  if (Number.isFinite(aAlt)) return -1;
  if (Number.isFinite(bAlt)) return 1;
  return String(a.properties?.flight ?? a.properties?.aircraft_hex ?? '').localeCompare(
    String(b.properties?.flight ?? b.properties?.aircraft_hex ?? '')
  );
}

function renderAdsbLiveRow(properties: Record<string, unknown>): string {
  const label = String(properties.flight || properties.registration || properties.aircraft_hex || 'Aircraft');
  const altitude = formatOptional(properties.alt_baro_ft ?? properties.alt_geom_ft, ' ft');
  const speed = formatOptional(properties.ground_speed_kt, ' kt');
  const track = formatOptional(properties.track_deg, ' deg');
  const area = String(properties.area || 'receiver');
  const band = String(properties.altitude_band_ft || 'unknown');
  const type = String(properties.aircraft_type || properties.aircraft_class || '');
  return `
    <div class="adsb-live-row">
      <span class="adsb-live-id">${escapeHtml(label)}</span>
      <span class="adsb-live-meta">${escapeHtml(altitude)}</span>
      <span class="adsb-live-sub">
        <span>${escapeHtml(speed)}</span>
        <span>${escapeHtml(track)}</span>
        <span>${escapeHtml(area)}</span>
        <span>${escapeHtml(band)}</span>
        ${type ? `<span>${escapeHtml(type)}</span>` : ''}
      </span>
    </div>
  `;
}

function renderAdsbPopup(properties: Record<string, unknown>): string {
  const title = String(properties.flight || properties.registration || properties.aircraft_hex || 'Aircraft');
  const altitude = formatOptional(properties.alt_baro_ft, ' ft');
  const speed = formatOptional(properties.ground_speed_kt, ' kt');
  const track = formatOptional(properties.track_deg, ' deg');
  const registration = String(properties.registration || 'unknown');
  const type = String(properties.aircraft_type || properties.aircraft_class || 'unknown');
  return `
    <div class="adsb-popup">
      <strong>${escapeHtml(title)}</strong>
      <div><span>Registration</span><span>${escapeHtml(registration)}</span></div>
      <div><span>Type</span><span>${escapeHtml(type)}</span></div>
      <div><span>Altitude</span><span>${escapeHtml(altitude)}</span></div>
      <div><span>Speed</span><span>${escapeHtml(speed)}</span></div>
      <div><span>Track</span><span>${escapeHtml(track)}</span></div>
      <div><span>Area</span><span>${escapeHtml(String(properties.area || 'receiver'))}</span></div>
    </div>
  `;
}

function renderRouteHoverPopup(properties: Record<string, unknown>): string {
  const key = trackKeyFromProperties(properties);
  const summary = key ? findSummaryByFlightKey(key) : null;
  const title = summary
    ? flightLabel(summary)
    : String(properties.flight || properties.registration || properties.aircraft_hex || 'Flight route');
  const meta = summary ? flightMeta(summary) : String(properties.aircraft_hex || properties.area || 'published route');
  const observed = summary
    ? formatObservedRange(summary.first_observed_at, summary.last_observed_at)
    : formatObservedRange(stringValue(properties.first_observed_at), stringValue(properties.last_observed_at));
  const altitude = formatOptional(summary?.altitude_ft ?? properties.alt_baro_ft, ' ft');
  const speed = formatOptional(summary?.speed_kt ?? properties.ground_speed_kt, ' kt');
  const points = formatOptional(summary?.point_count ?? properties.point_count, ' pts');
  const hits = Math.round(Number(summary?.property_hits ?? 0)).toLocaleString('en-US');
  const band = String(summary?.altitude_band_ft || properties.altitude_band_ft || 'unknown');
  const area = String(summary?.area || properties.area || 'corridor');

  return `
    <div class="adsb-popup adsb-route-popup">
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(meta)}</p>
      <div><span>Observed</span><span>${escapeHtml(observed)}</span></div>
      <div><span>Altitude</span><span>${escapeHtml(altitude)}</span></div>
      <div><span>Speed</span><span>${escapeHtml(speed)}</span></div>
      <div><span>Band</span><span>${escapeHtml(band)}</span></div>
      <div><span>Area</span><span>${escapeHtml(area)}</span></div>
      <div><span>History</span><span>${escapeHtml(points)} · ${escapeHtml(hits)} hits</span></div>
    </div>
  `;
}

function renderCorridorPopup(properties: Record<string, unknown>, title: string): string {
  const count = formatOptional(properties.count, '');
  const impact = formatOptional(properties.impact_score, '');
  const proximity = String(properties.proximity_band || 'corridor');
  const band = String(properties.altitude_band_ft || 'unknown');
  const cellSize = Number(properties.cell_size_degrees);
  const cellLabel = Number.isFinite(cellSize) ? `${cellSize.toFixed(4)} deg` : 'band';
  const observed = formatObservedRange(
    stringValue(properties.first_observed_at),
    stringValue(properties.last_observed_at || properties.observed_at)
  );
  return `
    <div class="adsb-popup">
      <strong>${escapeHtml(title)}</strong>
      <div><span>Type</span><span>${escapeHtml(proximity)}</span></div>
      <div><span>Observed</span><span>${escapeHtml(observed)}</span></div>
      <div><span>Cell</span><span>${escapeHtml(cellLabel)}</span></div>
      <div><span>Altitude</span><span>${escapeHtml(band)}</span></div>
      <div><span>Count</span><span>${escapeHtml(count)}</span></div>
      <div><span>Impact</span><span>${escapeHtml(impact)}</span></div>
    </div>
  `;
}

function formatObservedRange(startValue: string | null | undefined, endValue: string | null | undefined): string {
  const start = parseDate(startValue);
  const end = parseDate(endValue);
  if (start && end) {
    if (sameLocalDate(start, end)) {
      return `${formatShortDate(start)} ${formatShortClock(start)}-${formatShortClock(end)}`;
    }
    return `${formatShortDateTime(start)}-${formatShortDateTime(end)}`;
  }
  if (start) return formatShortDateTime(start);
  if (end) return formatShortDateTime(end);
  return 'unknown';
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sameLocalDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatShortDateTime(date: Date): string {
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatShortDate(date: Date): string {
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatShortClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatOptional(value: unknown, unit: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'unknown';
  return `${Math.round(number).toLocaleString('en-US')}${unit}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string)
  );
}
