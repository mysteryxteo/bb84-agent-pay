/**
 * bb84-mppx — payment method "bb84" (intent "charge") for Machine Payments Protocol servers built
 * with mppx.
 *
 * bb84 accounts are hash-chain accounts without ECDSA keys, so the payer cannot hand over a signed
 * transaction or authorization. Like Tempo's "push" mode, the payer broadcasts the payment himself —
 * an ordinary token transfer on the bb84 chain whose memo is "mpp:<challenge id>" — and presents the
 * transaction hash:
 *
 *   credential.payload = { "type": "hash", "hash": "0x…" }
 *   request            = { "amount": "<base units>", "currency": "<token address>", "recipient": "0x…",
 *                          "methodDetails": { "chainId": 42069000 } }
 *
 * The server does not need a node: the transaction is checked and bound to recipient / token / memo by
 * the public bb84 facilitator (https://bb84.com/api/x402, the same service x402 merchants use). Because
 * the memo contains the challenge id — which mppx protects with its HMAC — a payment made for one
 * challenge cannot be presented for another, here or at any other server.
 */
import { Errors, Method, Receipt, z } from "mppx";

export const BB84_METHOD = "bb84";
export const BB84_CHAIN_ID = 42069000;
export const BB84_NETWORK = "eip155:42069000";
export const BB84_FACILITATOR_URL = "https://bb84.com/api/x402";
/** Token contracts on the bb84 chain (6 decimals each). */
export const BB84_ASSETS = {
  USDC: "0x50590EE131EdC98a7213c91Ae82e3e8987B9b5eE",
  EURC: "0x47dbBf8233cd91C16360bDb69e325f771FD9A667",
} as const;

/** "0.01" → "10000" (USDC and EURC have 6 decimals). */
export function baseUnits(amount: string | number): string {
  const s = String(amount).trim().replace(",", ".");
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(s)) throw new Error(`bb84-mppx: not an amount with at most 6 decimals: ${amount}`);
  const [whole, frac = ""] = s.split(".");
  const v = BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
  if (v <= 0n) throw new Error("bb84-mppx: the amount must be greater than 0");
  return v.toString();
}

/** The method definition (wire schema). Use `charge()` for a configured server method. */
export const bb84Charge = Method.from({
  name: BB84_METHOD,
  intent: "charge",
  schema: {
    credential: {
      payload: z.object({ type: z.literal("hash"), hash: z.string() }),
    },
    request: z.object({
      amount: z.string(),
      currency: z.string(),
      recipient: z.string(),
      description: z.optional(z.string()),
      externalId: z.optional(z.string()),
      methodDetails: z.optional(z.object({ chainId: z.optional(z.number()), memo: z.optional(z.string()) })),
    }),
  },
});

/** Remembers which payments were already delivered. Use a shared one when you run several instances. */
export interface ProofStore {
  /** Marks `key` as taken. Must return false if it already is — atomically. */
  claim(key: string, ttlSeconds: number): boolean | Promise<boolean>;
  /** Gives `key` back (the facilitator refused the payment), so it can be presented again. */
  release(key: string): void | Promise<void>;
}

export class MemoryProofStore implements ProofStore {
  private readonly taken = new Map<string, number>();
  claim(key: string, ttlSeconds: number): boolean {
    const now = Date.now();
    if (this.taken.size > 10_000) {
      for (const [k, until] of this.taken) if (until < now) this.taken.delete(k);
    }
    const until = this.taken.get(key);
    if (until !== undefined && until >= now) return false;
    this.taken.set(key, now + ttlSeconds * 1000);
    return true;
  }
  release(key: string): void {
    this.taken.delete(key);
  }
}

export interface Bb84ChargeOptions {
  /** Your bb84 address (0x…) that receives the payments. */
  recipient: string;
  /** "USDC" (default), "EURC" or a token address on the bb84 chain. */
  currency?: "USDC" | "EURC" | (string & {});
  /** Facilitator that checks the transaction. Default: https://bb84.com/api/x402 */
  facilitatorUrl?: string;
  /** Where delivered payments are remembered. Default: in memory, per process. */
  store?: ProofStore;
  /** How long a delivered payment is remembered, in seconds. Default 180 days (the facilitator's maximum payment age). */
  rememberSeconds?: number;
  /** fetch implementation (tests). */
  fetch?: typeof globalThis.fetch;
}

function tokenAddress(currency: string): string {
  const known = (BB84_ASSETS as Record<string, string>)[currency.toUpperCase()];
  const addr = (known ?? currency).toLowerCase();
  if (!Object.values(BB84_ASSETS).some(a => a.toLowerCase() === addr)) {
    throw new Error(`bb84-mppx: currency must be USDC or EURC on the bb84 chain, got ${currency}`);
  }
  return addr;
}

/**
 * Configured server method. Example:
 *
 *   const mppx = Mppx.create({ methods: [charge({ recipient: "0x…" })], secretKey: process.env.MPP_SECRET_KEY })
 *   const result = await mppx["bb84/charge"]({ amount: baseUnits("0.01"), expires: … })(request)
 */
export function charge(options: Bb84ChargeOptions) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(options.recipient)) throw new Error("bb84-mppx: recipient must be a 0x address on the bb84 chain");
  const currency = tokenAddress(options.currency ?? "USDC");
  const recipient = options.recipient.toLowerCase();
  const facilitator = (options.facilitatorUrl ?? BB84_FACILITATOR_URL).replace(/\/+$/, "");
  const store = options.store ?? new MemoryProofStore();
  const remember = options.rememberSeconds ?? 180 * 86400;
  const doFetch = options.fetch ?? globalThis.fetch;

  return Method.toServer(bb84Charge, {
    defaults: { currency, recipient, methodDetails: { chainId: BB84_CHAIN_ID } },
    async broadcast({ credential }) {
      const challenge = credential.challenge;
      const request = challenge.request;
      const hash = credential.payload.hash.toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Errors.InvalidPayloadError({ reason: "hash must be a transaction hash" });
      // The terms come from the challenge mppx verified (HMAC), never from the payer's wishes.
      if (tokenAddress(request.currency) !== currency || request.recipient.toLowerCase() !== recipient
          || (request.methodDetails?.chainId ?? BB84_CHAIN_ID) !== BB84_CHAIN_ID) {
        throw new Errors.VerificationFailedError({ reason: "challenge is not for this bb84 recipient / token" });
      }
      const memo = request.methodDetails?.memo ?? `mpp:${challenge.id}`;
      // One payment, one delivery: taken before the facilitator is asked, given back if it says no.
      const key = `${BB84_NETWORK}:${hash}`;
      if (!(await store.claim(key, remember))) throw new Errors.CredentialReplayedError({ reason: "this payment was already used" });
      let result: { success?: boolean; errorReason?: string; transaction?: string };
      try {
        const requirements = {
          scheme: "bb84-prepaid", network: BB84_NETWORK, amount: request.amount, asset: currency, payTo: recipient,
          maxTimeoutSeconds: 86400, extra: { memo, paymentFlow: "upfront" },
        };
        const res = await doFetch(`${facilitator}/settle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            x402Version: 2,
            paymentPayload: { x402Version: 2, accepted: requirements, payload: { transaction: hash } },
            paymentRequirements: requirements,
          }),
        });
        if (!res.ok) throw new Error(`facilitator answered HTTP ${res.status}`);
        result = (await res.json()) as typeof result;
      } catch (e) {
        await store.release(key);
        throw new Errors.VerificationFailedError({ reason: `bb84 facilitator not reachable (${e instanceof Error ? e.message : "error"})` });
      }
      if (!result.success) {
        await store.release(key);
        throw new Errors.VerificationFailedError({ reason: String(result.errorReason ?? "payment not accepted") });
      }
      return Receipt.from({ method: BB84_METHOD, reference: hash, status: "success", timestamp: new Date().toISOString() });
    },
  });
}
