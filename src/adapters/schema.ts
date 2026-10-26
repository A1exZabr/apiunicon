import { z } from "zod";

export const HttpsOriginSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      // .url() has already reported it; a value that does not parse must not throw out of safeParse.
      return;
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      context.addIssue({
        code: "custom",
        message: "base origin must be an HTTPS origin without credentials, path, query, or fragment",
      });
    }
  })
  .transform((value) => new URL(value).origin);

// A dot segment in any spelling: "." or "..", each dot possibly written %2e in either case. The URL parser resolves one
// before it reads the query or the fragment, so "..?x=1" and "..#x" are dot segments too, and the part of a segment
// after its first "?" or "#" is left out when it is checked. The parser also strips a space or control character at the
// end of a path and removes tabs and line breaks anywhere in it, so those are left out before the check too ("../ "
// is "../" to it). One rule for every layer: the schema checks an operation's path template with it, and prepareCall
// checks the template again and the path made with the arguments.
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/iu;

export function hasDotSegment(path: string): boolean {
  return path
    .replace(/[\u0000-\u0020]/gu, "")
    .split("/")
    .some((segment) => DOT_SEGMENT.test(segment.split(/[?#]/u, 1)[0] ?? ""));
}

// A path template is a relative path of the API: it starts with one slash, has no scheme, backslash or control
// character, and no dot segment. A plain space, a "?" and a "#" are not refused: stored adapters use them (an OData
// filter such as "?$filter=Posted eq true"), and the repository parses every stored adapter again on each read. The
// parser strips a space at the end of a path, but hasDotSegment leaves spaces out before it checks, so "/v3/posting/.. "
// is still refused as the dot segment it becomes.
const OperationPathSchema = z.string().superRefine((value, context) => {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("://") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    hasDotSegment(value)
  ) {
    context.addIssue({ code: "custom", message: "operation path must be a safe relative path" });
  }
});

// An array is a list of plain values (strings, numbers, booleans), such as the article numbers a marketplace campaign is made
// for; like an object, it goes only in the JSON body.
const ParameterDefinitionSchema = z
  .object({
    type: z.enum(["string", "number", "integer", "boolean", "object", "array"]),
    location: z.enum(["path", "query", "body"]),
    required: z.boolean(),
    description: z.string().min(1).max(1_000).optional(),
  })
  .strict()
  .superRefine((definition, context) => {
    if (definition.type === "object" && definition.location !== "body") {
      context.addIssue({ code: "custom", message: "object parameters are allowed only in the body" });
    }
    if (definition.type === "array" && definition.location !== "body") {
      context.addIssue({ code: "custom", message: "array parameters are allowed only in the body" });
    }
  });

const CredentialBindingSchema = z
  .object({
    fieldName: z.string().min(1).max(100).regex(/^[\x21-\x7e]+$/u),
    target: z.literal("header"),
    headerName: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/u),
  })
  .strict();

// An operation id as AdapterOperationSchema accepts it. Code that names an id back to the assistant does so only when
// the id has this shape, so a refusal never repeats other text the assistant typed.
export const OPERATION_ID_PATTERN = /^[a-z][a-z0-9_]{0,99}$/u;

export const AdapterOperationSchema = z
  .object({
    id: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/u),
    description: z.string().min(1).max(2_000),
    risk: z.enum(["read", "write", "destructive"]),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    origin: HttpsOriginSchema.optional().describe(
      "API host for this operation, one of baseOrigins. Omit to use the first base origin.",
    ),
    path: OperationPathSchema,
    input: z.record(z.string().min(1).max(100), ParameterDefinitionSchema),
    response: z
      .object({
        select: z.array(z.string().min(1).max(500)).max(100).optional().describe(
          "Dotted paths of the fields to keep from a successful JSON response, for example cards.nmID; arrays are traversed. Use it when a response is too large for the assistant.",
        ),
      })
      .strict()
      .optional(),
    documentationRefs: z.array(z.string().min(1).max(500)).max(100),
  })
  .strict();

export const AdapterDslSchema = z
  .object({
    schemaVersion: z.literal(1),
    baseOrigins: z.array(HttpsOriginSchema).min(1).max(40).describe(
      "Every API host the adapter calls. Services that spread their API over several hosts list each one and set origin on the operations.",
    ),
    credentialBindings: z.array(CredentialBindingSchema).max(20),
    operations: z.array(AdapterOperationSchema).min(1).max(200),
  })
  .strict()
  .superRefine((dsl, context) => {
    const operationIds = new Set<string>();
    for (const [index, operation] of dsl.operations.entries()) {
      if (operationIds.has(operation.id)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "id"],
          message: "operation IDs must be unique",
        });
      }
      operationIds.add(operation.id);

      if (operation.origin !== undefined && !dsl.baseOrigins.includes(operation.origin)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "origin"],
          message: "operation origin must be listed in baseOrigins",
        });
      }

      for (const [name, parameter] of Object.entries(operation.input)) {
        const token = `{${name}}`;
        if (parameter.location === "path" && !operation.path.includes(token)) {
          context.addIssue({
            code: "custom",
            path: ["operations", index, "input", name],
            message: `path parameter requires ${token} in operation path`,
          });
        }
      }
    }
  });

export type AdapterDsl = z.infer<typeof AdapterDslSchema>;
export type AdapterOperation = z.infer<typeof AdapterOperationSchema>;
