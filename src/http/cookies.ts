import type { FastifyRequest } from "fastify";

export function readCookies(request: FastifyRequest): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    try {
      result[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      result[name] = "";
    }
  }
  return result;
}
