@lab.Title

## Welcome to Your Lab Environment

To begin, log into the virtual machine using the following credentials: +++@lab.VirtualMachine(Win11-Pro-Base).Password+++

**Note:** Text formatted as an +++example+++ represents type text. Clicking on this text will automatically insert it to prevent any typing errors.

# From documents to an Insurance Workbench

Imagine you are helping an insurance claims team review vehicle incident packets containing repair estimates, claimant statements, and towing and rental invoices. Manually piecing together these documents makes it difficult to spot inconsistencies and check the relevant policy information. Your goal is to bring the key facts and their source evidence into one workbench so reviewers can investigate each case more efficiently.

In this lab you will use Azure AI Content Understanding to turn synthetic insurance documents into structured, source-linked results. You will build and test analyzers in CU Studio, then connect your finished analyzer to a **separate Insurance Workbench application**. Along the way, you will:

- **Explore prebuilt analyzers:** compare document layout with pre-built extraction models, and inspect how returned values relate to the source documents.
- **Customize extraction:** extend an invoice template to extract vehicle, VIN, and odometer details from a repair estimate, then build a Statement analyzer that combines extracted facts with grounded summaries.
- **Classify and split document packets:** identify document types and logical page ranges in mixed insurance packets, keeping continuation pages together without extracting fields yet.
- **Add extraction routes:** connect document categories to prebuilt analyzers and your custom repair and Statement analyzers, including dedicated routes for towing and rental invoices. Review the returned fields and source highlights.
- **Review results in the Insurance Workbench:** explore saved results, review **Business rules validation** findings, inspect grounded policy comparisons, then connect your own built analyzer to run live analysis across ten customer packets.

===

## Step 1: Explore prebuilt analyzers

To get started, let's explore the prebuilt analyzers in CU (Content Understanding) Studio by uploading and analyzing a few sample documents.
This will help you understand the distinction between layout extraction and schema-based extraction before you move on to customizing your own analyzers.

Open the browser to navigate to CU the Studio Gallery (`https://contentunderstanding.ai.azure.com/discover`).
Click **Sign in** on the top right corner of the page and log in with the provided credentials for Azure:
- Username: +++@lab.CloudPortalCredential(User1).Username+++
- If prompted for a Temporary Access Pass (TAP): +++@lab.CloudPortalCredential(User1).AccessToken+++
- If prompted for a Password: +++@lab.CloudPortalCredential(User1).Password+++

Once done, follow the steps below to explore the prebuilt analyzers:
1. Click on **Layout** to test the document layout extraction. When prompted to confirm the details of the subscription, resource group and resource name, confirm default selections and proceed. Click **Next**->**Save**.
2. You'll get a list of samples for different content types (checklist, financial report, formulas, etc). Select a sample to see the original document scan and how the prebuilt analyzer extracts information from it.
!IMAGE[chshn4cn.png](instructions359897/chshn4cn.png)
4. Next click on **Browse for files** to upload your own document for analysis. In the File Explorer window that opens, navigate to `C:\Users\LabUser\Desktop\ignite26-LAB664\data\step1` and select **towing-invoice.pdf**. Notice how both the content and the format (tables, lists, headers) are extracted and displayed on the right side panel.
!IMAGE[xfe4ei8u.png](instructions359897/xfe4ei8u.png)

Now come back to the previous page - by clicking on the arrow on the top left corner of the page - and let's examine the differences between the prebuilt layout extraction and the schema-based extraction for the same document. 
1. Scroll down on the **Procurement** section to locate the **Invoice** prebuilt analyzer and click on it to open the details.
2. Inspect the default sample to understand how the schema-based extraction identifies and extracts specific fields relevant to the document type, such as **AmontDue**, **BalanceForward** and **Billing Address**. Note that each field is also mapped to the corresponding confidence score.
3. Now upload the same **towing-invoice.pdf** document to see how the schema-based extraction applies to your own file. Compare the extracted fields and confidence scores with the layout extraction results you've got in the previous step to understand the differences.

Feel free to experiment with further pre-built analyzers to understand how CU Studio handles different document types and extraction scenarios. Below you can find a few examples of prebuilt analyzers along with the sample documents provided in the data folder, and the fields they extract.

| Prebuilt in Studio | Upload | Inspect |
| :--- | :--- | :--- |
| Identity / Generic ID document | demo-id.pdf | Named holder and available ID-like fields. This fictional membership specimen is not a government ID. |
| US tax / 1099A | form-1099a.pdf | Tax year, lender, borrower, account, and form boxes. Nested year/copy results are not extra input documents. |

> [!Note] **Checkpoint:** you can explain the difference between document layout and schema-based extraction.

===

## Step 2: Build a custom repair extractor

In the following step, we will build a custom repair extractor to handle repair estimate documents specifically. This involves creating a new extraction project, defining the necessary fields, and testing the extraction on a sample repair estimate PDF.

For this step, use the **gpt-5.5** model instance pre-provisioned and mapped by the lab template. 

1. Move from the **Discover** to the **Build** tab, by selecting it on the top right corner of the blue top navigation bar.
2. Click on **Create** to start building your custom repair extractor.
3. Name the project as `custom-repair-extractor`.
4. Select `2026-06-01 (Preview)` as the API version and `Standard Extraction` as the workflow type.
!IMAGE[kke6gm3z.png](instructions359897/kke6gm3z.png)
6. Expand the **Advanced settings** section and select **gpt-5.5** as model.
7. Leave the other parameters as default and confirm by selecting **Create**.
!IMAGE[qm5a1m18.png](instructions359897/qm5a1m18.png)
7. Once your project is created, select **Browse for Files** and upload `C:\Users\LabUser\Desktop\ignite26-LAB664\data\step2\repair-estimate.pdf`.
8. In the **Choose a template window**, select the **Invoice** one. Click on **Save** to proceed.
9. Add **these three lowercase fields**, with method **Extract**, one by one. For each field, enter the field's **Name** and **Description** from the table below. Complete both cells before selecting **Add field** again, and repeat for all three rows.

| Field | Type / method | Copy this description |
| :--- | :--- | :--- |
| `vehicle` | String / Extract | `Printed vehicle name as one string, including year/make/model when present. Do not add color, decode the VIN, or infer missing details.` |
| `vin` | String / Extract | `Exact value explicitly labeled VIN. Do not correct it or substitute registration, plate, or account numbers. Leave unset if absent.` |
| `odometer` | Number / Extract | `Printed Odometer or Inspection Mileage as a number. Remove grouping separators; no units. Do not substitute Annual Mileage or infer an absent value.` |
10. Click on **Save** to confirm the added fields.
!IMAGE[y1l65rn4.png](instructions359897/y1l65rn4.png)
11. **Run analysis**.
!IMAGE[ctdjrztc.png](instructions359897/ctdjrztc.png)
12. In the analysis results, verify the saved schema contains the three fields above: `vehicle = "2019 Toyota Corolla LE"`, `vin = "5YFEPMAE3KA513905"`, `odometer = 94360`. The repair proposal total is $1,310.13. 
13. After the test passes, click on **Build analyzer** and name it `repair_extractor_analyzer`. Add as description `Extractor for repair estimates based on uploaded documents`.Select **Build** to complete the process.
!IMAGE[eli9ysmu.png](instructions359897/eli9ysmu.png)
14. Once you are prompted with 'Built successfully', your analyzer is ready for use. Click on **Jump to analyzer list** to verify the analyzer details. You'll find your newly created analyzer in the **Analyzer list**.
!IMAGE[22c2gk9p.png](instructions359897/22c2gk9p.png)

### Add a custom Statement extractor

Now let's work with a different kind of document: a claimant's account of an incident. Unlike an invoice, a statement may describe the same damage in several places or leave important details unstated. You will use **Extract** for facts explicitly present in the document and **Generate** for a concise, grounded synthesis of the narrative.

Instead of entering each field manually, you will import a prepared schema and inspect how its field descriptions constrain the result.

1. Return to the **Build** tab -> **Project list** and create a second **Standard Extraction** project using the '2026-06-01 (Preview)' API version. Name it `custom-statement-extractor`.
2. In **Advanced settings**, select **gpt-5.5**, then select **Create**.
3. Click on **Browse for Files**. Within the File Explorer window, navigate to `C:\Users\LabUser\Desktop\ignite26-LAB664\data\documents\packet-01` and upload `06-handwriting.pdf`.
4. In the pop-up that appears after the document upload, keep **Document Analysis** as selected template, disable **AI-Powered field suggestions**, then select **Save**.
!IMAGE[szpjguew.png](instructions359897/szpjguew.png)
5. In the field-schema toolbar, choose **Import**, navigate to `C:\Users\LabUser\Desktop\ignite26-LAB664\data\step2`, and select `statement-schema.json`. Confirm schema replacement if prompted, then **Save**. This imports the fields and descriptions; no field-by-field typing is needed.
!IMAGE[03cudcq2.png](instructions359897/03cudcq2.png)

You should have **seven flat fields: five Extract and two Generate**, with **Source & Confidence** enabled. *Do not add these fields again*.

| Field | Type / method | What to check |
| :--- | :--- | :--- |
| `claimant_name` | String / Extract | Identifies the claimant or insured vehicle owner, not a witness, other driver, adjuster, or recipient. |
| `incident_date` | Date / Extract | Uses the incident date, not the date the statement or email was written or sent. |
| `incident_location` | String / Extract | Contains only an explicitly reported incident location. |
| `vehicle` | String / Extract | Describes the claimant's vehicle as one string, without color, the other vehicle, or inferred details. |
| `vin` | String / Extract | Preserves the exact stated VIN without decoding, correcting, or inferring it. |
| `reported_damage` | String / Generate | Combines claimant-reported damage into a concise description, without presenting it as inspected or verified. |
| `summary` | String / Generate | Summarizes the narrative while preserving uncertainty, without inferring fault, coverage, liability, or payment. |

6. Wait until saving indicators clear, then select **Run analysis** to test the uploaded handwritten statement. Inspect the returned facts alongside the source document.
   - In the statement, check `claimant_name = "Danielle Ortiz"` and `incident_date = 2026-02-12`. The incident date should not be replaced by the letter's sent date.
   - The five *Extract* fields contain stated facts; the two *Generate* fields provide readable, grounded synthesis rather than verbatim quotes.
   - Inspect source highlights and confidence where returned. 
   - If a fact is not stated in the document, check that the analyzer leaves the corresponding field empty rather than guessing a value.

> [!Tip] 
> Make sure to disable the **Hide missing fields** toggle to view all fields, including those that are not populated in the current document.
>
> !IMAGE[33b9kcoj.png](instructions359897/33b9kcoj.png)

Next, test the same schema against a typed email:

1. Select **Browse for Files** and upload `C:\Users\LabUser\Desktop\ignite26-LAB664\data\samples\email-statement.pdf`. Save the project, wait for saving to finish, then select **Run analysis**.
2. Perform the same checks as in the handwritten statement. 
3. After reviewing both documents, select **Build analyzer** and enter a new unique ID, for example `statement_extractor_analyzer`. Add as a description `Custom analyzer for extracting facts from handwritten and typed statements.` In the **Analyzer list**, you should now see two custom analyzers, as in the screenshot below.
!IMAGE[516v1pe7.png](instructions359897/516v1pe7.png)

> [!Note] **Checkpoint:** your custom repair and statement analyzers have both been tested and built, and you have recorded both analyzer IDs.

===

## Step 3: Classify and split a packet, without extraction

So far, you have analyzed one document at a time. An insurance submission usually contains several documents, often with different formats and multiple pages. In this step, you will create a classifier that identifies document types and splits a packet into logical documents before extracting any fields.

You will start with a small three-page packet, then test the same configuration against two larger packets. This will help you see the difference between a page boundary and a document boundary.

### Create the classification project

1. Return to **Build**->**Project List** in CU Studio and create a new **Classification** project, named `packet_classifier`. Make sure to configure the API version to *Preview* first.
!IMAGE[9maoqxjx.png](instructions359897/9maoqxjx.png)
2. In **Advanced settings**, select **gpt-5.5** as **Model for Analysis** and create the project.
3. In the new project, select **Browse for files**. Navigate to `C:\Users\LabUser\Desktop\ignite26-LAB664\data\step3` and upload `classification-packet.pdf`.
 
> [!Note] **Upload first:** the routing-rule editor becomes available after a file is uploaded.

4. In **Routing rules**, add the four category keys and descriptions in the table below, one by one. For each category, enter the category's **Name** and **Description** from the table. Keep the keys exactly as shown. Complete both cells before selecting **Add category** again, and repeat for all four rows.
!IMAGE[7qhnpb5o.png](instructions359897/7qhnpb5o.png)

> [!Note] **Do not assign child analyzer IDs yet**; you will add extraction routes in step 4.

| Category key | Copy this description |
| :--- | :--- |
| `id_document` | `The lab's identity-like demo card with named holder, portrait and membership identifier. This synthetic membership card demonstrates ID field extraction, not government-ID authenticity. Exclude invoice, tax and repair documents.` |
| `tax_1099a` | `An IRS Form 1099-A Acquisition or Abandonment of Secured Property, including fictional borrower-copy examples. Exclude other tax forms and prose references.` |
| `repair_estimate` | `A standalone repair workshop estimate or quote with vehicle details and proposed parts/labor. Keep continuation pages of the same estimate together; split a different estimate even if adjacent. Exclude towing/rental/glass invoices and their supporting inspection supplements even when they mention a proposed repair schedule.` |
| `other` | `Each distinct supporting document: policy declarations/endorsements, claim intake forms, incident reports, handwritten statements, towing/rental/glass invoices with their own continuation supplements, valuation/downtime schedules, and workshop inspection records. Identify logical boundaries even when adjacent documents both have category other. Keep paginated continuation pages together; do not merge different document titles or identifiers. These documents are unrouted, not discarded.` |

Next, configure how the classifier separates documents:

1. In **Routing rules**, turn on **Enable segment**, then open the settings panel, by clicking on the gear icon. Select **Auto segment content**, leave **Allow in-page segments** off, and do not select **Segment by page**. Close the dialog and leave other settings unchanged.
!IMAGE[9zacnykv.png](instructions359897/9zacnykv.png)

> [!Note] With the configured settings, a two-page rental invoice should remain one logical document. Two adjacent documents should still be separate, even when both belong to `other`.

2. Select **Save** and wait until saving indicators clear before changing tabs. Select **Run analysis** and remain in the project until it finishes. Inspect the results to ensure documents are segmented correctly.
3. Inspect details in **Test** tab. The **Segment** selector initially shows the retained parent, `input1`. Open it and select each `input1/segment...` entry to see its category and page range. Expect `id_document` on page 1, `tax_1099a` on page 2, and `repair_estimate` on page 3. Every page should be covered once. Classification-only child segments have **Result**, not domain extractor fields.
!IMAGE[s51l89mw.png](instructions359897/s51l89mw.png)
4. To keep a before/after comparison, select the parent `input1`, then **Result** and **Download** to save the JSON. 
!IMAGE[n0m86b6w.png](instructions359897/n0m86b6w.png)

> [!Tip] Download results before leaving the project or adding routes; reopening a saved project does not restore the displayed analysis results.

### Test the full customer packet

In the previous step, you tested a small packet to ensure the classifier correctly segments individual documents. Now, you will test the full customer packet to verify the classifier's behavior on larger, multi-document files.

1. Within the same project, select again **Browse for Files** and upload `C:\Users\LabUser\Desktop\ignite26-LAB664\data\step3\packet-01.pdf`. 
2. Click on **Run analysis**. After it finishes, inspect each segment's category and page range. Compare the returned boundaries with the individual PDFs under `C:\Users\LabUser\Desktop\ignite26-LAB664\data\documents\packet-01`. Use the authored document groups below as a reference for **packet-01.pdf**:

> [!Note] Page references use the PDF viewer's 1-based page numbers in the uploaded packet, not page numbers printed within individual documents or the segment number.

| Pages | Logical document | Category at this stage |
| :--- | :--- | :--- |
| 1 | Membership card | `id_document` |
| 2-4 | Policy | `other` |
| 5-6 | Claim | `other` |
| 7 | Incident report | `other` |
| 8 | Repair estimate | `repair_estimate` |
| 9 | Statement | `other` |
| 10-11 | Rental invoice | `other` |
| 12 | Inspection | `other` |
| 13 | Form 1099-A | `tax_1099a` |

3. Check that continuation pages stay together, while different adjacent documents remain separate even when both belong to `other`. The statement and rental invoice are Other at this stage; they are unrouted, not discarded. Download the parent result for comparison, as you've done in the previous step.

> [!Tip] You can easily check the pages assigned to each segment, by looking at the label below the segment name.
> !IMAGE[vcl16bde.png](instructions359897/vcl16bde.png)

4. Next, upload `packet-03.pdf` from the same folder and run analysis. Review its 13 pages against the individual files in `C:\Users\LabUser\Desktop\ignite26-LAB664\data\documents\packet-03`, then download the parent result. Unlike packet-01, this packet has separate repair estimates on pages 8 and 9 (`repair_estimate`), a statement on page 10 (`other`), and a towing invoice on page 11 (`other`). All other page ranges and categories match the table above.
5. Before moving to the next step, select **Build analyzer** and use a unique ID such as `packet_classifier`. Also include a description, for example, `Classifier for multi-document analysis`.
6. After the build succeeds, choose **Stay in the project** to continue.

> [!Note] **Checkpoint:** you can identify categories and logical page ranges in a mixed packet. No extraction routes have been assigned yet.

===

## Step 4: Add extraction routes to the classifier

> [!Note] **Reuse the uploaded packets:** the three PDFs in `data\step4` are identical to the ones in `data\step3`. Select their existing thumbnails in the project. If you need to upload them again, use [classification-packet.pdf](../data/step4/classification-packet.pdf), [packet-01.pdf](../data/step4/packet-01.pdf) (statement and rental invoice), and [packet-03.pdf](../data/step4/packet-03.pdf) (towing invoice). This keeps the before/after comparison about routing, not a changed source.

1. Continue in the editable step 3 project. If you left it, return to [CU Studio Build](https://contentunderstanding.ai.azure.com/build), open **Project list**, and open your project. 
2. Open **Routing rules**. In each existing category's **Analyzer ID** selector, choose the route in the table below. Use the selector's **Prebuilt** tab to search for the exact prebuilt ID, or **Custom** to find your built repair analyzer. Selecting a route shows its schema preview within the project; you do not need to leave for the gallery.
!IMAGE[1b7s3xw7.png](instructions359897/1b7s3xw7.png)

> [!Note] For tax, choose the unversioned `prebuilt-tax.us.1099A`, not the year-specific entry. Edit the existing `other` description to the new version below, but leave its Analyzer ID unassigned. 

| Category key | Extraction route | Description change |
| :--- | :--- | :--- |
| `id_document` | `prebuilt-idDocument.generic` | Keep the step 3 description. |
| `tax_1099a` | `prebuilt-tax.us.1099A` | Keep the step 3 description. |
| `repair_estimate` | Your `repair_extractor_analyzer` ID | Keep the step 3 description. |
| `other` | **No route** | `Each distinct unrouted supporting document: policy declarations/endorsements, claim intake forms, incident reports, glass/panel service supporting records, valuation/downtime schedules, and workshop inspection records. Statements, towing bills, and rental billing belong to their named categories, not Other. Identify logical boundaries even when adjacent documents both have category other. Keep continuation pages together; do not merge different titles or identifiers. These documents are unrouted, not discarded. Exclude towing/recovery/security charge supplements; classify those as towing_invoice.` |

3. Select **Add category** and enter `statement` with its description below, then select your custom Statement analyzer through **Analyzer ID** > **Custom**. Repeat for `towing_invoice` and `rental_invoice`, selecting `prebuilt-invoice` through **Prebuilt** for each. Complete each name and description before adding the next row.
!IMAGE[ujvd6zg6.png](instructions359897/ujvd6zg6.png)

| Category key | Extraction route | Description change |
| :--- | :--- | :--- |
| `statement` | Your `statement_extractor_analyzer` ID | `A handwritten or typed claimant statement or email describing the incident, claimant vehicle, and reported damage. Keep continuation pages of the same statement together. Exclude claim forms, incident reports, witness or other-driver accounts, and repair or invoice documents.` |
| `towing_invoice` | `prebuilt-invoice` | `A towing or roadside-recovery invoice, bill or charge ledger for vehicle transport, storage or release. Keep continuation and release/custody supplements from the same bill together. Payment may be unpaid or pending; do not infer payment. Exclude repair estimates, rental billing, and glass or panel service quotes. Include towing/recovery/security charge supplements that list service charges or a total due, even when they also contain inspection details or repair-quote references.` |
| `rental_invoice` | `prebuilt-invoice` | `A vehicle rental billing document or invoice with rental agreement references, dates or daily charges. Keep the same agreement's pickup/billing/vehicle-condition continuation pages together. Payment may be unpaid or pending; do not infer payment. Exclude towing bills, repair estimates, and glass or panel service quotes.` |

4. Verify there are **seven categories and six assigned routes**, with no route for `other`. Keep **Enable segment** on and click on the gear icon to verify the settings. Keep **Auto segment content** selected, **Allow in-page segments** off, and **Segment by page** unselected. 
!IMAGE[bj0sbmti.png](instructions359897/bj0sbmti.png)
5. Select **Save** and wait until saving indicators clear.
6. Select the existing **classification-packet.pdf** thumbnail, then **Run analysis**. Wait for completion before inspecting results or selecting another file. 
7. In **Test**, expand the segments dropdown and select the child content you want to inspect (e.g. input1/segment1), then open **Fields**. 
!IMAGE[6cp63e2r.png](instructions359897/6cp63e2r.png)

> [!Note] The parent `input1` is not the child extractor's field view. 

Inspect ID fields on segment 1, nested 1099-A fields on segment 2, and custom `vehicle`, `vin`, and `odometer` fields on segment 3. The tax route adds nested year/copy segment entries; select the nested entry with a **Fields** tab. These are not extra input documents. Select a field label to inspect its source highlight. 
8. Return to `input1` > **Result** and download the routed result separately from the step 3 JSON.
9. Replicate the same process for the other 2 files:
   - Select **packet-01.pdf** and run analysis. Compare categories and page ranges with step 3, then inspect repair on page 8, the Statement route on page 9, and the rental invoice across pages 10-11. The statement and rental invoice now have their named categories and child fields rather than belonging to Other. Check that the rental continuation remains part of the same invoice. Download the parent result.
   - Select **packet-03.pdf** and run analysis. Inspect the Statement route on page 10, and the towing invoice on page 11, along with the other categories and logical boundaries. Check invoice amounts against the towing supplement's **$237 charge** on page 11, not the separate **$1,699.04 repair quote** it references. Download the parent result. Other documents remain in the parent content without a domain extraction route.
10. Compare returned fields with their source documents. Keep claimant-reported details distinct from verified facts, and proposed repair amounts distinct from invoiced charges or proof of payment. If a fact is not stated, check that its field is unset rather than invented; turn off **Hide missing fields** to see fields marked **Not found**.
11. After reviewing all three packets, select **Build analyzer** with a new unique ID, such as `router_analyzer`. Do not overwrite the classification-only analyzer you created in the previous step. After a successful build, use **Jump to analyzer list**. Verify this exact analyzer has status **Ready**. Record its ID and your resource endpoint for step 5.

> [!Note] **Checkpoint:** a tested, ready router links every non-Other category to extraction.

===

## Step 5: Setup Insurance Workbench app

In this step, you will move from authoring analyzers to reviewing their results in an application. The Insurance Workbench loads ten customer packets, totaling 118 pages, from `data\packets`; you do not need to upload them manually.

The app automatically loads the included cached extraction results and policy reviews. Use it as a results viewer: inspect the collection, review **Business rules validation** results, and follow policy findings back to their evidence. CU Studio remains your tool for editing and building analyzers. Later, you will explicitly rerun one repair estimate and can ask the policy agent follow-up questions.

### Prepare and launch the app

Use the prepared lab environment with Azure CLI and **Python 3.10 or later**, including pip and venv. The commands below restore dependencies, discover the lab's existing Azure resources, and index the policy PDFs using Search-managed Standard extraction with figure descriptions. They do not redeploy Azure infrastructure or assign roles.

1. Open **Windows PowerShell** CLI and move to the repository root, the folder containing `src`, `data`, and `infra`:

   ```PowerShell
   Set-Location "C:\Users\LabUser\Desktop\ignite26-LAB664"
   ```

2. Sign in with the account provided in the **Resources** tab. Choose **Work or School account** if prompted, then select the lab subscription:

   ```PowerShell
   az login

   ```

3. Run the two commands below in the order they are listed. 
   - **Setup** restores the locked npm dependencies, including *Deep Chat*, and prepares `.tools\policy-venv` using the lab's approved package sources.
   - **Deploy** discovers Search, Storage, Foundry resources and the model in your resource group, uploads the policy PDFs to Blob Storage, and configures a Search indexer and Content Understanding skill. Azure AI Search runs extraction, semantic chunking and AI figure descriptions, then populates the index. Deployment writes the workbench connection after verification. Policy review reuses saved Parse evidence without preparing a claim-summary analyzer or submitting claim CU reanalysis. Python does not extract or manually upload policy chunks. No pre-filled configuration file or hosted agent is needed.

   ```PowerShell
   powershell -ExecutionPolicy Bypass -File .\infra\setup.ps1
   powershell -ExecutionPolicy Bypass -File .\infra\deploy.ps1 -ResourceGroup "@lab.CloudResourceGroup(ResourceGroup1).Name" -Apply
   ```


4. Launch the separate app and keep this terminal open:

   ```PowerShell
   powershell -ExecutionPolicy Bypass -File .\infra\launch-workbench.ps1
   ```

5. Open +++http://127.0.0.1:8791/+++ in a new browser tab. Do not open `workbench.html` directly.

Wait for the cached results to load. Opening the app or switching review tabs does not submit a new analysis. The setup above prepares the connection needed for the repair rerun in step 6 and follow-up chat in step 7.

> [!Note] To stop the app at anytime just return to PowerShell and press **Ctrl+C**. 

### Explore the included results first 

1. Open **Parse and extract**. The cached results load automatically; wait until the **Cached** badge and all ten customer rows appear. There is no batch to start or completion counter to wait for.
2. Start with **Classification**. Each row is one customer; each check is a returned document instance and page range. Click a check or field value to open its full source PDF at that page. Documents classified as `other` are not shown in this grid, but remain in the analyzer's full response.
3. Switch to the **ID**, **1099-A**, **Repair Estimate**, **Statement**, **Towing Invoice**, and **Rental Invoice** views. Select a returned value to inspect its source document.
4. Turn on **Confidence** to inspect returned scores. Blank means the service omitted a score, not zero. Click line items for source boxes or their table icon to expand item rows below the customer.

===
## Step 6. Business rules validation

**Business rules validation** uses fixed extraction and arithmetic rules to validate extraction accuracy. In this exercise, use the fixed repair error to identify issue with analyzer, improve it in CU Studio and compare results.

1. Select **Business rules validation**. The matrix contains exactly three fixed extraction checks:
    - **Total Amount, SubTotal, Tax verification** asks whether SubTotal plus tax equals Total Amount.
    - **Repair line items, SubTotal verification** asks whether repair line-item amounts sum to the explicit SubTotal.
    - **Multiple Estimates Warning** warns when repair-estimate totals differ. It shows each shop and quote amount with a source link. This is a review warning, not proof of an extraction error.
2. Select the red **Error** for packet 8, under **Repair line items, SubTotal verification**. 
!IMAGE[hs9rqs9w.png](instructions359897/hs9rqs9w.png)
The original Repair Estimate result shows the calculation `USD 980.00 + 124.00 + 0.00 = 1104.00; Subtotal = 1600.00`. Review the explanation and the formula fields, then select the source or formula to highlight the native values in the PDF.
3. Go back to **CU Studio** and reopen the editable custom **Repair Estimate** extraction project from step 2 - *custom-repair-extractor*. Do not edit the packet router or classification project: this rerun requires a ready single-document repair extractor. 
4. In the **Schema** fields list, identify **LineItems** and click on the grid icon to open the line items editor. 
!IMAGE[spqympsb.png](instructions359897/spqympsb.png)
Then add these two **number / Extract** fields, within the **Total Amount** object umbrella:

   | Field | Description |
   |---|---|
   | `PartsAmount` | `Part amount associated with each line item` |
   | `LaborAmount` | `Labor amount associated with each line item` |

 Add the 2 new fields *after* the current ones (**Amount**, **CurrencyCode**). The validation rule continues to prefer a returned row total -**Amount**- and uses parts plus labor only when that total is missing.
 !IMAGE[wosopyzi.png](instructions359897/wosopyzi.png)
 Click **Back to main view**->**Save** to confirm the schema changes.
5. To verify the changes, select **Browse for files**, upload and test `C:\Users\LabUser\Desktop\ignite26-LAB664\data\documents\packet-08\05-estimate.pdf` before running the analysis (through the **Run Analysis** button). Expand **LineItems** object in the **Test** tab and inspect every line item and its source regions. A useful result for this document is:

   | Line item | PartsAmount | LaborAmount | Amount |
   |---|---:|---:|---:|
   | 1 | 980.00 | 223.20 | 1203.20 |
   | 2 | 124.00 | 62.00 | 186.00 |
   | 3 | 0.00 | 210.80 | 210.80 |

   The explicit `SubtotalAmount` is `1600.00`. These values reconcile, but always verify the native Studio result rather than assuming a model run is deterministic.
6. Save and build the updated project by clicking on **Build analyzer** and pick a new unique analyzer name, like `custom_repair_analyzer_v2`. Add a description too, such as `Updated repair analyzer with parts and labor amounts`. Wait until the analyzer is **Ready**, then copy its analyzer name exactly. 
7. Return to the packet-8 error in the **Insurance Workbench App**, enter it in **Updated repair estimate analyzer name**, and select **Rerun**. This submits only `05-estimate.pdf` as a fresh, billable CU call; there is no second confirmation dialog.
!IMAGE[z71i70zd.png](instructions359897/z71i70zd.png)
8. While the spinner is active, wait for the rerun to finish. The updated result appears below the original with its own status and calculation. Its field table shows formula inputs plus returned `PartsAmount` and `LaborAmount`, grouped by numeric line-item index in the order total, parts, labor, followed by SubTotal. Select the original and updated results to compare their own source boxes. A successful updated result should show `USD 1203.20 + 186.00 + 210.80 = 1600.00 (Subtotal)` and change the check to **Pass**.
!IMAGE[6cfzqmxd.png](instructions359897/6cfzqmxd.png)
9. The rerun preview is temporary and browser-only. It is not written to the saved extraction cache or native JSON. Navigating within the current run keeps the original and latest updated result; another rerun replaces the previous preview. Refreshing the page or changing runs clears it. If the source cannot be matched to one individual PDF, return to Studio and correct the router's document boundaries before rerunning.

> [+Note] **Where the files are**
>
> `instructions\lab.md` is the Markdown version of this single guide; `infra\setup.ps1` installs dependencies; `infra\launch-workbench.ps1` launches only the app. `src\workbench` contains the minimal app runtime, not another lab guide.
>
> `data\packets`: 10 complete customer PDFs. `data\documents\packet-01` through `packet-10`: 90 individual logical-document PDFs, extracted from the authored page groups. `data\samples`: six small Studio specimens. `data\packets.json`: source hashes and authored page ranges. `data\results`: completed CU runs, each with its original manifest and ten native JSON responses; future live runs save here too.
>
> `data\step1` through `data\step4` are convenience copies of the recommended inputs, not a second dataset. The app uses the canonical PDFs under `data`. Full packet 01 contains a statement and rental billing; full packet 03 contains towing. The authored four-class reference labels statements and both invoice types as Other, while the seven-class routed run gives them separate categories.

===

## Step 7. Check policy compliance using Azure Search (Foundry IQ) knowledge
### Explore cached policy reviews

**Check policies** shows **Claim policy checks**, with three ordered comparisons: **Daily rate**, **Effective terms**, and **Repair estimate**. These checks don't change the separate **Business rules validation** results. Selecting a policy check opens its concise headline, one to three claim-versus-policy comparisons, status and citations in the right panel. Select a linked value to inspect its source PDF, then **Back to policy check** to return. The loaded CU results remain shared across tabs.

The app automatically loads ten cached agent reviews from the current packet dataset and their recorded CU Layout index alongside the CU results. Loading these reviews does not contact Azure. Inspect all **30** saved checks and their linked evidence without Azure setup, a restore script or another review. Previous five-, four- and three-check reviews remain history; the new contract distinguishes this three-check set from the earlier one containing Rental start. **Ask agent** requires the live connection prepared in step 5 for additional questions; it does not replace the saved checks. This workflow uses the existing dependencies and needs no new npm packages.

1. Open **Check policies** after the initial cached results finish loading.
2. Confirm that all ten customer rows show their saved checks. Grounded Search retrieval is the default; there is no retrieval selector and you do not need to start or wait for an agent batch.
3. Select packet **02 / Washington**, then open **Daily rate**. Compare the claimed **$61/day** rental base rate with the **$85/day** effective contractual cap for the matched policy ID and insured VIN. Inspect the saved status rather than assuming a scripted answer. A numerical fit is conditional on rental eligibility, not permission to pay.
4. Open the source links to inspect the matched Washington declarations and effective-date record, then select **Back to policy check** to return. Inspect **Effective terms** to compare the actual loss date with the matched policy and genuine amendment's effective dates. A check mark means **Satisfied**; an open circle means **Review required**. The circular-arrow **Waiting for info** status means missing claim evidence needed for that comparison, not a model still running. **N/A** can apply to Daily rate for confirmed non-rental claims; effective terms and repair remain independent.

| Case | Daily base evidence | Contractual daily cap | Comparison to inspect |
| :--- | ---: | ---: | :--- |
| Packet 01 / Texas | $54 | $75 | $54/day fits the matched effective cap numerically, conditional on eligibility |
| Packet 02 / Washington | $61 | $85 | $61/day fits the matched effective cap numerically |

These are source comparisons, not guaranteed model outcomes. Missing unrelated repair completion, fee classification or insurer payment authorization doesn't create a wait for these three narrow checks.

Open **Repair estimate** and ask, "Is each supplied repair-estimate total within this state's routine review authority?" Compare each relevant distinct quote's gross total, including stated tax and before deductible or payments, with the state-specific threshold retrieved from the repair-authority diagram. This is **synthetic internal routine review authority**, not law, a contractual coverage cap or payment approval. The check is independent of rental applicability, including confirmed non-rental cases. Different quote amounts alone don't require review here: **Business rules validation** keeps its separate multiple-estimates warning. Inspect the linked diagram rather than assuming a threshold or substituting Texas's **$75/day** or Washington's **$85/day** contractual rental limits.

5. For packet **01**, inspect the matching revised declarations and issued amendment. The blank optional-code cell must not shift the Honda's deductible or rental limits. Verify the policy ID and insured VIN against the actual source image, not just similar vehicle descriptions or parsed text.
6. Select **Policy documents** to see three full-path dataset-folder links: original PDFs, saved Search outputs, and saved Digital Parse outputs. On the local Windows workbench, select a link to request the folder in Explorer, or use **Copy path**. To inspect an individual document in the workbench, select a source link in a check result and use **Original**, **CU Search**, or **Digital parse**. Both genuine native outputs are included for every active PDF. CU Search uses `prebuilt-documentSearch`, not relabeled Layout output. Digital parse can successfully return no text for a scanned effective-date record; the viewer explains that result without substituting OCR. Switching tabs makes no Azure calls. Inspect the repair-authority diagram's complete state branches.
7. Inspect a linked **Claim** value. Typed CU facts use their original source boxes when available; **First-pass parsed page text** links preserve the exact supplied page range without invented boxes. A text interpretation isn't a typed CU fact. Optionally select **Daily rate**, then **Ask agent**, and ask, "Compare Washington's claimed daily base rate with the matched contractual cap and cite the declarations." Chat uses the prepared live connection and can incur Azure charges; it doesn't replace the saved checks.

The agent connects fields extracted from the claim to the business rules and policy evidence associated with that claim. Its findings and linked sources help reviewers understand which checks are satisfied and where humans should spend time reviewing missing evidence, exceptions, or approvals. The agent supports that review; it does not make the final claim or payment decision.

These are source-based examples, not guaranteed model answers. Inspect differing results, missing facts or errors rather than forcing a pass. The synthetic repair SOP can't supply a missing contractual benefit. Contradictory evidence or unclear controlling rules require review. A genuine issued amendment and its effective time, not a customer signature alone, establish changed terms. **Satisfied** for daily rate doesn't approve the claim or authorize payment.

### Optional: inspect Search, policy files and the agent

| Inspect | Where to look | What to learn |
| :--- | :--- | :--- |
| Active Search index | Select the linked index name beside **Azure Search (FoundryIQ) Index for policy documents** to open its exact Azure portal view, then **Search explorer**. Search `rental daily rate`. | Chunks carry policy text, document identity, version and page information. The link identifies the displayed results' source generation; a different live index is labeled separately. |
| Original policy files | Select **Policy documents** or open the [active manifest](../data/policies/rental/ocr-comparison-v2/manifest.json). | The 21 active PDFs retain tables, scans and repair diagrams. Both native viewer outputs work offline. |
| Archived policy files | Open `data\policies\archive\legacy-rental-review-v2\`. | The 21 legacy rental-terms/SOP PDFs remain for historical citations but don't enter active retrieval or previews. No Blob upload is involved. |
| Agent Framework | Open [`infra/policy-framework-agent.py`](../infra/policy-framework-agent.py). Find `Agent`, `OpenAIChatClient` and `search_policy_rules`. | Initial reviews interpret rental applicability for Daily rate, then run three parallel comparisons with saved Parse fields, selected first-pass text and prefetched rules; terms and repair remain independent. Follow-up chat can use the Search tool. |

For shared-resource names and subscriptions, see [under the hood](../docs/policy-checks.md#optional-look-under-the-hood). Don't change roles, networking or shared resources during this exercise.

**FoundryIQ** is the lab's umbrella label for grounded retrieval. This implementation queries an ordinary Azure AI Search index directly, not a Foundry IQ knowledge base. The current bundle records its exact isolated CU Layout index; loading it doesn't query Azure. The optional managed setup can provision a different **Standard** index, but that doesn't change the provenance of saved results. Resource labels render without Azure calls; opening the Search portal target requires your Azure permissions. **CU Search** and **Digital parse** document tabs are separate cached representations; changing the viewer doesn't change the active Search index.

### Prepare follow-up chat

The policy agent runs locally in Python Agent Framework and queries an ordinary Azure AI Search index. There is no hosted agent to create in Studio. Studio sign-in does not authenticate the local app.

Setup above has already indexed the policies and activated `.tools\policy-agent-framework.json`. No additional deployment command is needed here. Policy review uses saved Parse fields and selected first-pass page text, not a separate claim-summary analyzer or another CU analysis. The router you built in step 4 isn't changed. If you rerun deployment after launching the app, restart the app and reload the browser before continuing.

Open a saved finding in **Check policies**, then select **Ask agent**. A prepared connection is required to send questions, but not to view the cached reviews. If **Ask agent** is unavailable, confirm that step 5's deployment completed successfully and restart the app. A configured status reports local configuration, not a successful connection; saved results do not prove that Search or the model is reachable.

If a question fails, keep the exact error and use the [troubleshooting table](../docs/policy-setup.md#troubleshoot-live-policy-setup). Do not repeatedly send billable requests to diagnose a configuration problem.
 
---

===

## Step 8: Optional: Use GitHub Copilot + CLI to improve your analyzer

Take what you've learned in Studio further with the Content Understanding CLI (`azd ai cu`) and Copilot. Build and improve analyzers, process documents and compare results, simply by describing what you want.

In this exercise, ask Copilot to repeat the repair-analyzer workflow from Step 6 on a disposable copy, then review the changes and before/after results. Your original analyzers and Workbench results stay unchanged.

This optional exercise plans two document analyses. Azure charges and Copilot usage apply.

### Install the Content Understanding CLI

Open a separate **Windows PowerShell** window. With Azure Developer CLI (`azd`) 1.37.0 or later already available on the lab VM, run:

```PowerShell
azd ai cu
```

When `azd ai cu` prompts, press **Enter** to install `azure.ai.content-understanding`. Then run:

```PowerShell
azd ai cu --help
azd auth login
```

Sign in with the same Azure lab account used in CU Studio. Copilot will check the connection and ask for your Step 4 resource endpoint if it is not already configured.

### Sign in to the GitHub Copilot app

1. In your browser, navigate to [GitHub enterprise sign-in](https://github.com/enterprises/skillable-events/sso) and sign in with your **Azure lab credentials**.
2. Return to the **GitHub Copilot app** and select **Sign in with GitHub**. Follow the instructions on the web page that opens, including the one-time code prompt, to complete sign-in.
3. Under **Sessions** (not **Chats**), click **+** > **Open local folder** and choose `C:\Users\LabUser\Desktop\ignite26-LAB664`.
4. Select that folder under **Start session in**. Set **Environment** to **This computer** and **Workspace** to **Current checkout**.

### Give the agent the task

Replace `<ORIGINAL_REPAIR_ANALYZER_ID>` with the analyzer built in **Step 2**, not the router or the improved analyzer built in Step 6. Paste this prompt:

> The repair amounts in packet 8 don't add up. My analyzer is `<ORIGINAL_REPAIR_ANALYZER_ID>`. Can you try fixing it on a copy and show me the before and after?

Copilot shows each CU CLI command before running it. Review the proposed scope and schema diff. Approve only the named repair estimate and disposable analyzer. Copilot will ask separately before deleting/recreating its copy; never approve replacement of an original analyzer.

### Review the comparison

Review the before/after table in Copilot: parts, labor, row totals, subtotal, and the remaining difference. The JSON evidence is saved under `.tools\copilot-lab`.

Fresh results can vary. Missing values are not zero, and matching arithmetic does not prove extraction accuracy. If the result does not improve, discuss the remaining issue rather than repeatedly rerunning it.

### More prompts to try

Stay in the same session. The first prompt needs approval for **four new document analyses**. The second uses saved results only.

**Check other packets**

> Can you try the repair estimates from packets 1 and 3 with both analyzers? Check if the fix changed anything else, like the vehicle, VIN or odometer. Show me the files and ask before running the four analyses.

Use the individual repair estimates, not the full packets. Changed values are potential regressions to review, not proof that either result is correct.

**Review the changes - no new Azure calls**

> Other than the amounts we fixed, did anything change or go missing? Show me the old and new values using the saved results. Don't run anything again.