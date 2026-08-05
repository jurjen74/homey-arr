'use strict';

/**
 * Walk history pages backwards until reaching records already processed.
 *
 * A single fixed-size page silently loses events: if more records are created between two polls
 * than fit in one page, the ones that fall below it are never marked seen and never fire, and
 * newer events keep pushing them further down. A library scan or bulk season import routinely
 * produces dozens of records at once, so this is not a corner case.
 *
 * Pages are fetched sequentially and each response is released before the next request, so peak
 * memory stays at one page regardless of how far this walks — which is why the caller should keep
 * `pageSize` small and raise `maxPages` instead.
 *
 * @param {(page: number) => Promise<{records: object[]}>} fetchPage  1-based page fetcher
 * @param {(id: number) => boolean} isSeen     true when a record has already been processed
 * @param {number} pageSize                    page size used by fetchPage, to detect the last page
 * @param {number} maxPages                    hard bound, so a first run or long outage cannot spiral
 * @returns {Promise<object[]>} unseen records, **oldest first** — the order events happened in
 */
async function collectNewHistory({
  fetchPage, isSeen, pageSize, maxPages,
}) {
  const collected = [];

  for (let page = 1; page <= maxPages; page++) {
    // eslint-disable-next-line no-await-in-loop
    const result = await fetchPage(page);
    const records = Array.isArray(result?.records) ? result.records : [];
    if (!records.length) break;

    // Scan the whole page rather than stopping at the first seen record: history is ordered by
    // date, so a backdated record could sit below one already processed.
    let overlapped = false;
    for (const record of records) {
      if (isSeen(record.id)) overlapped = true;
      else collected.push(record);
    }

    // Overlap means everything older has been handled; a short page means there is no more.
    if (overlapped || records.length < pageSize) break;
  }

  return collected.reverse();
}

module.exports = { collectNewHistory };
