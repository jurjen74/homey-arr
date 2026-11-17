'use strict';

const { heapText, megabytes, count } = require('./diagnostics');

// Device-store key. Present only while there is something to remember; a healthy device has none.
const STORE_KEY = 'libraryGuard';

// How long the library is left alone after the app died while loading it, by number of runs in
// a row that ended that way. Each is a few minutes short of a multiple of the 30-minute refresh
// interval, so the retry lands on a regular tick instead of just missing one.
const MINUTE = 60 * 1000;
const BACKOFF_MS = [30, 120, 360, 1440].map((minutes) => (minutes - 5) * MINUTE);

// Big libraries report how far they are, so that a log cut off mid-load still says how much
// had arrived. Small ones never reach the first step and stay silent.
const PROGRESS_EVERY = 5000;

// Errors that take the whole device down, not just the library. The regular poll hits the same
// wall within a minute and marks the device unavailable with the same reason, so a warning on
// top of that would only repeat it — and outlive it by up to half an hour.
const DEVICE_WIDE = new Set(['refused', 'not_found', 'unauthorized', 'invalid_url', 'network']);

const WORDING = {
  movies: { label: 'Movie', noun: 'movies' },
  series: { label: 'Series', noun: 'series' },
};

/**
 * Wraps a device's library refresh — the one fetch whose size the app does not control — so
 * that when it goes wrong, the user is told what happened instead of watching the app restart.
 *
 * An out-of-memory abort cannot be caught: the process is gone before any handler runs. So the
 * guard leaves a note in the device store before a refresh that has not yet succeeded in this
 * run, and removes it afterwards. A note still there at startup means the previous run died
 * mid-refresh. The library is then skipped for a while, with a warning on the device, a line in
 * the log and (the first time) a timeline notification; health, queue, calendar and downloads
 * carry on, where before the app would crash again within seconds, indefinitely.
 *
 * A refresh that merely fails — a timeout, a response that is not what it should be — shows as
 * a warning too, and clears on the next success.
 */
class LibraryGuard {

  /**
   * @param {object} options
   * @param {import('homey').Device} options.device
   * @param {'movies'|'series'} options.kind
   * @param {() => number} [options.now]
   */
  constructor({ device, kind, now = Date.now }) {
    this._device  = device;
    this._kind    = kind;
    this._wording = WORDING[kind];
    this._now     = now;
    this._version = String(device.homey.manifest?.version || '');

    this._state      = { pending: null, crashes: 0, retryAt: 0 }; // replaced by start()
    this._proven     = false; // a refresh has completed in this run
    this._running    = false;
    this._failed     = false; // the last refresh ended in an error
    this._warned     = false; // a warning of ours is showing
    this._loggedSize = null;  // last "N items" written to the log
    this._lastCount  = null;
  }

  /** True while the library is being left alone after a crash. Nothing may fetch it meanwhile. */
  get paused() {
    return this._state.retryAt > this._now();
  }

  /** True when the last refresh ended in an error (as opposed to never having run, or paused). */
  get failed() {
    return this._failed;
  }

  /** One phrase for log lines written elsewhere, e.g. "6,214 movies". */
  summary() {
    if (this.paused) return `${this._wording.noun} skipped after a crash`;
    if (this._lastCount === null) return `${this._wording.noun} not loaded`;
    return `${count(this._lastCount)} ${this._wording.noun}`;
  }

  /**
   * Reads what the previous run left behind. Call once from onInit, before the first refresh.
   */
  async start() {
    const stored = this._device.getStoreValue(STORE_KEY);
    // A note from another version of the app is not evidence against this one.
    const mine = stored && stored.version === this._version ? stored : {};
    this._state = {
      pending:  mine.pending  || null,
      crashes:  mine.crashes  || 0,
      retryAt:  mine.retryAt  || 0,
    };

    if (this._state.pending) {
      // The refresh that started then never finished: the process died with it.
      const startedAt = new Date(this._state.pending).toISOString();
      this._state.crashes += 1;
      this._state.retryAt  = this._now() + BACKOFF_MS[Math.min(this._state.crashes, BACKOFF_MS.length) - 1];
      this._state.pending  = null;
      await this._save();

      this._device.error(
        `The previous run ended while loading the ${this._wording.noun} (started ${startedAt}), `
        + `most likely out of memory. Skipping the library until ${new Date(this._state.retryAt).toISOString()} `
        + `(${this._state.crashes} in a row) — ${heapText()}`,
      );
      await this._warn(`device.warning.${this._kind}_crashed`);
      // Once, not on every retry that fails the same way: the warning on the device stays.
      if (this._state.crashes === 1) await this._notify(`notification.${this._kind}_crashed`);
    } else if (this.paused) {
      // Restarted for some other reason while an earlier crash is still being waited out.
      this._device.log(`Still skipping the ${this._wording.noun} until ${new Date(this._state.retryAt).toISOString()} after an earlier crash`);
      await this._warn(`device.warning.${this._kind}_crashed`);
    }
  }

  /**
   * Runs one refresh. Never rejects.
   *
   * @param {(stats: object) => Promise<number>} refresh  Does the work and resolves with the
   *   number of items. `stats` is to be handed to the client so progress can be reported.
   * @returns {Promise<boolean>} true when the library was refreshed
   */
  async run(refresh) {
    if (this._running || this.paused) return false;
    this._running = true;

    // Only a refresh that has not yet succeeded in this run is worth a store write. Once one
    // has, the next is the same request against the same server; should that one kill the app
    // after all, the refresh at the following startup is marked again and catches it.
    const marked = !this._proven;
    const startedAt = this._now();
    const stats = {
      bytes: 0,
      items: 0,
      every: PROGRESS_EVERY,
      onProgress: (s) => this._device.log(`Loading ${this._wording.noun}: ${count(s.items)} so far, ${megabytes(s.bytes)} MB — ${heapText()}`),
    };

    try {
      if (marked) {
        this._state.pending = startedAt;
        await this._save();
      }

      const items = await refresh(stats);

      const recovered = this._state.crashes > 0;
      this._proven    = true;
      this._failed    = false;
      this._lastCount = items;
      this._state     = { pending: null, crashes: 0, retryAt: 0 };
      if (marked) await this._save();
      // The first success of a run also clears a warning a previous run may have left showing.
      if (this._warned || marked) await this._unwarn();

      const size = `${count(items)} ${this._wording.noun}`;
      if (size !== this._loggedSize || recovered) {
        this._loggedSize = size;
        this._device.log(`${this._wording.label} library: ${size}, ${megabytes(stats.bytes)} MB in ${((this._now() - startedAt) / 1000).toFixed(1)} s — ${heapText()}`);
      }
      return true;
    } catch (err) {
      // It failed; it did not take the process down. Not a crash, so the note goes.
      this._failed = true;
      if (this._state.pending) {
        this._state.pending = null;
        await this._save();
      }
      this._device.error(`${this._wording.label} refresh failed:`, err.message);
      if (!DEVICE_WIDE.has(err.code)) {
        await this._warn(`device.warning.${this._kind}_failed`, { reason: err.message });
      }
      return false;
    } finally {
      this._running = false;
    }
  }

  /**
   * The app is stopping in the ordinary way. A refresh cut off by that is not a crash, so the
   * note it left must not be found at the next start.
   */
  async stop() {
    if (this._state.pending) {
      this._state.pending = null;
      await this._save();
    }
  }

  /**
   * Forget everything and allow a refresh straight away — the settings changed, so this may be
   * another server, or the user's way of saying "try again".
   */
  async reset() {
    this._state  = { pending: null, crashes: 0, retryAt: 0 };
    this._proven = false;
    this._failed = false;
    await this._save();
    await this._unwarn();
  }

  // --- internals -------------------------------------------------------------------------------

  // Losing the note costs the protection, not the refresh: never let the store get in the way.
  async _save() {
    try {
      const { pending, crashes, retryAt } = this._state;
      if (!pending && !crashes && !retryAt) {
        if (this._device.getStoreValue(STORE_KEY) != null) await this._device.unsetStoreValue(STORE_KEY);
      } else {
        await this._device.setStoreValue(STORE_KEY, {
          version: this._version, pending, crashes, retryAt,
        });
      }
    } catch (err) {
      this._device.error('Library guard could not write its state:', err.message);
    }
  }

  async _warn(key, tags) {
    try {
      await this._device.setWarning(this._device.homey.__(key, tags));
      this._warned = true;
    } catch (err) {
      this._device.error('Setting the device warning failed:', err.message);
    }
  }

  async _unwarn() {
    try {
      await this._device.unsetWarning();
      this._warned = false;
    } catch (err) {
      this._device.error('Clearing the device warning failed:', err.message);
    }
  }

  async _notify(key) {
    try {
      const excerpt = this._device.homey.__(key, { device: this._device.getName() });
      await this._device.homey.notifications.createNotification({ excerpt });
    } catch (err) {
      this._device.error('Creating the notification failed:', err.message);
    }
  }

}

module.exports = LibraryGuard;
