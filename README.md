# bb84-agent-pay

Building blocks for merchants who want to be paid in bb84 (USDC and EURC on the bb84 chain) by AI agents.

| Package | For | What it adds |
|---|---|---|
| [`bb84-x402`](packages/x402) | APIs and MCP servers built with the official [x402](https://x402.org) SDK | the scheme `bb84-prepaid` |
| [`bb84-mppx`](packages/mppx) | APIs built with [mppx](https://mpp.dev) (Machine Payments Protocol) | the payment method `bb84` |

Your server needs no bb84 node and no keys. The public facilitator `https://bb84.com/api/x402` checks each payment;
the money arrives on your bb84 address.

On the paying side, the bb84 wallet connector for AI assistants has the tool `pay_and_call`: it calls your endpoint,
shows your price to the user in the bb84 app and repeats the call with the payment proof.
Protocol details: <https://bb84.com/developers#accept-agents>.

## Try the examples

```bash
npm install
npm run build
PAY_TO=0xYOUR_BB84_ADDRESS BB84_X402_SECRET=$(openssl rand -hex 32) node examples/x402-express.mjs   # port 4021
PAY_TO=0xYOUR_BB84_ADDRESS MPP_SECRET_KEY=$(openssl rand -hex 32)  node examples/mpp-express.mjs    # port 4022
curl -i http://127.0.0.1:4021/weather     # 402 with the payment requirements
```

## Tests

`npm test` runs the unit tests of both packages. End-to-end tests against the real SDKs (x402 2.30, mppx 0.18) live
next to the bb84 backend (`tests/pay_and_call`) and start the two examples of this repository.

## Publishing

```bash
npm run build && npm test
npm publish --workspace packages/x402 --access public
npm publish --workspace packages/mppx --access public
```
