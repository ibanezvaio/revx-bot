// scripts/polymarket-derive-creds.mjs
import { ClobClient } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const host = process.env.POLYMARKET_BASE_URL || "https://clob.polymarket.com";
const pk = "0x4e418a5a148765eb0b06598e2cf574a270f992b8c126b5ee012e49c5544ad6ba";

if (!pk) throw new Error("Missing POLYMARKET_PRIVATE_KEY (0x...)");

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const walletClient = createWalletClient({
  account,
  chain: polygon,
  transport: http(),
});

// Most EOAs: signatureType=0; Magic/email login often signatureType=1.
// If you already know yours, set POLYMARKET_SIGNATURE_TYPE accordingly.
const signatureType = Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? 0);

// funder = Polymarket “profile address” / address you send USDC to.
// If you’re a normal EOA setup, funder is often the same as account.address.
// If you use a Safe/proxy, it may differ.
const funder = process.env.POLYMARKET_FUNDER || account.address;

// Derive/create API creds
const clientForCreds = new ClobClient(host, 137, walletClient);
const creds = await clientForCreds.createOrDeriveApiKey();

console.log("POLYMARKET_API_KEY=" + creds.apiKey);
console.log("POLYMARKET_SECRET=" + creds.secret);
console.log("POLYMARKET_PASSPHRASE=" + creds.passphrase);
console.log("POLYMARKET_SIGNATURE_TYPE=" + signatureType);
console.log("POLYMARKET_FUNDER=" + funder);
console.log("SIGNER_ADDRESS=" + account.address);