import { randomUUID } from "node:crypto";

export function newId(prefix: "cnv" | "job"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
