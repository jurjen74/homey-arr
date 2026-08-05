'use strict';

// Shared date helpers for the drivers: calendar-day resolution in the user's zone, and the
// age of an air/release date used by the *_downloaded flow tokens.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Reported as the age when a record has no usable air/release date. Deliberately large and
// positive so an unknown reads as "not recent" and cannot satisfy a `less than N days` flow
// condition by accident.
const UNKNOWN_AGE_DAYS = 9999;

// Intl.DateTimeFormat construction is comparatively expensive and the calendar loops call this
// once per item per poll, so keep one formatter per timezone.
const formatters = new Map();

function formatterFor(timezone) {
  let fmt = formatters.get(timezone);
  if (!fmt) {
    // 'en-US' with explicit parts rather than a locale that happens to render ISO order —
    // Node builds with small-icu only ship en-US locale data, but tzdata is always present.
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year:     'numeric',
      month:    '2-digit',
      day:      '2-digit',
    });
    formatters.set(timezone, fmt);
  }
  return fmt;
}

/**
 * Resolve an instant to its YYYY-MM-DD calendar date in the given IANA timezone.
 * Falls back to the UTC date when the timezone is missing or unsupported.
 *
 * @param {string} timezone  IANA zone name, e.g. from homey.clock.getTimezone()
 * @param {Date}   [date]    Instant to resolve; defaults to now
 * @returns {string} YYYY-MM-DD
 */
function localDate(timezone, date = new Date()) {
  // An unparseable date has no calendar day. Return '' so a caller's date comparison simply
  // never matches, rather than throwing — note the UTC fallback below would throw on this too,
  // and callers feed us API values (`new Date(ep.airDateUtc)`) that are not guaranteed valid.
  if (Number.isNaN(date.getTime())) return '';

  if (timezone) {
    try {
      const parts = formatterFor(timezone).formatToParts(date);
      const get = (type) => parts.find((p) => p.type === type)?.value;
      const [y, m, d] = [get('year'), get('month'), get('day')];
      if (y && m && d) return `${y}-${m}-${d}`;
    } catch {
      // Unknown zone or no tzdata — fall through to UTC.
    }
  }
  return date.toISOString().split('T')[0];
}

/**
 * Whole days elapsed since an air/release date, truncated toward zero.
 *
 * Negative means the date is still in the future — pre-air grabs are normal, so callers testing
 * for "recent" should use a range rather than only an upper bound. Returns UNKNOWN_AGE_DAYS when
 * the value is missing or unparseable.
 *
 * @param {string} isoString  ISO 8601 instant, e.g. an episode's airDateUtc
 * @param {Date}   [now]      Reference point; defaults to now
 * @returns {number} whole days, or UNKNOWN_AGE_DAYS
 */
function daysSince(isoString, now = new Date()) {
  if (!isoString) return UNKNOWN_AGE_DAYS;
  const then = new Date(isoString);
  if (Number.isNaN(then.getTime())) return UNKNOWN_AGE_DAYS;
  // `|| 0` normalises the -0 that Math.trunc yields for dates a few hours in the future.
  return Math.trunc((now.getTime() - then.getTime()) / MS_PER_DAY) || 0;
}

/**
 * Pick the date an item has actually been available from: the most recent one already passed,
 * or — if none has — the soonest upcoming one.
 *
 * Radarr carries digital, physical and cinema dates at once, and a plain precedence order picks
 * the digital date even when it is months away while the film has been in cinemas for weeks. That
 * makes the age a large negative and lets a cam rip satisfy a "less than N days" flow condition.
 *
 * @param {string[]} dates  Candidate ISO instants; empty/invalid entries are ignored
 * @param {Date}     [now]  Reference point; defaults to now
 * @returns {string} the chosen date, or '' if none are usable
 */
function effectiveDate(dates, now = new Date()) {
  const nowMs = now.getTime();
  let past = null;
  let future = null;

  for (const value of dates) {
    if (!value) continue;
    const ms = new Date(value).getTime();
    if (Number.isNaN(ms)) continue;

    if (ms <= nowMs) {
      if (past === null || ms > past.ms) past = { value, ms };
    } else if (future === null || ms < future.ms) {
      future = { value, ms };
    }
  }

  return (past ?? future)?.value ?? '';
}

module.exports = {
  localDate, daysSince, effectiveDate, UNKNOWN_AGE_DAYS,
};
