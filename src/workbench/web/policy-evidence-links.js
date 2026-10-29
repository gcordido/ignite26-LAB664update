/** Resolve only supplied CU paths; never guess sources from labels or values. */
export function claimFieldSources(fields, path) {
  return fields.filter((fact) => {
    const selected = path.startsWith(`${fact.category}.`)
      ? path.slice(fact.category.length + 1) : path;
    return fact.status === "present" && fact.value !== null &&
      (fact.field === selected || fact.field.startsWith(`${selected}.`) ||
       fact.field.startsWith(`${selected}[`)) &&
      fact.regions.some((region) => Number.isInteger(region.page) && region.page > 0);
  });
}

export function policyRuleSources(citations, rule) {
  return citations.filter((citation) => citation.RuleId === rule &&
    /^\/data\/policies\/rental\/(?:ocr-comparison-v2\/)?[a-z0-9-]+\.pdf#page=[1-9]\d*$/.test(citation.href ?? ""));
}
