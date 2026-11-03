"""Provision a verified CU Layout index on the existing Search service.

Without --apply, validate sources and read the optional source index/analyzer.
With --apply, reuse verified unchanged chunks or extract the registered PDFs,
and activate a separate verified generation. No source index is modified.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location("policy_setup", Path(__file__).with_name("setup-policy-index.py"))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)

FIELDS = ("id", "content", "stateCodes", "documentId", "version", "file",
          "section", "page", "ruleIds", "sha256", "corpusHash", "indexFingerprint")
API = setup.SEARCH_API


def request_error(method, url, status, value, headers):
    target = urlsplit(url)
    service = "Azure AI Search" if target.hostname and target.hostname.endswith(".search.windows.net") else "Content Understanding"
    correlation = next((str(v) for k, v in headers.items()
                        if k.lower() in ("x-ms-request-id", "apim-request-id", "request-id")), None)
    message = f"{service} {method} {target.scheme}://{target.netloc}{target.path}: {setup._err(status, value)}"
    if correlation:
        message += f" (request ID: {correlation})"
    if status == 403:
        message += (" Check the signed-in identity's Search data-plane permissions "
                    "(index management, document upload/query) and the service network rules."
                    if service == "Azure AI Search" else
                    " Check the signed-in identity's CU analyze permissions and the resource network rules.")
    return message


def request(http, method, url, scope=setup.SEARCH_SCOPE, body=None, raw=None, headers=None,
            allowed=(200,)):
    status, value, response_headers = http.request(method, url, scope, body=body, raw=raw, headers=headers)
    if status not in allowed:
        raise setup.SetupError(request_error(method, url, status, value, response_headers))
    return value, response_headers


def index_url(name, settings):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,126}", name):
        raise setup.SetupError("Invalid Search index name.")
    return f"{settings['searchEndpoint']}/indexes/{name}"


def read_rows(http, name, settings):
    rows = []
    while True:
        value, _ = request(http, "POST", f"{index_url(name, settings)}/docs/search?api-version={API}",
                           body={"search": "*", "top": 1000, "skip": len(rows)})
        page = [{k: v for k, v in row.items() if not k.startswith("@")} for row in value["value"]]
        rows.extend(page)
        if len(page) < 1000:
            return rows


def verify_rows(rows, sources, generation=None, require_all=True):
    docs = {d["documentId"]: d for d in sources["documents"]}
    covered = {key: set() for key in docs}
    for row in rows:
        doc = docs.get(row.get("documentId"))
        if doc is None or set(row) != set(FIELDS):
            raise setup.SetupError("Unexpected Layout source identity or fields.")
        for field in ("file", "version", "sha256", "ruleIds"):
            if row[field] != doc[field]:
                raise setup.SetupError(f"{doc['documentId']}: inconsistent {field}.")
        if set(row["stateCodes"]) != set(doc["stateCodes"]):
            raise setup.SetupError(f"{doc['documentId']}: inconsistent stateCodes.")
        if (not isinstance(row["content"], str) or not row["content"].strip()
                or not isinstance(row["id"], str) or not row["id"]
                or type(row["page"]) is not int
                or row["section"] not in doc["sections"]
                or doc["sections"][row["section"]] != row["page"]):
            raise setup.SetupError(f"{doc['documentId']}: invalid content, section or page.")
        for field in ("corpusHash", "indexFingerprint"):
            if not re.fullmatch(r"[a-f0-9]{64}", str(row[field])):
                raise setup.SetupError(f"Invalid Layout {field}.")
        if generation and (row["corpusHash"] != sources["corpusHash"]
                           or row["indexFingerprint"] != generation):
            raise setup.SetupError("Layout generation mismatch.")
        covered[doc["documentId"]].add(row["page"])
    if len({r["id"] for r in rows}) != len(rows):
        raise setup.SetupError("Duplicate Layout chunk keys.")
    if len({(r["corpusHash"], r["indexFingerprint"]) for r in rows}) != 1:
        raise setup.SetupError("Layout source mixes generations.")
    for doc in sources["documents"]:
        pages = covered[doc["documentId"]]
        if (require_all or pages) and not set(doc["sections"].values()) <= pages:
            raise setup.SetupError(f"{doc['documentId']}: incomplete source pages.")


def layout(http, doc, settings, root):
    identity = {"sha256": doc["sha256"], "endpoint": settings["cuEndpoint"],
                "apiVersion": settings["cuApiVersion"], "analyzer": "prebuilt-layout"}
    cache = root / ".tools" / "policy-layout-cache" / f"{setup.digest(identity)}.json"
    if cache.exists():
        saved = setup.read_json(cache)
        if saved["identity"] != identity:
            raise setup.SetupError("Layout extraction cache identity mismatch.")
        value = saved["response"]
    else:
        base = settings["cuEndpoint"].rstrip("/")
        url = (f"{base}/contentunderstanding/analyzers/prebuilt-layout:analyzeBinary"
               f"?api-version={settings['cuApiVersion']}")
        value, headers = request(http, "POST", url, setup.CU_SCOPE,
                                 raw=Path(doc["path"]).read_bytes(),
                                 headers={"Content-Type": "application/octet-stream"}, allowed=(200, 202))
        location = next((v for k, v in headers.items() if k.lower() == "operation-location"), None)
        if location:
            if not location.startswith(base + "/"):
                raise setup.SetupError("CU returned an unexpected operation URL.")
            deadline = time.monotonic() + 600
            while time.monotonic() < deadline:
                time.sleep(2)
                value, _ = request(http, "GET", location, setup.CU_SCOPE)
                status = str(value.get("status", "")).lower()
                if status == "succeeded":
                    break
                if status not in ("running", "notstarted"):
                    raise setup.SetupError(f"CU Layout failed: {value.get('error')}")
            else:
                raise setup.SetupError("CU Layout timed out.")
        if str(value.get("status", "")).lower() != "succeeded":
            raise setup.SetupError("CU Layout did not succeed.")
        setup.atomic_json(cache, {"identity": identity, "response": value})
    if str(value.get("status", "")).lower() != "succeeded":
        raise setup.SetupError("Cached Layout operation did not succeed.")
    pages = {}
    for content in value["result"]["contents"]:
        markdown = content.get("markdown", "")
        actual_pages = content.get("pages", [])
        parts = markdown.split("<!-- PageBreak -->")
        if len(parts) != len(actual_pages):
            raise setup.SetupError("CU Layout page boundaries are ambiguous; no citations were guessed.")
        for page, text in zip(actual_pages, parts):
            number = page["pageNumber"]
            if number in pages or not text.strip():
                raise setup.SetupError("CU Layout has duplicate or empty pages.")
            pages[number] = text.strip()
    return [{
        "id": setup.digest([doc["documentId"], section, page]), "content": pages[page],
        "stateCodes": doc["stateCodes"], "documentId": doc["documentId"],
        "version": doc["version"], "file": doc["file"], "section": section,
        "page": page, "ruleIds": doc["ruleIds"], "sha256": doc["sha256"],
    } for page in sorted(set(doc["sections"].values()))
        for section in [next(k for k, v in doc["sections"].items() if v == page)]]


def layout_fields():
    return [
        {"name": name, "type": ("Edm.Int32" if name == "page" else
                               "Collection(Edm.String)" if name in ("stateCodes", "ruleIds") else
                               "Edm.String"),
         **({"key": True, "filterable": True} if name == "id" else
            {"searchable": True} if name == "content" else {"filterable": True})}
        for name in FIELDS
    ]


def run(args, http=None, root=None):
    http, root = http or setup.Http(), root or setup.ROOT
    sources = setup.load_sources(root)
    settings = setup.runtime_settings(root, {
        **setup.resource_seed(args),
        "modelDeployment": args.model_deployment, "cuModelName": args.cu_model_name,
        "claimAnalyzerId": args.claim_analyzer_id,
        "cuApiVersion": args.cu_api_version,
    })
    deployment = root / setup.DEPLOYMENT_PATH
    saved = setup.read_json(deployment) if deployment.exists() else {}
    if saved.get("searchResourceId") != settings["searchResourceId"]:
        saved = {}
    source_index = args.source_index or saved.get("layoutSourceIndex")
    target_index = args.index_name or saved.get("layoutIndexName")
    for name in (source_index, target_index):
        if name:
            index_url(name, settings)
    if source_index and source_index == target_index:
        raise setup.SetupError("The source index cannot be overwritten.")
    if args.create_claim_analyzer:
        analyzer = setup.prepare_claim_analyzer(http, settings, apply_changes=args.apply)
        if args.apply or analyzer.get("status") != "planned":
            settings = analyzer
    else:
        settings = setup.resolve_analyzer(http, settings)
    definition, rows = {"fields": layout_fields()}, []
    if source_index:
        definition, _ = request(http, "GET", f"{index_url(source_index, settings)}?api-version={API}")
        if {f["name"] for f in definition["fields"]} != set(FIELDS):
            raise setup.SetupError("The source index is not a supported CU Layout index.")
        rows = read_rows(http, source_index, settings)
        verify_rows(rows, sources, require_all=False)
    present = {r["documentId"] for r in rows}
    missing = [d for d in sources["documents"] if d["documentId"] not in present]
    if source_index and any(d.get("documentType") != "policy_contract" for d in missing):
        raise setup.SetupError("Source index is missing existing SOP evidence; refusing partial migration.")
    report = {"sourceIndex": source_index, "targetIndex": target_index, "extractionMode": "layout",
              "reusedChunks": len(rows), "newDocuments": [d["file"] for d in missing],
              "ready": True, "status": "preflight"}
    if not args.apply:
        return report
    for doc in missing:
        rows.extend(layout(http, doc, settings, root))
    generation = setup.digest({"pipeline": "verified-layout-extension-v1",
                               "searchEndpoint": settings["searchEndpoint"],
                               "corpusHash": sources["corpusHash"],
                               "chunks": [{k: v for k, v in r.items()
                                           if k not in ("corpusHash", "indexFingerprint")} for r in
                                          sorted(rows, key=lambda r: r["id"])]})
    name = target_index or f"lab664-rental-v2-layout-{generation[:12]}"
    if name == source_index:
        raise setup.SetupError("The source index cannot be overwritten.")
    for row in rows:
        row.update(corpusHash=sources["corpusHash"], indexFingerprint=generation)
    verify_rows(rows, sources, generation)
    target = {"name": name, "description": f"LAB664 verified CU Layout extension; generation={generation}",
              "fields": definition["fields"]}
    target_url = f"{index_url(name, settings)}?api-version={API}"
    status, actual, response_headers = http.request("GET", target_url, setup.SEARCH_SCOPE)
    if status == 200:
        setup.assert_owned("index", target, actual)
        existing = read_rows(http, name, settings)
        expected = {row["id"]: row for row in rows}
        if any(row != expected.get(row.get("id")) for row in existing):
            raise setup.ConflictError("Existing Layout chunks differ; choose a new index name.")
        present_ids = {row["id"] for row in existing}
    elif status == 404:
        request(http, "PUT", f"{index_url(name, settings)}?api-version={API}", body=target,
                headers={"If-None-Match": "*"}, allowed=(200, 201))
        present_ids = set()
    else:
        raise setup.SetupError(request_error("GET", target_url, status, actual, response_headers))
    pending = [row for row in rows if row["id"] not in present_ids]
    for offset in range(0, len(pending), 100):
        value, _ = request(http, "POST", f"{index_url(name, settings)}/docs/index?api-version={API}",
                           body={"value": [{"@search.action": "upload", **r} for r in pending[offset:offset + 100]]})
        if len(value["value"]) != len(pending[offset:offset + 100]) or any(not r["status"] for r in value["value"]):
            raise setup.SetupError(f"Search rejected Layout chunks: {value}")
    for _ in range(30):
        actual = read_rows(http, name, settings)
        if len(actual) == len(rows):
            break
        time.sleep(2)
    verify_rows(actual, sources, generation)
    if setup.digest(sorted(actual, key=lambda r: r["id"])) != setup.digest(sorted(rows, key=lambda r: r["id"])):
        raise setup.SetupError("Indexed Layout content differs from verified extraction.")
    for doc in sources["documents"]:
        value, _ = request(http, "POST", f"{index_url(name, settings)}/docs/search?api-version={API}",
                           body={"search": "*", "filter": f"documentId eq '{doc['documentId']}'", "top": 1})
        if not value.get("value"):
            raise setup.SetupError(f"No retrievable chunks for {doc['documentId']}.")
    config_path = root / setup.CONFIG_PATH
    if config_path.exists():
        setup.atomic_json(root / setup.BACKUP_PATH, setup.read_json(config_path))
    setup.atomic_json(root / ".tools" / "policy-agent-framework-layout-index.json",
                      {"documents": sources["documents"], "chunks": actual, "indexFingerprint": generation})
    config = {
        "schemaVersion": 1, "provider": "agent-framework",
        **{key: settings[key] for key in setup.RESOURCE_TYPES},
        "azureOpenAIEndpoint": settings["azureOpenAIEndpoint"],
        "modelDeployment": settings["modelDeployment"],
        "cuModelName": settings["modelName"],
        "searchEndpoint": settings["searchEndpoint"], "indexName": name,
        "corpusHash": sources["corpusHash"], "indexFingerprint": generation, "extractionMode": "layout",
        "cuEndpoint": settings["cuEndpoint"], "cuApiVersion": settings["cuApiVersion"],
        "claimAnalyzerId": settings["claimAnalyzerId"], "claimAnalyzerHash": settings["claimAnalyzerHash"],
    }
    if args.source_index or args.index_name:
        saved.update({key: settings[key] for key in setup.RESOURCE_TYPES})
        saved.update(modelDeployment=settings["modelDeployment"], cuModelName=settings["modelName"],
                     claimAnalyzerId=settings["claimAnalyzerId"], cuApiVersion=settings["cuApiVersion"])
        if args.source_index:
            saved["layoutSourceIndex"] = args.source_index
        if args.index_name:
            saved["layoutIndexName"] = args.index_name
        setup.atomic_json(deployment, saved)
    setup.atomic_json(config_path, config)
    return {**report, "status": "verified", "indexName": name, "chunks": len(actual),
            "documents": len(sources["documents"])}


def parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-index", help="optional verified CU Layout index to read, never modify")
    parser.add_argument("--index-name", help="isolated target name; reruns verify and reuse matching chunks")
    parser.add_argument("--model-deployment")
    parser.add_argument("--cu-model-name", help="CU model name when it differs from its deployment name")
    parser.add_argument("--claim-analyzer-id")
    parser.add_argument("--cu-api-version")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--create-claim-analyzer", action="store_true",
                        help="explicitly create the claim extractor if absent; never overwrite")
    setup.add_resource_arguments(parser)
    return parser


def main():
    try:
        print(json.dumps(run(parser().parse_args()), indent=2))
    except (setup.SetupError, KeyError, ValueError) as error:
        print(f"Layout setup stopped: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
