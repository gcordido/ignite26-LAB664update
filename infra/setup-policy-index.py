"""Set up the Search-managed (Standard) ingestion generation for the rental policy corpus.

Pipeline, all on the EXISTING Azure AI Search service (no serverless, no new service):
Blob container (managed identity) -> indexer -> Content Understanding skill
(2026-05-01-preview: semantic chunking + figure descriptions + page locations)
-> index projections -> ordinary keyword index.

Default (no flags) is READ-ONLY: it validates local sources and checks Azure
prerequisites with GET requests only. ``--apply`` is the only mode that creates or
uploads anything, and only when every prerequisite is verified. Role assignments,
network settings and deletions are never performed; missing roles are reported.
Ordinary setup does not create or require the legacy claim-summary analyzer.
``--apply`` activates a new configuration only after the indexer and retrieval
are verified; ``--index-only`` leaves the app's active configuration unchanged.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
CORPUS = Path("data") / "policies" / "rental" / "ocr-comparison-v2"
CONFIG_PATH = Path(".tools") / "policy-agent-framework.json"
BACKUP_PATH = Path(".tools") / "policy-agent-framework.layout-backup.json"
SNAPSHOT_PATH = Path(".tools") / "policy-agent-framework-managed-index.json"
STATE_PATH = Path(".tools") / "policy-agent-framework-ingestion.json"
DEPLOYMENT_PATH = Path(".tools") / "policy-deployment.json"
RESOURCE_TYPES = {
    "searchResourceId": ("Microsoft.Search/searchServices", r"[a-z0-9][a-z0-9-]{0,58}[a-z0-9]"),
    "storageResourceId": ("Microsoft.Storage/storageAccounts", r"[a-z0-9]{3,24}"),
    "foundryResourceId": ("Microsoft.CognitiveServices/accounts", r"[a-zA-Z0-9][a-zA-Z0-9-]{0,62}"),
}
SEARCH_API = "2026-05-01-preview"
ARM_ROLE_API = "2022-04-01"
STORAGE_API = "2023-11-03"
NAME_PREFIX = "lab664-rental-v2-managed"
SCHEMA = 2

# Retrieval contract of the managed index. Collections (stateCodes, ruleIds) and
# citationSections cannot be projected from blob metadata, so they are derived
# locally from the verified manifest/citations by documentId and page range.
INDEX_FIELDS = (
    "id", "parentId", "content", "documentId", "version", "file", "page", "pageTo",
    "ordinal", "sha256", "corpusHash", "indexFingerprint",
)
BLOB_METADATA = {  # blob metadata key -> index field
    "documentid": "documentId", "version": "version", "sha256": "sha256",
    "corpushash": "corpusHash", "indexfingerprint": "indexFingerprint",
}
PIPELINE = {
    "searchApi": SEARCH_API,
    "skill": "Microsoft.Skills.Util.ContentUnderstandingSkill",
    "extractionOptions": ["locationMetadata"],
    "chunking": {"method": "semantic", "unit": "tokens", "maximumLength": 1200},
    "projection": "index-projections/skipIndexingParentDocuments",
    "metadataMapping": dict(BLOB_METADATA),
}

ROLES = {
    "Storage Blob Data Reader": "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1",
    "Storage Blob Data Contributor": "ba92f5b4-2d11-453d-a403-e96b0029c9fe",
    "Storage Blob Data Owner": "b7e6dc6d-f1e8-4753-8033-0f276bb0955b",
    "Search Service Contributor": "7ca78c08-252a-4471-8644-bb5ff32d4ba0",
    "Search Index Data Contributor": "8ebe5a00-799e-43f5-93ac-243d3dce84a7",
    "Search Index Data Reader": "1407120a-92aa-4202-b7e9-c0e197c71c8f",
    "Cognitive Services User": "a97b65f3-24c7-4388-baec-2e87135dc908",
}
# (principal, scope, acceptable role names, purpose)
REQUIREMENTS = (
    ("searchIdentity", "storage", ("Storage Blob Data Reader", "Storage Blob Data Contributor",
                                   "Storage Blob Data Owner"),
     "indexer reads policy PDFs from Blob with its managed identity"),
    ("searchIdentity", "foundry", ("Cognitive Services User",),
     "Content Understanding skill calls the Foundry resource with the indexer identity"),
    ("caller", "storage", ("Storage Blob Data Contributor", "Storage Blob Data Owner"),
     "create the generation container and upload source PDFs"),
    ("caller", "search", ("Search Service Contributor",),
     "create datasource, skillset, index and indexer"),
    ("caller", "search", ("Search Index Data Contributor", "Search Index Data Reader"),
     "read back indexed chunks for verification"),
)


class SetupError(RuntimeError):
    """A fail-closed setup error."""


class ConflictError(SetupError):
    """An existing Azure object is not this generation's owned object."""


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SetupError(f"Cannot read JSON {path.name}: {exc}") from exc


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for attempt in range(8):
        try:
            os.replace(tmp, path)
            break
        except PermissionError:
            if attempt == 7:
                raise
            time.sleep(0.1 * (attempt + 1))


# ---------------------------------------------------------------- local sources

SEED_KEYS = {"modelDeployment", "cuModelName", "indexModelDeployment", "indexCuModelName",
             "claimAnalyzerId", "cuApiVersion",
             "layoutSourceIndex", "layoutIndexName", *RESOURCE_TYPES}


def runtime_settings(root: Path = ROOT, seed: dict[str, Any] | None = None) -> dict[str, Any]:
    """Verified runtime settings, overridden by machine-local deployment inputs and explicit seeds."""
    config = {}
    for path in (root / CONFIG_PATH, root / DEPLOYMENT_PATH):
        if path.is_file():
            value = read_json(path)
            if not isinstance(value, dict):
                raise SetupError(f"{path.name} must contain a JSON object.")
            if path.name == DEPLOYMENT_PATH.name and set(value) - SEED_KEYS:
                raise SetupError(f"Unknown deployment settings: {sorted(set(value) - SEED_KEYS)}")
            config.update(value)
    unknown = set(seed or {}) - SEED_KEYS
    if unknown:
        raise SetupError(f"Unknown seed settings: {sorted(unknown)}; allowed: {sorted(SEED_KEYS)}")
    config = {**config, **{k: v for k, v in (seed or {}).items() if v}}
    resources = {}
    names = {}
    for key, (resource_type, name_pattern) in RESOURCE_TYPES.items():
        value = config.get(key)
        match = re.fullmatch(
            rf"/subscriptions/([a-f0-9]{{8}}-(?:[a-f0-9]{{4}}-){{3}}[a-f0-9]{{12}})"
            rf"/resourceGroups/([A-Za-z0-9_.()-]{{1,90}})/providers/{re.escape(resource_type)}/({name_pattern})",
            value if isinstance(value, str) else "", re.IGNORECASE,
        )
        if not match:
            raise SetupError(f"{key} must be a full Azure {resource_type} resource ID. "
                             f"Set it in {DEPLOYMENT_PATH} or pass its resource-id flag.")
        resources[key], names[key] = value, match[3].lower()
    foundry_root = f"https://{names['foundryResourceId']}.services.ai.azure.com"
    settings = {
        **resources,
        "searchEndpoint": f"https://{names['searchResourceId']}.search.windows.net",
        "azureOpenAIEndpoint": foundry_root,
        "modelDeployment": config.get("modelDeployment", ""),
        "modelName": config.get("cuModelName") or config.get("modelDeployment", ""),
        # Search-managed CU skill model; falls back to the agent model when no override is set.
        "indexModelDeployment": config.get("indexModelDeployment") or config.get("modelDeployment", ""),
        "indexModelName": (config.get("indexCuModelName") or config.get("indexModelDeployment")
                           or config.get("cuModelName") or config.get("modelDeployment", "")),
        "cuEndpoint": foundry_root,
        "cuApiVersion": config.get("cuApiVersion", "2025-11-01"),
        "claimAnalyzerId": config.get("claimAnalyzerId", ""),
        "claimAnalyzerHash": config.get("claimAnalyzerHash", ""),
    }
    if not settings["modelDeployment"]:
        raise SetupError(f"modelDeployment is required for CU figure descriptions: set it in {CONFIG_PATH} "
                         "or pass --model-deployment (an existing Foundry model deployment).")
    for key in ("modelDeployment", "modelName", "indexModelDeployment", "indexModelName"):
        if not isinstance(settings[key], str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", settings[key]):
            raise SetupError(f"{key} must be a model/deployment name of 1-128 letters, digits, dots, underscores or hyphens.")
    if settings["cuApiVersion"] not in ("2025-11-01", "2026-06-01-preview"):
        raise SetupError("cuApiVersion must be 2025-11-01 or 2026-06-01-preview.")
    return settings


def digest(value: Any) -> str:
    """Canonical sha256 used for analyzer hashes (matches the runtime's JSON.stringify-based digest)."""
    def norm(v: Any) -> Any:
        if isinstance(v, float) and v.is_integer():
            return int(v)
        if isinstance(v, dict):
            return {k: norm(i) for k, i in v.items()}
        if isinstance(v, list):
            return [norm(i) for i in v]
        return v
    return hashlib.sha256(json.dumps(norm(value), ensure_ascii=False, separators=(",", ":"),
                                     sort_keys=True, allow_nan=False).encode("utf-8")).hexdigest()


def analyzer_hash(actual: dict[str, Any]) -> str:
    return digest({k: actual[k] for k in ("baseAnalyzerId", "config", "fieldSchema", "models") if k in actual})


def claim_evidence_analyzer_definition(completion_model: str = "gpt-4.1-mini") -> dict[str, Any]:
    """Flat, literal facts for evidence review; no inferred answers or policy conclusions."""
    descriptions = {
        "ClaimId": "Insurance claim reference from the loss intake or rental agreement.",
        "LossState": "Two-letter US loss state from the incident location or loss intake.",
        "LossDate": "Date of loss/accident from LOSS DETAILS, the incident report or insured statement.",
        "LossTime": "Time of loss from LOSS DETAILS or the incident report.",
        "CustomerName": "Named insured from the declarations and loss intake.",
        "PolicyId": "Policy number / POLICY REFERENCE in the loss intake or auto declarations.",
        "InsuredVIN": "VIN of the insured damaged vehicle from the loss intake or declarations.",
        "InsuredVehicle": "Year, make and model of the insured damaged vehicle.",
        "RentalRequested": ("Explicit rental/replacement vehicle request answer, including a clearly selected "
                            "Yes or No checkbox whose QUESTION explicitly asks about a RENTAL or REPLACEMENT "
                            "VEHICLE. True requires an explicit Yes to that rental question; false requires an "
                            "explicit No or statement that no rental is requested. Ignore TOWING REQUESTED, "
                            "TOWING REQUIRED, repair, glass and other service questions entirely: their Yes/No "
                            "answers establish neither true nor false for a rental request. Without an explicit "
                            "rental question/statement, leave this field absent.", "boolean"),
        "RentalUsed": ("Explicit statement that a rental/replacement vehicle was used or was not used. "
                       "False requires affirmative evidence of no rental use. Missing rental documents "
                       "alone do not establish false.", "boolean"),
        "RequestTypeEvidence": ("Exact words and selected checkbox answer establishing which benefits/services "
                                "were requested, especially rental requested Yes/No, no rental used, or "
                                "towing/repair only. Include the field label together with the selected answer; "
                                "a bare No without its question is insufficient. Preserve conflicting statements. "
                                "Payment/authorization pending is not rental request evidence. Do not infer "
                                "from missing documents or from policy benefits."),
        "DrivabilityEvidence": "Exact statement of insured vehicle drivability from the insured statement, intake observations or workshop inspection.",
        "PolicyTerm": "Policy period start and end dates from the auto declarations.",
        "PolicyDailyBaseCap": ("Base rental daily benefit limit in the policy/endorsement.", "number"),
        "PolicyMaximumDays": ("Maximum covered rental days from the declarations/endorsement.", "number"),
        "PolicyTaxTreatment": "Exact statement about mandatory rental taxes/surcharges in the policy.",
        "PolicyEndorsement": "Rental endorsement wording, including its effective date if explicitly shown.",
        "RentalAgreementId": "Agreement/contract reference from the actual rental agreement.",
        "RentalClaimLink": "Insurance claim reference printed on the rental agreement or bill.",
        "RentalPickup": "Actual vehicle pickup date/time from the rental agreement.",
        "RentalReturn": "Actual completed return date/time from the final rental bill or return record.",
        "RentalScheduledReturn": "Scheduled/planned return date/time from the rental agreement.",
        "RentalBilledDays": ("Actual billed rental units/days from the rental bill.", "number"),
        "RentalDailyBaseRate": ("Stated daily base rate, before tax, from the rental agreement/bill.", "number"),
        "RentalSubtotal": ("Rental base subtotal from the rental bill.", "number"),
        "RentalTaxes": ("Tax/surcharge total from the rental bill.", "number"),
        "RentalCharges": "Itemized rental charges, tax descriptions, optional fees and credits as printed.",
        "RentalTotal": ("Final total from the rental bill.", "number"),
        "RentalCurrency": "Rental invoice currency, when printed.",
        "ScheduledRepairStart": "Scheduled start date from the repair plan or repair estimate schedule.",
        "ScheduledRepairCompletion": "Scheduled completion date from the repair plan or estimate schedule.",
        "ActualRepairDelivery": "Explicit actual delivery/intake date FOR REPAIRS; an inspection or appointment is not repair delivery.",
        "ActualRepairCompletion": "Explicit actual completed repair/release date; planned completion is not actual.",
        "InsurerAuthorizationEvidence": "Exact insurer authorization/payment status or statement from claim/repair documents.",
        "PriorRentalUsageEvidence": "Explicit prior rental usage for this same loss, including an explicit statement of none if present.",
    }
    fields = {}
    for name, description in descriptions.items():
        text, typ = description if isinstance(description, tuple) else (description, "string")
        if name.startswith("Rental") and name not in ("RentalRequested", "RentalUsed"):
            text += (" Extract only from an actual rental-vehicle agreement, rental invoice or rental "
                     "return record. Never copy a repair estimate, towing invoice, glass bill, policy "
                     "benefit limit, or general claim total into this rental field. If no rental "
                     "agreement/bill/return record states this fact, leave it absent.")
        fields[name] = {"type": typ, "method": "extract",
                        "description": text + " Return only document evidence; absent facts stay null. Never infer a value."}
    return {"description": "LAB664 flat claim facts for grounded policy evidence review; no adjudication.",
            "baseAnalyzerId": "prebuilt-document", "models": {"completion": completion_model},
            "config": {"returnDetails": True}, "fieldSchema": {"name": "claim_summary", "fields": fields}}


def _safe_pdf(corpus: Path, filename: Any) -> Path:
    if (not isinstance(filename, str) or not filename.lower().endswith(".pdf")
            or filename != Path(filename).name or filename == ".pdf"):
        raise SetupError(f"Manifest pdf must be a plain .pdf filename: {filename!r}")
    path = corpus / filename
    if not path.is_file():
        raise SetupError(f"Source PDF is missing: {filename}")
    return path


def load_sources(root: Path = ROOT) -> dict[str, Any]:
    """Validate manifest, citations and PDFs; the document count comes from the manifest."""
    corpus = root / CORPUS
    manifest_path = corpus / "manifest.json"
    if not manifest_path.is_file():
        raise SetupError("manifest.json is missing.")
    raw = manifest_path.read_bytes()
    try:
        manifest = json.loads(raw)
    except ValueError as exc:
        raise SetupError(f"manifest.json is malformed: {exc}") from exc
    citations_raw = read_json(corpus / "citations.json")
    docs_in = manifest.get("documents") if isinstance(manifest, dict) else None
    if not isinstance(docs_in, list) or not docs_in:
        raise SetupError("manifest.json must contain a non-empty documents list.")
    if not isinstance(citations_raw, list):
        raise SetupError("citations.json must be a list.")
    citations = {}
    for item in citations_raw:
        if not isinstance(item, dict) or not item.get("documentId"):
            raise SetupError("citations.json has a malformed entry.")
        citations[item["documentId"]] = item
    documents, seen_ids, seen_files = [], set(), set()
    for doc in docs_in:
        if not isinstance(doc, dict):
            raise SetupError("manifest document entries must be objects.")
        doc_id, version = doc.get("documentId"), doc.get("version")
        if not isinstance(doc_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", doc_id) or not isinstance(version, str) or not version:
            raise SetupError("Every manifest document needs documentId and version.")
        if doc_id in seen_ids or doc.get("pdf") in seen_files:
            raise SetupError(f"Duplicate manifest document or pdf: {doc_id}")
        seen_ids.add(doc_id)
        seen_files.add(doc.get("pdf"))
        pdf = _safe_pdf(corpus, doc.get("pdf"))
        digest = sha256_hex(pdf.read_bytes())
        if not re.fullmatch(r"[a-f0-9]{64}", str(doc.get("sha256", ""))) or digest != doc["sha256"]:
            raise SetupError(f"{doc_id}: PDF hash does not match the manifest.")
        cite = citations.get(doc_id)
        if (not cite or cite.get("version") != version or cite.get("sha256") != digest
                or cite.get("pdf") != doc["pdf"]):
            raise SetupError(f"{doc_id}: citations.json is missing or inconsistent.")
        sections = cite.get("sections")
        if not isinstance(sections, dict) or not sections or not all(
                isinstance(k, str) and k and isinstance(v, int) and not isinstance(v, bool) and v >= 1
                for k, v in sections.items()):
            raise SetupError(f"{doc_id}: citation sections must map headings to page numbers.")
        rule_ids = doc.get("ruleIds")
        if not isinstance(rule_ids, list) or not rule_ids or not all(isinstance(r, str) for r in rule_ids):
            raise SetupError(f"{doc_id}: ruleIds must be a non-empty list.")
        if cite.get("ruleIds") != rule_ids:
            raise SetupError(f"{doc_id}: citation ruleIds differ from the manifest.")
        if doc.get("documentType") == "repair_review_sop":
            state_rules = doc.get("stateRules")
            if (doc.get("role") != "repair_review" or "REPAIR-SCOPE-01" not in rule_ids
                    or not isinstance(state_rules, dict) or set(state_rules) != set(doc.get("states", []))
                    or cite.get("stateRules") != state_rules
                    or any(not isinstance(rule, dict) or set(rule) != {"page", "ruleId"}
                           or type(rule["page"]) is not int or rule["page"] not in sections.values()
                           or rule["ruleId"] not in rule_ids for rule in state_rules.values())):
                raise SetupError(f"{doc_id}: repair diagram needs verified state-specific page/rule mappings.")
        states = doc.get("states")
        if not isinstance(states, list) or not states or not all(
                isinstance(s, str) and re.fullmatch(r"[A-Z]{2}", s) for s in states):
            raise SetupError(f"{doc_id}: states must be a non-empty list.")
        if (doc.get("role") == "rental_terms"
                and doc.get("diagramAuthority") not in ("controlling", "illustrative")):
            raise SetupError(f"{doc_id}: rental terms must declare diagramAuthority.")
        policy_scope = doc.get("policyScope")
        if policy_scope is not None or doc.get("documentType") == "policy_contract":
            if (not isinstance(policy_scope, dict) or set(policy_scope) != {"policyId", "vin"}
                    or not all(isinstance(v, str) and v.strip() for v in policy_scope.values())
                    or not re.fullmatch(r"[A-HJ-NPR-Z0-9]{17}", policy_scope["vin"])):
                raise SetupError(f"{doc_id}: contract evidence requires a policy ID and insured VIN.")
        state_codes = list(states)
        if doc.get("documentType") == "shared_standard" and "SHARED" not in state_codes:
            state_codes.append("SHARED")
        documents.append({
            "documentId": doc_id, "version": version, "file": doc["pdf"], "sha256": digest,
            "stateCodes": state_codes, "ruleIds": list(rule_ids),
            "sections": dict(sections), "path": str(pdf),
            "documentType": doc.get("documentType"),
            **({"role": doc["role"], "stateRules": doc["stateRules"]}
               if doc.get("documentType") == "repair_review_sop" else {}),
            **({"policyScope": policy_scope} if policy_scope is not None else {}),
        })
    if "activeChecks" in manifest:
        expected_states = {"TX", "WA", "AZ", "CO", "FL", "IL", "LA", "CA", "NY", "OH"}
        declarations = [d for d in docs_in if d.get("role") == "revised_declarations"]
        effective = [d for d in docs_in
                     if d.get("role") in ("policy_effective_date", "issued_amendment")]
        repair = [d for d in docs_in if d.get("role") == "repair_review"]
        if (manifest["activeChecks"] != ["Daily rate", "Effective terms", "Repair estimate"]
                or len(docs_in) != 21 or len(declarations) != 10 or len(effective) != 10
                or len(repair) != 1
                or any(d.get("documentType") != "policy_contract" or len(d["states"]) != 1
                       for d in declarations + effective)
                or {d["states"][0] for d in declarations} != expected_states
                or {d["states"][0] for d in effective} != expected_states
                or {d["states"][0] for d in effective if d.get("role") == "issued_amendment"} != {"TX"}
                or repair[0].get("documentType") != "repair_review_sop"
                or set(repair[0]["states"]) != expected_states):
            raise SetupError("The three-check corpus requires all ten declarations, ten effective-date "
                             "sources (including the Texas issued amendment), and one repair diagram.")
    documents.sort(key=lambda d: d["documentId"])
    return {"corpusHash": sha256_hex(raw), "documents": documents}


def generation_hash(sources: dict[str, Any], settings: dict[str, Any]) -> str:
    """Definition + source hash; any pipeline, model or source change yields a new generation."""
    return sha256_hex(canonical_bytes({
        "schema": SCHEMA, "pipeline": PIPELINE,
        "model": [settings["indexModelName"], settings["indexModelDeployment"]],
        "services": [settings["searchEndpoint"], settings["storageResourceId"], settings["cuEndpoint"]],
        "corpusHash": sources["corpusHash"],
        "sources": [[d["documentId"], d["version"], d["file"], d["sha256"], d["stateCodes"],
                     d["ruleIds"], sorted(d["sections"].items())] for d in sources["documents"]],
    }))


def names_for(generation: str) -> dict[str, str]:
    short = generation[:12]
    base = f"{NAME_PREFIX}-{short}"
    return {"index": base, "datasource": f"{base}-ds", "skillset": f"{base}-ss",
            "indexer": f"{base}-ixr", "container": f"lab664-rental-v2-{short}"}


def owner_marker(generation: str) -> str:
    return f"LAB664 managed policy ingestion; schema={SCHEMA}; generation={generation}"

# ---------------------------------------------------------- Search definitions

def index_definition(names: dict[str, str], generation: str) -> dict[str, Any]:
    def field(name, typ, **kw):
        return {"name": name, "type": typ, "searchable": False, "filterable": False,
                "sortable": False, "facetable": False, "key": False, "retrievable": True, **kw}
    return {
        "name": names["index"], "description": owner_marker(generation),
        "fields": [
            field("id", "Edm.String", key=True, searchable=True, filterable=True, sortable=True, analyzer="keyword"),
            field("parentId", "Edm.String", filterable=True),
            field("content", "Edm.String", searchable=True),
            field("documentId", "Edm.String", filterable=True),
            field("version", "Edm.String", filterable=True),
            field("file", "Edm.String"),
            field("page", "Edm.Int32", filterable=True, sortable=True),
            field("pageTo", "Edm.Int32", filterable=True, sortable=True),
            field("ordinal", "Edm.Int32", sortable=True),
            field("sha256", "Edm.String", filterable=True),
            field("corpusHash", "Edm.String", filterable=True),
            field("indexFingerprint", "Edm.String", filterable=True),
        ],
    }


def datasource_definition(names: dict[str, str], generation: str, settings: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": names["datasource"], "description": owner_marker(generation), "type": "azureblob",
        "credentials": {"connectionString": f"ResourceId={settings['storageResourceId']};"},
        "container": {"name": names["container"]},
    }


def skillset_definition(names: dict[str, str], generation: str, settings: dict[str, Any]) -> dict[str, Any]:
    root = "/document/text_sections/*"
    mappings = [
        {"name": "content", "source": f"{root}/content"},
        {"name": "page", "source": f"{root}/locationMetadata/pageNumberFrom"},
        {"name": "pageTo", "source": f"{root}/locationMetadata/pageNumberTo"},
        {"name": "ordinal", "source": f"{root}/locationMetadata/ordinalPosition"},
        {"name": "file", "source": "/document/metadata_storage_name"},
    ] + [{"name": field, "source": f"/document/{field}"} for field in BLOB_METADATA.values()]
    return {
        "name": names["skillset"], "description": owner_marker(generation),
        "skills": [{
            "@odata.type": "#" + PIPELINE["skill"], "name": "content-understanding",
            "description": "Semantic chunks with page locations and figure descriptions",
            "context": "/document", "modelName": settings["indexModelName"],
            "modelDeployment": settings["indexModelDeployment"],
            "extractionOptions": PIPELINE["extractionOptions"],
            "chunkingProperties": dict(PIPELINE["chunking"]),
            "inputs": [{"name": "file_data", "source": "/document/file_data"}],
            "outputs": [{"name": "text_sections", "targetName": "text_sections"}],
        }],
        "cognitiveServices": {
            "@odata.type": "#Microsoft.Azure.Search.AIServicesByIdentity",
            "subdomainUrl": settings["cuEndpoint"], "identity": None,
        },
        "indexProjections": {
            "selectors": [{
                "targetIndexName": names["index"], "parentKeyFieldName": "parentId",
                "sourceContext": root, "mappings": mappings,
            }],
            "parameters": {"projectionMode": "skipIndexingParentDocuments"},
        },
    }


def indexer_definition(names: dict[str, str], generation: str) -> dict[str, Any]:
    return {
        "name": names["indexer"], "description": owner_marker(generation),
        "dataSourceName": names["datasource"], "skillsetName": names["skillset"],
        "targetIndexName": names["index"], "disabled": False,
        "fieldMappings": [{"sourceFieldName": key, "targetFieldName": field}
                          for key, field in BLOB_METADATA.items()],
        "parameters": {
            "maxFailedItems": 0, "maxFailedItemsPerBatch": 0,
            "configuration": {
                "dataToExtract": "contentAndMetadata", "parsingMode": "default",
                "allowSkillsetToReadFileData": True, "indexedFileNameExtensions": ".pdf",
            },
        },
    }


def definitions(names, generation, settings) -> dict[str, tuple[str, dict[str, Any]]]:
    return {
        "index": ("indexes", index_definition(names, generation)),
        "datasource": ("datasources", datasource_definition(names, generation, settings)),
        "skillset": ("skillsets", skillset_definition(names, generation, settings)),
        "indexer": ("indexers", indexer_definition(names, generation)),
    }


def _subset(expected: Any, actual: Any) -> bool:
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            k in actual and _subset(v, actual[k]) for k, v in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(expected) == len(actual) and all(
            _subset(e, a) for e, a in zip(expected, actual))
    return expected == actual


FIELD_KEYS = ("name", "type", "key", "searchable", "filterable", "sortable")


def _norm_fields(fields: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{k: (f.get(k) if k in ("name", "type") else bool(f.get(k))) for k in FIELD_KEYS}
            for f in fields]


def assert_owned(kind: str, expected: dict[str, Any], actual: dict[str, Any]) -> None:
    """Fail closed unless an existing object is exactly this generation's definition."""
    name = expected["name"]
    if actual.get("description") != expected["description"]:
        raise ConflictError(f"Existing {kind} '{name}' is not owned by this generation.")
    if kind == "index":
        if _norm_fields(actual.get("fields", [])) != _norm_fields(expected["fields"]):
            raise ConflictError(f"Existing index '{name}' has a different schema.")
        return
    comparable = {k: v for k, v in expected.items() if k != "credentials"}
    if not _subset(comparable, actual):
        raise ConflictError(f"Existing {kind} '{name}' differs from the expected definition.")


# ------------------------------------------------------------------- HTTP

def progress(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", file=sys.stderr, flush=True)


def _decode(payload: bytes) -> Any:
    if not payload:
        return None
    try:
        return json.loads(payload)
    except ValueError:
        return payload.decode("utf-8", "replace")[:500]


def _err(status: int, body: Any) -> str:
    error = body.get("error") if isinstance(body, dict) else None
    text = error.get("message") if isinstance(error, dict) else body
    return f"HTTP {status}: {str(text)[:300] if text is not None else 'empty response body'}"


class Http:
    """Small injectable transport (AzureCliCredential); tests replace it entirely."""

    def __init__(self, credential: Any | None = None, sleep: Callable[[float], None] = time.sleep):
        self._credential, self._sleep = credential, sleep
        self._tokens: dict[str, tuple[str, int]] = {}

    def token(self, scope: str) -> str:
        cached = self._tokens.get(scope)
        if cached is not None and cached[1] > time.time() + 300:
            return cached[0]
        if self._credential is None:
            from azure.identity import AzureCliCredential
            self._credential = AzureCliCredential(process_timeout=30)
        target = urllib.parse.urlsplit(scope).hostname
        progress(f"Requesting Azure CLI token for {target} (CLI timeout: 30s)...")
        started = time.monotonic()
        token = self._credential.get_token(scope)
        self._tokens[scope] = (token.token, token.expires_on)
        progress(f"Authentication ready for {target} ({time.monotonic() - started:.1f}s).")
        return token.token

    def request(self, method: str, url: str, scope: str, body: Any = None,
                headers: dict[str, str] | None = None, raw: bytes | None = None
                ) -> tuple[int, Any, dict[str, str]]:
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        hdrs = {"Authorization": f"Bearer {self.token(scope)}", "Accept": "application/json"}
        if body is not None:
            hdrs["Content-Type"] = "application/json"
        hdrs.update(headers or {})
        target = urllib.parse.urlsplit(url)
        operation = f"{method} {target.hostname}{target.path}"
        for attempt in range(4):
            progress(f"{operation} (attempt {attempt + 1}/4, request timeout: 120s)...")
            started = time.monotonic()
            req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    value = _decode(resp.read())
                    progress(f"{operation} -> HTTP {resp.status} ({time.monotonic() - started:.1f}s).")
                    return resp.status, value, dict(resp.headers)
            except urllib.error.HTTPError as err:
                payload = _decode(err.read())
                progress(f"{operation} -> HTTP {err.code} ({time.monotonic() - started:.1f}s).")
                if err.code in (429, 503) and attempt < 3:
                    progress(f"Service busy; retrying in {2 ** attempt}s.")
                    self._sleep(2 ** attempt)
                    continue
                return err.code, payload, dict(err.headers or {})
            except urllib.error.URLError as exc:
                raise SetupError(f"Network error calling {urllib.parse.urlsplit(url).netloc}: {exc.reason}") from exc
        raise SetupError("unreachable")


ARM = "https://management.azure.com"
ARM_SCOPE = "https://management.azure.com/.default"
SEARCH_SCOPE = "https://search.azure.com/.default"
STORAGE_SCOPE = "https://storage.azure.com/.default"


def token_oid(token: str) -> str:
    try:
        payload = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["oid"]
    except (IndexError, KeyError, ValueError) as exc:
        raise SetupError("Cannot determine the caller object id from the Azure token.") from exc


# ----------------------------------------------------------------- preflight

def role_assignments(http: Any, scope: str, principal: str) -> list[dict[str, str]]:
    filt = urllib.parse.quote(f"assignedTo('{principal}')", safe="()'")
    url = f"{ARM}{scope}/providers/Microsoft.Authorization/roleAssignments?api-version={ARM_ROLE_API}&$filter={filt}"
    out = []
    while url:
        if not url.startswith(ARM + "/"):
            raise SetupError("Unexpected role-assignment pagination endpoint.")
        status, body, _ = http.request("GET", url, ARM_SCOPE)
        if status != 200 or not isinstance(body, dict):
            raise SetupError(f"Cannot list role assignments on {scope.rsplit('/', 1)[-1]}: {_err(status, body)}")
        for item in body.get("value", []):
            props = item.get("properties", {})
            assigned = props.get("scope", "")
            resource, parent = scope.lower(), assigned.lower()
            if parent == "/" or resource == parent or resource.startswith(parent.rstrip("/") + "/"):
                out.append({"role": props.get("roleDefinitionId", "").rsplit("/", 1)[-1].lower(), "scope": assigned})
        url = body.get("nextLink")
    return out


def check_roles(held: dict[tuple[str, str], list[dict[str, str]]]) -> list[dict[str, Any]]:
    """Fail-closed: a requirement is met only when an accepted role is positively found."""
    results = []
    for who, scope_key, role_names, purpose in REQUIREMENTS:
        accepted = {ROLES[name] for name in role_names}
        ok = any(a["role"] in accepted for a in held.get((who, scope_key)) or [])
        results.append({"principal": who, "scope": scope_key, "anyOf": list(role_names),
                        "purpose": purpose, "ok": ok})
    return results


CU_SCOPE = "https://cognitiveservices.azure.com/.default"


def resolve_analyzer(http: Any, settings: dict[str, Any]) -> dict[str, Any]:
    """Read-only: GET the existing claim analyzer and return settings with its actual hash. Fails closed."""
    analyzer_id = settings.get("claimAnalyzerId")
    if not analyzer_id or not re.fullmatch(r"[A-Za-z0-9_]{1,64}", analyzer_id):
        raise SetupError("claimAnalyzerId must name an existing CU analyzer (letters, digits, underscores): "
                         "set it in the config or pass --claim-analyzer-id.")
    url = (f"{settings['cuEndpoint'].rstrip('/')}/contentunderstanding/analyzers/{analyzer_id}"
           f"?api-version={settings['cuApiVersion']}")
    status, body, _ = http.request("GET", url, CU_SCOPE)
    if status != 200 or not isinstance(body, dict):
        raise SetupError(f"Cannot read CU analyzer {analyzer_id}: {_err(status, body)}")
    if str(body.get("status", "")).lower() not in ("ready", "succeeded"):
        raise SetupError(f"CU analyzer {analyzer_id} is not ready (status {body.get('status')!r}).")
    return {**settings, "claimAnalyzerHash": analyzer_hash(body)}


def prepare_claim_analyzer(http: Any, settings: dict[str, Any], apply_changes: bool = False,
                           sleep: Callable[[float], None] = time.sleep) -> dict[str, Any]:
    """Explicit opt-in bootstrap; never replace an existing analyzer."""
    analyzer_id = settings["claimAnalyzerId"]
    if not isinstance(analyzer_id, str) or not re.fullmatch(r"[A-Za-z0-9_]{1,64}", analyzer_id):
        raise SetupError("Creating a claim analyzer requires an ID of 1-64 letters, digits or underscores.")
    url = (f"{settings['cuEndpoint']}/contentunderstanding/analyzers/{analyzer_id}"
           f"?api-version={settings['cuApiVersion']}")
    expected = claim_evidence_analyzer_definition(settings["modelName"])
    status, actual, _ = http.request("GET", url, CU_SCOPE)
    if status == 200:
        if not _subset(expected, actual):
            raise ConflictError(f"Existing analyzer {analyzer_id} differs from the lab claim schema; "
                                "choose a new ID or omit --create-claim-analyzer to use it unchanged.")
        return resolve_analyzer(http, settings)
    if status != 404:
        raise SetupError(f"Cannot inspect claim analyzer: {_err(status, actual)}")
    if not apply_changes:
        return {"id": analyzer_id, "status": "planned", "model": settings["modelName"]}
    status, body, _ = http.request("PUT", url, CU_SCOPE, body=expected, headers={"If-None-Match": "*"})
    if status not in (200, 201, 202):
        raise SetupError(f"Cannot create claim analyzer: {_err(status, body)}")
    for _ in range(120):
        sleep(5)
        status, actual, _ = http.request("GET", url, CU_SCOPE)
        if status != 200 or not isinstance(actual, dict):
            raise SetupError(f"Cannot read created claim analyzer: {_err(status, actual)}")
        state = str(actual.get("status", "")).lower()
        if state in ("ready", "succeeded"):
            if not _subset(expected, actual):
                raise SetupError("Created claim analyzer does not match the requested extraction schema.")
            return resolve_analyzer(http, settings)
        if state not in ("creating", "running", "notstarted"):
            raise SetupError(f"Claim analyzer creation failed: {actual.get('error', state)}")
    raise SetupError("Claim analyzer creation timed out.")


def preflight(http: Any, root: Path = ROOT, offline: bool = False,
              seed: dict[str, Any] | None = None, create_claim_analyzer: bool = False,
              index_only: bool = False) -> dict[str, Any]:
    """Read-only: local validation plus GET-only Azure checks."""
    progress("Checking policy sources and deployment settings...")
    sources = load_sources(root)
    settings = runtime_settings(root, seed)
    generation = generation_hash(sources, settings)
    names = names_for(generation)
    report: dict[str, Any] = {
        "ready": False, "generation": generation, "names": names,
        "documents": len(sources["documents"]), "corpusHash": sources["corpusHash"],
        "extractionMode": "standard", "figureDescriptions": True, "indexOnly": index_only,
        **{key: settings[key] for key in RESOURCE_TYPES},
        "checks": [], "missingRoles": [], "problems": [],
    }
    if offline:
        report["problems"].append("local-only: Azure prerequisites were not checked")
        return report
    progress(f"Checking Azure resources and permissions for {len(sources['documents'])} policy PDFs...")
    scopes = {key: settings[f"{key}ResourceId"] for key in ("search", "storage", "foundry")}
    versions = {"search": "2025-05-01", "storage": "2023-05-01", "foundry": "2025-06-01"}
    resources = {}
    for key, rid in scopes.items():
        status, body, _ = http.request("GET", f"{ARM}{rid}?api-version={versions[key]}", ARM_SCOPE)
        if status != 200 or not isinstance(body, dict):
            report["problems"].append(f"Cannot read {key} resource: {_err(status, body)}")
        else:
            resources[key] = body
    if "search" in resources:
        search = resources["search"]
        principal = (search.get("identity") or {}).get("principalId")
        props = search.get("properties", {})
        report["checks"].append({"name": "search", "sku": (search.get("sku") or {}).get("name"),
                                 "disableLocalAuth": props.get("disableLocalAuth"),
                                 "publicNetworkAccess": props.get("publicNetworkAccess"),
                                 "hasManagedIdentity": bool(principal)})
        report["searchIdentity"] = principal
        if not principal:
            report["problems"].append("Search service has no system-assigned managed identity.")
    for key in ("storage", "foundry"):
        if key in resources:
            props = resources[key].get("properties", {})
            report["checks"].append({"name": key, "publicNetworkAccess": props.get("publicNetworkAccess"),
                                     "defaultAction": (props.get("networkAcls") or {}).get("defaultAction"),
                                     "allowSharedKeyAccess": props.get("allowSharedKeyAccess")})
    held: dict[tuple[str, str], list[dict[str, str]]] = {}
    try:
        caller = token_oid(http.token(ARM_SCOPE))
        report["callerObjectId"] = caller
        principals = {"caller": caller, "searchIdentity": report.get("searchIdentity")}
        for who, key, _, _ in REQUIREMENTS:
            if principals[who] and (who, key) not in held:
                held[(who, key)] = role_assignments(http, scopes[key], principals[who])
    except SetupError as exc:
        report["problems"].append(str(exc))
    report["roles"] = check_roles(held)
    principal_ids = {"searchIdentity": report.get("searchIdentity"), "caller": report.get("callerObjectId")}
    report["missingRoles"] = [
        {"principal": r["principal"], "principalId": principal_ids[r["principal"]],
         "scopeResourceId": scopes[r["scope"]], "anyOfRoles": r["anyOf"], "purpose": r["purpose"]}
        for r in report["roles"] if not r["ok"]]
    report["existing"] = {}
    for kind, (collection, _) in definitions(names, generation, settings).items():
        progress(f"Checking existing Search {kind}: {names[kind]}...")
        status, body, _ = http.request(
            "GET", f"{settings['searchEndpoint']}/{collection}('{names[kind]}')?api-version={SEARCH_API}", SEARCH_SCOPE)
        report["existing"][kind] = "present" if status == 200 else ("absent" if status == 404 else _err(status, body))
        if status not in (200, 404):
            report["problems"].append(f"Cannot inspect {kind}: {_err(status, body)}")
    if not index_only and (create_claim_analyzer or (seed or {}).get("claimAnalyzerId")):
        progress("Checking the explicitly requested legacy claim-summary analyzer...")
        try:
            resolved = (prepare_claim_analyzer(http, settings) if create_claim_analyzer
                        else resolve_analyzer(http, settings))
            report["claimAnalyzer"] = (resolved if resolved.get("status") == "planned" else
                                       {"id": resolved["claimAnalyzerId"], "hash": resolved["claimAnalyzerHash"]})
        except SetupError as exc:
            report["problems"].append(str(exc))
    report["ready"] = not report["missingRoles"] and not report["problems"]
    progress("Prerequisite checks passed." if report["ready"] else
             "Prerequisite checks blocked indexing; see missingRoles and problems in the JSON report.")
    return report

# ---------------------------------------------------------------- apply steps

def storage_url(names: dict[str, str], settings: dict[str, Any],
                blob: str | None = None, query: str = "") -> str:
    account = settings["storageResourceId"].rsplit("/", 1)[-1]
    path = names["container"] + (f"/{urllib.parse.quote(blob)}" if blob else "")
    return f"https://{account}.blob.core.windows.net/{path}{query}"


def blob_metadata(doc: dict[str, Any], generation: str, corpus_hash: str) -> dict[str, str]:
    return {"documentid": doc["documentId"], "version": doc["version"], "sha256": doc["sha256"],
            "corpushash": corpus_hash, "indexfingerprint": generation}


def upload_sources(http: Any, sources: dict[str, Any], names: dict[str, str], generation: str,
                   refresh: bool, settings: dict[str, Any]) -> dict[str, str]:
    base = {"x-ms-version": STORAGE_API}
    progress(f"Preparing Blob container: {names['container']}...")
    status, body, _ = http.request("PUT", storage_url(names, settings, query="?restype=container"), STORAGE_SCOPE,
                                   headers=base, raw=b"")
    if status not in (201, 409):
        raise SetupError(f"Cannot create container: {_err(status, body)}")
    result = {}
    total = len(sources["documents"])
    for number, doc in enumerate(sources["documents"], 1):
        progress(f"Source {number}/{total}: checking {doc['file']}...")
        meta = blob_metadata(doc, generation, sources["corpusHash"])
        status, _, head = http.request("HEAD", storage_url(names, settings, doc["file"]), STORAGE_SCOPE, headers=base)
        lower = {k.lower(): v for k, v in (head or {}).items()}
        if status == 200:
            if all(lower.get(f"x-ms-meta-{k}") == v for k, v in meta.items()):
                result[doc["file"]] = "unchanged"
                progress(f"Source {number}/{total}: unchanged; reusing {doc['file']}.")
                continue
            if not refresh:
                raise ConflictError(f"Blob {doc['file']} exists with different metadata; use --refresh to replace it.")
        elif status != 404:
            raise SetupError(f"Cannot inspect blob {doc['file']}: HTTP {status}")
        put = {**base, "x-ms-blob-type": "BlockBlob", "Content-Type": "application/pdf",
               **{f"x-ms-meta-{k}": v for k, v in meta.items()}}
        progress(f"Source {number}/{total}: uploading {doc['file']}...")
        status, body, _ = http.request("PUT", storage_url(names, settings, doc["file"]), STORAGE_SCOPE,
                                       headers=put, raw=Path(doc["path"]).read_bytes())
        if status != 201:
            raise SetupError(f"Cannot upload {doc['file']}: {_err(status, body)}")
        result[doc["file"]] = "uploaded"
        progress(f"Source {number}/{total}: upload complete.")
    return result


def ensure_objects(http: Any, names, generation, settings) -> dict[str, str]:
    outcome = {}
    for kind in ("index", "datasource", "skillset", "indexer"):
        progress(f"Preparing Search {kind}: {names[kind]}...")
        collection, expected = definitions(names, generation, settings)[kind]
        url = f"{settings['searchEndpoint']}/{collection}('{names[kind]}')?api-version={SEARCH_API}"
        status, body, _ = http.request("GET", url, SEARCH_SCOPE)
        if status == 200:
            assert_owned(kind, expected, body)
            outcome[kind] = "reused"
            progress(f"Search {kind}: reusing matching definition.")
            continue
        if status != 404:
            raise SetupError(f"Cannot inspect {kind}: {_err(status, body)}")
        status, body, _ = http.request("PUT", url, SEARCH_SCOPE, body=expected,
                                       headers={"If-None-Match": "*", "Prefer": "return=representation"})
        if status not in (200, 201):
            raise SetupError(f"Cannot create {kind}: {_err(status, body)}")
        outcome[kind] = "created"
        progress(f"Search {kind}: created.")
    return outcome


def indexer_status(http: Any, names: dict[str, str], settings: dict[str, Any]) -> dict[str, Any]:
    status, body, _ = http.request(
        "GET", f"{settings['searchEndpoint']}/indexers('{names['indexer']}')/search.status?api-version={SEARCH_API}",
        SEARCH_SCOPE)
    if status != 200 or not isinstance(body, dict):
        raise SetupError(f"Cannot read indexer status: {_err(status, body)}")
    return body


def _running(status: dict[str, Any]) -> bool:
    last = status.get("lastResult")
    return (not last and status.get("status") == "running") or bool(last and last.get("status") == "inProgress")


def indexer_ready(status: dict[str, Any], expected_documents: int) -> tuple[bool, str]:
    """Succeeded, no failures, every manifest document processed."""
    if _running(status):
        return False, "indexer is still running"
    last = status.get("lastResult") or {}
    if last.get("status") != "success":
        return False, f"last indexer run is {last.get('status', 'absent')}: {str(last.get('errorMessage', ''))[:200]}"
    if last.get("itemsFailed", 0):
        return False, f"{last['itemsFailed']} document(s) failed"
    if last.get("itemsProcessed", 0) < expected_documents:
        return False, f"processed {last.get('itemsProcessed', 0)} of {expected_documents} documents"
    return True, "ok"


def run_indexer(http: Any, names, expected_documents: int, force: bool, settings: dict[str, Any], timeout: float = 1800,
                sleep: Callable[[float], None] = time.sleep, interval: float = 15) -> dict[str, Any]:
    progress(f"Checking Search indexer: {names['indexer']}...")
    started = time.monotonic()
    status = indexer_status(http, names, settings)
    previous_start = (status.get("lastResult") or {}).get("startTime")
    ready, _ = indexer_ready(status, expected_documents)
    waiting_for_run = force or not ready
    if waiting_for_run:
        joining_run = _running(status) and not force
        if joining_run:
            progress("Search indexer is already running; waiting for that run without submitting another.")
        if force:
            code, body, _ = http.request(
                "POST", f"{settings['searchEndpoint']}/indexers('{names['indexer']}')/search.reset?api-version={SEARCH_API}",
                SEARCH_SCOPE, body={})
            if code != 204:
                raise SetupError(f"Cannot reset indexer for refresh: {_err(code, body)}")
        if not joining_run:
            progress("Starting Search-managed extraction, figure descriptions and indexing...")
            code, body, _ = http.request(
                "POST", f"{settings['searchEndpoint']}/indexers('{names['indexer']}')/search.run?api-version={SEARCH_API}",
                SEARCH_SCOPE, body={})
            if code not in (202, 409):
                raise SetupError(f"Cannot run indexer: {_err(code, body)}")
        waited = 0.0
        while True:
            last = status.get("lastResult") or {}
            progress(f"Waiting for indexer; latest reported result: {last.get('status', status.get('status', 'unknown'))}, "
                     f"{last.get('itemsProcessed', 0)}/{expected_documents} documents processed, "
                     f"{last.get('itemsFailed', 0)} failed; elapsed {time.monotonic() - started:.0f}s. "
                     f"Checking again in {interval:g}s.")
            sleep(interval)
            waited += interval
            status = indexer_status(http, names, settings)
            last = status.get("lastResult") or {}
            if not _running(status) and (joining_run or not previous_start or last.get("startTime") != previous_start):
                break
            if waited > timeout:
                raise SetupError("Timed out waiting for the indexer.")
    ready, reason = indexer_ready(status, expected_documents)
    if not ready:
        errors = [str(e.get("errorMessage", ""))[:200] for e in (status.get("lastResult") or {}).get("errors", [])[:3]]
        raise SetupError(f"Indexer not ready: {reason} {errors}")
    if waiting_for_run:
        progress(f"Search indexer complete: {(status.get('lastResult') or {}).get('itemsProcessed', 0)} "
                 f"documents processed, 0 failed ({time.monotonic() - started:.1f}s).")
    else:
        progress("Search indexer has a successful matching run; no new extraction requested "
                 f"({time.monotonic() - started:.1f}s).")
    return status


# ------------------------------------------------------------ chunks/readback

def citation_sections(doc: dict[str, Any], page: int, page_to: int) -> list[str]:
    """Verified citation headings whose page falls in the chunk's [page, pageTo] range."""
    return [h for _, h in sorted((p, h) for h, p in doc["sections"].items() if page <= p <= page_to)]


def digest_chunks(chunks: list[dict[str, Any]]) -> str:
    ordered = sorted(chunks, key=lambda c: (c["documentId"], c["page"], c["pageTo"], c["ordinal"], c["id"]))
    return sha256_hex(canonical_bytes(ordered))


def read_chunks(http: Any, names: dict[str, str], settings: dict[str, Any]) -> list[dict[str, Any]]:
    rows, last = [], None
    progress(f"Reading indexed chunks from {names['index']}...")
    url = f"{settings['searchEndpoint']}/indexes('{names['index']}')/docs/search.post.search?api-version={SEARCH_API}"
    while True:
        body = {"search": "*", "top": 1000, "orderby": "id asc", "select": ",".join(INDEX_FIELDS)}
        if last is not None:
            body["filter"] = f"id gt '{last}'"
        status, payload, _ = http.request("POST", url, SEARCH_SCOPE, body=body)
        if status != 200 or not isinstance(payload, dict):
            raise SetupError(f"Cannot read back chunks: {_err(status, payload)}")
        page = [{k: v for k, v in r.items() if not k.startswith("@")} for r in payload.get("value", [])]
        rows += page
        progress(f"Read {len(rows)} indexed chunks so far.")
        if len(page) < 1000:
            return rows
        last = str(page[-1]["id"]).replace("'", "''")


def validate_chunks(rows: list[dict[str, Any]], sources: dict[str, Any], generation: str) -> list[dict[str, Any]]:
    """Fail-closed metadata/page validation; returns chunks with derived citationSections."""
    docs = {d["documentId"]: d for d in sources["documents"]}
    if not rows:
        raise SetupError("The index has no chunks.")
    chunks, covered = [], {doc_id: set() for doc_id in docs}
    for row in rows:
        missing = [f for f in INDEX_FIELDS if row.get(f) in (None, "")]
        if missing:
            raise SetupError(f"Chunk {row.get('id')} is missing fields {missing}.")
        doc = docs.get(row["documentId"])
        if doc is None:
            raise SetupError(f"Chunk {row['id']} has unknown documentId {row['documentId']}.")
        if row["version"] != doc["version"] or row["sha256"] != doc["sha256"] or row["file"] != doc["file"]:
            raise SetupError(f"Chunk {row['id']} metadata disagrees with the manifest for {row['documentId']}.")
        if row["corpusHash"] != sources["corpusHash"] or row["indexFingerprint"] != generation:
            raise SetupError(f"Chunk {row['id']} belongs to a different corpus/generation.")
        page, page_to = row["page"], row["pageTo"]
        if (type(page) is not int or type(page_to) is not int or page < 1 or page_to < page
                or page_to > max(doc["sections"].values())):
            raise SetupError(f"Chunk {row['id']} has an invalid page range.")
        if not isinstance(row["content"], str) or not row["content"].strip():
            raise SetupError(f"Chunk {row['id']} has no content.")
        covered[row["documentId"]].update(range(page, page_to + 1))
        chunks.append({**row, "stateCodes": doc["stateCodes"], "ruleIds": doc["ruleIds"],
                       "citationSections": citation_sections(doc, page, page_to)})
    for doc_id, doc in docs.items():
        absent = sorted(set(doc["sections"].values()) - covered[doc_id])
        if absent:
            raise SetupError(f"{doc_id}: no chunk covers cited page(s) {absent}.")
    return chunks


def generation_filter(sources: dict[str, Any], generation: str, state: str | None = None) -> str:
    ids = [d["documentId"] for d in sources["documents"] if state is None or state in d["stateCodes"]]
    if not ids:
        raise SetupError(f"No source documents apply to state {state}.")
    return (f"corpusHash eq '{sources['corpusHash']}' and indexFingerprint eq '{generation}' "
            f"and search.in(documentId, '{','.join(ids)}', ',')")


def verify_generation(http: Any, sources: dict[str, Any], names, generation: str,
                      settings: dict[str, Any]) -> dict[str, Any]:
    progress("Verifying indexed source metadata, page coverage and retrieval...")
    chunks = validate_chunks(read_chunks(http, names, settings), sources, generation)
    progress(f"Validated {len(chunks)} chunks; checking state-scoped retrieval...")
    url = f"{settings['searchEndpoint']}/indexes('{names['index']}')/docs/search.post.search?api-version={SEARCH_API}"
    probes = {}
    states = sorted({s for d in sources["documents"] for s in d["stateCodes"] if s != "SHARED"})
    for number, state in enumerate(states, 1):
        progress(f"Retrieval check {number}/{len(states)}: {state}...")
        status, payload, _ = http.request("POST", url, SEARCH_SCOPE, body={
            "search": "rental rate duration evidence", "searchFields": "content", "top": 3,
            "filter": generation_filter(sources, generation, state)})
        if status != 200 or not isinstance(payload, dict) or not payload.get("value"):
            raise SetupError(f"Filtered retrieval probe for {state} returned no chunks.")
        allowed_ids = {d["documentId"] for d in sources["documents"] if state in d["stateCodes"]}
        if any(row.get("documentId") not in allowed_ids for row in payload["value"]):
            raise SetupError(f"Filtered retrieval probe for {state} returned another state's policy.")
        probes[state] = len(payload["value"])
        progress(f"Retrieval check {number}/{len(states)}: {state} passed ({probes[state]} matches).")
    return {"chunkCount": len(chunks), "chunkDigest": digest_chunks(chunks), "chunks": chunks, "probes": probes}


# ----------------------------------------------------------------- activation

def write_state(root: Path, state: dict[str, Any]) -> None:
    atomic_json(root / STATE_PATH, {"schemaVersion": 1, **state})


def save_snapshot(root: Path, sources, generation, verification, path: Path = SNAPSHOT_PATH) -> None:
    docs = [{k: d[k] for k in ("documentId", "version", "file", "sha256", "stateCodes", "ruleIds", "sections")}
            for d in sources["documents"]]
    atomic_json(root / path, {
        "schemaVersion": SCHEMA, "corpusHash": sources["corpusHash"], "indexFingerprint": generation,
        "chunkDigest": verification["chunkDigest"], "documents": docs, "chunks": verification["chunks"]})


def retain_claim_metadata(root: Path, config: dict[str, Any]) -> dict[str, Any]:
    """Keep valid local compatibility metadata on unchanged targets, without analyzer calls."""
    current = root / CONFIG_PATH
    if any(key in config for key in ("claimAnalyzerId", "claimAnalyzerHash")) or not current.is_file():
        return config
    previous = read_json(current)
    if not isinstance(previous, dict):
        raise SetupError(f"{CONFIG_PATH} must contain a JSON object.")
    runtime_keys = ("schemaVersion", "provider", "azureOpenAIEndpoint", "modelDeployment",
                    "searchEndpoint", "indexName", "corpusHash", "indexFingerprint",
                    "extractionMode", "cuEndpoint", "cuApiVersion")
    if any(previous.get(key) != config[key] for key in runtime_keys):
        return config
    patterns = {"claimAnalyzerId": r"[A-Za-z0-9_-]{1,128}", "claimAnalyzerHash": r"[a-f0-9]{64}"}
    metadata = {key: previous[key] for key in patterns if key in previous}
    if any(not isinstance(value, str) or not re.fullmatch(patterns[key], value)
           for key, value in metadata.items()):
        progress("Not retaining invalid legacy claim-summary metadata from the previous configuration.")
        return config
    return {**config, **metadata}


def activate(root: Path, sources, settings, names, generation, verification) -> dict[str, Any]:
    """Write the new snapshot/config only after verification; keep a backup of the old config."""
    current = root / CONFIG_PATH
    if current.is_file() and not (root / BACKUP_PATH).exists():
        atomic_json(root / BACKUP_PATH, read_json(current))
    save_snapshot(root, sources, generation, verification)
    config = {
        "schemaVersion": 1, "provider": "agent-framework",
        **{key: settings[key] for key in RESOURCE_TYPES},
        "azureOpenAIEndpoint": settings["azureOpenAIEndpoint"], "modelDeployment": settings["modelDeployment"],
        "cuModelName": settings["modelName"],
        "cuEndpoint": settings["cuEndpoint"], "cuApiVersion": settings["cuApiVersion"],
        **{key: settings[key] for key in ("claimAnalyzerId", "claimAnalyzerHash") if key in settings},
        "searchEndpoint": settings["searchEndpoint"], "indexName": names["index"],
        "corpusHash": sources["corpusHash"], "indexFingerprint": generation,
        "chunkDigest": verification["chunkDigest"], "extractionMode": "standard",
        "extractionLimitation": ("Search-managed Content Understanding (semantic chunks with AI figure "
                                 "descriptions). Descriptions are model-generated; ambiguous diagram evidence "
                                 "requires review of the source PDF."),
        "snapshotPath": SNAPSHOT_PATH.as_posix(), "indexedDocumentCount": len(sources["documents"]),
        "indexedChunkCount": verification["chunkCount"],
        "retrievalFields": list(INDEX_FIELDS), "derivedFields": ["stateCodes", "ruleIds", "citationSections"],
        "ingestion": {"mode": "search-managed-standard", "apiVersion": SEARCH_API, "names": names,
                      "pipeline": PIPELINE, "verifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
    }
    config = retain_claim_metadata(root, config)
    atomic_json(current, config)
    return config


def apply(http: Any, root: Path = ROOT, refresh: bool = False,
          sleep: Callable[[float], None] = time.sleep, seed: dict[str, Any] | None = None,
          create_claim_analyzer: bool = False, index_only: bool = False) -> dict[str, Any]:
    report = preflight(http, root, seed=seed, create_claim_analyzer=create_claim_analyzer, index_only=index_only)
    if not report["ready"]:
        write_state(root, {"status": "blocked", "generation": report["generation"],
                           "missingRoles": report["missingRoles"], "problems": report["problems"]})
        report["status"] = "blocked"
        return report
    sources, settings = load_sources(root), runtime_settings(root, seed)
    if not index_only and (create_claim_analyzer or (seed or {}).get("claimAnalyzerId")):
        progress("Preparing the separate claim-summary analyzer...")
        settings = (prepare_claim_analyzer(http, settings, apply_changes=True, sleep=sleep)
                    if create_claim_analyzer else resolve_analyzer(http, settings))
    else:
        settings.pop("claimAnalyzerId", None)
        settings.pop("claimAnalyzerHash", None)
    generation, names = report["generation"], report["names"]
    write_state(root, {"status": "running", "generation": generation, "names": names})
    steps = {"blobs": upload_sources(http, sources, names, generation, refresh, settings),
             "objects": ensure_objects(http, names, generation, settings)}
    run_indexer(http, names, len(sources["documents"]), refresh, settings, sleep=sleep)
    verification = verify_generation(http, sources, names, generation, settings)
    if index_only:
        progress("Saving the verified index snapshot; leaving the app configuration unchanged...")
        snapshot_path = Path(".tools") / f"policy-index-{generation[:12]}.json"
        save_snapshot(root, sources, generation, verification, snapshot_path)
    else:
        progress("Activating the verified index in the app configuration...")
        activate(root, sources, settings, names, generation, verification)
    write_state(root, {"status": "verified", "generation": generation, "names": names,
                       "chunkDigest": verification["chunkDigest"]})
    report.update(status="verified", steps=steps, chunkCount=verification["chunkCount"],
                  chunkDigest=verification["chunkDigest"], indexName=names["index"],
                  extractionMode="standard", figureDescriptions=True, runtimeActivated=not index_only)
    if index_only:
        report["snapshotPath"] = snapshot_path.as_posix()
    progress(f"Indexing verified: {names['index']} ({verification['chunkCount']} chunks).")
    return report


def add_resource_arguments(parser: argparse.ArgumentParser) -> None:
    for key in RESOURCE_TYPES:
        flag = re.sub(r"(?<!^)([A-Z])", r"-\1", key).lower()
        parser.add_argument(f"--{flag}", help=f"existing Azure resource ID; overrides {DEPLOYMENT_PATH}")


def resource_seed(args: argparse.Namespace) -> dict[str, Any]:
    return {key: getattr(args, re.sub(r"(?<!^)([A-Z])", r"_\1", key).lower(), None) for key in RESOURCE_TYPES}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--apply", action="store_true", help="create/upload/index when prerequisites are verified")
    parser.add_argument("--index-only", action="store_true",
                        help="index policy PDFs without reading/creating a claim analyzer or changing app configuration")
    parser.add_argument("--refresh", action="store_true", help="with --apply: re-run indexing, replacing drifted blobs")
    parser.add_argument("--model-deployment", help="existing Foundry model deployment (seed for a fresh clone)")
    parser.add_argument("--cu-model-name", help="CU model name when it differs from the deployment name")
    parser.add_argument("--index-model-deployment",
                        help="model deployment for the Search CU skill (defaults to --model-deployment)")
    parser.add_argument("--index-cu-model-name", help="Search CU skill model name when it differs from its deployment")
    parser.add_argument("--claim-analyzer-id", help="opt into legacy summary-analyzer validation; its hash is read, not supplied")
    parser.add_argument("--create-claim-analyzer", action="store_true",
                        help="with --apply, explicitly create the legacy claim extractor only if absent; requires an explicit or saved ID")
    parser.add_argument("--cu-api-version", help="CU API version for the analyzer lookup")
    parser.add_argument("--local-only", action="store_true", help="validate local sources only; no Azure calls")
    add_resource_arguments(parser)
    args = parser.parse_args(argv)
    if args.refresh and not args.apply:
        parser.error("--refresh requires --apply")
    if args.index_only and args.create_claim_analyzer:
        parser.error("--index-only cannot be combined with --create-claim-analyzer")
    try:
        http = Http()
        seed = {**resource_seed(args), "modelDeployment": args.model_deployment, "cuModelName": args.cu_model_name,
                        "indexModelDeployment": args.index_model_deployment, "indexCuModelName": args.index_cu_model_name,
                "claimAnalyzerId": args.claim_analyzer_id, "cuApiVersion": args.cu_api_version}
        report = (apply(http, ROOT, args.refresh, seed=seed, create_claim_analyzer=args.create_claim_analyzer,
                        index_only=args.index_only)
                  if args.apply else preflight(http, ROOT, args.local_only, seed, args.create_claim_analyzer,
                                               index_only=args.index_only))
    except SetupError as exc:
        print(f"Setup stopped: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        progress("Setup interrupted. Search may still be running; check the indexer in Azure before retrying. "
                 "No verification success is being reported.")
        return 130
    print(json.dumps(report, indent=2))
    return 0 if report.get("status") == "verified" or (not args.apply and report["ready"]) else 2


if __name__ == "__main__":
    sys.exit(main())