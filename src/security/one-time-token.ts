import { createHash, randomBytes } from "node:crypto";

// The tokens of one-time links (key entry, a confirmation, a deletion) and of the chat card's buttons for one change.
// Only their hashes are stored, so a copy of the database opens no link and presses no button.

// A link's token: 32 random bytes in base64url.
const LINK_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/u;
// The chat card's token: 16 random bytes, 128 bits, in base64url.
const CARD_TOKEN_BYTES = 16;
const CARD_TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/u;
// Longer than any card token could be: such a value is refused before it is hashed.
export const MAX_CARD_TOKEN_INPUT = 64;

export function newLinkToken(): string {
  return randomBytes(32).toString("base64url");
}

export function newCardToken(): string {
  return randomBytes(CARD_TOKEN_BYTES).toString("base64url");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// A value that cannot be such a token matches nothing and is not looked up.
export function isLinkToken(value: string): boolean {
  return LINK_TOKEN_SHAPE.test(value);
}

export function isCardToken(value: string): boolean {
  return CARD_TOKEN_SHAPE.test(value);
}
