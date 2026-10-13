// Your own rates, laid over the fetched ones.
//
// The case this exists for is concrete: a model the public list does not carry, or a machine whose
// network cannot reach the list at all. Without it every figure reads `¥0.00` — which is
// indistinguishable from a session that cost nothing, and is the worse of the two failures.
import assert from "node:assert/strict";
import test from "node:test";

import { mergeLocalRates } from "../src/pricing-doc.mjs";

const fetched = { "vendor/model-a": { currency: "USD", cacheHit: 0.3, cacheMiss: 3, output: 15, label: "fetched" } };

test("a model you name is priced, keyed the way sessions spell it", () => {
  const merged = mergeLocalRates({}, { models: { "gpt-6-sol": { input: 1.25, output: 10, cachedInput: 0.125 } } });
  const row = merged["gpt-6-sol"];
  assert.equal(row.cacheMiss, 1.25);
  assert.equal(row.cacheHit, 0.125);
  assert.equal(row.output, 10);
  assert.equal(row.label, "local");
});

test("your rate wins over the fetched one of the same name", () => {
  const merged = mergeLocalRates(fetched, { models: { "vendor/model-a": { input: 1, output: 2 } } });
  assert.equal(merged["vendor/model-a"].output, 2);
  assert.equal(merged["vendor/model-a"].label, "local");
});

test("models you did not name are left exactly as fetched", () => {
  const merged = mergeLocalRates(fetched, { models: { other: { input: 1, output: 2 } } });
  assert.deepEqual(merged["vendor/model-a"], fetched["vendor/model-a"]);
});

test("a missing cached input rate falls back to the plain input rate, not to free", () => {
  // A cached token priced at zero would understate a long session badly; charging it as input is
  // the conservative direction and the one a provider's own table implies when it publishes one rate.
  const merged = mergeLocalRates({}, { models: { m: { input: 2, output: 8 } } });
  assert.equal(merged.m.cacheHit, 2);
});

test("a row with no output rate is skipped rather than half-applied", () => {
  // Half a row is worse than none: output tokens are usually most of the cost, and pricing them at
  // zero would silently understate the turn while looking priced.
  const merged = mergeLocalRates({}, { models: { m: { input: 1 }, n: { input: 1, output: "free" } } });
  assert.equal(merged.m, undefined);
  assert.equal(merged.n, undefined);
});

test("an empty or missing local table changes nothing", () => {
  assert.deepEqual(mergeLocalRates(fetched, undefined), fetched);
  assert.deepEqual(mergeLocalRates(fetched, { models: {} }), fetched);
  assert.deepEqual(mergeLocalRates(undefined, { models: {} }), {});
});

test("an entry is keyed by the name you wrote, lowercased, and no alias is invented", () => {
  // The first version of this test claimed a vendor-prefixed name would also answer to its bare
  // suffix, which is not true: `canonicalName` normalises spelling, it does not strip a vendor. So
  // the rule a user has to know is the honest one — write the name exactly as the session records
  // it, or list every spelling you see.
  const merged = mergeLocalRates({}, { models: { "Vendor/Model-A": { input: 1, output: 2 } } });
  assert.ok(merged["vendor/model-a"] !== undefined, "the name you wrote is matched case-insensitively");
  assert.equal(merged["model-a"], undefined, "no bare alias is invented for a vendor-prefixed name");
});
