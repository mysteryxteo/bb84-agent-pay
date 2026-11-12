import test from "node:test";
import assert from "node:assert/strict";
import { Bb84PrepaidScheme, parseBb84Price, BB84_ASSETS, BB84_NETWORK, MemoryMemoStore } from "../dist/index.js";

const PAYTO = "0x" + "ab".repeat(20);
const offer = (extra = {}) => ({ scheme: "bb84-prepaid", network: BB84_NETWORK, amount: "20000", asset: BB84_ASSETS.USDC, payTo: PAYTO, maxTimeoutSeconds: 3600, extra });
const ctx = (requirements, more = {}) => ({ requirements, resourceInfo: { url: "https://x/y" }, paymentRequiredResponse: {}, ...more });

test("prices", () => {
  assert.deepEqual(parseBb84Price("$0.02"), { asset: BB84_ASSETS.USDC, amount: "20000" });
  assert.deepEqual(parseBb84Price(0.5), { asset: BB84_ASSETS.USDC, amount: "500000" });
  assert.deepEqual(parseBb84Price("€1,25"), { asset: BB84_ASSETS.EURC, amount: "1250000" });
  assert.deepEqual(parseBb84Price("0.05 EURC"), { asset: BB84_ASSETS.EURC, amount: "50000" });
  assert.equal(parseBb84Price({ asset: "eurc", amount: "7" }).asset, BB84_ASSETS.EURC);
  for (const bad of ["free", "0", "$0.0000001", { asset: "0x" + "11".repeat(20), amount: "5" }, { asset: "USDC", amount: "0.5" }]) {
    assert.throws(() => parseBb84Price(bad), /bb84-x402/);
  }
});

test("every 402 gets its own reference, other schemes are left alone", async () => {
  const s = new Bb84PrepaidScheme({ secret: "s".repeat(40) });
  const other = { scheme: "exact", network: "eip155:8453", amount: "1", asset: "0x1", payTo: PAYTO, maxTimeoutSeconds: 60 };
  const a = await s.enrichPaymentRequiredResponse(ctx([offer(), other]));
  const b = await s.enrichPaymentRequiredResponse(ctx([offer(), other]));
  assert.match(a[0].extra.memo, /^x402:[0-9a-f]{20}\.[0-9a-f]{20}$/);
  assert.notEqual(a[0].extra.memo, b[0].extra.memo);
  assert.equal(a[1], other);
  const again = await s.enrichPaymentRequiredResponse(ctx(a));          // the SDK's second call for the same response
  assert.equal(again[0].extra.memo, a[0].extra.memo);
});

test("a presented payment keeps its reference, a foreign one does not", async () => {
  const s = new Bb84PrepaidScheme({ secret: "s".repeat(40) });
  const [issued] = await s.enrichPaymentRequiredResponse(ctx([offer()]));
  const header = p => ({ transportContext: { request: { paymentHeader: Buffer.from(JSON.stringify(p)).toString("base64") } } });
  const paid = { x402Version: 2, accepted: issued, payload: { transaction: "0x" + "12".repeat(32) } };
  const [same] = await s.enrichPaymentRequiredResponse(ctx([offer()], header(paid)));
  assert.equal(same.extra.memo, issued.extra.memo);
  const forged = { ...paid, accepted: { ...issued, extra: { memo: "x402:" + "0".repeat(20) + "." + "0".repeat(20) } } };
  const [fresh] = await s.enrichPaymentRequiredResponse(ctx([offer()], header(forged)));
  assert.notEqual(fresh.extra.memo, forged.accepted.extra.memo);
  const cheaper = { ...paid, accepted: { ...issued, amount: "1" } };       // reference issued for another price
  const [fresh2] = await s.enrichPaymentRequiredResponse(ctx([offer()], header(cheaper)));
  assert.notEqual(fresh2.extra.memo, issued.extra.memo);
  const otherServer = new Bb84PrepaidScheme({ secret: "t".repeat(40) });   // same payTo, other key
  const [fresh3] = await otherServer.enrichPaymentRequiredResponse(ctx([offer()], header(paid)));
  assert.notEqual(fresh3.extra.memo, issued.extra.memo);
});

test("settle hook: own reference once, foreign never, released after a failure", async () => {
  const s = new Bb84PrepaidScheme({ secret: "s".repeat(40), store: new MemoryMemoStore() });
  const [issued] = await s.enrichPaymentRequiredResponse(ctx([offer()]));
  const payload = { x402Version: 2, accepted: issued, payload: { transaction: "0x" + "12".repeat(32) } };
  const requirements = offer({ memo: "x402:another-request" });           // what this request's offers would carry
  assert.equal(await s.schemeHooks.onBeforeSettle({ paymentPayload: payload, requirements }), undefined);
  assert.equal(requirements.extra.memo, issued.extra.memo, "the paid reference is the one that gets settled");
  const second = await s.schemeHooks.onBeforeSettle({ paymentPayload: payload, requirements: offer() });
  assert.deepEqual([second.abort, second.reason], [true, "payment_already_used"]);
  await s.schemeHooks.onVerifiedPaymentCanceled({ paymentPayload: payload });
  assert.equal(await s.schemeHooks.onBeforeSettle({ paymentPayload: payload, requirements: offer() }), undefined, "usable again after the handler failed");
  const forged = { ...payload, accepted: { ...issued, extra: { memo: "order-4711" } } };
  const r = await s.schemeHooks.onBeforeSettle({ paymentPayload: forged, requirements: offer() });
  assert.deepEqual([r.abort, r.reason], [true, "invalid_payment_requirements"]);
});

test("declares the upfront flow", () => {
  const s = new Bb84PrepaidScheme();
  assert.deepEqual(s.paymentFlows[s.defaultAssetTransferMethod], { supported: ["upfront"], default: "upfront" });
  assert.deepEqual(s.dynamicExtraFields, ["memo"]);
  assert.throws(() => new Bb84PrepaidScheme({ secret: "short" }), /32 characters/);
  assert.match(String(s.validateFacilitatorSupport(BB84_NETWORK, { x402Version: 2, scheme: "bb84-prepaid", network: BB84_NETWORK, extra: { paymentFlow: "authorization" } })), /upfront/);
});
