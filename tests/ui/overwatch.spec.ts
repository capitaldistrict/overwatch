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

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
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
    const panelBox = await box(panel);
    const liveBox = await box(livePanel);

    await expect(panel).toHaveAttribute('data-drawer-state', 'medium');
    await expect(page.getByTestId('drawer-handle')).toBeVisible();
    expect(panelBox.width).toBeCloseTo(viewport!.width, 1);
    expect(panelBox.height).toBeGreaterThan(250);
    expect(panelBox.height).toBeLessThan(330);
    expect(liveBox.y + liveBox.height).toBeLessThanOrEqual(panelBox.y + 2);

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
