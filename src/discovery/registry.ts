import type { AdapterRecord } from "../adapters/repository.js";
import { credentialKind, credentialLabel, stableId } from "./collector.js";
import { DiscoveryResultSchema, type DiscoveryResult } from "./schema.js";

export function discoveryFromAdapter(
  adapter: Pick<AdapterRecord, "slug" | "displayName" | "version" | "dsl">,
  linkUrl: string,
): DiscoveryResult {
  const evidence = [{
    pageUrl: linkUrl,
    kind: "registry_adapter" as const,
    excerpt: `Reusable adapter ${adapter.slug} v${adapter.version}`.slice(0, 240),
  }];
  return DiscoveryResultSchema.parse({
    serviceName: adapter.displayName,
    suggestedLabel: adapter.displayName,
    origins: adapter.dsl.baseOrigins.map((origin) => ({
      id: stableId("origin", origin),
      origin,
      serviceLabel: adapter.displayName.slice(0, 120),
      confidence: "high",
      evidence,
      observationCount: 1,
    })),
    credentials: adapter.dsl.credentialBindings.map(({ fieldName }) => {
      const kind = fieldName.toLocaleLowerCase("en-US") === "authorization" ? "api_key" : credentialKind(fieldName);
      return {
        id: stableId("credential", fieldName),
        fieldName,
        kind,
        placement: "header",
        humanLabel: credentialLabel(kind, fieldName),
        confidence: "high",
        evidence,
      };
    }),
    unsupportedAuthMethods: [],
  });
}
