Content Understanding / hands-on lab

# From documents to an Insurance Workbench

Follow these five steps in order: try prebuilts, customize extraction, classify a packet, add extraction routes, and use a **separate application** to compare policy checks with and without Azure Search retrieval. This guide contains all lab instructions.

Use [CU Studio](https://contentunderstanding.ai.azure.com/) for steps 1-4. Sign in and select your approved Azure resource. You need permission to use Content Understanding, build analyzers, and use the resource's configured models. Studio tests and live app analysis incur Azure charges.

> [!Alert] **Model choice:** use the Preview workflow with **GPT-5 for classification/segmentation**, **GPT-5.5 for custom repair extraction**, and **GPT-5.2 for prebuilt extraction**. Ask the lab owner to configure those models if unavailable; do not change shared resource deployments or defaults yourself. The app uses `2026-06-01-preview` for this flow.

- [1. Prebuilt](#step-1-explore-prebuilt-analyzers)
- [2. Custom](#step-2-build-a-custom-repair-extractor)
- [3. Classifier](#step-3-classify-and-split-a-packet-without-extraction)
- [4. Classifier + routes](#step-4-add-extraction-routes-to-the-classifier)
- [5. Your app](#step-5-connect-to-your-separate-insurance-workbench-app)

===

## Step 1: Explore prebuilt analyzers

> [!Note] **Upload from `data\step1`:** [towing-invoice.pdf](../data/step1/towing-invoice.pdf) (1 page), [demo-id.pdf](../data/step1/demo-id.pdf) (1 page), and [form-1099a.pdf](../data/step1/form-1099a.pdf) (1 page). Use one file at a time as shown below.

1. [] Open the [CU Studio prebuilt-analyzer gallery](https://contentunderstanding.ai.azure.com/discover). Select the document prebuilt named in each row, choose your resource if prompted, upload the indicated PDF, and run analysis.
2. [] Inspect the document and the actual response together. Click a returned field or table value to inspect its source; compare layout-only output with domain-specific extraction.

| Prebuilt in Studio | Upload | Inspect |
|:---|:---|:---|
| Document Layout | [towing-invoice.pdf](../data/step1/towing-invoice.pdf) | Text, reading order, tables, and page structure. This is not invoice-domain extraction. |
| Invoice / `prebuilt-invoice` | [Same towing-invoice.pdf](../data/step1/towing-invoice.pdf) | Vendor, customer, charges, total, tax, and line items. A charge is not proof of payment. |
| ID document / `prebuilt-idDocument.generic` | [demo-id.pdf](../data/step1/demo-id.pdf) | Named holder and available ID-like fields. This fictional membership specimen is not a government ID. |
| US tax / `prebuilt-tax.us.1099A` | [form-1099a.pdf](../data/step1/form-1099a.pdf) | Tax year, lender, borrower, account, and form boxes. Nested year/copy results are not extra input documents. |

> [!Note] **Checkpoint:** you can explain the difference between document layout and schema-based extraction.

**Workbench:** do not launch it yet. You will explicitly launch the separate app in [step 5](#step-5-connect-to-your-separate-insurance-workbench-app).

===

## Step 2: Build a custom repair extractor

> [!Note] **Upload from `data\step2`:** [repair-estimate.pdf](../data/step2/repair-estimate.pdf) (1 page). This is the same repair estimate used on page 3 of the core packet in the next steps.

1. [] In [CU Studio Build](https://contentunderstanding.ai.azure.com/build), create a Preview **Standard Extraction** project. Start with the **Invoice template** from the [prebuilt-analyzer gallery](https://contentunderstanding.ai.azure.com/discover). In project Advanced, select **GPT-5.5**.
2. [] Keep the template fields. Add **only these three lowercase fields**, with method **Extract**, and enable source and confidence for them. Do not add separate make/model/year, plate, or odometer-unit fields.

| Field | Type / method | Copy this description |
|:---|:---|:---|
| `vehicle` | String / Extract | Printed vehicle name as one string, including year/make/model when present. Do not add color, decode the VIN, or infer missing details. |
| `vin` | String / Extract | Exact value explicitly labeled VIN. Do not correct it or substitute registration, plate, or account numbers. Leave unset if absent. |
| `odometer` | Number / Extract | Printed Odometer or Inspection Mileage as a number. Remove grouping separators; no units. Do not substitute Annual Mileage or infer an absent value. |

3. [] Upload [repair-estimate.pdf](../data/step2/repair-estimate.pdf), save, and wait until saving indicators clear. **Run analysis in Studio before building the analyzer.**
4. [] Check the values and source highlights: `vehicle = "2019 Toyota Corolla LE"`, `vin = "5YFEPMAE3KA513905"`, `odometer = 94360`. The repair proposal total is $1,310.13, distinct from the towing invoice. Missing values must not become invented values or zero.
5. [] After the test passes, **Build analyzer** with your own unique ID, for example `lab664_lee_repair`. Record the actual ID and verify the saved schema contains the three fields above. Do not overwrite another learner's analyzer.

> [!Note] **Checkpoint:** a tested custom repair analyzer is ready, and you have its analyzer ID.

**Workbench:** no app launch is needed here; [step 5](#step-5-connect-to-your-separate-insurance-workbench-app) connects the finished routed analyzer.

===

## Step 3: Classify and split a packet, without extraction

> [!Note] **Start with `data\step3`:** [classification-packet.pdf](../data/step3/classification-packet.pdf) (3 pages). Then use [packet-01.pdf](../data/step3/packet-01.pdf) (Danielle, 13 pages) and [packet-03.pdf](../data/step3/packet-03.pdf) (12 pages) for realistic logical-document boundaries.

1. [] In [CU Studio Build](https://contentunderstanding.ai.azure.com/build), create a Preview **Classification** project with **GPT-5**. Add the four category keys and descriptions below. **Do not assign child analyzer IDs yet.** The [prebuilt-analyzer gallery](https://contentunderstanding.ai.azure.com/discover) will be used for extraction routes in step 4, not this classification-only test.
2. [] Enable segmentation and choose **Auto segment content**. Leave **Allow in-page segments** off. Do not choose **Segment by page**; keep parent content. The settings are `enableSegment=true`, `allowInPageSegments=false`, `segmentPerPage=false`, `omitContent=false`.

| Category key | Copy this description |
|:---|:---|
| `id_document` | The lab's identity-like demo card with named holder, portrait and membership identifier. This synthetic membership card demonstrates ID field extraction, not government-ID authenticity. Exclude invoice, tax and repair documents. |
| `tax_1099a` | An IRS Form 1099-A Acquisition or Abandonment of Secured Property, including fictional borrower-copy examples. Exclude other tax forms and prose references. |
| `repair_estimate` | A standalone repair workshop estimate or quote with vehicle details and proposed parts/labor. Keep continuation pages of the same estimate together; split a different estimate even if adjacent. Exclude towing/rental/glass invoices and their supporting inspection supplements even when they mention a proposed repair schedule. |
| `other` | Each distinct supporting document: policy declarations/endorsements, claim intake forms, incident reports, handwritten statements, towing/rental/glass invoices with their own continuation supplements, valuation/downtime schedules, and workshop inspection records. Identify logical boundaries even when adjacent documents both have category other. Keep paginated continuation pages together; do not merge different document titles or identifiers. These documents are unrouted, not discarded. |

3. [] Upload the [three-page core](../data/step3/classification-packet.pdf). Save and **Run analysis before building**. Expect ID on page 1, 1099-A on page 2, and repair estimate on page 3. Every page should be covered once. Domain extractor fields are not expected yet.
4. [] Test [packet-01.pdf](../data/step3/packet-01.pdf), then [packet-03.pdf](../data/step3/packet-03.pdf). Inspect the category and page range of each logical document, not one segment per page. Compare to the individual source PDFs under `data\documents\packet-01` and `data\documents\packet-03`. Different adjacent Other documents must remain separate; a document's continuation pages should stay together.
5. [] For packet 01, the authored groups are: membership card p1; policy p2-4; claim p5-6; incident p7; repair p8; statement p9; rental invoice p10-11; inspection p12; 1099-A p13. At this four-class stage, the rental invoice belongs to Other. Review discrepancies rather than assuming authored grouping proves the model wrong.
6. [] After testing, build a unique `..._classifier` analyzer if you want to call this stage from the app. Keep the editable project for step 4.

> [!Note] **Checkpoint:** you have categories and logical page ranges, but no extraction routes.

**Workbench:** [step 5](#step-5-connect-to-your-separate-insurance-workbench-app) explains launching the separate app; it accepts a ready classification-only analyzer as well as a routed one.

===

## Step 4: Add extraction routes to the classifier

> [!Note] **Use the same inputs from `data\step4`:** [classification-packet.pdf](../data/step4/classification-packet.pdf), [packet-01.pdf](../data/step4/packet-01.pdf) (rental invoice), and [packet-03.pdf](../data/step4/packet-03.pdf) (towing invoice). This makes the before/after comparison about routing, not a changed source.

1. [] Reopen your step 3 project in [CU Studio Build](https://contentunderstanding.ai.azure.com/build). Keep the classifier on **GPT-5** and the same logical-segmentation settings. Link the first three categories below to the indicated analyzers. Select prebuilts from the [prebuilt-analyzer gallery](https://contentunderstanding.ai.azure.com/discover); use your actual custom repair ID.
2. [] Add `towing_invoice` and `rental_invoice`, using the descriptions below, and route both to Invoice. Update Other's description to the new version. Keep the custom repair extractor on **GPT-5.5**. The resource's `prebuilt-analyzer-completion` mapping must use **GPT-5.2**; verify with the lab owner rather than changing a shared mapping.

| Category key | Extraction route | Description change |
|:---|:---|:---|
| `id_document` | `prebuilt-idDocument.generic` | Keep the step 3 description. |
| `tax_1099a` | `prebuilt-tax.us.1099A` | Keep the step 3 description. |
| `repair_estimate` | Your `..._repair` ID | Keep the step 3 description. |
| `towing_invoice` | `prebuilt-invoice` | A towing or roadside-recovery invoice, bill or charge ledger for vehicle transport, storage or release. Keep continuation and release/custody supplements from the same bill together. Payment may be unpaid or pending; do not infer payment. Exclude repair estimates, rental billing, and glass or panel service quotes. |
| `rental_invoice` | `prebuilt-invoice` | A vehicle rental billing document or invoice with rental agreement references, dates or daily charges. Keep the same agreement's pickup/billing/vehicle-condition continuation pages together. Payment may be unpaid or pending; do not infer payment. Exclude towing bills, repair estimates, and glass or panel service quotes. |
| `other` | **No route** | Each distinct unrouted supporting document: policy declarations/endorsements, claim intake forms, incident reports, handwritten statements, glass/panel service supporting records, valuation/downtime schedules, and workshop inspection records. Towing bills and rental billing belong to their named invoice categories, not Other. Identify logical boundaries even when adjacent documents both have category other. Keep continuation pages together; do not merge different titles or identifiers. These documents are unrouted, not discarded. |

3. [] Save and **Run analysis in Studio before building**, first on the core packet and then on both full packets. Compare categories and ranges with step 3, now with child fields and source highlights. Rental and towing have moved out of Other; other logical boundaries should remain meaningful.
4. [] For the core packet, inspect ID p1, nested tax fields p2, and the three custom repair fields p3. For packet 01, inspect repair p8 and rental p10-11. Inspect the towing invoice in packet 03. Keep the proposed repair amount distinct from actual invoiced charges.
5. [] Only after review, **Build analyzer** with a new unique `..._router` ID. Do not overwrite the classification-only analyzer. Wait for status **ready** and record this exact ID and the resource endpoint for step 5.

> [!Note] **Checkpoint:** a tested, ready router links every non-Other category to extraction.

**Workbench:** now follow [step 5](#step-5-connect-to-your-separate-insurance-workbench-app) to install and explicitly launch the separate app.

===

## Step 5: Connect to your separate Insurance Workbench App

> [!Note] **App input:** all ten full PDFs in `data\packets` (120 pages total). The app loads these automatically; no manual upload is needed. The completed native results in `data\results` let you explore without submitting analysis. [CU Studio Build](https://contentunderstanding.ai.azure.com/build) remains your authoring tool; the [prebuilt-analyzer gallery](https://contentunderstanding.ai.azure.com/discover) remains in Studio.

### Install once, then launch the app yourself

Install **Python 3.10 or later** with pip and venv. Open PowerShell in the repository root (the folder containing `src`, `data`, and `infra`). Run the setup script. It installs a supported Node runtime if needed, Azure CLI if missing (using Windows App Installer/winget), the locked npm dependencies including **Deep Chat**, and the **Python Agent Framework** dependencies in `.tools\policy-venv`. An internet connection and any installer approval are required. It does **not** sign you in, create cloud resources, or launch the app.

After pulling updates, stop the app, rerun setup, and restart it. The launcher selects the local Python environment automatically. Agent Framework is installed through pip, not npm; its core and OpenAI packages have independent version numbers. For package mirrors or an explicit Python path, see [infrastructure setup](../infra/README.md#lab-machines-with-package-mirrors).

```PowerShell
powershell -ExecutionPolicy Bypass -File .\infra\setup.ps1

# YOU now launch the separate app. Keep this terminal open.
powershell -ExecutionPolicy Bypass -File .\infra\launch-workbench.ps1
```

Open [Insurance Workbench App - http://127.0.0.1:8791/](http://127.0.0.1:8791/) in another browser tab. Do not open `workbench.html` directly. Stop the app with **Ctrl+C**. This lab guide can remain open independently of the app.

### Explore the included results first - no Azure analysis

1. [] In **Cache Results**, select the included completed **10/10** run and click **Load**. The Cached badge identifies historical native CU JSON, not a fresh run or your new analyzer. Its tooltip preserves the original analyzer, API version, timestamp, and dataset fingerprint.
2. [] Start with **Classification**. Each row is one customer; each check is a returned document instance and page range. Click a check or field value to open its full source PDF at that page. Other is hidden from this grid, not removed from the response.
3. [] Switch to **ID**, **1099-A**, **Repair Estimate**, **Towing Invoice**, and **Rental Invoice**. Only returned types appear. Repair defaults show vendor, vehicle, VIN, total, tax, and line items; use **All fields** for odometer.
4. [] Turn on **Confidence** to inspect returned scores. Blank means the service omitted a score, not zero. Click line items for source boxes or their table icon for the item popup. Drag column edges or the PDF divider to resize. Double-click a field to focus at 300%; double-click again to fit. Use wheel zoom, drag-to-pan, and the bottom page controls.
5. [] Use **{ }** to download the complete native JSON for the selected customer. Compare it with the source PDF; values, geometry, and confidence come from CU, not fabricated app output.

### Compare policy checks with and without retrieval

Use the prepared lab configuration for this exercise. The lab owner must complete [policy setup](../docs/policy-setup.md) before the session; installing dependencies alone doesn't configure an index. Sign in with `az login` using your approved lab identity. Saved CU results avoid rerunning the Studio router, but policy checks still call Azure and incur charges, including missing claim-summary extraction.

1. [] With the included completed **10/10** run loaded, select **Policy checks**.
2. [] In **Policy retrieval**, select **No policy retrieval**. Select **Run policy checks** and confirm the operation for all loaded cases. Wait for completion. Inspect packet **01**'s **Daily rate**: without the SOP, it must remain **Review required**, without invented thresholds or citations.
3. [] Change the dropdown to **Azure Search retrieval**, select **Run policy checks** again, and confirm. Changing the dropdown alone doesn't submit a new run.
4. [] Compare **Daily rate** for packets **01** and **02**. Select each check to read **Expected**, **Actual** and **Reasoning** in the right-hand panel.

| Case | CU daily base | Contractual daily cap | Retrieved SOP routine authority | Expected result |
|:---|---:|---:|---:|:---|
| Packet 01 / Texas | $54 | $85 | $75, inclusive | **Satisfied**: within both limits |
| Packet 02 / Washington | $61 | $85 | $60, inclusive | **Review required**: routine authority exceeded; supervisor exception evidence missing |

5. [] For packet **01**, select the Texas **Source** link. Inspect **TX-R2** on page 2 and **Schedule A** on page 3 of `tx-rental-review-sop-v2.pdf`. The $75 value is internal routine handling authority, not the $85 contractual cap. Blank cells in the exception table don't grant extra authority.
6. [] In the source viewer, compare **Document**, **CU Layout** and **Digital parse**. Then select **Back to policy checks**. Optionally inspect Washington's scanned SOP or Arizona's image-based eligibility flowchart. A missing extraction has an explicit billable generation action; switching tabs alone doesn't call CU.
7. [] Optionally select **Chat** and ask, "Explain this case's daily-rate result. Cite the SOP and distinguish routine authority from the contractual cap." Chat uses the selected case and mode; each submitted question can incur Azure charges.

The same agent and claim facts are used in both modes; retrieval supplies the otherwise missing rules. These are source-based expectations, not guaranteed model answers. Inspect differing results, missing facts or errors rather than forcing a pass. **Satisfied** for daily rate doesn't approve the claim or authorize payment; other checks can still require review.

### Optional: inspect Search, policy files and the agent

| Inspect | Where to look | What to learn |
|:---|:---|:---|
| Active Search index | Note the index below **Policy retrieval**. In the [Azure portal](https://portal.azure.com/), open the Search resource matching `searchEndpoint` in `.tools\policy-agent-framework.json`, then **Indexes** > the active index > **Search explorer**. Search `rental daily rate`. | Chunks carry policy text, document identity, version and page information. The agent filters to the loss state and verified source generation. |
| Original policy files | Open the [v2 corpus](../data/policies/rental/ocr-comparison-v2/), especially the [Texas SOP](../data/policies/rental/ocr-comparison-v2/tx-rental-review-sop-v2.pdf) and [manifest](../data/policies/rental/ocr-comparison-v2/manifest.json). | CU must preserve table structure, blank cells, scanned text and figures so rules can be retrieved and cited. |
| Blob ingestion, if deployed | In Search, inspect the matching **Data source**, **Indexer** and **Skillset**. Follow the actual container to the storage account's **Storage browser**. | Managed ingestion reads policy PDFs from Blob Storage, runs the CU skill and indexes chunks. The Layout index alone doesn't prove this pipeline exists. |
| Agent Framework | Open [`infra/policy-framework-agent.py`](../infra/policy-framework-agent.py). Find `Agent`, `OpenAIChatClient` and `search_policy_rules`. | The workbench invokes a Python agent; the Search tool is attached only in retrieval mode. |

For shared-resource names and subscriptions, see [under the hood](../docs/policy-checks.md#optional-look-under-the-hood). Don't change roles, networking or shared resources during this exercise.

This teaches search-backed grounding related to **Foundry IQ**, but this PR queries an ordinary Azure AI Search index directly, not a Foundry IQ knowledge base. Read the actual extraction label: the currently configured shared index uses **CU Layout**. The optional [managed CU pipeline](../docs/policy-setup.md) provides semantic extraction only after successful setup. **CU Layout** and **Digital parse** document tabs are separate cached representations, not proof that Search-managed Standard extraction is active.

### Connect your own built analyzer and run live

Stop the app first. Sign in with Azure CLI; browser Studio sign-in does not authenticate this Node app. Choose the subscription containing **your approved CU resource**. Use its resource-root endpoint, not a Studio or Foundry project URL. Your identity needs permission to list and invoke its analyzers.

```PowerShell
az login
az account set --subscription "YOUR-SUBSCRIPTION-ID"

powershell -ExecutionPolicy Bypass -File .\infra\launch-workbench.ps1 `
  -Endpoint "https://YOUR-APPROVED-RESOURCE.services.ai.azure.com"
```

1. [] Reopen or reload [Insurance Workbench App](http://127.0.0.1:8791/). In **Analyzer**, select the exact `..._router` ID you built in step 4. The list contains ready custom logical classifiers/routers, not standalone prebuilts. If missing, check the endpoint, permissions, API version, and that the analyzer was built successfully.
2. [] Click **Run live**. Read the confirmation for ten packets / 120 pages; only confirm when you intend to incur Azure charges. The app verifies the existing analyzer and linked extractors; it does not deploy models or create analyzers.
3. [] Watch progress and elapsed time. Each native response is saved under `data\results\RUN-ID` before results are derived. Completed results become a new cache entry. A failed run remains visibly failed; inspect its error before explicitly starting another billable run.
4. [] Compare your live extraction with the PDFs and the saved run. To see classification alone, select your step 3 `..._classifier` and explicitly start a separate billable run. Fields appear only when extraction routes actually returned them.

> [!Note] **Checkpoint:** you connected CU results to a separate application, compared policy checks with and without retrieval, and traced a daily-rate result to its SOP.

> [+Note] **Where the files are**
>
> `instructions\lab.md` is the Markdown version of this single guide; `instructions\lab.html` is the original HTML version. `infra\setup.ps1` installs dependencies; `infra\launch-workbench.ps1` launches only the app. `src\workbench` contains the minimal app runtime, not another lab guide.
>
> `data\packets`: 10 complete customer PDFs. `data\documents\packet-01` through `packet-10`: 90 individual logical-document PDFs, extracted from the authored page groups. `data\samples`: five small Studio specimens. `data\packets.json`: source hashes and authored page ranges. `data\results`: one included completed run with its original manifest and ten native JSON responses; future live runs save here too.
>
> `data\step1` through `data\step4` are convenience copies of the recommended inputs, not a second dataset. The app uses the canonical PDFs under `data`. Full packet 01 contains rental billing; full packet 03 contains towing. The authored four-class reference labels both as Other, while the six-class routed run gives them separate invoice categories.

---

All people and documents are synthetic. This lab demonstrates document processing, not government-ID validation, tax advice, coverage determination, liability, payment approval, or an insurance claim decision. A person must review the actual source.
