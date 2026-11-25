# bb84-x402

Accept bb84 payments (USDC and EURC on the bb84 chain, `eip155:42069000`) in a resource server built with the
official [x402](https://x402.org) SDK. This package adds the scheme `bb84-prepaid`.

```bash
npm install bb84-x402
```

```ts
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { Bb84PrepaidScheme, BB84_NETWORK, BB84_FACILITATOR_URL } from "bb84-x402";

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: BB84_FACILITATOR_URL }))
  .register(BB84_NETWORK, new Bb84PrepaidScheme({ secret: process.env.BB84_X402_SECRET }));

const app = express();
app.use(paymentMiddleware({
  "GET /weather": {
    accepts: [{ scheme: "bb84-prepaid", network: BB84_NETWORK, price: "$0.02",
                payTo: "0xYOUR_BB84_ADDRESS", maxTimeoutSeconds: 86400 }],
    description: "Weather report",
  },
}, server));
app.get("/weather", (req, res) => res.json({ report: "sunny" }));
```

You can list bb84 next to your other networks in the same `accepts` array.

## Who pays

AI assistants pay such endpoints through the **bb84 wallet connector** (remote MCP server
`https://bb84.com/api/connect/mcp`, tool `pay_and_call`): the assistant calls your URL, the user confirms the price
in the bb84 app, and the call is repeated with the payment proof. Add the connector in Claude under
*Settings → Connectors → Add custom connector*, or with `claude mcp add --transport http bb84 https://bb84.com/api/connect/mcp`.

## How it works

bb84 accounts are hash-chain accounts without ECDSA keys, so a payer cannot sign an authorization for a facilitator
to submit. The payer pays first, with an ordinary token transfer that carries the reference of your offer, and then
presents the transaction hash. In x402 v2 terms this is a client-submitted payment proof with the payment flow
`upfront`: the SDK calls `settle` before your handler runs.

The scheme

- puts a fresh reference into every 402 response (`extra.memo`), protected with an HMAC over payee, token and amount;
- accepts a payment only for a reference it issued itself, for exactly these terms;
- delivers each payment once, and gives it back if settlement or your handler fails;
- leaves checking the transaction to the bb84 facilitator, which binds it to payee, token and reference.

## Options

| Option | Meaning |
|---|---|
| `secret` | Key for the references, at least 32 characters. Set it when you run several instances or want open offers to survive a restart. Default: random per process |
| `store` | Where delivered references are remembered (`claim` / `release`). Default: in memory. Use a shared store when you run several instances |
| `rememberSeconds` | How long a delivered reference is remembered. Default 180 days, the facilitator's maximum payment age |

## Prices

`"$0.02"` and `0.02` mean USDC, `"€0.02"` and `"0.02 EURC"` mean EURC. `{ asset: "USDC", amount: "20000" }` is taken
as base units (6 decimals).

## Offer lifetime

A person confirms the payment in the bb84 app. Set `maxTimeoutSeconds` to at least a few minutes, better an hour or
more. The bb84 connector refuses offers that are held for less than 4 minutes.

Protocol details: <https://bb84.com/developers#x402>. License: MIT.
