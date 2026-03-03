export type ClobClientCtor = new (...args: any[]) => any;

export type ApiCreds = {
  key: string;
  secret: string;
  passphrase: string;
};

export type CreatePolymarketClobClientParams = {
  mode: "read" | "trade";
  host: string;
  chainId: number;
  ClobClient: ClobClientCtor;
  signer?: unknown;
  apiCreds?: ApiCreds;
  signatureType?: number;
  funder?: string;
};

export function buildClobClientCtorArgs(params: CreatePolymarketClobClientParams): unknown[] {
  if (params.mode === "read") {
    return [
      params.host,
      params.chainId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      true,
      undefined,
      true
    ];
  }

  if (!params.signer) {
    throw new Error("Trade-mode CLOB client requires signer");
  }
  if (!params.apiCreds) {
    throw new Error("Trade-mode CLOB client requires apiCreds");
  }
  if (!Number.isFinite(Number(params.signatureType))) {
    throw new Error("Trade-mode CLOB client requires signatureType");
  }
  if (!params.funder || params.funder.trim().length === 0) {
    throw new Error("Trade-mode CLOB client requires funder");
  }

  return [
    params.host,
    params.chainId,
    params.signer,
    params.apiCreds,
    params.signatureType,
    params.funder,
    undefined,
    true,
    undefined,
    undefined,
    true,
    undefined,
    true
  ];
}

export function createPolymarketClobClient(params: CreatePolymarketClobClientParams): any {
  const args = buildClobClientCtorArgs(params);
  return new params.ClobClient(...args);
}
