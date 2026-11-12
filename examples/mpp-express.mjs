// A paid API built with mppx (Machine Payments Protocol) that accepts bb84 (USDC / EURC on the bb84 chain).
//   PAY_TO=0x…your bb84 address…  MPP_SECRET_KEY=<32+ random characters>  node examples/mpp-express.mjs
// Then: curl -i http://localhost:4022/weather   → 402 with a WWW-Authenticate: Payment challenge
import express from "express";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { Mppx } from "mppx/express";
import { charge, baseUnits, BB84_FACILITATOR_URL } from "bb84-mppx";

const PAY_TO = process.env.PAY_TO ?? "0x" + "ab".repeat(20);
const PORT = Number(process.env.PORT ?? 4022);

const mppx = Mppx.create({
  methods: [charge({ recipient: PAY_TO, currency: "USDC", facilitatorUrl: process.env.BB84_FACILITATOR_URL ?? BB84_FACILITATOR_URL })],
  secretKey: process.env.MPP_SECRET_KEY ?? "change-me-".repeat(4),
  realm: process.env.MPP_REALM,
});
// A person confirms the payment in the bb84 app, so the challenge must live longer than mppx's
// default of 5 minutes.
const oneHour = () => new Date(Date.now() + 3600_000).toISOString();

const stats = { weather: 0 };
const app = express();
app.get("/stats", (req, res) => res.json(stats));
app.get("/weather", (req, res, next) => mppx.bb84.charge({ amount: baseUnits("0.02"), expires: oneHour() })(req, res, next),
  (req, res) => { stats.weather++; res.json({ report: "sunny, 21 °C", city: req.query.city ?? null }); });
app.get("/short", mppx.bb84.charge({ amount: baseUnits("0.02") }),          // mppx default: valid for 5 minutes
  (req, res) => res.json({ report: "sunny" }));

const tls = process.env.TLS_KEY && process.env.TLS_CERT
  ? { key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) } : null;
(tls ? https.createServer(tls, app) : http.createServer(app))
  .listen(PORT, "127.0.0.1", () => console.log(`MPP merchant with bb84 on ${tls ? "https" : "http"}://127.0.0.1:${PORT}`));
