import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(nodeScrypt);
const KEY_LENGTH = 64;

export type StoredPassword = {
  hash: string;
  salt: string;
};

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  return (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
}

export async function hashPassword(password: string): Promise<StoredPassword> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return { hash: hash.toString("base64"), salt: salt.toString("base64") };
}

export async function verifyPassword(
  password: string,
  stored: StoredPassword,
): Promise<boolean> {
  try {
    const salt = Buffer.from(stored.salt, "base64");
    const expected = Buffer.from(stored.hash, "base64");
    const actual = await derive(password, salt);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
