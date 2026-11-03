"""Per-check projections of original Parse fields, page text and policy evidence."""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path

from azure.ai.contentunderstanding import to_llm_input
from azure.ai.contentunderstanding.models import AnalysisResult

COMMON_FIELDS = {
    "Routing", "ClaimId", "LossState", "LossDate", "LossTime", "PolicyId",
    "InsuredVIN", "InsuredVehicle", "Policy.PolicyId", "Policy.RentalCoverage",
    "Policy.EffectiveDate", "Policy.ExpirationDate", "PolicyTerm",
    "Product", "CoverageType", "RequestedBenefit", "RequestType",
    "RentalRequested", "RentalUsed", "RequestTypeEvidence", "NoRentalEvidence",
    "RentalAgreementId", "RentalClaimLink", "RentalVehicle.AgreementId", "RentalVehicle.ClaimLink",
    "RentalPickup", "RentalReturn", "Rental.Pickup", "Rental.Return",
    "RentalBilledDays", "RentalTotal", "Rental.BilledUnits", "Rental.Total",
    "Rental.LineItems.Description",
}
CHECK_FIELDS = {
    "Daily rate": {
        "Policy", "PolicyDailyBaseCap", "PolicyEndorsement",
        "RentalDailyBaseRate", "RentalCurrency", "Rental.DailyRates",
        "Rental.Currency", "Rental.ChargingTerms", "Rental.LineItems",
    },
    "Rental start": {
        "PolicyEndorsement", "Damage", "DrivabilityEvidence",
        "RentalPickup", "Rental.Pickup", "Rental.DailyRates.StartDate", "Rental.ChargingTerms",
        "Repair", "ActualRepairDelivery", "ScheduledRepairStart", "Authorization.CoveredStart",
    },
    "Effective terms": {
        "Policy", "PolicyDailyBaseCap", "PolicyEndorsement",
    },
}
INVOICE_FIELDS = {
    "Daily rate": {"InvoiceId", "InvoiceDate", "LineItems", "TotalAmount"},
    "Rental start": {"InvoiceId", "InvoiceDate", "LineItems.Description", "LineItems.ServiceStartDate",
               "LineItems.ServiceEndDate", "LineItems.Quantity", "PaymentTerm"},
    "Effective terms": {"InvoiceId", "LineItems.Description"},
}
EXCLUDED_CATEGORIES = {"id_document", "identity_document", "tax_document", "tax_form"}


def project_field(field: dict, path: str, selected: set[str]) -> dict | None:
    """Keep typed CU values, including missing values, without flattening arrays."""
    if path in selected:
        return deepcopy(field)
    if not any(item.startswith(path + ".") for item in selected):
        return None
    result = {key: deepcopy(value) for key, value in field.items()
              if key not in ("valueObject", "valueArray")}
    if "valueObject" in field and field["valueObject"] is not None:
        result["valueObject"] = {
            name: value for name, child in field["valueObject"].items()
            if (value := project_field(child, f"{path}.{name}", selected)) is not None
        }
    elif "valueArray" in field and field["valueArray"] is not None:
        # All rows remain, even when a selected child is absent from one row.
        result["valueArray"] = [
            project_field(child, path, selected) for child in field["valueArray"]
        ]
    return result


def check_analysis(analysis: dict, check: str) -> dict:
    if check not in CHECK_FIELDS:
        raise ValueError(f"Unknown policy check: {check}")
    documents = []
    for content in analysis.get("contents", []):
        category = content.get("category", "")
        if category in EXCLUDED_CATEGORIES:
            continue
        if category == "rental_invoice":
            selected = COMMON_FIELDS | INVOICE_FIELDS[check]
        else:
            selected = COMMON_FIELDS | CHECK_FIELDS[check] | {
                "vehicle", "vin", "incident_date", "incident_location", "reported_damage", "summary",
                "LineItems.Description", "InvoiceId", "InvoiceDate",
            }
        fields = {
            name: value for name, field in content.get("fields", {}).items()
            if (value := project_field(field, name, selected)) is not None
        }
        # Keep segment identity even if all selected facts are unknown/absent.
        documents.append({**deepcopy(content), "fields": fields})
    return {**deepcopy(analysis), "contents": documents,
            "textEvidence": [deepcopy(item) for item in analysis.get("textEvidence", [])
                             if item.get("category") not in EXCLUDED_CATEGORIES]}


def missing_fields(fields: dict, prefix: str = "") -> list[str]:
    missing = []
    for name, field in fields.items():
        path = f"{prefix}.{name}" if prefix else name
        if field.get("valueObject") is not None:
            missing.extend(missing_fields(field["valueObject"], path))
        elif field.get("valueArray") is not None:
            for index, child in enumerate(field["valueArray"]):
                missing.extend(missing_fields({f"{path}[{index}]": child}))
        elif not any(key.startswith("value") and value is not None
                     and (not isinstance(value, str) or value.strip())
                     for key, value in field.items()):
            missing.append(path)
    return missing


def fields_frontmatter(analysis: dict) -> str:
    """Use the public CU SDK formatter, with OCR disabled and unknowns explicit."""
    blocks = []
    for content in analysis.get("contents", []):
        # These are original CU type/value pairs, not re-extracted or inferred facts.
        value = {"kind": "document", "category": content.get("category"),
                 "fields": content.get("fields", {})}
        missing = missing_fields(value["fields"])
        text = to_llm_input(
            AnalysisResult({"contents": [value]}), include_fields=True, include_markdown=False,
            custom_metadata={"missingFields": missing} if missing else None,
        )
        if text.strip():
            provenance = {key: value for key, value in content.items() if key != "fields"}
            blocks.append("Original Parse document provenance: "
                          + json.dumps(provenance, ensure_ascii=False) + "\n" + text)
    return "\n\n*****\n\n".join(blocks)


def claim_input(analysis: dict) -> str:
    """Keep selected first-pass segments whole; text interpretation isn't extraction."""
    facts = fields_frontmatter(analysis)
    text = json.dumps(analysis.get("textEvidence", []), ensure_ascii=False)
    return ("Original typed Parse fields (UNTRUSTED claim evidence):\n"
            + (facts or "No relevant extracted fields were provided.")
            + "\n\nUNTRUSTED first-pass parsed page text with provenance "
            "(derived interpretation only, NOT new CU fields):\n" + text
            + "\n\nPermitted exact claim references for sourceReferences and ClaimField "
            "(select verbatim from this JSON list, never construct an identifier):\n"
            + json.dumps(sorted(claim_references(analysis)), ensure_ascii=False)
            + "\nTyped paths may be unqualified or use the exact supplied category prefix, "
            "but ONLY when that spelling appears in the list. Page-text references must use "
            "the exact listed textEvidence.id, not contentPath, a page number or an invented parse ID.")


def claim_references(analysis: dict) -> set[str]:
    """Enumerate typed paths, exact category aliases and supplied segment IDs."""
    references = set()

    def visit(field: dict, path: str) -> None:
        references.add(path)
        for name, child in (field.get("valueObject") or {}).items():
            visit(child, f"{path}.{name}")
        for index, child in enumerate(field.get("valueArray") or []):
            visit(child, f"{path}[{index}]")

    for content in analysis.get("contents", []):
        category = content.get("category")
        for name, field in content.get("fields", {}).items():
            visit(field, name)
            if isinstance(category, str) and category:
                visit(field, f"{category}.{name}")
    references.update(item["id"] for item in analysis.get("textEvidence", [])
                      if isinstance(item.get("id"), str) and item["id"])
    return references


def check_evidence(evidence: list[dict], sources: dict, check: str) -> list[dict]:
    """Trim by verified role/page metadata; never cut a table, figure or clause."""
    if check not in CHECK_FIELDS:
        raise ValueError(f"Unknown policy check: {check}")
    result = []
    for doc in evidence:
        source = sources[doc["file"]]
        # Effective-date checks need declarations and issued changes, not rental
        # timing diagrams. Other checks retain whole relevant contract pages.
        if check == "Effective terms" and source.get("role") == "rental_terms":
            continue
        if source.get("role") == "rental_terms" and check != "Rental start" and doc["page"] > 1:
            continue
        if source.get("documentType") != "policy_contract":
            pages = {1, 2, 4}
            if check != "Effective terms":
                pages.add(3)
            if check == "Rental start":
                pages.add(5)
            if not any(doc["page"] <= page <= doc["pageTo"] for page in pages):
                continue
        # Hashes and generation IDs have already been checked; they are not rules.
        result.append(deepcopy(doc))
    return result


def check_questions(file: Path, checks: list[str]) -> dict[str, str]:
    text = file.read_text(encoding="utf-8").split("## Per-check questions\n", 1)
    if len(text) != 2:
        raise ValueError("Per-check policy questions are missing.")
    sections = {}
    for section in text[1].split("\n## ", 1)[0].split("\n### ")[1:]:
        name, _, body = section.partition("\n")
        question = "\n".join(line.removeprefix("> ").removeprefix(">")
                             for line in body.splitlines() if line.startswith(">")).strip()
        if not question:
            raise ValueError(f"Empty per-check question: {name}")
        sections[name.strip()] = question
    if set(sections) != {"Shared", *checks}:
        raise ValueError("Per-check questions must contain Shared and exactly the three check names.")
    return sections


def check_prompt(analysis: dict, check: str, questions: dict[str, str],
                 applicability: dict | None = None) -> str:
    shared = ("\n\nShared rental applicability (derived interpretation of supplied Parse evidence, "
              "NOT a new extracted CU field):\n" + json.dumps(applicability, ensure_ascii=False)
              if applicability is not None else "")
    return (questions["Shared"] + "\n\n" + questions[check]
            + shared + "\n\n" + claim_input(check_analysis(analysis, check)))
