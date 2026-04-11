# Sonarr Homey App

Homey SDK v3 app (`net.ladenius.sonarr`) that integrates a Sonarr server as a Homey device, with home screen widgets.

## Project structure

```
drivers/sonarr/       — device driver (polling, capabilities, triggers, actions)
lib/SonarrClient.js   — thin HTTP wrapper around the Sonarr v3 API
widgets/
  sonarr-upcoming/    — "Upcoming Episodes" home screen widget
  sonarr-recent/      — "Recently Downloaded" home screen widget
.homeycompose/        — source files; app.json/drivers/widgets are generated from here
```

Build with `homey app build` before deploying. Edit `.homeycompose/` source files, not the generated root-level `app.json`.

## Homey-specific rules

- **`brandColor`** — use `brandColor` in `app.json`, not `color`. The `color` field is silently ignored and Homey falls back to its default green.
- **Spacing variables** — always use `--homey-su-N` (1 unit = 4 px) instead of hardcoded px for padding/margin. Common values: `su-1`=4px, `su-2`=8px, `su-3`=12px, `su-4`=16px.
- **Widget capability filter** — `widget.compose.json` uses `"filter": { "capabilities": "sonarr_status" }` so the widget only binds to this app's device.

## Widget patterns

### Dynamic height

Widgets use `"height": 1` in the manifest to allow shrinking, then call `Homey.setHeight(px)` after each render.

**Do not measure `document.body.scrollHeight`** — Homey may expand the body to fill the iframe, making the measurement wrong in both directions (too large when content is short, clipped when content is tall).

Instead:
1. Wrap all widget content in `<div id="wrapper">` (not on `body`).
2. Measure with `Math.ceil(wrapper.getBoundingClientRect().bottom)` — this captures the wrapper's true bottom edge including any body margin Homey injects.

```javascript
function applyHeight() {
  const h = Math.ceil(document.getElementById('wrapper').getBoundingClientRect().bottom);
  localStorage.setItem(HEIGHT_KEY, h);
  Homey.setHeight(h);
}
```

### Flash prevention

Two caches in `localStorage` eliminate visual glitches on reload:
- **Content cache** (`*-html`) — restore previous rendered HTML immediately before the API call completes, avoiding an empty-list flash.
- **Height cache** (`*-height`) — call `Homey.setHeight(savedH)` at the top of `onHomeyReady`, before `render()`, avoiding the height-1-to-full-height jump.

### Scrolling

Internal iframe scrolling does **not** work reliably on the Homey dashboard. When the dashboard is itself scrollable, Homey's native layer captures vertical touch gestures before the iframe's JS can handle them. Do not attempt to implement scrollable widgets — use dynamic height to fit all content instead.

### Layout modes

Both widgets support three layouts controlled by a `layout` setting:
- `text` — text only (default)
- `thumbnail-text` — poster image + text
- `thumbnail` — poster grid only

The CSS class is applied to `#list`:
```javascript
list.className = 'list'
  + (layout === 'thumbnail-text' ? ' thumb-text' : '')
  + (layout === 'thumbnail'      ? ' thumb-only' : '');
```

### Secondary line rendering

Use `filter(Boolean).join(' · ')` to avoid orphaned separators when a part is empty:

```javascript
[esc(ep.title), group ? '' : esc(dateLabel)].filter(Boolean).join(' &middot; ')
```

## Device polling

`SonarrDevice._poll()` runs on an interval (default 60 s) and calls all updaters in parallel via `Promise.all`. The calendar is fetched 14 days ahead and cached in `this._cachedCalendar`; the widget API reads from this cache, it does not hit Sonarr directly.

## Widget API

Widget `api.js` files receive `{ homey, query }`. They resolve the device from the driver and delegate:

```javascript
// widgets/sonarr-upcoming/api.js
async getUpcoming({ homey, query }) {
  const devices = homey.drivers.getDriver('sonarr').getDevices();
  if (!devices.length) throw new Error('No Sonarr device found');
  return devices[0].getUpcomingEpisodes(days, count);
}
```

The widget HTML calls this via `Homey.api('GET', `/?days=7&count=5`, null)`.
