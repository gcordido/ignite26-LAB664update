import assert from "node:assert/strict";
import { test } from "node:test";
import { Cache, summarize } from "./batch.ts";
import { packetJson } from "./packet-json.ts";
import { checkNames, parsedPolicyScope, parsedTextEvidence, policyClaimAnalysis } from "./policy-core.ts";

test("all ten saved Parse packets resolve explicit policy and insured vehicle scope without summaries", async () => {
  const cache = new Cache();
  const run = await cache.load("c12569eb-cf4b-479a-9f57-d6bf57fb5732");
  for (const packet of run.source) {
    const raw = await cache.raw(run.id, packet.id);
    const exported = packetJson(raw, packet, run, summarize(raw, packet, run.analyzer.mode));
    const scope = parsedPolicyScope(exported);
    assert.match(scope.lossState ?? "", /^[A-Z]{2}$/, packet.id);
    assert.match(scope.policyScope.policyId ?? "", /^[A-Z]+-A\d+$/, packet.id);
    assert.equal(scope.policyScope.vin, packet.expectedRepair.vin);
    const input = policyClaimAnalysis(exported, raw);
    assert.ok(input.textEvidence.length);
    assert.ok(input.contents.every((document) =>
      !["claim_summary", "id_document", "tax_1099a"].includes(document.category)));
    for (const source of input.textEvidence) {
      assert.ok(parsedTextEvidence(exported).some((native) =>
        native.id === source.id && native.text === source.text && native.pages === source.pages));
      assert.ok(source.pages.start > 0 && source.pages.end <= packet.pages);
    }
  }
  assert.deepEqual(checkNames, ["Daily rate", "Effective terms", "Repair estimate"]);
});

test("scope preserves conflicting identities and excludes rented-vehicle and supplier routing", async () => {
  const cache = new Cache();
  const run = await cache.load("c12569eb-cf4b-479a-9f57-d6bf57fb5732");
  const packet = run.source[0], raw = await cache.raw(run.id, packet.id);
  const exported = packetJson(raw, packet, run, summarize(raw, packet, run.analyzer.mode));
  const source = exported.documents.find((document) => document.category === "statement")!;
  const first = source.extractions[0];
  const conflict = structuredClone(exported);
  const statement = conflict.documents.find((document) => document.category === "statement")!;
  statement.extractions[0].fields = { ...first.fields,
    PolicyId: "WRONG-A12345", LossState: "WA", InsuredVIN: "4S4BTACC1LA511562" };
  const scope = parsedPolicyScope(conflict);
  assert.equal(scope.policyScope.policyId, null);
  assert.equal(scope.policyScope.vin, null);
  assert.equal(scope.lossState, null);
  const invoice = exported.documents.find((document) => document.category === "rental_invoice")!;
  invoice.extractions[0].fields = { ...invoice.extractions[0].fields,
    PolicyId: "SUPPLIER-A98765", InsuredVIN: "4S4BTACC1LA511562", LossState: "NY" };
  invoice.extracted_text += "\nPolicy Number: SUPPLIER-A98765\nInsured VIN: 4S4BTACC1LA511562\nLoss State: NY";
  const repair = exported.documents.find((document) => document.category === "repair_estimate")!;
  repair.extractions[0].fields = { ...repair.extractions[0].fields,
    VendorAddress: { City: "Seattle", State: "WA" } };
  repair.extracted_text += "\nRepair shop address: Seattle, WA";
  assert.equal(parsedPolicyScope(exported).policyScope.vin, packet.expectedRepair.vin);
  assert.equal(parsedPolicyScope(exported).lossState, "TX");
});
