export type FormValue = string | string[] | undefined;
export type FormBody = Record<string, FormValue>;

export function parseForm(body: unknown): FormBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return body as FormBody;
}

export function first(form: FormBody, key: string): string | undefined {
  const value = form[key];
  return Array.isArray(value) ? value[0] : value;
}

export function values(form: FormBody, key: string): string[] {
  const value = form[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// Without a prototype, so a field named __proto__, constructor or toString is only a field.
export function decodeUrlEncoded(encoded: string): FormBody {
  const body = Object.create(null) as FormBody;
  for (const [key, value] of new URLSearchParams(encoded).entries()) {
    const existing = body[key];
    if (existing === undefined) body[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else body[key] = [existing, value];
  }
  return body;
}
