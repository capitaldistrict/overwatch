import { expect, test, type Locator, type Page } from '@playwright/test';

const blankPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
);

const parcelOverflightsFixture = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        parcel_id: '72.6-1-9',
        source_pin: '72.6-1-9',
        count: 2,
        flight_count: 1,
        min_altitude_ft: 12500,
        latest_altitude_ft: 12600,
        altitude_severity: 'subtle',
        last_observed_at: '2026-06-03T05:45:00Z',
      },
      geometry: { type: 'Point', coordinates: [-73.86, 42.8] },
    },
  ],
};

const flightSummariesFixture = {
  updated_at: '2026-06-03T22:30:00Z',
  active_count: 2,
  geobounds_count: 1,
  property_hit_count: 1,
  summaries: [
    {
      active: true,
      aircraft_class: 'general aviation',
      aircraft_hex: 'A90802',
      aircraft_type: 'C172',
      altitude_band_ft: '0-2499',
      altitude_ft: 1975,
      area: 'niskayuna',
      flight: 'N681MA',
      geobounds_hit: true,
      impact_score: 12,
      label: 'N681MA',
      last_observed_at: '2026-06-03T22:30:00Z',
      persisted: true,
      point_count: 12,
      property_hits: 2,
      speed_kt: 118,
      track_deg: 18,
      track_key: 'hex:A90802',
      sparkline: {
        altitude_ft: [2100, 2050, 1975],
        speed_kt: [112, 116, 118],
        property_hits: [0, 1, 2],
      },
    },
    {
      active: true,
      aircraft_class: 'commercial',
      aircraft_hex: 'A537B2',
      aircraft_type: 'B737',
      altitude_band_ft: '10000+',
      altitude_ft: 40000,
      area: 'corridor',
      flight: 'SWA3974',
      geobounds_hit: false,
      impact_score: 4,
      label: 'SWA3974',
      last_observed_at: '2026-06-03T22:29:00Z',
      persisted: false,
      point_count: 4,
      property_hits: 0,
      speed_kt: 437,
      track_deg: 270,
      track_key: 'hex:A537B2',
      sparkline: {
        altitude_ft: [40000, 40000, 40000],
        speed_kt: [436, 437, 437],
        property_hits: [0, 0, 0],
      },
    },
    {
      active: false,
      aircraft_class: 'unknown',
      aircraft_hex: 'BEE123',
      altitude_band_ft: '10000+',
      altitude_ft: 18000,
      area: 'corridor',
      geobounds_hit: false,
      impact_score: 1,
      label: 'BEE123',
      last_observed_at: '2026-06-03T22:10:00Z',
      persisted: true,
      point_count: 1,
      property_hits: 0,
      track_key: 'hex:BEE123',
    },
  ],
};

test.describe('desktop layout', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop');
    await loadApp(page);
  });

  test('keeps the map and analysis rail side by side', async ({ page }) => {
    const mapBox = await box(page.getByTestId('map-wrap'));
    const panelBox = await box(page.getByTestId('overflight-drawer'));
    const handle = page.getByTestId('drawer-handle');

    expect(panelBox.width).toBeGreaterThanOrEqual(350);
    expect(panelBox.x).toBeGreaterThan(mapBox.x + mapBox.width - 2);
    await expect(handle).toBeHidden();
    await expect(page.getByText('Static site; updates after the next published snapshot.')).toBeVisible();
    await expect(page.locator('#map-layer-controls')).toBeVisible();
    await expect(page.locator('#map-legend')).toBeVisible();
    await expect(page.locator('#adsb-refresh-snapshot')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#adsb-refresh-monitor')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#adsb-refresh-rate')).toBeDisabled();
    await expect(page.getByText('Monitor polls the latest published files')).toBeVisible();

    await page.locator('#adsb-refresh-monitor').click();
    await expect(page.locator('#adsb-refresh-monitor')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#adsb-refresh-rate')).toBeEnabled();

    const routesToggle = page.locator('[data-map-layer="routes"]');
    await expect(routesToggle).toHaveAttribute('aria-pressed', 'true');
    await routesToggle.click();
    await expect(routesToggle).toHaveAttribute('aria-pressed', 'false');
    await routesToggle.click();
    await expect(routesToggle).toHaveAttribute('aria-pressed', 'true');

    const corridorsToggle = page.locator('[data-map-layer="corridors"]');
    await expect(corridorsToggle).toHaveAttribute('aria-pressed', 'true');
    await corridorsToggle.click();
    await expect(corridorsToggle).toHaveAttribute('aria-pressed', 'false');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('focuses a selected flight and exposes the low-altitude facet', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Low alt/ })).toBeVisible();

    const flight = page.locator('[data-flight-key="hex:A90802"]').first();
    await expect(flight).toBeVisible();
    await flight.click();

    await expect(flight).toHaveClass(/selected/);
    await expect(page.locator('#map-focus-banner')).toBeVisible();
    await expect(page.locator('#map-focus-banner')).toContainText('N681MA');
    await expect(page.locator('#flight-focus-clear')).toBeVisible();

    await page.locator('#flight-focus-clear').click();
    await expect(page.locator('#map-focus-banner')).toBeHidden();
  });
});

test.describe('mobile drawer', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile');
    await loadApp(page);
  });

  test('starts as a map-first bottom sheet without horizontal overflow', async ({ page }) => {
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();

    const panel = page.getByTestId('overflight-drawer');
    const livePanel = page.locator('#adsb-live-panel');
    const progressiveIndicator = page.locator('#mobile-progressive-indicator');
    const panelBox = await box(panel);
    const liveBox = await box(livePanel);
    const layerControlsBox = await box(page.locator('#map-layer-controls'));

    await expect(panel).toHaveAttribute('data-drawer-state', 'medium');
    await expect(page.getByTestId('drawer-handle')).toBeVisible();
    await expect(progressiveIndicator).toBeVisible();
    await expect(progressiveIndicator).toContainText(/Overview|Routes|Impact|Parcel detail/);
    expect(panelBox.width).toBeCloseTo(viewport!.width, 1);
    expect(panelBox.height).toBeGreaterThan(250);
    expect(panelBox.height).toBeLessThan(330);
    expect(layerControlsBox.width).toBeLessThan(viewport!.width - 58);
    expect(liveBox.y + liveBox.height).toBeLessThanOrEqual(panelBox.y + 2);
    expect(liveBox.height).toBeLessThan(76);
    await expect(page.locator('.adsb-refresh-controls')).toBeHidden();
    await expect(page.locator('#adsb-live-list')).toBeHidden();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('cycles through expanded, peek, and medium states', async ({ page }) => {
    const panel = page.getByTestId('overflight-drawer');
    const handle = page.getByTestId('drawer-handle');
    const livePanel = page.locator('#adsb-live-panel');
    const mediumHeight = (await box(panel)).height;

    await handle.click();
    await expect(panel).toHaveAttribute('data-drawer-state', 'expanded');
    await expect(handle).toHaveAttribute('aria-expanded', 'true');
    await expect(handle).toHaveAttribute('aria-label', 'Collapse overflight drawer');
    await page.waitForTimeout(260);
    expect((await box(panel)).height).toBeGreaterThan(mediumHeight + 250);
    expect(Number(await livePanel.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(0.2);

    await handle.click();
    await expect(panel).toHaveAttribute('data-drawer-state', 'peek');
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    await expect(handle).toHaveAttribute('aria-label', 'Open overflight drawer');
    await page.waitForTimeout(260);
    expect((await box(panel)).height).toBeLessThan(mediumHeight - 100);
    await expect(page.locator('#flight-watch-list')).toBeHidden();

    await handle.click();
    await expect(panel).toHaveAttribute('data-drawer-state', 'medium');
    await expect(handle).toHaveAttribute('aria-label', 'Expand overflight drawer');
    await page.waitForTimeout(260);
    expect((await box(panel)).height).toBeGreaterThan(mediumHeight - 20);
    expect(Number(await livePanel.evaluate((el) => getComputedStyle(el).opacity))).toBeGreaterThan(0.8);
  });

  test('snaps after drag gestures', async ({ page }) => {
    const panel = page.getByTestId('overflight-drawer');
    const handle = page.getByTestId('drawer-handle');

    await dragHandle(page, handle, -280);
    await expect(panel).toHaveAttribute('data-drawer-state', 'expanded');
    await page.waitForTimeout(260);
    const expandedHeight = (await box(panel)).height;

    await dragHandle(page, handle, 520);
    await expect(panel).toHaveAttribute('data-drawer-state', 'peek');
    await page.waitForTimeout(260);
    expect((await box(panel)).height).toBeLessThan(expandedHeight - 350);
  });

  test('search result opens parcel detail in the expanded drawer', async ({ page }) => {
    const search = page.getByLabel('Search parcels by address or PIN');
    await search.fill('660 Fillmore');
    const firstResult = page.locator('#results .result').first();
    await expect(firstResult).toBeVisible();
    await firstResult.click();

    const panel = page.getByTestId('overflight-drawer');
    await expect(panel).toHaveAttribute('data-drawer-state', 'expanded');
    await expect(page.locator('#parcel-detail')).toContainText(/PIN|Parcel ID/);
    await expect(page.locator('#parcel-detail')).toContainText('Overflights');
    await expect(page.locator('#parcel-detail')).toContainText('10,000+ ft');
  });
});

async function loadApp(page: Page) {
  await page.route(/https:\/\/[abc]\.tile\.openstreetmap\.org\/.*/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/png', body: blankPng });
  });
  await page.route(/\/adsb\/parcel-overflights\.geojson.*/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(parcelOverflightsFixture),
    });
  });
  await page.route(/\/adsb\/flight-summaries\.json.*/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(flightSummariesFixture),
    });
  });
  await page.goto('/');
  await expect(page.getByTestId('map')).toBeVisible();
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
}

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  expect(rect).not.toBeNull();
  return rect!;
}

async function dragHandle(page: Page, handle: Locator, deltaY: number) {
  const handleBox = await box(handle);
  const x = handleBox.x + handleBox.width / 2;
  const y = handleBox.y + handleBox.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + deltaY, { steps: 12 });
  await page.mouse.up();
}
