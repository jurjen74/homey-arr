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
- **App icon (`assets/icon.svg`)** — must use `fill="currentColor"` as an **XML attribute**, not inside a `style=""` string. Homey's native device picker renderer does not resolve `currentColor` from inline CSS, so `style="fill:currentColor"` leaves the icon invisible on the brand color circle. Always write `<path fill="currentColor" fill-rule="evenodd" .../>`.
- **Pair view logo** — the `connect.html` logo should render a brand-colored circle with a white icon, matching how Homey displays icons everywhere else. Set `background: <brandColor>; border-radius: 50%; color: #fff;` on the `.logo` div and use `fill="currentColor"` in the inline SVG. Each driver uses its own brand color (Sonarr: `#00ccff`, Radarr: `#FFC230`).
- **Widget number fields** — always include `"step": 1` on `"type": "number"` settings to restrict input to whole numbers. Without it, the field accepts decimals.
- **Status indicator** — use the built-in `alarm_generic` boolean capability (`false`=healthy, `true`=issues). Enum capabilities with `uiComponent: "sensor"` do not render on the device card. Customize labels via `capabilitiesOptions` in the driver manifest.
- **Capability migration** — when adding/removing capabilities on existing devices, guard with `hasCapability()` in `onInit` before calling `addCapability()`/`removeCapability()`.
- **`process.memoryUsage()` crashes on Homey** — Homey's sandboxed Node runtime does not expose `/proc/self/status`, so `uv_resident_set_memory` throws `ENOENT` and kills the app as an uncaughtException. Never use `process.memoryUsage()`, `os.freemem()`, or `os.totalmem()` in app code.

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

## Memory-efficient API access

Large *arr API responses are parsed per-item rather than building the full object tree, keeping peak heap to ~one item at a time regardless of collection size.

**`ArrClient` helpers (in `lib/ArrClient.js`):**
- `iterJsonArray(text)` — generator that walks raw JSON character-by-character and yields one item substring at a time, tracking depth and string escapes. Never builds a full parsed tree.
- `getArray(path, query, mapFn)` — fetches raw text, iterates per-item via `iterJsonArray`, applies `mapFn` to each `JSON.parse(itemStr)`. Use for top-level array endpoints (`/api/v3/series`, `/api/v3/movie`).
- `getRecords(path, query, mapFn)` — same approach for paginated endpoints returning `{ records: [...], totalRecords: N }`. Locates the `"records"` key then the next `[` after it (two-step, whitespace-tolerant) to find the array start.

**Slim mappers** in `SonarrClient` / `RadarrClient` extract only the fields each caller needs so the discarded raw object is GC'd immediately after each `JSON.parse`.

**Sonarr history note:** `/api/v3/history` always embeds full `series` + `episode` objects in every record regardless of flags, producing ~2 MB for 15 records. Per-item parsing (`getRecentHistorySlim`) keeps peak memory to one record at a time; the raw buffer is still downloaded but is transient.

## Device polling

Each device's `_poll()` runs on an interval (default 60 s) and calls all updaters in parallel via `Promise.all`. The calendar is fetched 14 days ahead and cached in `this._cachedCalendar`; the widget API reads from this cache.

## Calendar dates: UTC vs local

The "today" cards (`episode_airing_today`, `movie_releasing_today`) fire from `_updateUpcoming()`. Getting their date handling right needs three separate distinctions:

**1. The two APIs return different kinds of date, and they must not be treated alike.**

| Field | Kind | Correct comparison |
|-------|------|--------------------|
| Sonarr `airDateUtc` | Real instant — the actual broadcast moment | Convert to the user's zone, then compare dates |
| Radarr `digitalRelease` / `physicalRelease` / `inCinemas` | Date-only value stamped at midnight UTC | Compare the stored string prefix against the local date — **do not** convert |

Converting Radarr's fields to local time shifts every release a day earlier for anyone west of UTC, because `2026-08-04T00:00:00Z` is 19:00 on Aug 3 in New York. They are calendar dates wearing a timestamp, not instants.

**2. "Today" is the user's local day, never the UTC day.** Use `lib/localDate.js` with `this._timezone()` (wraps `homey.clock.getTimezone()`, falls back to UTC). Comparing against `new Date().toISOString().split('T')[0]` makes the card fire at 00:00 UTC — 01:00/02:00 local in CET/CEST, and on the *previous evening* in the Americas.

`localDate()` uses `formatToParts` with an explicit `en-US` locale rather than a locale that renders ISO order (`en-CA`/`sv-SE`); Node small-icu builds only ship `en-US` locale data, though tzdata is always present. Formatters are cached per zone since the calendar loop calls this once per item per poll.

**3. The fetch window stays anchored to the UTC date.** `getCalendar(utcToday, +14d)` is deliberate — UTC-today is at or before the start of local-today in every offset, so the window always covers the local day the comparison is looking for. Do not "fix" it to `localToday`: for positive offsets that would drop episodes airing just after local midnight. Widening it backwards is equally wrong — it inflates `*_upcoming_count` with already-past entries.

**Dedupe state is persisted, not in-memory.** `_firedAiringKeys` / `_firedReleasingKeys` are restored in `onInit` from the device store (`airingKeys` / `releasingKeys`, shape `{ date, keys[] }`) and rewritten only on polls that actually fired. Without this, an app restart — every store update, firmware update, reboot or crash — empties the Set and re-announces the whole day's lineup on the next poll.

The `_seenHistoryIds` "ignore anything older than 5 minutes on first poll" trick does **not** work for these cards: they fire at local midnight, *ahead of* the broadcast, so on a mid-day restart the episode is still in the future and no time-based heuristic can tell "already announced" from "not yet announced". Persistence is the only correct fix.

The store write happens **after** the triggers fire, so a failed write can never suppress an announcement. The trade-off is that a crash between firing and writing re-announces — which is exactly the old behaviour, so it degrades no worse than before.

## Slow poll pattern

The full series/movie library list is expensive to fetch and parse. It runs on a separate 30-minute interval (`_slowPollInterval`) rather than on every fast poll:

- **Runs immediately at startup** (no initial delay) so `_seriesPosterUrls` / `_movieListCache` are populated before the widget's first render call.
- Sets the repeat interval after the first run via `homey.setInterval`.
- Populates `_seriesListCache` / `_movieListCache` (slim entries for autocomplete) and `_seriesPosterUrls` (Map for poster fallback).

**Poster fallback pattern (Sonarr):** The calendar's embedded `series` object may omit images depending on Sonarr version. `getUpcomingItems()` applies the fallback at **read time**, not cache-build time:
```javascript
posterUrl: ep.series.posterUrl || this._seriesPosterUrls?.get(ep.seriesId) || '',
```
This means posters appear as soon as the slow poll completes, without waiting for the calendar to refresh.

## History polling and flow triggers

Download/import events are detected by polling `/api/v3/history` (paginated, sorted descending by date) rather than `/history/since`. The timestamp-based `/since` approach was abandoned because clock skew and failed requests caused missed events.

**ID-based deduplication:**
- `_seenHistoryIds` (a `Set`) tracks processed history record IDs in memory.
- On first poll (`_seenHistoryIds === null`), records older than 5 minutes are pre-populated without firing triggers. Records within the last 5 minutes are treated as new — this prevents re-firing flows for old events after a restart while still catching downloads that completed just before a restart.
- Sonarr's `_updateHistory` uses `getRecentHistorySlim(15)` — per-item parsing. The slim mapper keeps four scalars off the embedded episode (`title`, `airDateUtc`, `seasonNumber`, `episodeNumber`) and discards everything else; the series object is dropped entirely, so the series title is resolved from the per-item cache (`_getSeriesById`) when a trigger fires.
- Radarr's `_updateHistory` uses `getRecentHistory(15, false)` — movie objects are embedded via `RadarrClient`'s override (always passes `includeMovie: true`).

**Event types that trigger "downloaded" flows:**
- `downloadFolderImported` — standard download client import
- `seriesFolderImported` (Sonarr) / `movieFolderImported` (Radarr) — files found via library scan or manual import

**`ArrClient.getRecentHistory(pageSize, includeDetails, eventType)`:**
- `eventType` (numeric) filters server-side: `3` = `downloadFolderImported`. Used by widget calls to avoid fetching grabbed/renamed/failed records.
- `RadarrClient` overrides this method to always include `includeMovie: true`.

**Widget "recent" fetch sizes:**
- Without `uniqueTitle`: `count * 2` records with `eventType: 3` — sufficient since every record is a distinct import.
- With `uniqueTitle` (one item per series/movie): fetch 500 records — a single bulk season download can produce 100+ import records before the next series appears in history.

## Download age tokens

`episode_downloaded` / `movie_downloaded` expose `air_date` / `release_date` plus a numeric
`days_since_air` / `days_since_release`, so a flow can distinguish a genuinely new episode from a
back-catalog or season-pack import with a plain numeric condition — no rolling Logic variable
needed.

- The values come free: Sonarr's history embeds the episode object in every record anyway (see
  the history note above), and `RadarrClient` already passes `includeMovie: true`. The slim
  mappers just stopped discarding the fields.
- `daysSince()` in `lib/localDate.js` truncates toward zero, so **negative values are normal** —
  pre-air grabs happen. A flow testing for "recent" should use a range, not only an upper bound.
- A missing or unparseable date yields `UNKNOWN_AGE_DAYS` (9999), deliberately large and positive
  so an unknown reads as "not recent" and cannot satisfy a `less than N days` condition.
- Season/episode numbers come from Sonarr's embedded episode, falling back to the release-name
  regex only when it is absent. Use `??` not `||` there — season 0 (specials) is a real value.

## Flow card IDs and titles

Flow card IDs must be globally unique within the app. Radarr-specific cards are prefixed with `radarr_`. Cards with different token shapes (e.g., `episode_downloaded` vs `movie_downloaded`) use distinct IDs even without the prefix.

Flow card **titles** must include the driver name (Sonarr/Radarr) wherever the title would otherwise be ambiguous between the two drivers — especially health/status cards that exist in both. Examples:
- ✓ `"Sonarr health status changed"` / `"Radarr health status changed"`
- ✓ `"Sonarr !{{is|is not}} healthy"` / `"Radarr !{{is|is not}} healthy"`
- ✗ `"Health status changed"` (identical for both, confusing in the flow editor)
- ✗ `"Server !{{is|is not}} healthy"` (generic "Server")

## Linting and dependencies

`npm run lint` requires **`tsconfig.json` to exist** — `eslint-config-athom/homey-app` sets `parserOptions.project: "./tsconfig.json"` for its type-aware rules. Without it every file fails with `Parsing error: Cannot read file ... tsconfig.json` and the lint is effectively dead. The project is plain JS, so the tsconfig has `checkJs: false` and `noEmit: true`; it exists only to give `@typescript-eslint/no-floating-promises` and `no-misused-promises` type information. Its `include` must cover every file the lint script visits, or typescript-eslint errors on the ones outside the program.

`.eslintrc.json` turns off the airbnb rules that fight this codebase's deliberate style — aligned object values and assignments (`key-spacing`, `no-multi-spaces`), single-line multi-statement guards (`brace-style`), and the aligned ternary decision chains (`no-nested-ternary`, `indent`, `operator-linebreak`). **Never run `eslint --fix` without checking the diff**: it would strip the column alignment across every mapper in the codebase.

`package.json` declares `engines.node` — without it `eslint-plugin-node` assumes `>=8.0.0` and reports optional catch binding, rest/spread and `URLSearchParams` as unsupported.

**Dependency overrides:** `eslint-config-athom@3.1.5` (the latest release) pins `@typescript-eslint@^6`, whose `typescript-estree` resolves `minimatch` 9.0.3 — inside the 9.0.0–9.0.6 ReDoS range. `npm audit fix` cannot reach it without breaking the config's pin, so `package.json` scopes an override to `^9.0.9`, which still satisfies estree's own `^9.0.3` range. Drop the override once Athom ships a config built on `@typescript-eslint@^8`.

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
