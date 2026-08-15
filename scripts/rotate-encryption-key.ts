import { GatewayError } from "../src/domain/errors.js";
import { SecretBox } from "../src/infrastructure/crypto.js";
import { openDatabase } from "../src/infrastructure/database.js";
import { rotateEncryptedPayloads } from "../src/infrastructure/key-rotation.js";

function decodeKey(raw: string | undefined, name: string): Buffer {
  if (!raw) {
    throw new GatewayError("INVALID_REQUEST", `${name} is required`, 500);
  }
  const key = Buffer.from(raw, "base64");
  if (key.byteLength !== 32) {
    throw new GatewayError("INVALID_REQUEST", `${name} must be 32 bytes encoded as base64`, 500);
  }
  return key;
}

const databasePath = process.env.CODEXGW_DATABASE_PATH;
if (!databasePath) {
  throw new GatewayError("INVALID_REQUEST", "CODEXGW_DATABASE_PATH is required", 500);
}

const current = new SecretBox(decodeKey(process.env.CODEXGW_DATA_ENCRYPTION_KEY, "CODEXGW_DATA_ENCRYPTION_KEY"));
const next = new SecretBox(decodeKey(process.env.CODEXGW_DATA_ENCRYPTION_KEY_NEW, "CODEXGW_DATA_ENCRYPTION_KEY_NEW"));
const database = openDatabase(databasePath);

try {
  const result = await rotateEncryptedPayloads(database.db, current, next);
  process.stdout.write(`rotated jobs=${result.jobs} events=${result.events}\n`);
} finally {
  await database.close();
}
