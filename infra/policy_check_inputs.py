"""Per-check projections of CU field values and verified policy evidence."""

from __future__ import annotations

from copy import deepcopy
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
    "Amount": {
        "Policy", "PolicyDailyBaseCap", "PolicyMaximumDays", "PolicyTaxTreatment", "PolicyEndorsement",
        "RentalDailyBaseRate", "RentalBilledDays", "RentalSubtotal", "RentalTaxes",
        "RentalTotal", "RentalCurrency", "RentalCharges", "Rental.DailyRates", "Rental.BilledUnits",
        "Rental.Subtotal", "Rental.Taxes", "Rental.Fees", "Rental.Credits", "Rental.Total",
        "Rental.Currency", "Rental.ChargingTerms", "Rental.LineItems", "PriorRentalUsage",
        "PriorRentalUsageEvidence", "Authorization.RateException", "Authorization.DurationExtension",
        "InsurerAuthorizationEvidence",
    },
    "Timing": {
        "Policy.CumulativeDayCap", "PolicyMaximumDays", "PolicyEndorsement", "Damage",
        "DrivabilityEvidence", "RentalPickup", "RentalReturn", "RentalScheduledReturn", "RentalBilledDays",
        "Rental.Pickup", "Rental.Return", "Rental.ScheduledReturn", "Rental.BilledUnits",
        "Rental.DailyRates.StartDate", "Rental.DailyRates.EndDate", "Rental.ChargingTerms",
        "Repair", "ActualRepairDelivery", "ActualRepairCompletion", "ScheduledRepairStart",
        "ScheduledRepairCompletion", "PriorRentalUsage", "PriorRentalUsageEvidence",
        "Authorization.CoveredStart", "Authorization.CoveredEnd", "Authorization.DurationExtension",
        "InsurerAuthorizationEvidence",
    },
    "Effective terms": {
        "Policy", "PolicyDailyBaseCap", "PolicyMaximumDays", "PolicyTaxTreatment", "PolicyEndorsement",
    },
    "Charges and reimbursement calculation": {
        "Policy.TaxTreatment", "Policy.Currency", "Policy.Exclusions", "PolicyTaxTreatment",
        "RentalDailyBaseRate", "RentalBilledDays", "RentalSubtotal", "RentalTaxes", "RentalCharges",
        "RentalTotal", "RentalCurrency", "Rental.DailyRates", "Rental.BilledUnits",
        "Rental.ChargingTerms", "Rental.LineItems", "Rental.Subtotal", "Rental.Taxes",
        "Rental.Fees", "Rental.Credits", "Rental.Total", "Rental.Currency",
    },
    "Authorization and payment readiness": {
        "Authorization", "InsurerAuthorizationEvidence", "RentalTotal", "RentalCurrency",
        "RentalDailyBaseRate", "RentalBilledDays", "RentalPickup", "RentalReturn",
        "Rental.Total", "Rental.Currency", "Rental.Pickup", "Rental.Return", "Rental.BilledUnits",
        "Rental.DailyRates", "Repair", "ActualRepairDelivery", "ActualRepairCompletion",
        "PriorRentalUsage", "PriorRentalUsageEvidence",
    },
}
INVOICE_FIELDS = {
    "Amount": {"InvoiceId", "InvoiceDate", "LineItems", "SubtotalAmount", "TotalTaxAmount",
               "TotalAmount", "TaxDetails", "TotalDiscountAmount"},
    "Timing": {"InvoiceId", "InvoiceDate", "LineItems.Description", "LineItems.ServiceStartDate",
               "LineItems.ServiceEndDate", "LineItems.Quantity", "PaymentTerm"},
    "Effective terms": {"InvoiceId", "LineItems.Description"},
    "Charges and reimbursement calculation": {
        "InvoiceId", "LineItems", "SubtotalAmount", "TotalTaxAmount", "TotalAmount",
        "TaxDetails", "TotalDiscountAmount", "AmountDue", "BalanceForward",
    },
    "Authorization and payment readiness": {
        "InvoiceId", "InvoiceDate", "LineItems.Description", "LineItems.Quantity",
        "TotalAmount", "AmountDue", "BalanceForward", "PaymentTerm",
    },
}


def project_field(field: dict, path: str, selected: set[str]) -> dict | None:
    """Keep typed CU values, including missing values, without flattening arrays."""
    if path in selected:
        return deepcopy(field)
    if not any(item.startswith(path + ".") for item in selected):
        return None
    result = {"type": field["type"]}
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
    for content in analysis["contents"]:
        category = content.get("category", "")
        if category == "claim_summary":
            selected = COMMON_FIELDS | CHECK_FIELDS[check]
        elif category == "rental_invoice":
            selected = COMMON_FIELDS | INVOICE_FIELDS[check]
        elif category in ("statement", "repair_estimate", "towing_invoice"):
            selected = COMMON_FIELDS | CHECK_FIELDS[check] | {
                "vehicle", "vin", "incident_date", "incident_location", "reported_damage", "summary",
                "LineItems.Description",
            }
        else:
            continue
        fields = {
            name: value for name, field in content.get("fields", {}).items()
            if (value := project_field(field, name, selected)) is not None
        }
        if fields:
            documents.append({"kind": "document", "category": category, "fields": fields})
    return {"contents": documents}


def missing_fields(fields: dict, prefix: str = "") -> list[str]:
    missing = []
    for name, field in fields.items():
        path = f"{prefix}.{name}" if prefix else name
        if field.get("valueObject") is not None:
            missing.extend(missing_fields(field["valueObject"], path))
        elif field.get("valueArray") is not None:
            for index, child in enumerate(field["valueArray"]):
                missing.extend(missing_fields({f"{path}[{index}]": child}))
        elif not any(key.startswith("value") and value is not None for key, value in field.items()):
            missing.append(path)
    return missing


def fields_frontmatter(analysis: dict) -> str:
    """Use the public CU SDK formatter, with OCR disabled and unknowns explicit."""
    blocks = []
    for content in analysis["contents"]:
        # These are original CU type/value pairs, not re-extracted or inferred facts.
        value = {"kind": "document", "category": content.get("category"),
                 "fields": content.get("fields", {})}
        missing = missing_fields(value["fields"])
        text = to_llm_input(
            AnalysisResult({"contents": [value]}), include_fields=True, include_markdown=False,
            custom_metadata={"missingFields": missing} if missing else None,
        )
        if text.strip():
            blocks.append(text)
    return "\n\n*****\n\n".join(blocks)


def check_evidence(evidence: list[dict], sources: dict, check: str) -> list[dict]:
    """Trim by verified role/page metadata; never cut a table, figure or clause."""
    result = []
    for doc in evidence:
        source = sources[doc["file"]]
        # Effective-date checks need declarations and issued changes, not rental
        # timing diagrams. Other checks retain whole relevant contract pages.
        if check == "Effective terms" and source.get("role") == "rental_terms":
            continue
        if source.get("role") == "rental_terms" and check != "Timing" and doc["page"] > 1:
            continue
        if source.get("documentType") != "policy_contract":
            pages = {1, 2, 4}
            if check != "Effective terms":
                pages.add(3)
            if check == "Timing":
                pages.add(5)
            if not any(doc["page"] <= page <= doc["pageTo"] for page in pages):
                continue
        # Hashes and generation IDs have already been checked; they are not rules.
        result.append({key: doc[key] for key in
                       ("id", "file", "documentId", "version", "content", "ruleIds", "citationSections")})
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
        raise ValueError("Per-check questions must contain Shared and exactly the five check names.")
    return sections


def check_prompt(analysis: dict, check: str, questions: dict[str, str]) -> str:
    facts = fields_frontmatter(check_analysis(analysis, check))
    return (questions["Shared"] + "\n\n" + questions[check]
            + "\n\nCU fields-only SDK input (untrusted claim evidence):\n"
            + (facts or "No relevant extracted fields were provided."))
