# bb84-mppx

Accept bb84 payments (USDC and EURC on the bb84 chain, `eip155:42069000`) in a
[Machine Payments Protocol](https://mpp.dev) server built with mppx. This package adds the payment method `bb84`
(intent `charge`).

```bash
npm install bb84-mppx
```

```ts
import express from "express";
import { Mppx } from "mppx/express";
import { charge, baseUnits } from "bb84-mppx";

const mppx = Mppx.create({
  methods: [charge({ recipient: "0xYOUR_BB84_ADDRESS", currency: "USDC" })],
  secretKey: process.env.MPP_SECRET_KEY,
});

const app = express();
app.get("/weather",
  (req, res, next) => mppx.bb84.charge({
    amount: baseUnits("0.02"),
    expires: new Date(Date.now() + 3600_000).toISOString(),
  })(req, res, next),
  (req, res) => res.json({ report: "sunny" }));
```

You can register `charge()` next to your other methods; mppx then offers all of them in the same 402.

## How it works

Like the push mode of other chains: the payer broadcasts the payment and presents the transaction hash.

| Part | Content |
|---|---|
| `request` | `amount` (base units), `currency` (token address), `recipient`, `methodDetails.chainId` (42069000) |
| Payment | a token transfer to `recipient` whose memo is `mpp:<challenge id>` (or `methodDetails.memo` if you set one) |
| Credential `payload` | `{ "type": "hash", "hash": "0x…" }` |
| Receipt | `method: "bb84"`, `reference`: the transaction hash |

The challenge id is protected by mppx's HMAC and is part of the on-chain memo, so a payment made for one challenge
fits no other, on this server or any other. Your server needs no node: the public facilitator
`https://bb84.com/api/x402` checks the transaction and binds it to recipient, token and memo. Each payment is
delivered once (`store`); a second presentation gets 403.

## Options

| Option | Meaning |
|---|---|
| `recipient` | Your bb84 address |
| `currency` | `"USDC"` (default), `"EURC"` or a token address |
| `store` | Where delivered payments are remembered. Default: in memory. Use a shared store when you run several instances |
| `facilitatorUrl` | Default `https://bb84.com/api/x402` |

## Challenge lifetime

mppx challenges live 5 minutes by default. A person confirms the payment in the bb84 app, so set `expires` to an hour
or more. The bb84 connector refuses challenges that are valid for less than 4 minutes.

Protocol details: <https://bb84.com/developers#mpp>. License: MIT.
