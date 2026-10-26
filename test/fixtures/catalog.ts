import type { CatalogEntry } from "../../src/catalog/source.js";

export const WB_LINK = "https://dev.wildberries.ru/docs/openapi/reports";
export const WB_ENTRY_ID = "6c1f8d5e-7f1a-4c55-9a43-0f3c0e1b2a10";

export function wbEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    entryId: WB_ENTRY_ID,
    version: 3,
    displayName: "Wildberries Statistics",
    description: "Sales and orders reports",
    domain: "wildberries.ru",
    dsl: {
      schemaVersion: 1,
      baseOrigins: ["https://statistics-api.wildberries.ru"],
      credentialBindings: [{ fieldName: "Authorization", target: "header", headerName: "Authorization" }],
      operations: [{
        id: "report_sales",
        description: "Sales for a period",
        risk: "read",
        method: "GET",
        path: "/api/v1/supplier/sales",
        input: { dateFrom: { type: "string", location: "query", required: true } },
        documentationRefs: [],
      }],
    },
    operationChecks: { report_sales: "verified" },
    documentation: [{ url: "https://dev.wildberries.ru/openapi/reports.yaml", sha256: null }],
    ...overrides,
  };
}
