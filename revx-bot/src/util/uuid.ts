import { randomUUID } from "node:crypto";

export function makeRunId(): string {
  return randomUUID().split("-")[0];
}

export function makeClientOrderId(prefix: string): string {
  void prefix;
  return randomUUID();
}
