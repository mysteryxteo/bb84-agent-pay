import test from "node:test";
import assert from "node:assert/strict";
import { charge, baseUnits, bb84Charge, BB84_ASSETS, MemoryProofStore } from "../dist/index.js";

const RCPT = "0x" + "ab".repeat(20), HASH = "0x" + "12".repeat(32);
const usdc = BB84_ASSETS.USDC.toLowerCase();
const cred = (over = {}, hash = HASH) => ({
  challenge: { id: "challenge-1", realm: "x", method: "bb84", intent: "charge",
               request: { amount: "20000", currency: usdc, recipient: RCPT, methodDetails: { chainId: 42069000 }, ...over } },
  payload: { type: "hash", hash },
});
const facilitator = answers => {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); const a = answers.shift(); if (a instanceof Error) throw a; return new Response(JSON.stringify(a), { status: 200 }); };
  return { f, calls };
};

test("amounts", () => {
  assert.equal(baseUnits("0.01"), "10000");
  assert.equal(baseUnits(2), "2000000");
  assert.equal(baseUnits("1,5"), "1500000");
  for (const bad of ["0", "abc", "0.0000001"]) assert.throws(() => baseUnits(bad), /bb84-mppx/);
});

test("method definition", () => {
  assert.equal(bb84Charge.name, "bb84");
  assert.equal(bb84Charge.intent, "charge");
  const m = charge({ recipient: RCPT, currency: "EURC" });
  assert.equal(m.defaults.currency, BB84_ASSETS.EURC.toLowerCase());
  assert.equal(m.defaults.recipient, RCPT);
  assert.throws(() => charge({ recipient: "alice" }), /0x address/);
  assert.throws(() => charge({ recipient: RCPT, currency: "DAI" }), /USDC or EURC/);
});

test("a payment is settled through the facilitator with the challenge-bound memo", async () => {
  const { f, calls } = facilitator([{ success: true, transaction: HASH }]);
  const m = charge({ recipient: RCPT, fetch: f, facilitatorUrl: "https://facilitator.test/x402/" });
  const receipt = await m.broadcast({ credential: cred(), request: cred().challenge.request });
  assert.equal(receipt.status, "success"); assert.equal(receipt.method, "bb84"); assert.equal(receipt.reference, HASH);
  assert.equal(calls[0].url, "https://facilitator.test/x402/settle");
  const req = calls[0].body.paymentRequirements;
  assert.deepEqual([req.scheme, req.network, req.amount, req.asset, req.payTo, req.extra.memo, req.extra.paymentFlow],
                   ["bb84-prepaid", "eip155:42069000", "20000", usdc, RCPT, "mpp:challenge-1", "upfront"]);
  assert.deepEqual(calls[0].body.paymentPayload.payload, { transaction: HASH });
});

test("one payment, one delivery; a refused payment can be presented again", async () => {
  const { f, calls } = facilitator([{ success: false, errorReason: "transaction_not_found" }, { success: true, transaction: HASH }]);
  const m = charge({ recipient: RCPT, fetch: f, store: new MemoryProofStore() });
  await assert.rejects(m.broadcast({ credential: cred(), request: {} }), e => e.name === "VerificationFailedError");
  assert.equal((await m.broadcast({ credential: cred(), request: {} })).status, "success");      // released after the refusal
  await assert.rejects(m.broadcast({ credential: cred(), request: {} }), e => e.name === "CredentialReplayedError");
  assert.equal(calls.length, 2, "the facilitator is not asked for a replay");
});

test("only this recipient, token and chain", async () => {
  const { f, calls } = facilitator([]);
  const m = charge({ recipient: RCPT, fetch: f });
  for (const over of [{ recipient: "0x" + "cd".repeat(20) }, { currency: BB84_ASSETS.EURC.toLowerCase() }, { methodDetails: { chainId: 1 } }]) {
    await assert.rejects(m.broadcast({ credential: cred(over), request: {} }), e => e.name === "VerificationFailedError");
  }
  await assert.rejects(m.broadcast({ credential: cred({}, "0x1234"), request: {} }), e => e.name === "InvalidPayloadError");
  assert.equal(calls.length, 0);
});

test("facilitator down: not delivered, nothing burnt", async () => {
  const { f } = facilitator([new Error("ECONNREFUSED"), { success: true, transaction: HASH }]);
  const m = charge({ recipient: RCPT, fetch: f });
  await assert.rejects(m.broadcast({ credential: cred(), request: {} }), e => e.name === "VerificationFailedError");
  assert.equal((await m.broadcast({ credential: cred(), request: {} })).status, "success");
});
