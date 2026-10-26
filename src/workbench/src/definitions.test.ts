import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { dataRoot, record } from "./config.ts";
import {
  statementFields,
  statementSchemaIssue,
  verifyAnalyzer,
} from "./definitions.ts";

function client(
  categories: string[],
  routed = true,
  badStatement = false,
  importedFields?: Record<string, unknown>,
) {
  return {
    async detail(id: string) {
      if (id === "router")
        return {
          status: "ready",
          config: {
            enableSegment: true,
            contentCategories: Object.fromEntries(
              categories.map((category) => [
                category,
                category === "other" || !routed
                  ? { description: category }
                  : { description: category, analyzerId: category },
              ]),
            ),
          },
        };
      const fields =
        id === "statement"
          ? {
              ...statementFields,
              ...(badStatement ? { incident_date: "string" } : {}),
            }
          : { vehicle: "string", vin: "string", odometer: "number" };
      return {
        status: "ready",
        config: { enableSegment: false },
        fieldSchema: {
          fields:
            id === "statement" && importedFields
              ? importedFields
              : Object.fromEntries(
                  Object.entries(fields).map(([name, type]) => [
                    name,
                    { type, method: "extract" },
                  ]),
                ),
        },
      };
    },
  };
}
test("normal statement route supports seven classes without rejecting legacy four/six-class analyzers", async () => {
  const core = ["id_document", "tax_1099a", "repair_estimate", "other"];
  for (const categories of [
    core,
    [...core, "towing_invoice", "rental_invoice"],
    [...core, "towing_invoice", "rental_invoice", "statement"],
  ]) {
    const verified = await verifyAnalyzer(client(categories), "router");
    assert.equal(verified.mode, "routed");
    assert.equal(Object.keys(verified.categories).length, categories.length);
  }
});
test("Studio import supplies five extracted facts and two generated narratives accepted by a routed analyzer", async () => {
  const schema: unknown = JSON.parse(
    await readFile(
      path.join(dataRoot, "step2", "statement-schema.json"),
      "utf8",
    ),
  );
  const fields = record(record(record(schema)?.fieldSchema)?.fields);
  assert.ok(fields);
  assert.deepEqual(Object.keys(fields), Object.keys(statementFields));
  for (const [name, value] of Object.entries(fields)) {
    const field = record(value);
    assert.equal(
      field?.method,
      ["reported_damage", "summary"].includes(name) ? "generate" : "extract",
    );
    assert.equal(field?.estimateSourceAndConfidence, true);
  }
  assert.equal(statementSchemaIssue(fields), undefined);
  const categories = [
    "id_document",
    "tax_1099a",
    "repair_estimate",
    "statement",
    "other",
  ];
  assert.equal(
    (await verifyAnalyzer(client(categories, true, false, fields), "router"))
      .mode,
    "routed",
  );
  await assert.rejects(
    verifyAnalyzer(
      client(categories, true, false, {
        ...fields,
        claimant_name: { ...record(fields.claimant_name), method: "generate" },
      }),
      "router",
    ),
    /claimant_name: string, Extract/,
  );
  await assert.rejects(
    verifyAnalyzer(
      client(categories, true, false, {
        ...fields,
        summary: { ...record(fields.summary), method: "classify" },
      }),
      "router",
    ),
    /summary: string, Generate/,
  );
});
test("statement routes require a correctly typed custom extractor, while classification-only remains supported", async () => {
  const categories = [
    "id_document",
    "tax_1099a",
    "repair_estimate",
    "statement",
    "other",
  ];
  await assert.rejects(
    verifyAnalyzer(client(categories, true, true), "router"),
    /incident_date: date/,
  );
  assert.equal(
    (await verifyAnalyzer(client(categories, false), "router")).mode,
    "classification-only",
  );
  await assert.rejects(
    verifyAnalyzer(client([...categories, "towing_invoice"]), "router"),
    /both towing_invoice and rental_invoice/,
  );
});
