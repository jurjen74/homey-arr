'use strict';

// Facts about the runtime, for the log lines that end up in a diagnostics report.
//
// Everything here is best-effort and must never throw: v1.0.10 crashed on startup because its
// memory logging called process.memoryUsage(), which Homey's sandbox cannot serve (see
// CLAUDE.md). v8.getHeapStatistics() asks V8 itself and reads nothing from /proc, but it is
// still wrapped — a diagnostic that fails should cost its own log line and nothing else.

const MB = 1024 * 1024;

let v8 = null;
try {
  // eslint-disable-next-line global-require
  v8 = require('v8');
} catch {
  // Left null: heapStats() then reports nothing.
}

/**
 * @returns {{ usedMb: number, limitMb: number } | null} null when the numbers cannot be read.
 *   `limitMb` is what V8 reports as its limit. It includes room that only the young generation
 *   can use, so the heap is in trouble well before `usedMb` reaches it — read it as a property
 *   of the device, not as a gauge.
 */
function heapStats() {
  try {
    const stats = v8.getHeapStatistics();
    return {
      usedMb:  Math.round(stats.used_heap_size / MB),
      limitMb: Math.round(stats.heap_size_limit / MB),
    };
  } catch {
    return null;
  }
}

/** @returns {string} e.g. "heap 14 of 128 MB" */
function heapText() {
  const heap = heapStats();
  return heap ? `heap ${heap.usedMb} of ${heap.limitMb} MB` : 'heap unknown';
}

// The V8 options that size the heap, wherever they were given. Only these: other options are
// nobody's business in a log that users send on.
function heapFlags() {
  try {
    const all = [...process.execArgv, ...String(process.env.NODE_OPTIONS || '').split(/\s+/)];
    return all.filter((arg) => /^--(max|min|initial)[-_](old|semi|heap|young)/.test(arg));
  } catch {
    return [];
  }
}

/** @returns {string} e.g. "Node v22.20.0, heap limit 128 MB (--max-old-space-size=80)" */
function runtimeText() {
  const heap = heapStats();
  const flags = heapFlags();
  return [
    `Node ${process.version}`,
    heap ? `heap limit ${heap.limitMb} MB` : 'heap limit unknown',
  ].join(', ') + (flags.length ? ` (${flags.join(' ')})` : '');
}

/** @returns {string} megabytes with one decimal, e.g. "38.6" */
function megabytes(bytes) {
  return (bytes / MB).toFixed(1);
}

/** @returns {string} thousands separated, e.g. "6,214". en-US is the one locale small-icu has. */
function count(n) {
  return Number(n).toLocaleString('en-US');
}

module.exports = {
  heapStats, heapText, runtimeText, megabytes, count,
};
