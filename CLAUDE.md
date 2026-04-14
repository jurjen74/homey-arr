# Arr Video Suite — Homey App

Homey SDK v3 app (`net.ladenius.arr`) integrating Sonarr and Radarr as Homey devices, with shared home screen widgets.

## Project structure

```
drivers/
  sonarr/         — Sonarr device driver
  radarr/         — Radarr device driver
lib/
  ArrClient.js    — Base HTTP client for the *arr v3 API family
  SonarrClient.js — Extends ArrClient, adds getSeries()
  RadarrClient.js — Extends ArrClient, adds getMovies()
widgets/
  arr-upcoming/   — "Upcoming" widget (works with Sonarr or Radarr device)
  arr-recent/     — "Recently Downloaded" widget (works with Sonarr or Radarr device)
.homeycompose/    — source files; app.json/drivers/widgets are generated from here
```

Build with `homey app build` before deploying. Edit `.homeycompose/` source files, not the generated root-level `app.json`.

## Homey-specific rules

- **`brandColor`** — use `brandColor` in `app.json`, not `color`. The `color` field is silently ignored and Homey falls back to its default green.
- **Spacing variables** — always use `--homey-su-N` (1 unit = 4 px) instead of hardcoded px for padding/margin. Common values: `su-1`=4px, `su-2`=8px, `su-3`=12px, `su-4`=16px.
- **Widget capability filter** — `widget.compose.json` uses `"filter": { "capabilities": "alarm_generic" }` with `"type": "app"` scoping, so the device picker shows only Sonarr/Radarr devices from this app.
- **Capability icons** — SVG icons in `assets/capabilities/` must use `fill="currentColor"` with filled paths. Homey renders icons as a single-color mask; stroke-only icons (`fill="none"` + `stroke`) are invisible.
- **Status indicator** — use the built-in `alarm_generic` boolean capability (`false`=healthy, `true`=issues). Enum capabilities with `uiComponent: "sensor"` do not render on the device card. Customize labels via `capabilitiesOptions` in the driver manifest.
- **Capability migration** — when adding/removing capabilities on existing devices, guard with `hasCapability()` in `onInit` before calling `addCapability()`/`removeCapability()`.

## Shared widget interface

Both `SonarrDevice` and `RadarrDevice` implement identical method signatures so the shared widgets (`arr-upcoming`, `arr-recent`) work with either:

```javascript
// Upcoming items — normalized shape
device.getUpcomingItems(days, count)
// → [{ title, subtitle, badge, releaseDate, hasFile, posterUrl }]
// Sonarr: subtitle=episode title, badge='S01E02', releaseDate=airDateUtc
// Radarr: subtitle='', badge=year string, releaseDate=digitalRelease|physicalRelease|inCinemas

// Recent downloads — normalized shape
device.getRecentItems(count, uniqueTitle)
// → [{ title, subtitle, badge, date, quality, posterUrl }]
```

## Widget device selection

`Homey.getDevice()` does **not** exist in the widget SDK. Use `Homey.getDeviceIds()` instead — returns a `string[]` of selected device IDs. With `singular: true` in the manifest there is always at most one entry. Pass the ID as a query param to `api.js`, which then searches all drivers:

```javascript
// Frontend
const deviceId = Homey.getDeviceIds()[0] ?? '';
Homey.api('GET', `/?deviceId=${encodeURIComponent(deviceId)}`, null);
```

The API resolves the device across both drivers:

```javascript
// api.js pattern
function findDevice(homey, deviceId) {
  for (const driverName of ['sonarr', 'radarr']) {
    try {
      const devices = homey.drivers.getDriver(driverName).getDevices();
      if (deviceId) {
        // d.getId() returns the Homey-internal UUID — matches Homey.getDeviceIds() in the widget.
        // NOTE: d.id (the property) is undefined; only d.getId() (the method) works.
        const found = devices.find(d => d.getId() === deviceId);
        if (found) return found;
      } else if (devices.length) return devices[0];
    } catch {}
  }
  return null;
}
```

## Widget patterns

### Dynamic height

Widgets use `"height": 1` in the manifest to allow shrinking, then call `Homey.setHeight(px)` after each render.

**Do not measure `document.body.scrollHeight`** — Homey may expand the body to fill the iframe, making the measurement wrong in both directions.

Instead:
1. Wrap all widget content in `<div id="wrapper">` (not on `body`).
2. Measure with `Math.ceil(wrapper.getBoundingClientRect().bottom)`.

```javascript
function applyHeight() {
  const h = Math.ceil(document.getElementById('wrapper').getBoundingClientRect().bottom);
  localStorage.setItem(HEIGHT_KEY, h);
  Homey.setHeight(h);
}
```

### Per-device localStorage cache keys

When the same widget type is placed on the dashboard for both a Sonarr and a Radarr device, both instances share the same `localStorage` namespace. Use the `deviceId` as part of the cache key so instances don't bleed into each other:

```javascript
// Declare as let so render() can set per-device keys
let CACHE_KEY  = 'arr-upcoming-html';
let HEIGHT_KEY = 'arr-upcoming-height';

async function render() {
  const deviceId = Homey.getDeviceIds()[0] ?? '';
  CACHE_KEY  = `arr-upcoming-html-${deviceId}`;
  HEIGHT_KEY = `arr-upcoming-height-${deviceId}`;
  // ... rest of render
}
```

### Flash prevention

Two caches in `localStorage` eliminate visual glitches on reload:
- **Content cache** (`*-html-<deviceId>`) — restore previous rendered HTML immediately before the API call completes.
- **Height cache** (`*-height-<deviceId>`) — call `Homey.setHeight(savedH)` at the top of `onHomeyReady`, before `render()`.

### Scrolling

Internal iframe scrolling does **not** work reliably on the Homey dashboard. Use dynamic height to fit all content instead.

### Layout modes

Both widgets support three layouts controlled by a `layout` setting:
- `text` — text only (default)
- `thumbnail-text` — poster image + text
- `thumbnail` — poster grid only

### Secondary line rendering

Use `filter(Boolean).join(' · ')` to avoid orphaned separators when subtitle is empty (e.g., Radarr movies):

```javascript
const secondary = [esc(item.subtitle), group ? '' : esc(dateLabel)].filter(Boolean).join(' &middot; ');
```

## Device polling

Each device's `_poll()` runs on an interval (default 60 s) and calls all updaters in parallel via `Promise.all`. The calendar is fetched 14 days ahead and cached in `this._cachedCalendar`; the widget API reads from this cache.

## History polling and flow triggers

Download/import events are detected by polling `/api/v3/history` (paginated, sorted descending by date) rather than `/history/since`. The timestamp-based `/since` approach was abandoned because clock skew and failed requests caused missed events.

**ID-based deduplication:**
- `_seenHistoryIds` (a `Set`) tracks processed history record IDs in memory.
- On first poll (`_seenHistoryIds === null`), records older than 5 minutes are pre-populated without firing triggers. Records within the last 5 minutes are treated as new — this prevents re-firing flows for old events after a restart while still catching downloads that completed just before a restart.
- `_updateHistory` fetches 100 records with `includeDetails` so embedded series/episode/movie objects are present.

**Event types that trigger "downloaded" flows:**
- `downloadFolderImported` — standard download client import
- `seriesFolderImported` (Sonarr) / `movieFolderImported` (Radarr) — files found via library scan or manual import

**`ArrClient.getRecentHistory(pageSize, includeDetails, eventType)`:**
- `eventType` (numeric) filters server-side: `3` = `downloadFolderImported`. Used by widget calls to avoid fetching grabbed/renamed/failed records.
- `RadarrClient` overrides this method to always include `includeMovie: true`.

**Widget "recent" fetch sizes:**
- Without `uniqueTitle`: `count * 2` records with `eventType: 3` — sufficient since every record is a distinct import.
- With `uniqueTitle` (one item per series/movie): fetch 500 records — a single bulk season download can produce 100+ import records before the next series appears in history.

## Flow card IDs and titles

Flow card IDs must be globally unique within the app. Radarr-specific cards are prefixed with `radarr_`. Cards with different token shapes (e.g., `episode_downloaded` vs `movie_downloaded`) use distinct IDs even without the prefix.

Flow card **titles** must include the driver name (Sonarr/Radarr) wherever the title would otherwise be ambiguous between the two drivers — especially health/status cards that exist in both. Examples:
- ✓ `"Sonarr health status changed"` / `"Radarr health status changed"`
- ✓ `"Sonarr !{{is|is not}} healthy"` / `"Radarr !{{is|is not}} healthy"`
- ✗ `"Health status changed"` (identical for both, confusing in the flow editor)
- ✗ `"Server !{{is|is not}} healthy"` (generic "Server")

## Localization

Supported languages: **en** (English), **nl** (Dutch).

Manifest strings (flow titles, capability labels, widget settings, driver names) use inline `{ "en": "...", "nl": "..." }` objects directly in JSON — do **not** put these in `locales/`.

`locales/en.json` and `locales/nl.json` are only for strings accessed programmatically via `Homey.__('key')` in JS/HTML, such as widget titles and pair UI strings.

When adding new user-visible strings, always add both `en` and `nl` entries.

## Publishing

Validate at publish level first, then publish:

```bash
homey app validate --level publish
homey app publish
```

`homey app validate` (without `--level publish`) only runs debug-level checks and will miss publish-only requirements like driver images.

After `homey app publish` the app appears as a **Draft** in the [Developer Portal](https://tools.developer.homey.app). From there, use **Release to Test** to generate a shareable install link for limited testers before going through full certification.

**Required assets (must exist before publish):**

App-level (in `assets/images/`):
- `small.png` — 250×175 px
- `large.png` — 500×350 px
- `xlarge.png` — 1000×700 px

Driver-level (in `drivers/<id>/assets/images/`):
- `small.png` — 75×75 px
- `large.png` — 500×500 px

Driver image paths in `driver.compose.json` must use the full absolute path from the app root — relative paths are passed through verbatim and the validator resolves them against the build root, not the driver directory:

```json
"images": {
  "small": "/drivers/sonarr/assets/images/small.png",
  "large": "/drivers/sonarr/assets/images/large.png"
}
```

Widget-level (in `widgets/<id>/`):
- `preview-light.png` — 1024×1024 px, shown in widget picker (light mode)
- `preview-dark.png` — 1024×1024 px, shown in widget picker (dark mode)

Widget preview images are auto-discovered by filename — no manifest field needed. They are served from Homey's app store CDN and will appear blank during local development (`homey app run`). They only show correctly after publishing.

**`README.txt`** is the app store description (plain text). Keep it structured with section headers separated by `---`.
