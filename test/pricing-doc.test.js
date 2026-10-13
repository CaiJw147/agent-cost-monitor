// The offline pricing document and the diff that decides when to rewrite it.
//
// The behaviour that matters is not "write a file" but "write it only when the list really
// changed, and never with a partial one" — a document that is rewritten on every fetch cannot
// answer the question it exists for ("when did a rate last move?"), and one that can be emptied by
// a failed fetch is worse than no document at all.
import assert from "node:assert/strict";
import test from "node:test";

import { diffPricing, pricingRows, renderPricingDoc, summariseDiff } from "../src/pricing-doc.mjs";

/** The shape `parseOpenRouterModels` returns, minimally. */
const index = (entries) => ({ byId: new Map(entries) });
const entry = (over = {}) => ({ cacheHit: 0.3, cacheMiss: 3, cacheWrite: 3.75, output: 15, label: "Test", ...over });

test("a document lists one row per model, not one per spelling", () => {
  // flattenIndex fans a model into every alias a session might use — correct for lookups,
  // and wrong here: the document would show the same model four times.
  const rows = pricingRows(index([["vendor/model-a", entry()], ["vendor/model-b", entry({ cacheMiss: 1 })]]));
  assert.deepEqual(rows.map((r) => r.id), ["vendor/model-a", "vendor/model-b"]);
  assert.equal(rows[0].input, 3);
  assert.equal(rows[0].output, 15);
});

test("a null or empty index produces no rows rather than throwing", () => {
  assert.deepEqual(pricingRows(undefined), []);
  assert.deepEqual(pricingRows({ byId: new Map() }), []);
});

test("the diff names what was added, removed and repriced", () => {
  const before = pricingRows(index([["a/one", entry()], ["a/two", entry()], ["a/three", entry()]]));
  const after = pricingRows(index([["a/one", entry()], ["a/two", entry({ output: 20 })], ["a/four", entry()]]));
  const diff = diffPricing(before, after);
  assert.deepEqual(diff.added, ["a/four"]);
  assert.deepEqual(diff.removed, ["a/three"]);
  assert.deepEqual(diff.changed, ["a/two"]);
  assert.equal(diff.empty, false);
  assert.equal(summariseDiff(diff), "1 added, 1 removed, 1 repriced");
});

test("an identical list is no change, which is what stops the rewrite", () => {
  const rows = pricingRows(index([["a/one", entry()]]));
  const diff = diffPricing(rows, pricingRows(index([["a/one", entry()]])));
  assert.equal(diff.empty, true);
  assert.equal(summariseDiff(diff), "no change");
});

test("a reordered source is not a change either", () => {
  // The provider's ordering is not information; sorting first is what keeps a reshuffle from
  // looking like 1,300 repriced models.
  const before = pricingRows(index([["b/two", entry()], ["a/one", entry()]]));
  const after = pricingRows(index([["a/one", entry()], ["b/two", entry()]]));
  assert.equal(diffPricing(before, after).empty, true);
});

test("the document states when it was fetched, when it changed, and what changed", () => {
  const rows = pricingRows(index([["a/one", entry()], ["a/two", entry({ cacheMiss: 0.5 })]]));
  const doc = renderPricingDoc({
    rows,
    fetchedAt: "2026-10-13T00:00:00.000Z",
    changedAt: "2026-10-12T00:00:00.000Z",
    checkedAt: "2026-10-13T06:00:00.000Z",
    source: "https://example.test/models",
    usdToCny: 6.6921,
    diff: { added: [], removed: [], changed: ["a/two"], empty: false },
  });
  assert.match(doc, /^# Model pricing — offline copy/);
  assert.match(doc, /- Models: \*\*2\*\*/);
  assert.match(doc, /- Rates last changed: 2026-10-12T00:00:00.000Z/);
  assert.match(doc, /- Last change: 1 repriced/);
  assert.match(doc, /\| `a\/one` \| 3\.00 \| 0\.3000 \| 3\.75 \| 15\.00 \|/, "a row per model, in USD per million");
  assert.match(doc, /\| `a\/two` \| 0\.5000 \|/, "small rates keep their precision");
  assert.match(doc, /usdToCny|USD to CNY: 6\.6921/, "the conversion is recorded with the rates");
});

test("an empty document says so instead of looking like free models", () => {
  const doc = renderPricingDoc({ rows: [], fetchedAt: null, changedAt: null, checkedAt: null, source: "x", usdToCny: null, diff: undefined });
  assert.match(doc, /nothing fetched yet/);
  assert.match(doc, /Rates fetched: never/);
  assert.match(doc, /- Models: \*\*0\*\*/);
});

test("a missing cache-write price drops the column rather than printing dashes", () => {
  const rows = pricingRows(index([["a/one", entry({ cacheWrite: undefined })]]));
  const doc = renderPricingDoc({ rows, fetchedAt: null, changedAt: null, checkedAt: null, source: "x", usdToCny: null, diff: undefined });
  assert.doesNotMatch(doc, /Cache write/);
  assert.match(doc, /\| Model \| Input \| Cached input \| Output \|/);
});
