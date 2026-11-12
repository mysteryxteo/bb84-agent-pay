// A paid API built with the official x402 SDK that accepts bb84 (USDC / EURC on the bb84 chain).
//   PAY_TO=0x…your bb84 address…  BB84_X402_SECRET=<32+ random characters>  node examples/x402-express.mjs
// Then: curl -i http://localhost:4021/weather   → 402 with the payment requirements
import express from "express";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { Bb84PrepaidScheme, BB84_NETWORK, BB84_FACILITATOR_URL } from "bb84-x402";

const PAY_TO = process.env.PAY_TO ?? "0x" + "ab".repeat(20);
const FACILITATOR = process.env.BB84_FACILITATOR_URL ?? BB84_FACILITATOR_URL;
const PORT = Number(process.env.PORT ?? 4021);

// One offer per currency; the buyer's wallet picks one.
const offer = price => ({ scheme: "bb84-prepaid", network: BB84_NETWORK, price, payTo: PAY_TO, maxTimeoutSeconds: 86400 });

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR }))
  .register(BB84_NETWORK, new Bb84PrepaidScheme({ secret: process.env.BB84_X402_SECRET }));

const stats = { weather: 0, translate: 0, boom: 0 };
const app = express();
app.use(express.json());
app.get("/stats", (req, res) => res.json(stats));
app.use(paymentMiddleware({
  "GET /weather": { accepts: [offer("$0.02"), offer("€0.02")], description: "Weather report", mimeType: "application/json" },
  "POST /translate": { accepts: offer("0.05 EURC"), description: "Translation", mimeType: "application/json" },
  "GET /boom": { accepts: offer("$0.02"), description: "A handler that fails on its first call" },
}, resourceServer));

app.get("/weather", (req, res) => { stats.weather++; res.json({ report: "sunny, 21 °C", city: req.query.city ?? null }); });
app.post("/translate", (req, res) => { stats.translate++; res.json({ translated: `(translated) ${req.body?.text ?? ""}` }); });
app.get("/boom", (req, res) => { stats.boom++; stats.boom === 1 ? res.status(500).json({ error: "handler failed" }) : res.json({ ok: "recovered" }); });

const tls = process.env.TLS_KEY && process.env.TLS_CERT
  ? { key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) } : null;
(tls ? https.createServer(tls, app) : http.createServer(app))
  .listen(PORT, "127.0.0.1", () => console.log(`x402 merchant with bb84 on ${tls ? "https" : "http"}://127.0.0.1:${PORT}`));
