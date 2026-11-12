/**
 * bb84-x402 — scheme "bb84-prepaid" for the official x402 SDK (resource-server side).
 *
 * bb84 accounts are hash-chain accounts without ECDSA keys, so a payer cannot sign an EIP-3009 /
 * Permit2 authorization for the facilitator to submit. The payer pays first, with an ordinary token
 * transfer on the bb84 chain that carries the reference ("memo") of your offer, and then presents the
 * transaction hash. In x402 v2 terms: a client-submitted payment proof, payment flow "upfront"
 * (settle → resource → respond).
 *
 * What this class does inside the SDK:
 *  - puts a fresh, HMAC-protected reference into every 402 response (`extra.memo`);
 *  - when a payment comes back, takes the reference the payer actually used, checks that this server
 *    issued it for exactly these terms, and makes sure one payment is delivered once (MemoStore);
 *  - leaves verifying the transaction to the bb84 facilitator (https://bb84.com/api/x402), which
 *    binds the transaction to payTo / asset / reference.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  AssetAmount,
  Network,
  PaymentPayload,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemePaymentRequiredContext,
  SchemeServerHooks,
  SupportedKind,
} from "@x402/core/types";

export const BB84_SCHEME = "bb84-prepaid";
export const BB84_NETWORK = "eip155:42069000" as Network;
export const BB84_FACILITATOR_URL = "https://bb84.com/api/x402";
/** Token contracts on the bb84 chain (6 decimals each). */
export const BB84_ASSETS = {
  USDC: "0x50590EE131EdC98a7213c91Ae82e3e8987B9b5eE",
  EURC: "0x47dbBf8233cd91C16360bDb69e325f771FD9A667",
} as const;
export const BB84_ASSET_TRANSFER_METHOD = "memo-transfer";
const DECIMALS = 6;
const MEMO_RE = /^x402:([0-9a-f]{20})\.([0-9a-f]{20})$/;

/** Remembers which paid references were already delivered. Use a shared one (Redis, SQL) when you
 *  run more than one instance; the default keeps them in memory. */
export interface MemoStore {
  /** Marks `memo` as taken. Must return false if it already is — atomically. */
  claim(memo: string, ttlSeconds: number): boolean | Promise<boolean>;
  /** Gives `memo` back (settlement or your handler failed), so the buyer can present it again. */
  release(memo: string): void | Promise<void>;
}

export class MemoryMemoStore implements MemoStore {
  private readonly taken = new Map<string, number>();
  claim(memo: string, ttlSeconds: number): boolean {
    const now = Date.now();
    if (this.taken.size > 10_000) {
      for (const [k, until] of this.taken) if (until < now) this.taken.delete(k);
    }
    const until = this.taken.get(memo);
    if (until !== undefined && until >= now) return false;
    this.taken.set(memo, now + ttlSeconds * 1000);
    return true;
  }
  release(memo: string): void {
    this.taken.delete(memo);
  }
}

export interface Bb84PrepaidOptions {
  /** Key for the references this server issues. Set it (at least 32 characters) when you run several
   *  instances or want offers to survive a restart. Default: a random key per process. */
  secret?: string;
  /** Where delivered references are remembered. Default: in memory, per process. */
  store?: MemoStore;
  /** How long a delivered reference is remembered, in seconds. Must cover the facilitator's
   *  maximum payment age (180 days) if you want a hard guarantee; default 180 days. */
  rememberSeconds?: number;
}

function units(amount: string | number): string {
  const s = String(amount).trim().replace(",", ".");
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(s)) throw new Error(`bb84-x402: not an amount with at most ${DECIMALS} decimals: ${amount}`);
  const [whole, frac = ""] = s.split(".");
  const v = BigInt(whole) * 10n ** BigInt(DECIMALS) + BigInt((frac + "0".repeat(DECIMALS)).slice(0, DECIMALS));
  if (v <= 0n) throw new Error("bb84-x402: the price must be greater than 0");
  return v.toString();
}

/** "$0.10", 0.1, "0.10 USDC" → USDC; "€0.10", "0.10 EURC" → EURC; { amount, asset } is passed through. */
export function parseBb84Price(price: Price): AssetAmount {
  if (typeof price === "object" && price !== null) {
    const asset = (BB84_ASSETS as Record<string, string>)[String(price.asset).toUpperCase()] ?? price.asset;
    if (!Object.values(BB84_ASSETS).some(a => a.toLowerCase() === String(asset).toLowerCase())) {
      throw new Error(`bb84-x402: asset must be USDC or EURC on the bb84 chain, got ${price.asset}`);
    }
    if (!/^[1-9]\d{0,17}$/.test(price.amount)) throw new Error("bb84-x402: amount must be a positive integer in base units");
    return { asset, amount: price.amount, extra: price.extra };
  }
  const s = String(price).trim();
  const m = /^(?:(\$|€)\s*)?(\d+(?:[.,]\d+)?)\s*(USDC|EURC|USD|EUR)?$/i.exec(s);
  if (!m) throw new Error(`bb84-x402: cannot read the price "${s}" (examples: "$0.10", "€0.10", "0.10 EURC")`);
  const euro = m[1] === "€" || /^EUR/i.test(m[3] ?? "");
  return { asset: euro ? BB84_ASSETS.EURC : BB84_ASSETS.USDC, amount: units(m[2]) };
}

export class Bb84PrepaidScheme implements SchemeNetworkServer {
  readonly scheme = BB84_SCHEME;
  readonly defaultAssetTransferMethod = BB84_ASSET_TRANSFER_METHOD;
  readonly paymentFlows = { [BB84_ASSET_TRANSFER_METHOD]: { supported: ["upfront"], default: "upfront" } } as const;
  /** The reference differs in every 402 response; the SDK must not compare it when it matches a
   *  presented payment against the offers of the current request. */
  readonly dynamicExtraFields = ["memo"];
  readonly schemeHooks: SchemeServerHooks;

  private readonly key: Buffer;
  private readonly store: MemoStore;
  private readonly remember: number;

  constructor(options: Bb84PrepaidOptions = {}) {
    if (options.secret !== undefined && options.secret.length < 32) {
      throw new Error("bb84-x402: secret must have at least 32 characters");
    }
    this.key = options.secret ? Buffer.from(options.secret, "utf8") : randomBytes(32);
    this.store = options.store ?? new MemoryMemoStore();
    this.remember = options.rememberSeconds ?? 180 * 86400;
    this.schemeHooks = {
      onBeforeSettle: async ctx => {
        const paid = this.paidMemo(ctx.paymentPayload as PaymentPayload);
        const req = ctx.requirements as PaymentRequirements;
        if (!paid || !this.issuedFor(paid, req)) {
          return { abort: true, reason: "invalid_payment_requirements", message: "payment reference was not issued by this server for this offer" };
        }
        // The facilitator binds the transaction to the reference in the requirements. On transports
        // where the payment was not visible while this request's offers were built, they still carry
        // a fresh reference — settle the one that was paid.
        const extra = (req.extra ?? {}) as Record<string, unknown>;
        if (extra.memo !== paid) (req as { extra: Record<string, unknown> }).extra = { ...extra, memo: paid };
        if (!(await this.store.claim(paid, this.remember))) {
          return { abort: true, reason: "payment_already_used", message: "this payment was already delivered" };
        }
      },
      onSettleFailure: async ctx => {
        const paid = this.paidMemo(ctx.paymentPayload as PaymentPayload);
        if (paid) await this.store.release(paid);
      },
      onVerifiedPaymentCanceled: async ctx => {
        // Your handler failed after the payment was settled: let the buyer present it again.
        const paid = this.paidMemo(ctx.paymentPayload as PaymentPayload);
        if (paid) await this.store.release(paid);
      },
    };
  }

  async parsePrice(price: Price, _network: Network): Promise<AssetAmount> {
    return parseBb84Price(price);
  }

  getAssetDecimals(): number {
    return DECIMALS;
  }

  async enhancePaymentRequirements(requirements: PaymentRequirements, _kind: SupportedKind, _extensions: string[]): Promise<PaymentRequirements> {
    return requirements;
  }

  /** Every 402 gets a new reference — except when the request already carries a payment for one of
   *  our references: then the offer is rebuilt with that one, so it is the one that gets settled. */
  async enrichPaymentRequiredResponse(ctx: SchemePaymentRequiredContext): Promise<PaymentRequirements[]> {
    const presented = this.presentedPayment(ctx);
    const paid = presented ? this.paidMemo(presented) : undefined;
    return ctx.requirements.map(r => {
      if (r.scheme !== BB84_SCHEME || r.network !== BB84_NETWORK) return r;
      // The SDK calls this once per offer of this scheme and forbids changing what an earlier call
      // added — so an offer that already has its reference is left alone.
      if (typeof (r.extra as Record<string, unknown> | undefined)?.memo === "string") return r;
      const reuse = paid !== undefined && this.sameOffer(presented!.accepted, r) && this.issuedFor(paid, r);
      return { ...r, extra: { ...(r.extra ?? {}), memo: reuse ? paid : this.newMemo(r) } };
    });
  }

  validateFacilitatorSupport(_network: Network, kind: SupportedKind): string | void {
    const flow = kind.extra?.paymentFlow;
    if (flow !== undefined && flow !== "upfront") return `bb84-x402: facilitator declares paymentFlow ${String(flow)}, expected upfront`;
  }

  // ── references ──
  private tag(nonce: string, r: Pick<PaymentRequirements, "payTo" | "asset" | "amount">): string {
    const msg = [nonce, String(r.payTo).toLowerCase(), String(r.asset).toLowerCase(), r.amount].join("|");
    return createHmac("sha256", this.key).update(msg).digest("hex").slice(0, 20);
  }

  private newMemo(r: PaymentRequirements): string {
    const nonce = randomBytes(10).toString("hex");
    return `x402:${nonce}.${this.tag(nonce, r)}`;
  }

  /** `memo` is a reference this server issued for the terms of `r`. */
  private issuedFor(memo: string, r: Pick<PaymentRequirements, "payTo" | "asset" | "amount">): boolean {
    const m = MEMO_RE.exec(memo);
    if (!m) return false;
    const want = Buffer.from(this.tag(m[1], r)), got = Buffer.from(m[2]);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  private paidMemo(payload: PaymentPayload | undefined): string | undefined {
    const memo = (payload?.accepted?.extra as Record<string, unknown> | undefined)?.memo;
    return typeof memo === "string" ? memo : undefined;
  }

  private sameOffer(a: PaymentRequirements | undefined, b: PaymentRequirements): boolean {
    return !!a && a.scheme === b.scheme && a.network === b.network && a.amount === b.amount
      && String(a.asset).toLowerCase() === String(b.asset).toLowerCase()
      && String(a.payTo).toLowerCase() === String(b.payTo).toLowerCase();
  }

  /** The payment this request carries, if any: handed over by the SDK, or read from the HTTP header. */
  private presentedPayment(ctx: SchemePaymentRequiredContext): PaymentPayload | undefined {
    if (ctx.paymentPayload) return ctx.paymentPayload as PaymentPayload;
    const header = (ctx.transportContext as { request?: { paymentHeader?: string } } | undefined)?.request?.paymentHeader;
    if (typeof header !== "string" || header.length > 16384) return undefined;
    try {
      const p = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentPayload;
      return p && typeof p === "object" && p.accepted ? p : undefined;
    } catch {
      return undefined;
    }
  }
}
