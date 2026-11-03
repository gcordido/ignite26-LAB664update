import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { repositoryRoot } from "./config.ts";
import { checkNames, question, resolveCitations } from "./policy-core.ts";

test("three claim-versus-policy comparisons retain scoped evidence safeguards", async () => {
  assert.deepEqual(checkNames, [
    "Daily rate", "Rental start", "Effective terms",
  ]);
  const prompt = await question();
  assert.match(prompt, /Daily rate/);
  assert.match(prompt, /Rental start/);
  assert.match(prompt, /policy ID and insured VIN/i);
  assert.match(prompt, /blank/i);
  assert.match(prompt, /actual delivery/i);
  assert.match(prompt, /appointment/i);
  assert.match(prompt, /Figure R-1/i);
  assert.match(prompt, /loss date/i);
});

test("each source claim has three scoped, hash-verified evidence PDFs", async () => {
  const folder = path.join(repositoryRoot, "data", "policies", "rental", "ocr-comparison-v2");
  const [manifest, packetData, citationMaps, scenarioData] = await Promise.all([
    readFile(path.join(folder, "manifest.json"), "utf8").then(JSON.parse),
    readFile(path.join(repositoryRoot, "data", "packets.json"), "utf8").then(JSON.parse),
    readFile(path.join(folder, "citations.json"), "utf8").then(JSON.parse),
    readFile(path.join(folder, "scenario-questions.json"), "utf8").then(JSON.parse),
  ]);
  const contracts = manifest.documents.filter((doc: { documentType: string }) =>
    doc.documentType === "policy_contract");
  assert.equal(contracts.length, packetData.packets.length * 3);
  assert.equal(scenarioData.length, packetData.packets.length);

  for (const packet of packetData.packets) {
    const docs = contracts.filter((doc: {
      states: string[];
      policyScope: { vin: string };
    }) => doc.states.includes(packet.region) && doc.policyScope.vin === packet.expectedRepair.vin);
    assert.equal(docs.length, 3, `${packet.id} should have three scoped evidence documents`);
    const roles = new Set(docs.map((doc: { role: string }) => doc.role));
    assert.equal(roles.size, 3);
    assert.ok(roles.has("revised_declarations"));
    assert.ok(roles.has("rental_terms"));
    assert.ok(roles.has("issued_amendment") || roles.has("policy_effective_date"));
    const rentalTerms = docs.find((doc: { role: string }) => doc.role === "rental_terms");
    assert.deepEqual(rentalTerms.ruleIds, [
      "R.1", "R.2", "R.3", "R.4", "R.5", "R.6", "Figure R-1",
    ]);
    assert.deepEqual(rentalTerms.rulePages, [1, 2]);
    assert.equal(
      rentalTerms.diagramAuthority,
      ["TX", "WA"].includes(packet.region) ? "controlling" : "illustrative",
    );

    const scenarios = scenarioData.find((item: {
      packetId: string;
      state: string;
      vin: string;
      questions: { source: string; answer: string; citation: { DocumentId: string } }[];
    }) => item.packetId === packet.id);
    assert.ok(scenarios);
    assert.equal(scenarios.state, packet.region);
    assert.equal(scenarios.vin, packet.expectedRepair.vin);
    assert.equal(scenarios.questions.length, 3);
    assert.deepEqual(
      scenarios.questions.map((item: { source: string }) => item.source),
      ["sparse_table", "diagram", "scanned_document"],
    );
    assert.equal(scenarios.questions[0].answer, "$85 per day.");
    assert.equal(
      scenarios.questions[1].answer,
      "When it is actually delivered for covered repairs.",
    );
    assert.equal(new Set(scenarios.questions.map(
      (item: { citation: { DocumentId: string } }) => item.citation.DocumentId,
    )).size, 3);
    for (const item of scenarios.questions) {
      const source = contracts.find((doc: {
        documentId: string;
        states: string[];
        policyScope: { vin: string };
      }) => doc.documentId === item.citation.DocumentId);
      assert.ok(source, `${packet.id} scenario citation should be registered`);
      assert.ok(source.states.includes(packet.region));
      assert.equal(source.policyScope.vin, packet.expectedRepair.vin);
    }
  }

  const inputs = scenarioData.flatMap((item: {
    questions: { citation: Record<string, string> }[];
  }) => item.questions.map((question) => question.citation));
  const [resolved] = await resolveCitations({ Checks: [{ Citation: inputs }] });
  assert.equal(resolved.length, inputs.length);
  for (const [index, citation] of resolved.entries()) {
    const input = inputs[index];
    const map = citationMaps.find((item: { documentId: string }) =>
      item.documentId === input.DocumentId);
    assert.ok(map, `${input.DocumentId} should have a citation map`);
    assert.equal(
      citation.href,
      `/data/policies/rental/ocr-comparison-v2/${input.File}#page=${map.sections[input.Section]}`,
    );
  }
  const [[wrong]] = await resolveCitations({
    Checks: [{ Citation: [{ ...inputs[0], Section: "Invented heading" }] }],
  });
  assert.equal(wrong.href, null);
});
