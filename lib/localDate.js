'use strict';

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

module.exports = { localDate };
