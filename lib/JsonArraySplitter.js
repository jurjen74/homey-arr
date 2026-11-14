'use strict';

// JSON's structural characters are all ASCII, and UTF-8 never uses a byte below 0x80 inside a
// multi-byte character. So a response can be scanned for item boundaries as raw bytes, straight
// off the socket, without decoding it first.
const QUOTE     = 0x22; // "
const BACKSLASH = 0x5c; // \
const COMMA     = 0x2c; // ,
const LBRACKET  = 0x5b; // [
const RBRACKET  = 0x5d; // ]
const LBRACE    = 0x7b; // {
const RBRACE    = 0x7d; // }

// One item is a single movie, series or history record: a few KB, at most a few hundred. The
// limit only exists so that a response which is not what it claims to be cannot grow without
// bound while waiting for an item to close.
const DEFAULT_MAX_ITEM_BYTES = 4 * 1024 * 1024;

// Everything around the array: `{ "page": 1, …, "totalRecords": 42, "records": [` and `] }`.
const MAX_ENVELOPE_BYTES = 64 * 1024;

// How far back from an opening `[` to look for the property name it belongs to.
const KEY_LOOKBEHIND_BYTES = 256;

function isWhitespace(c) {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
}

class JsonSplitError extends Error {

  constructor(message) {
    super(message);
    this.name = 'JsonSplitError';
  }

}

/**
 * Splits a JSON array into its items while the response is still arriving.
 *
 * Feed it the body chunks in order; `onItem` is called with the text of each array item as soon
 * as that item is complete. Nothing but the item currently being received is held, so memory
 * stays at one chunk plus one item however long the array is.
 *
 * It is a splitter, not a validator: it tracks nesting and strings just far enough to find where
 * items end, and leaves checking each item to the JSON.parse the caller runs on it.
 */
class JsonArraySplitter {

  /**
   * @param {object} options
   * @param {(text: string) => void} options.onItem
   * @param {string|null} [options.key]  null when the response itself is the array. A property
   *   name when the array is that property of a top-level object, as in the paged endpoints'
   *   `{ "totalRecords": N, "records": [...] }`.
   * @param {number} [options.maxItemBytes]
   */
  constructor({ onItem, key = null, maxItemBytes = DEFAULT_MAX_ITEM_BYTES }) {
    this._onItem       = onItem;
    this._maxItemBytes = maxItemBytes;

    this._wrapped    = key !== null;
    this._opener     = this._wrapped ? LBRACE : LBRACKET;
    // Nesting depth while directly inside the array whose items are wanted.
    this._arrayDepth = this._wrapped ? 2 : 1;
    this._keyPattern = this._wrapped
      ? new RegExp(`(?:^|[^\\\\])"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*$`)
      : null;

    // Scanner state, carried from one chunk to the next.
    this._depth     = 0;
    this._inString  = false;
    this._escape    = false;
    this._inArray   = false;
    this._arrayDone = false;
    this._rootDone  = false;

    // The part of the item being received that arrived in earlier chunks.
    this._itemOpen  = false;
    this._itemParts = [];
    this._itemBytes = 0;

    // Wrapped mode only: the bytes outside the array, kept so the surrounding object's own
    // fields can be read once the response is complete.
    this._envelopeParts = [];
    this._envelopeBytes = 0;
  }

  /** @param {Buffer} chunk */
  write(chunk) {
    const n          = chunk.length;
    const arrayDepth = this._arrayDepth;

    let depth    = this._depth;
    let inString = this._inString;
    let escape   = this._escape;
    let inArray  = this._inArray;

    // Offsets into this chunk, -1 when there is none. An item or envelope run left open by the
    // previous chunk continues from the first byte of this one.
    let itemStart     = this._itemOpen ? 0 : -1;
    let envelopeStart = this._wrapped && depth > 0 && !inArray ? 0 : -1;

    for (let i = 0; i < n; i++) {
      const c = chunk[i];

      if (inString) {
        if (escape) escape = false;
        else if (c === BACKSLASH) escape = true;
        else if (c === QUOTE) inString = false;
        continue;
      }

      if (depth === 0) {
        // Outside the top-level value: before it opens, or after it has closed. A UTF-8 byte
        // order mark (EF BB BF) can only precede it.
        if (this._rootDone || isWhitespace(c) || c === 0xef || c === 0xbb || c === 0xbf) continue;
        if (c !== this._opener) {
          throw new JsonSplitError(this._wrapped ? 'response is not a JSON object' : 'response is not a JSON array');
        }
        depth = 1;
        if (this._wrapped) envelopeStart = i;
        else inArray = true;
        continue;
      }

      if (inArray && depth === arrayDepth) {
        // Directly inside the array: between items, or in an item that is a bare scalar.
        if (c === COMMA || c === RBRACKET) {
          if (itemStart !== -1) {
            this._emit(chunk, itemStart, i);
            itemStart = -1;
          }
          if (c === RBRACKET) {
            inArray = false;
            this._arrayDone = true;
            depth--;
            if (depth === 0) this._rootDone = true;
            else envelopeStart = i; // the closing bracket belongs to the envelope again
          }
          continue;
        }
        if (itemStart === -1) {
          if (isWhitespace(c)) continue;
          itemStart = i;
        }
      }

      if (c === QUOTE) {
        inString = true;
      } else if (c === LBRACE || c === LBRACKET) {
        if (c === LBRACKET && depth === 1 && envelopeStart !== -1 && !this._arrayDone
            && this._followsKey(chunk, envelopeStart, i)) {
          // The bracket itself stays in the envelope; what is inside it does not.
          this._keepEnvelope(chunk, envelopeStart, i + 1);
          envelopeStart = -1;
          inArray = true;
        }
        depth++;
      } else if (c === RBRACE || c === RBRACKET) {
        depth--;
        if (inArray && depth < arrayDepth) throw new JsonSplitError('array closed by the wrong bracket');
        if (depth === 0) {
          this._rootDone = true;
          if (envelopeStart !== -1) {
            this._keepEnvelope(chunk, envelopeStart, i + 1);
            envelopeStart = -1;
          }
        }
      }
    }

    if (itemStart !== -1) {
      this._itemParts.push(chunk.subarray(itemStart));
      this._itemBytes += n - itemStart;
      if (this._itemBytes > this._maxItemBytes) throw new JsonSplitError('item exceeds the size limit');
    }
    if (envelopeStart !== -1) this._keepEnvelope(chunk, envelopeStart, n);

    this._itemOpen = itemStart !== -1;
    this._depth    = depth;
    this._inString = inString;
    this._escape   = escape;
    this._inArray  = inArray;
  }

  /**
   * Call once the response has ended.
   *
   * @returns {{ complete: boolean, envelope: object|null }} `complete` is true only when the
   *   array and the value around it were both closed — anything less means the response was cut
   *   short or was not the expected shape, and the items seen so far must not be trusted as the
   *   whole list. `envelope` is the surrounding object with the array emptied (wrapped mode).
   */
  end() {
    const complete = this._rootDone && this._arrayDone;
    let envelope = null;
    if (complete && this._wrapped) {
      try {
        envelope = JSON.parse(Buffer.concat(this._envelopeParts).toString('utf8'));
      } catch {
        return { complete: false, envelope: null };
      }
    }
    return { complete, envelope };
  }

  _emit(chunk, start, end) {
    let text;
    if (this._itemParts.length) {
      this._itemParts.push(chunk.subarray(start, end));
      text = Buffer.concat(this._itemParts).toString('utf8');
      this._itemParts = [];
      this._itemBytes = 0;
    } else {
      text = chunk.toString('utf8', start, end);
    }
    this._onItem(text);
  }

  _keepEnvelope(chunk, start, end) {
    this._envelopeBytes += end - start;
    if (this._envelopeBytes > MAX_ENVELOPE_BYTES) throw new JsonSplitError('unexpected response shape');
    this._envelopeParts.push(chunk.subarray(start, end));
  }

  // True when the `[` at chunk[at] is the value of the wanted property, i.e. the envelope so far
  // ends with `"key":`. Runs once per array-valued property of the top-level object.
  _followsKey(chunk, envelopeStart, at) {
    const before = Buffer.concat([...this._envelopeParts, chunk.subarray(envelopeStart, at)]);
    const tail   = before.toString('latin1', Math.max(0, before.length - KEY_LOOKBEHIND_BYTES));
    return this._keyPattern.test(tail);
  }

}

module.exports = { JsonArraySplitter, JsonSplitError };
