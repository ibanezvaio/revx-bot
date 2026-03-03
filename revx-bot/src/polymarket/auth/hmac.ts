import { createHmac } from "node:crypto";

export type L2SigningInput = {
  timestamp: number;
  method: "GET" | "POST" | "DELETE";
  requestPath: string;
  body?: string;
};

export type L2Creds = {
  address: string;
  apiKey: string;
  passphrase: string;
  secretBase64: string;
};

export function buildL2SigningPayload(input: L2SigningInput): string {
  return `${input.timestamp}${input.method}${input.requestPath}${input.body || ""}`;
}

export function createL2HmacSignature(input: L2SigningInput, secretBase64: string): string {
  const key = Buffer.from(secretBase64, "base64");
  const payload = buildL2SigningPayload(input);
  return createHmac("sha256", key).update(payload).digest("base64");
}

export function buildL2Headers(creds: L2Creds, input: L2SigningInput): Record<string, string> {
  const signature = createL2HmacSignature(input, creds.secretBase64);
  return {
    POLY_ADDRESS: creds.address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: String(input.timestamp),
    POLY_API_KEY: creds.apiKey,
    POLY_PASSPHRASE: creds.passphrase
  };
}
