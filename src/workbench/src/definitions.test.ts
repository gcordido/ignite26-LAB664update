import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { dataRoot, record } from "./config.ts";
import {
  statementFields,
  statementSchemaIssue,
  verifyAnalyzer,
} from "./definitions.ts";

const samplesRoot = path.join(dataRoot, "samples");
const guidePath = path.join(dataRoot, "..", "instructions", "lab.md");

async function sampleJson(filename: string) {
  const value = record(
    JSON.parse(await readFile(path.join(samplesRoot, filename), "utf8")),
  );
  assert.ok(value);
  return value;
}

function manualSection(guide: string, label: string) {
  guide = guide.replaceAll("\r\n", "\n");
  const start = guide.indexOf(`**Enter manually — ${label}**`);
  assert.notEqual(start, -1);
  return guide.slice(start).split("\n\n")[0];
}

function manualFields(section: string) {
  return Object.fromEntries(
    [...section.matchAll(
      /^> \| `(\w+)` \| (String|Number|Date) \/ (Extract|Generate) \| `(.+)` \|$/gm,
    )].map(([, name, type, method, description]) => [
      name,
      { type: type.toLowerCase(), method: method.toLowerCase(), description },
    ]),
  );
}

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
      path.join(dataRoot, "samples", "statement-schema.json"),
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
  const manual = manualFields(
    manualSection(await readFile(guidePath, "utf8"), "Statement fields"),
  );
  assert.deepEqual(
    fields,
    Object.fromEntries(
      Object.entries(manual).map(([name, field]) => [
        name,
        { ...field, estimateSourceAndConfidence: true },
      ]),
    ),
  );
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
test("consolidated Studio packets retain the canonical packet bytes", async () => {
  for (const [sample, canonical] of [
    ["packet-01.pdf", "packets/packet-01.pdf"],
    ["packet-03.pdf", "packets/packet-03.pdf"],
    ["packet-01-statement.pdf", "documents/packet-01/06-handwriting.pdf"],
    ["packet-01-estimate.pdf", "documents/packet-01/05-estimate.pdf"],
    ["packet-03-estimate.pdf", "documents/packet-03/05-estimate.pdf"],
    ["packet-08-estimate.pdf", "documents/packet-08/05-estimate.pdf"],
  ]) {
    assert.deepEqual(
      await readFile(path.join(samplesRoot, sample)),
      await readFile(path.join(dataRoot, canonical)),
    );
  }
});
test("repair imports retain the native Invoice contract and apply only the taught line-item fix", async () => {
  const manifest = record(JSON.parse(
    await readFile(
      path.join(dataRoot, "results", "c12569eb-cf4b-479a-9f57-d6bf57fb5732", "manifest.json"),
      "utf8",
    ),
  ));
  assert.ok(manifest);
  assert.equal(manifest.apiVersion, "2026-06-01-preview");
  const children = record(record(manifest.analyzer)?.definition)?.children;
  assert.ok(Array.isArray(children));
  const child = record(children.find((value) => record(value)?.id === "prebuilt-invoice"));
  const invoice = record(record(record(child?.definition)?.fieldSchema)?.fields);
  assert.ok(invoice);
  const repair = await sampleJson("repair-schema.json");
  const fixed = await sampleJson("repair-fixed-schema.json");
  assert.deepEqual(Object.keys(repair), ["fieldSchema"]);
  assert.deepEqual(Object.keys(fixed), ["fieldSchema"]);
  const fields = record(record(repair.fieldSchema)?.fields);
  const fixedFields = record(record(fixed.fieldSchema)?.fields);
  assert.ok(fields && fixedFields);
  const guide = await readFile(guidePath, "utf8");
  const added = manualFields(manualSection(guide, "repair fields"));
  assert.deepEqual(Object.keys(added), ["vehicle", "vin", "odometer"]);
  assert.deepEqual(fields, { ...invoice, ...added });
  const fixedRows = Object.fromEntries(
    [...manualSection(guide, "repair fix").matchAll(
      /^> \| `(\w+)` \| Number \| (Extract|Generate) \| `(.+)` \|$/gm,
    )].map(([, name, method, description]) => [
      name,
      { type: "number", method: method.toLowerCase(), description },
    ]),
  );
  assert.deepEqual(Object.keys(fixedRows), ["PartsAmount", "LaborAmount", "TotalAmount"]);
  const expected = structuredClone(fields);
  const items = record(record(expected.LineItems)?.items);
  const properties = record(items?.properties);
  assert.ok(properties);
  delete properties.TotalAmount;
  Object.assign(properties, fixedRows);
  assert.deepEqual(fixedFields, expected);
  assert.deepEqual(fixedFields.TotalAmount, invoice.TotalAmount);
  assert.equal(record(fixedRows.PartsAmount)?.method, "extract");
  assert.equal(record(fixedRows.LaborAmount)?.method, "extract");
  assert.equal(record(fixedRows.TotalAmount)?.method, "generate");
});
test("classification and routing imports match manual rules and the native analyzer consumer", async () => {
  const guide = await readFile(guidePath, "utf8");
  const classifier = await sampleJson("classifier-config.json");
  const router = await sampleJson("router-config.json");
  const statement = await sampleJson("statement-schema.json");
  const repair = await sampleJson("repair-schema.json");
  const fixed = await sampleJson("repair-fixed-schema.json");
  const classificationRules = record(record(classifier.config)?.contentCategories);
  const routingRules = record(record(router.config)?.contentCategories);
  assert.ok(classificationRules && routingRules);
  const descriptions = (text: string) => Object.fromEntries(
    [...text.matchAll(/^> \| `(\w+)` \| `(.+ .+)` \|$/gm)]
      .map(([, name, description]) => [name, { description }]),
  );
  const manualClassification = descriptions(manualSection(guide, "classification rules"));
  assert.equal(Object.keys(manualClassification).length, 4);
  assert.deepEqual(classificationRules, manualClassification);
  const manualRouting = manualSection(guide, "extraction routes");
  const expected = { ...manualClassification, ...descriptions(manualRouting) };
  for (const [, name, route] of manualRouting.matchAll(
    /^> \| `(\w+)` \| `([\w.-]+)` \|$/gm,
  )) {
    assert.ok(expected[name]);
    Object.assign(expected[name], { analyzerId: route });
  }
  assert.deepEqual(routingRules, expected);
  assert.deepEqual(Object.keys(routingRules), [
    "id_document", "tax_1099a", "repair_estimate", "other",
    "statement", "towing_invoice", "rental_invoice",
  ]);
  assert.equal(Object.values(routingRules).filter((rule) => record(rule)?.analyzerId).length, 6);
  assert.equal(record(routingRules.other)?.analyzerId, undefined);
  for (const definition of [classifier, router]) {
    assert.equal(definition.baseAnalyzerId, "prebuilt-document");
    assert.deepEqual(definition.models, { completion: "gpt-5.5" });
    const config = record(definition.config);
    assert.equal(config?.enableSegment, true);
    assert.equal(config?.segmentPerPage, false);
    assert.equal(config?.allowInPageSegments, false);
    assert.equal(config?.returnDetails, true);
    for (const repairSchema of [repair, fixed]) {
      const calls: string[] = [];
      const verified = await verifyAnalyzer({
        async detail(id: string) {
          calls.push(id);
          if (id === "router") return { ...definition, status: "ready" };
          if (id === "repair_extractor_analyzer") return { ...repairSchema, status: "ready" };
          if (id === "statement_extractor_analyzer") return { ...statement, status: "ready" };
          return { status: "ready" };
        },
      }, "router");
      assert.equal(verified.mode, definition === classifier ? "classification-only" : "routed");
      if (definition === classifier) assert.deepEqual(calls, ["router"]);
      else {
        assert.ok(calls.includes("repair_extractor_analyzer"));
        assert.ok(calls.includes("statement_extractor_analyzer"));
      }
    }
  }
});
test("guide presents three core parts, optional extensions and one-folder import/manual paths", async () => {
  const guide = await readFile(guidePath, "utf8");
  const overview = guide.split("===")[0];
  assert.equal((overview.match(/^- \*\*Part [123]/gm) ?? []).length, 3);
  assert.equal((overview.match(/^- \*\*Optional/gm) ?? []).length, 2);
  for (const label of [
    "repair fields", "Statement fields", "classification rules",
    "extraction routes", "repair fix",
  ]) {
    assert.ok(guide.includes(`> [+Note] **Import from JSON — ${label}**`));
    assert.ok(guide.includes(`> [+Note] **Enter manually — ${label}**`));
  }
  for (const name of new Set(guide.match(/\b[\w-]+\.(?:pdf|json)\b/g))) {
    assert.ok((await stat(path.join(samplesRoot, name))).isFile());
  }
  assert.doesNotMatch(guide, /Where the files are|Reuse the uploaded packets|Running short on time|[Dd]ownload|data\\documents|samples\\packet-0[13](?=[`\\])|#environment-set-up|Search explorer/);
  assert.match(guide, /## Step 9: Optional:/);
  assert.match(guide, /## Step 10: Optional:/);
  assert.match(guide, /### Part 3: Fix the validation issue/);
  assert.match(guide, /#step-1-environment-setup/);
  const step9 = guide.split("## Step 9:")[1].split("## Step 10:")[0];
  assert.match(step9, /4\. Select the linked policy daily limit[\s\S]+5\. Inspect the searchable text, tables, and page references/);
  assert.match(step9, /not a knowledge-base API/);
  assert.match(step9, /Historical saved evidence can use CU Layout/);
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
