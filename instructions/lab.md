@lab.Title

## Welcome to Your Lab Environment

To begin, log into the virtual machine using the following credentials: +++@lab.VirtualMachine(Win11-Pro-Base).Password+++

**Note:** Text formatted as an +++example+++ represents type text. Clicking on this text will automatically insert it to prevent any typing errors.

### From files to decisions

Imagine you are helping an auto insurance claims team review vehicle incident packets. The packets contain details like repair estimates, claimant statements, and towing and rental invoices. Manually piecing together these documents makes it difficult to spot inconsistencies and check the relevant policy information. Your goal is to bring the key facts and their source evidence into one workbench so reviewers can investigate each case more efficiently.

In this lab, you will use Azure Document Intelligence and Content Understanding in Foundry to turn insurance documents into structured, source-linked results, then use code and agents to make decisions about the claims. You will build and test analyzers in CU Studio, then explore the end-to-end workflow and evaluate results with the **Insurance Workbench app**. Along the way, you will:

- **Explore Content Understanding's prebuilt capabilities:** compare document layout with prebuilt extraction models, and inspect how returned values relate to the source documents.
- **Customize extraction:** extend an invoice template to extract vehicle, VIN, and odometer details from a repair estimate, then build a Statement analyzer that combines extracted facts with grounded summaries.
- **Classify and split document packets:** identify document types and logical page ranges in mixed insurance packets, keeping continuation pages together without extracting fields yet.
- **Add extraction routes:** connect document categories to prebuilt analyzers and your custom repair and Statement analyzers, including dedicated routes for towing and rental invoices. Review the returned fields and source highlights.
- **Evaluate results and identify improvements:** see a real-world use case in the **Insurance Workbench app**, explore saved results across ten customer packets, review **Business rules validation** findings, inspect grounded policy comparisons, then use your updated analyzer to rerun one repair estimate.
- **Check claims against policies in a knowledge base:** explore issues identified by an agent checking the extracted claims against a knowledge base.
  
===

## Step 1: Environment setup

> [!Note] The following setup prepares the environment for the remaining steps of the lab. As it takes a few minutes, starting it now enables it to run while you explore analyzers in CU Studio. Keep the PowerShell window open and continue with the browser instructions below while it runs.

1. Open **Windows PowerShell**, pinned on the taskbar, and move to the repository root, the folder containing `src`, `data`, and `infra`:

!IMAGE[dafb0t2p.png](instructions359897/dafb0t2p.png)

   ```PowerShell
   Set-Location "C:\Users\LabUser\Desktop\ignite26-LAB664"
   ```

2. Sign in with the Azure account provided below.

   ```PowerShell
   az login
   ```
   Choose **Work or School account** if prompted, then use the following credentials:

   - Username: +++@lab.CloudPortalCredential(User1).Username+++
   - If prompted for a Temporary Access Pass (TAP): +++@lab.CloudPortalCredential(User1).AccessToken+++
   - If prompted for a Password: +++@lab.CloudPortalCredential(User1).Password+++

Then select 'No, this app only' when asked to sign in to all apps and websites. 

!IMAGE[38jmsmpt.png](instructions359897/38jmsmpt.png)

Finally, confirm the subscription selection by pressing **Enter**.

!IMAGE[jueqmgw8.png](instructions359897/jueqmgw8.png)

3. Run the command below to set up the dependencies and prepare the policy search index:

```PowerShell
powershell -ExecutionPolicy Bypass -Command "& '.\infra\setup.ps1'; & '.\infra\deploy.ps1' -ResourceGroup 'ResourceGroup1' -Apply"
```

    - **Setup** restores the locked npm dependencies, including *Deep Chat*, and prepares the Python environment in **.tools\policy-venv** using the lab's approved package sources.
    - **Deploy** finds the existing Azure AI Search, Storage, and Foundry resources and model in your resource group. It uploads the policy PDFs to Blob Storage and configures a Search indexer with a Content Understanding skill. Azure AI Search then extracts the content, splits it into semantic chunks, generates AI descriptions of figures, and populates the index. Once verification succeeds, the script saves the connection settings for the workbench.

    No pre-filled configuration file or hosted agent is required. Azure AI Search handles policy extraction and indexing; Python does not extract or upload individual chunks. Later policy checks reuse the saved claim Parse results rather than creating a claim-summary analyzer or running Content Understanding on the claims again.

Let the script run in the background. You don't need to wait for it to finish. Leave this terminal open. You will return to it in step 7 to check that setup completed and launch the app.

===

## Step 2: Explore prebuilt analyzers
### Explore the prebuilt analyzers in CU Studio

To get started, let's explore the prebuilt analyzers in CU (Content Understanding) Studio by uploading and analyzing a few sample documents.
This will help you understand the distinction between layout extraction and schema-based extraction before you move on to customizing your own analyzers.

Open the browser to navigate to the CU Studio Gallery (`https://contentunderstanding.ai.azure.com/discover`).
Click **Sign in** on the top right corner of the page and log in with the provided credentials for Azure:
- Username: +++@lab.CloudPortalCredential(User1).Username+++
- If prompted for a Temporary Access Pass (TAP): +++@lab.CloudPortalCredential(User1).AccessToken+++
- If prompted for a Password: +++@lab.CloudPortalCredential(User1).Password+++

### Try out Layout Analyzer

Once done, follow the steps below to explore the prebuilt analyzers:
1. Click on **Layout** to test the document layout extraction. 
2.  Click **Next**->**Save** to confirm details of subscription, resource group etc.
3. You'll get a list of samples for different content types (checklist, financial report, formulas, etc). Select a sample to see the original document scan and how the prebuilt analyzer extracts information from it.
4. 
!IMAGE[chshn4cn.png](instructions359897/chshn4cn.png)

4. Next, click on **Browse for files** to upload your own document for analysis. In the File Explorer window that opens, navigate to `C:\Users\LabUser\Desktop\ignite26-LAB664\data\samples` and select **towing-invoice.pdf**.
5. Explore the output in the right panel by navigating across the different tabs (**Markdown**, **Tables**, **Result**). It includes Markdown, document structure (tables, lists, headings), and JSON parsed from the document.

> [!Note] The Layout analyzer parses a file into standard Markdown and JSON representations. It uses OCR to extract text and also extracts additional structures like tables, headings, lists, formulas, and figures.

!IMAGE[xfe4ei8u.png](instructions359897/xfe4ei8u.png)

### Try out Invoice prebuilt

Return to the previous page by clicking the **Back** button at the top left of the page.

!IMAGE[utcl2ivw.png](instructions359897/utcl2ivw.png)

Let's examine the differences between the prebuilt layout extraction and the schema-based extraction for the same document. 
1. Scroll down on the **Procurement** section to locate the **Invoice** prebuilt analyzer and click on it to open the details.
2. Inspect the **Fields tab** on the right panel with the default samples.  Invoice does schema-based extraction to extract fields relevant to the document type, such as **AmountDue**, **BalanceForward** and **Billing Address**. Note fields have a confidence score.
3. Hover over a field in the right panel, like "AmountDue". Notice that it shows grounding to the document.
4. Now upload the same **towing-invoice.pdf** document to see how the schema-based extraction applies to your own file. Compare the extracted fields and confidence scores with the layout extraction results you've got in the previous step to understand the differences.

> [!Note] **Layout and fields:** Use Layout to inspect how a document is organized, and an invoice schema to retrieve named business values. A field such as **AmountDue** selects a specific meaning rather than returning every number on the page.

### Try out other prebuilts

Feel free to experiment with further prebuilt analyzers to understand how CU Studio handles different document types and extraction scenarios. Below you can find a few examples of prebuilt analyzers along with the sample documents provided in the data folder, and the fields they extract.

| Prebuilt in Studio | Upload | Inspect |
| :--- | :--- | :--- |
| Identity / Generic ID document | demo-id.pdf | Named holder and available ID-like fields. This fictional membership specimen is not a government ID. |
| US tax / 1099A | form-1099a.pdf | Tax year, lender, borrower, account, and form boxes. Nested year/copy results are not extra input documents. |

> [!Note] **Checkpoint:** you can explain the difference between document layout and schema-based extraction.

===

## Step 3: Build a custom analyzer

### Custom repair estimate analyzer 
In this step, we will build a custom repair analyzer to handle repair estimate documents specifically. This document is a lot like an invoice, but we need to add auto-specific fields like **VIN** and **odometer**.

> [!Note] For this step, you'll use the **gpt-5.5** model instance pre-provisioned and mapped by the lab template. 

1. Move from the **Discover** to the **Build** tab, by selecting it on the top right corner of the blue top navigation bar.
2. Click on **Create** to start building your custom repair analyzer.
3. Name the project as `custom-repair-extractor`.
4. Select `2026-06-01 (Preview)` as the API version and `Standard Extraction` as the workflow type.

!IMAGE[kke6gm3z.png](instructions359897/kke6gm3z.png)

5. Leave the other parameters as default and confirm by selecting **Create**.
6. Once your project is created, select **Browse for Files** and upload `C:\Users\LabUser\Desktop\ignite26-LAB664\data\samples\repair-estimate.pdf`.
7. In the **Choose a template window**, select the **Invoice** one. Click on **Save** to proceed.
8. Add **these three fields**, with method **Extract**, one by one. For each field, enter the field's **Name** and **Description** from the table below. Complete both cells before selecting **Add field** again, and repeat for all three rows.

!IMAGE[y1l65rn4.png](instructions359897/y1l65rn4.png)

| Field | Type / method | Copy this description |
| :--- | :--- | :--- |
| `vehicle` | String / Extract | `Printed vehicle name as one string, including year/make/model when present. Do not add color, decode the VIN, or infer missing details.` |
| `vin` | String / Extract | `Exact value explicitly labeled VIN. Do not correct it or substitute registration, plate, or account numbers. Leave unset if absent.` |
| `odometer` | **Number / Extract** | `Printed Odometer or Inspection Mileage as a number. Remove grouping separators; no units. Do not substitute Annual Mileage or infer an absent value.` |

> [!Note] **Field names and descriptions instruct the model:** Names and descriptions act like "mini-prompts" instructing the LLM how to interpret the document. For example, naming the intended entity, likely printed label, and exclusions helps distinguish a vehicle VIN from other identifiers.

9. Click on **Save** to confirm the added fields.
10. **Run analysis:** Click the **Run** button on the upper left to test the updated analyzer.

!IMAGE[ctdjrztc.png](instructions359897/ctdjrztc.png)

11. In the analysis results, verify the saved schema contains the three fields above: `vehicle = "2019 Toyota Corolla LE"`, `vin = "5YFEPMAE3KA513905"`, `odometer = 94360`. The repair proposal total is $1,310.13. 
12. After the test passes, click on **Build analyzer** to turn your tested extraction configuration into a reusable object. Name it `repair_extractor_analyzer` and optionally add a description. Select **Build** to complete the process.

!IMAGE[eli9ysmu.png](instructions359897/eli9ysmu.png)

13. Once you are prompted with 'Built successfully', your analyzer is ready for use. Click on **Jump to analyzer list** to verify the analyzer details. Close the window once done. You'll find your newly created analyzer in the **Analyzer list**.

!IMAGE[22c2gk9p.png](instructions359897/22c2gk9p.png)

===

## Step 4: Add a custom Statement analyzer with generative fields

Now let's work with a different kind of document: a statement about the incident. Unlike an invoice, a statement may describe the same damage in several places or leave important details unstated. You will use **Extract** for facts explicitly present in the document and **Generate** for a concise, grounded synthesis of the narrative.

Instead of entering each field manually, you will import a prepared schema and inspect how its field descriptions constrain the result.

1. Return to the **Build** tab -> **Project list** and create a second **Standard Extraction** project using the '2026-06-01 (Preview)' API version. Name it `custom-statement-extractor`, then select **Create**. 

!IMAGE[g5cz3r5i.png](instructions359897/g5cz3r5i.png)

2. Click on **Browse for Files**. Within the File Explorer window, navigate to `C:\Users\LabUser\Desktop\ignite26-LAB664\data\documents\packet-01` and upload `06-handwriting.pdf`.
3. In the pop-up that appears after the document upload, keep **Document Analysis** as the selected template, disable **AI-Powered field suggestions**, then select **Save**.

!IMAGE[szpjguew.png](instructions359897/szpjguew.png)

4. In the field-schema toolbar, choose **Import**, navigate to `C:\Users\LabUser\Desktop\ignite26-LAB664\data\samples`, and select `statement-schema.json`. Confirm schema replacement if prompted, then **Save**. This imports the fields and descriptions; no field-by-field typing is needed.

!IMAGE[03cudcq2.png](instructions359897/03cudcq2.png)

You should have **seven fields: five Extract and two Generate**, with **Source & Confidence** enabled. 

> [!Note] **Extract and Generate:** Keep stated facts separate from generated interpretations. A **generated field** can summarize by combining passages and may not be a direct quotation from the document. **Extract** indicates the result should be pulled directly from a value in the document.

5. Click **Save**.
6. Click **Run analysis** to test the uploaded handwritten statement. Inspect the returned facts alongside the source document.
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
3. After reviewing both documents, select **Build analyzer** and enter a new unique ID, for example `statement_extractor_analyzer`.  In the **Analyzer list**, you should now see two custom analyzers, as in the screenshot below.
!IMAGE[516v1pe7.png](instructions359897/516v1pe7.png)

> [!Note] **Checkpoint:** your custom repair and statement analyzers have both been tested and built, and you have recorded both analyzer IDs.

===

## Step 5: Split a claims packet using a classification analyzer

So far, you have analyzed one document at a time. An insurance submission usually contains several documents, often with different formats and multiple pages. In this step, you will create a classifier that identifies document types and splits a packet into logical documents before extracting any fields.

You will start with a small three-page packet, then test the same configuration against two larger packets. This will help you see the difference between a page boundary and a document boundary.

> [!Note] **Classification and splitting:** **Classification** identifies the document type based on a description. **Splitting** breaks the document into logical segments aligned with the categories.

### Create the classification project

1. Return to **Build**->**Project List** in CU Studio and create a new **Classification** project, named `packet_classifier`. Make sure to configure the API version to *Preview* first.

!IMAGE[9maoqxjx.png](instructions359897/9maoqxjx.png)

2. In the new project, select **Browse for files**. Navigate to `C:\Users\LabUser\Desktop\ignite26-LAB664\data\samples` and upload `classification-packet.pdf`.
 
> [!Note] **Upload first:** the routing-rule editor becomes available after a file is uploaded.

3. In **Routing rules**, add the four category keys and descriptions in the table below, one by one. For each category, enter the category's **Name** and **Description** from the table. Keep the keys exactly as shown. Complete both cells before selecting **Add category** again, and repeat for all four rows.

!IMAGE[7qhnpb5o.png](instructions359897/7qhnpb5o.png)

> [!Tip] **Do not assign child analyzer IDs yet**; you will add extraction routes in step 6.

| Category key | Copy this description |
| :--- | :--- |
| `id_document` | `The lab's identity-like demo card with named holder, portrait and membership identifier. This synthetic membership card demonstrates ID field extraction, not government-ID authenticity. Exclude invoice, tax and repair documents.` |
| `tax_1099a` | `An IRS Form 1099-A Acquisition or Abandonment of Secured Property, including fictional borrower-copy examples. Exclude other tax forms and prose references.` |
| `repair_estimate` | `A standalone repair workshop estimate or quote with vehicle details and proposed repair work. Keep continuation pages of the same estimate together; split a different estimate even if adjacent. Exclude towing/rental/glass invoices and their supporting inspection supplements even when they mention a proposed repair schedule.` |
| `other` | `Each distinct supporting document: policy declarations/endorsements, claim intake forms, incident reports, handwritten statements, towing/rental/glass invoices with their own continuation supplements, valuation/downtime schedules, and workshop inspection records. Identify logical boundaries even when adjacent documents both have category other. Keep paginated continuation pages together; do not merge different document titles or identifiers. These documents are unrouted, not discarded.` |

Click **Save** to confirm. Next, configure how the classifier separates documents:

1. In **Routing rules**, turn on **Enable segment**.

!IMAGE[9zacnykv.png](instructions359897/9zacnykv.png)

> [!Note] With the configured settings, a two-page rental invoice should remain one logical document. Two adjacent documents should still be separate, even when both belong to `other`.

2. Select **Save** and wait until saving indicators clear before changing tabs. Select **Run analysis** and remain in the project until it finishes. Inspect the results to ensure documents are segmented correctly.
3. Inspect details in **Test** tab. The **Segment** selector initially shows the retained parent, `input1`. Open it and select each `input1/segment...` entry to see its category and page range. Expect `id_document` on page 1, `tax_1099a` on page 2, and `repair_estimate` on page 3. Every page should be covered once. Classification-only child segments have **Result**, not domain analyzer fields.

!IMAGE[s51l89mw.png](instructions359897/s51l89mw.png)

4. To keep a before/after comparison, select the parent `input1`, then **Result** and **Download** to save the JSON. 

!IMAGE[n0m86b6w.png](instructions359897/n0m86b6w.png)

> [!Tip] Download results before leaving the project or adding routes; reopening a saved project does not restore the displayed analysis results.

### Test the full customer packet

In the previous step, you tested a small packet to ensure the classifier correctly segments individual documents. Now, you will test the full customer packet to verify the classifier's behavior on larger, multi-document files.

1. Within the same project, select again **Browse for Files** and upload `C:\Users\LabUser\Desktop\ignite26-LAB664\data\samples\packet-01.pdf`. 
2. Click on **Run analysis**. After it finishes, inspect each segment's category and page range. Compare the returned boundaries with the individual PDFs under `C:\Users\LabUser\Desktop\ignite26-LAB664\data\samples\packet-01`. Use the authored document groups below as a reference for **packet-01.pdf**:

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

4. Next, upload `packet-03.pdf` from the same folder and run analysis. Review its 13 pages against the individual files in `C:\Users\LabUser\Desktop\ignite26-LAB664\data\samples\packet-03`, then download the parent result. Unlike packet-01, this packet has separate repair estimates on pages 8 and 9 (`repair_estimate`), a statement on page 10 (`other`), and a towing invoice on page 11 (`other`). All other page ranges and categories match the table above.
5. Before moving to the next step, select **Build analyzer** and use a unique ID such as `packet_classifier`. Also include a description, for example, `Classifier for multi-document analysis`.
6. After the build succeeds, choose **Stay in the project** to continue.

> [!Note] **Checkpoint:** you can identify categories and logical page ranges in a mixed packet. No extraction routes have been assigned yet.

===

## Step 6: Extract fields from each segment of the packet
> [!Note] **Reuse the uploaded packets:** the three PDFs in `data\samples` are the same inputs used in the previous step. Select their existing thumbnails in the project. If you need to upload them again, use [classification-packet.pdf](../data/samples/classification-packet.pdf), [packet-01.pdf](../data/samples/packet-01.pdf) (statement and rental invoice), and [packet-03.pdf](../data/samples/packet-03.pdf) (towing invoice). 

Continue in the editable step 5 project. If you left it, return to [CU Studio Build](https://contentunderstanding.ai.azure.com/build), open **Project list**, and open your project.

The manual walkthrough below is the main learning path. If you are short on time, use the optional import shortcut instead of entering the routing rules by hand. Both paths finish with the same packet tests and router build.

### Running short on time? Import the routing configuration

In **Routing rules**, open **More actions** (`...`) next to **Add category**, select **Import**, and click on **Confirm**. Then choose your local JSON file including the routing configuration, at `C:\Users\LabUser\Desktop\ignite26-LAB664\data\samples\router-config.json`.

> [!Tip] If any of the imported analyzers are highlighted in red or show **Analyzer not found**, there might be a mismatch between the analyzer IDs in the JSON file and the analyzer IDs you defined in previous steps. Verify that the custom analyzer IDs in the JSON match exactly with the ones you built in steps 3 and 4.

Skip the manual configuration below and continue at [Verify, test, and build the router](#verify-test-and-build-the-router). Recheck segmentation there even after importing.

### Configure routes manually

1. Open **Routing rules**. In each existing category's **Analyzer ID** selector, choose the route in the table below. Use the selector's **Prebuilt** tab to search for the exact prebuilt ID, or **Custom** to find your built repair analyzer. Selecting a route shows its schema preview within the project; you do not need to leave for the gallery.
!IMAGE[1b7s3xw7.png](instructions359897/1b7s3xw7.png)

> [!Note] Leave the descriptions unchanged. For tax, choose the unversioned `prebuilt-tax.us.1099A`, not the year-specific entry. 

| Category key | Extraction route |
| :--- | :--- |
| `id_document` | `prebuilt-idDocument.generic` |
| `tax_1099a` | `prebuilt-tax.us.1099A` |
| `repair_estimate` | Your `repair_extractor_analyzer` ID |
| `other` | **No route** |

2. Select **Add category** and enter `statement` with its description below, then select your custom Statement analyzer through **Analyzer ID** > **Custom**. Repeat for `towing_invoice` and `rental_invoice`, selecting `prebuilt-invoice` through **Prebuilt** for each. Complete each name and description before adding the next row.
!IMAGE[ujvd6zg6.png](instructions359897/ujvd6zg6.png)

| Category key | Extraction route | Description change |
| :--- | :--- | :--- |
| `statement` | Your `statement_extractor_analyzer` ID | `A handwritten or typed claimant statement or email describing the incident, claimant vehicle, and reported damage. Keep continuation pages of the same statement together. Exclude claim forms, incident reports, witness or other-driver accounts, and repair or invoice documents.` |
| `towing_invoice` | `prebuilt-invoice` | `A towing or roadside-recovery invoice, bill or charge ledger for vehicle transport, storage or release. Keep continuation and release/custody supplements from the same bill together. Payment may be unpaid or pending; do not infer payment. Exclude repair estimates, rental billing, and glass or panel service quotes. Include towing/recovery/security charge supplements that list service charges or a total due, even when they also contain inspection details or repair-quote references.` |
| `rental_invoice` | `prebuilt-invoice` | `A vehicle rental billing document or invoice with rental agreement references, dates or daily charges. Keep the same agreement's pickup/billing/vehicle-condition continuation pages together. Payment may be unpaid or pending; do not infer payment. Exclude towing bills, repair estimates, and glass or panel service quotes.` |


### Verify, test, and build the router

Continue here after either manual configuration or import.

1. Verify there are **seven categories and six assigned routes**, with no route for `other`. 

!IMAGE[bj0sbmti.png](instructions359897/bj0sbmti.png)

2. Select **Save** and wait until saving indicators clear.
3. Select the existing **classification-packet.pdf** thumbnail, then **Run analysis**. Wait for completion before inspecting results or selecting another file.
4. In **Test**, expand the segments dropdown and select the child content you want to inspect (e.g. input1/segment1), then open **Fields**.
!IMAGE[6cp63e2r.png](instructions359897/6cp63e2r.png)

> [!Note] The parent `input1` is not the child analyzer's field view. 

Inspect ID fields on segment 1, nested 1099-A fields on segment 2, and custom `vehicle`, `vin`, and `odometer` fields on segment 3. The tax route adds nested year/copy segment entries; select the nested entry with a **Fields** tab. These are not extra input documents. Select a field label to inspect its source highlight.
5. Return to `input1` > **Result** and download the routed result separately from the step 5 JSON.
6. Replicate the same process for the other 2 files:
   - Select **packet-01.pdf** and run analysis. Compare categories and page ranges with step 5, then inspect repair on page 8, the Statement route on page 9, and the rental invoice across pages 10-11. The statement and rental invoice now have their named categories and child fields rather than belonging to Other. Check that the rental continuation remains part of the same invoice. Download the parent result.
   - Select **packet-03.pdf** and run analysis. Inspect the Statement route on page 10, and the towing invoice on page 11, along with the other categories and logical boundaries. Check invoice amounts against the towing supplement's **$237 charge** on page 11, not the separate **$1,699.04 repair quote** it references. Download the parent result. Other documents remain in the parent content without a domain extraction route.
7. Compare returned fields with their source documents. Keep claimant-reported details distinct from verified facts, and proposed repair amounts distinct from invoiced charges or proof of payment. If a fact is not stated, check that its field is unset rather than invented; turn off **Hide missing fields** to see fields marked **Not found**.
8. After reviewing all three packets, select **Build analyzer** with a new unique ID, such as `router_analyzer`. Do not overwrite the classification-only analyzer you created in the previous step. After a successful build, use **Jump to analyzer list**. Verify this exact analyzer has status **Ready**. Record its ID and your resource endpoint for step 5.

> [!Note] **Checkpoint:** a tested, ready router links every non-Other category to extraction.

===

## Step 7: Evaluate results with the Insurance Workbench app

In this step, you will move from authoring analyzers to reviewing their results in an application. The Insurance Workbench loads ten customer packets, totaling 118 pages, from `data\packets` ; you do not need to upload them manually.

The app automatically loads the included cached extraction results and policy reviews. Use it as a results viewer: inspect the collection, review **Business rules validation** results, and follow policy findings back to their evidence. Later, you will explicitly rerun one repair estimate and can ask the policy agent follow-up questions.

### Launch the app

1. Return to the PowerShell window you used in [step 1](#environment-set-up). Confirm both setup commands completed successfully and **Deploy** reported `Workbench configuration activated` . 
If it is still running, wait for it to finish. 
- If either command failed, resolve the reported error and rerun that command successfully before continuing.

2. Launch the separate app and keep this terminal open:

   ```PowerShell
   powershell -ExecutionPolicy Bypass -File .\infra\launch-workbench.ps1
   ```

3. Open +++http://127.0.0.1:8791/+++ in a new browser tab. Do not open `workbench.html` directly.

Wait for the cached results to load. Opening the app or switching review tabs does not submit a new analysis. The setup in step 1 prepares the connection needed for the repair rerun in step 8 and follow-up chat in step 9.

> [!Note] To stop the app at any time, return to PowerShell and press **Ctrl+C**.

### Explore the included results first 

1. Open **Parse and extract**. The cached results load automatically; wait until the **Cached** badge and all ten customer rows appear. There is no batch to start or completion counter to wait for.
2. Start with **Classification**. Each row is one customer; each check is a returned document instance and page range. Click a check or field value to open its full source PDF at that page. Documents classified as `other` are not shown in this grid, but remain in the analyzer's full response.
3. Switch to the **ID**, **1099-A**, **Repair Estimate**, **Statement**, **Towing Invoice**, and **Rental Invoice** views. Select a returned value to inspect its source document.
4. Turn on **Confidence** to inspect returned scores. Blank means the service omitted a score, not zero. Click line items for source boxes or their table icon to expand item rows below the customer.

> [!Note] **Confidence and grounding:** Confidence scores and source highlights are additional features created by CU for fields where these features are enabled. Confidence scores help identify low-confidence results for review. Source grounding shows where in the Markdown or PDF the value came from.

===
## Step 8. Evaluate results with business rules validation

Evaluation with **Business rules validation** uses fixed rules to check the consistency of the results. In this exercise, use the included repair error to identify an issue with the analyzer, improve it in CU Studio, and compare results.

1. Select **Business rules validation**. The matrix contains exactly three fixed extraction checks:
    - **Total Amount, SubTotal, Tax verification** asks whether SubTotal plus tax equals Total Amount.
    - **Repair line items, SubTotal verification** asks whether repair line-item amounts sum to the explicit SubTotal.
    - **Multiple Estimates Warning** warns when repair-estimate totals differ. It shows each shop and quote amount with a source link. This is a review warning, not proof of an extraction error.
2. Select the red **Error** for packet 8, under **Repair line items, SubTotal verification**. 

!IMAGE[hs9rqs9w.png](instructions359897/hs9rqs9w.png)

The original Repair Estimate result shows the calculation `USD 980.00 + 124.00 + 0.00 = 1104.00; Subtotal = 1600.00`. Review the explanation and the formula fields, then select the source or formula to highlight the native values in the PDF.
3. Go back to **CU Studio** and reopen the editable custom **Repair Estimate** extraction project from step 3, `custom-repair-extractor`. Do not edit the packet router or classification project: this rerun requires a ready single-document repair analyzer.
4. In the **Schema** fields list, identify **LineItems** and click on the grid icon to open the line items editor. 

!IMAGE[spqympsb.png](instructions359897/spqympsb.png)

The PDF lists parts and labor separately, matched by operation reference. The original extraction copied only the parts amounts into the row totals, leaving out labor. Use **Extract** for `PartsAmount` and `LaborAmount` to read those printed values, and **Generate** for `TotalAmount` to calculate their sum, which is not printed as a single row total. This makes the intended calculation explicit; the independent subtotal check still verifies the result.

Within **LineItems**, delete the existing **TotalAmount** object using its **Delete field** control. This removes its nested **Amount** and **CurrencyCode** fields too. Do not delete the separate document-level **TotalAmount** field.

 Add these three fields directly under **LineItems**, as siblings of **Description** and **Quantity**, not inside another object:

   | Field | Value type | Method | Description |
   |---|---|---|---|
   | `PartsAmount` | Number | Extract | `Part amount associated with each line item` |
   | `LaborAmount` | Number | Extract | `Labor amount associated with each line item` |
   | `TotalAmount` | Number | Generate | `Total amount for this line item. Use its explicit printed total; otherwise, sum PartsAmount and LaborAmount. Do not use a parts-only amount or the invoice subtotal. Leave unset if no line-item total is printed and either component is missing.` |

!IMAGE[ljfsfbut.png](instructions359897/ljfsfbut.png)

 Add the fields in this order. The new **TotalAmount** uses the same name as the deleted field, but is a single **Number**, not an object. The validation rule supports both this numeric `LineItems[i].TotalAmount` and the original `LineItems[i].TotalAmount.Amount`. It prefers the returned row total and uses parts plus labor only when that total is missing; a wrong returned total still fails.
 Click **Back to main view**->**Save** to confirm the schema changes.
5. To verify the changes, select **Browse for files** and upload `C:\Users\LabUser\Desktop\ignite26-LAB664\data\documents\packet-08\05-estimate.pdf`, then select **Run analysis**. Expand the **LineItems** object in the **Test** tab and inspect every line item and its source regions. A useful result for this document is:

   | Line item | PartsAmount | LaborAmount | TotalAmount |
   |---|---:|---:|---:|
   | 1 | 980.00 | 223.20 | 1203.20 |
   | 2 | 124.00 | 62.00 | 186.00 |
   | 3 | 0.00 | 210.80 | 210.80 |

   The explicit `SubtotalAmount` is `1600.00`. Inspect the extracted parts and labor source regions; a generated total may not have its own source box. These values reconcile, but always verify the native Studio result rather than assuming a model run is deterministic.

> [!Note] **Derived totals:** Treat a generated line-item total as a calculation, not newly printed source text. Verify its extracted parts and labor inputs against the PDF, then reconcile the rows with the independent subtotal. Arithmetic consistency alone doesn't prove every extracted value is correct.

6. Save and build the updated project by clicking on **Build analyzer** and pick a new unique analyzer name, like `custom_repair_analyzer_v2`. Add a description too, such as `Updated repair analyzer with parts and labor amounts`. Wait until the analyzer is **Ready**, then copy its analyzer name exactly. 
7. Return to the packet-8 error in the **Insurance Workbench app**, enter the new analyzer name in **Updated repair estimate analyzer name**, and select **Rerun**. This submits only `05-estimate.pdf` as a fresh, billable CU call; there is no second confirmation dialog.

!IMAGE[z71i70zd.png](instructions359897/z71i70zd.png)

8. While the spinner is active, wait for the rerun to finish. The updated result appears below the original with its own status and calculation. Its field table shows formula inputs plus returned `PartsAmount` and `LaborAmount`, grouped by numeric line-item index in the order total, parts, labor, followed by SubTotal. Select the original and updated results to compare their own source boxes. A successful updated result should show `USD 1203.20 + 186.00 + 210.80 = 1600.00 (Subtotal)` and change the check to **Pass**.

!IMAGE[tha6s6rr.png](instructions359897/tha6s6rr.png)

9. The rerun preview is temporary and browser-only. It is not written to the saved extraction cache or native JSON. Navigating within the current run keeps the original and latest updated result; another rerun replaces the previous preview. Refreshing the page or changing runs clears it. If the source cannot be matched to one individual PDF, return to Studio and correct the router's document boundaries before rerunning.

> [+Note] **Where the files are**
>
> `instructions\lab.md` is the Markdown version of this single guide; `infra\setup.ps1` installs dependencies; `infra\launch-workbench.ps1` launches only the app. `src\workbench` contains the minimal app runtime, not another lab guide.
>
> `data\packets`: 10 complete customer PDFs. `data\documents\packet-01` through `packet-10`: 90 individual logical-document PDFs, extracted from the authored page groups. `data\samples`: Studio specimens, complete practice packets and the Statement schema. `data\packets.json`: source hashes and authored page ranges. `data\results`: completed CU runs, each with its original manifest and ten native JSON responses; future live runs save here too.
>
> `data\samples` brings the recommended Studio inputs together in one folder, not a second dataset. The app uses the canonical PDFs under `data`. Full packet 01 contains a statement and rental billing; full packet 03 contains towing. The authored four-class reference labels statements and both invoice types as Other, while the seven-class routed run gives them separate categories.

===

## Step 9: Review claims with Azure Search (Foundry IQ)

Step 8 used fixed business rules. Now we'll add Azure Search (Foundry IQ) to retrieve guidance for a particular claim and compare it with the extracted facts. This demo queries a Search index directly.

!IMAGE[bsv08s9h.png](instructions359897/bsv08s9h.png)

If you're starting here and the app isn't running, follow [Step 7's app-launch instructions](#launch-the-app), then open +++http://127.0.0.1:8791/+++.

1. Open **Check policies**. The customer grid contains **Daily rate**, **Effective terms**, and **Repair estimate** checks.
2. Select the linked index name above the grid to inspect the policy index in the Azure portal's **Search explorer**, then return to the app.
3. Select the **Policy documents** link to open a folder containing the indexed documents in File Explorer.

### Follow claim facts to the policy evidence

4. In the **#1 Danielle Ortiz** row, select the result under **Daily rate**. Compare the **Claim** and **Policy** values in the right panel. Select the linked claim amount "54 USD/day" to inspect its source files from the claim. Then select **Back to policy check**.

!IMAGE[uf89wmrn.png](instructions359897/uf89wmrn.png)

5. Select the linked policy daily limit "$75/day base charge" to open the **Original** declarations that the agent found in Azure Search. Inspect the **Rental limit** column. Switch to **Prebuilt Search** to see the searchable representation created by Content Understanding as part of Azure Search standard content extraction. Then select **Back to policy check**.

!IMAGE[9n46bxvj.png](instructions359897/9n46bxvj.png)

> [!Note] **Search ingestion:** The lab's managed Search deployment uses [Content Understanding](https://learn.microsoft.com/azure/search/cognitive-search-skill-content-understanding) standard content extraction to retain searchable text, tables, and page references. This pipeline also enables semantic chunking and AI-generated figure descriptions. **Prebuilt Search** shows what the underlying indexed content looks like.

### Inspect figure-backed repair guidance

6. In the **#2 Victor Bennett** row, select the result under **Repair estimate**. Compare the gross repair total with the retrieved Washington routine-review threshold, rather than an arithmetic rule from step 8.

!IMAGE[91ysxon6.png](instructions359897/91ysxon6.png)

7. Select the linked policy threshold to inspect the supporting diagram. Compare its description in **Prebuilt Search** which uses a json object using MermadeJS format to render that flow chart  then select **Back to policy check**.

!IMAGE[2ihrasgl.png](instructions359897/2ihrasgl.png)


### Ask a follow-up question

8. For the selected **Repair estimate** check, select **Ask agent**. Enter a follow-up such as `What is the routine repair-review threshold if this incident were in Arizona?` Sending it allows you to use the agent to get additional clarification.

!IMAGE[ckohd4yo.png](instructions359897/ckohd4yo.png)

---

===

## Step 10: Optional: Use GitHub Copilot + CLI to improve your analyzer

In this optional exercise, you'll see how:

- The Content Understanding CLI (`azd ai cu`) lets you or a coding agent manage analyzers and analyze documents.
- Copilot can turn a natural-language request into an improvement workflow: inspect the analyzer, make targeted schema changes on a copy, and compare before/after results.

You'll repeat the repair-analyzer workflow from Step 8 on a disposable copy. Your original analyzers and Workbench results stay unchanged.

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

Sign in with the same Azure lab account used in CU Studio.

### Sign in to the GitHub Copilot app

1. In your browser, navigate to GitHub enterprise sign-in at `https://github.com/enterprises/skillable-events/sso` and sign in with your **Azure lab credentials**.
2. Open the **GitHub Copilot app** from the Desktop icon and select **Sign in with GitHub**. Follow the instructions on the web page that opens, including the one-time code prompt, to complete sign-in.

### Open the lab checkout

1. In the sidebar, select **+** beside **Projects**, then select **Open folder**.

!IMAGE[m78g0dmn.png](instructions359897/m78g0dmn.png)

2. Choose `C:\Users\LabUser\Desktop\ignite26-LAB664` in the folder picker. Select the lab project under **Projects**, then use **New** at the top left to start a fresh session for that project.

!IMAGE[7gblz1a9.png](instructions359897/7gblz1a9.png)

3. Below the prompt, open the workspace selector, which may initially show **New worktree**. In the **Where to work** menu, select **Current checkout**.

!IMAGE[yr72k9vw.png](instructions359897/yr72k9vw.png)

4. Confirm the prompt footer shows **ignite26-LAB664** and **Current checkout**. Keep **Interactive** mode and normal tool approvals enabled; do not enable **allow-all**.

!IMAGE[ns0m6984.png](instructions359897/ns0m6984.png)

5. Open the model picker in the prompt footer and select **GPT 6.1 Sol**. This selects Copilot's coding model; leave the CU analyzer's existing **GPT-5.5** configuration unchanged.

Use **Current checkout**, not **New worktree**: instructions staged on the VM may be uncommitted and absent from a new worktree. Changing folders in a PowerShell window does not change the Copilot app's workspace.

### Give the agent the task

Use `repair_extractor_analyzer` from **Step 3**, not the router or the improved analyzer from Step 8.

> Hey, I just validated packet 8 and the repair line items don't add up to the subtotal. Can you try fixing it on a copy of `repair_extractor_analyzer`? Add PartsAmount and LaborAmount as extracted numbers, and change the line-item TotalAmount from an object to a generated number. Use the printed row total if there is one, otherwise add parts and labor when both are there. Don't guess missing amounts, and leave the document total alone. Show me what you'll change first, then compare before and after.

After you send the prompt, Copilot will check your Azure connection and ask for your Content Understanding resource endpoint if needed.

As Copilot works, follow how it translates your request into analyzer checks, CLI commands, a schema diff, approvals and a before/after comparison. Inspect the commands and results along the way, not just the final answer.

At first tool use, you may see **Trust this repository?**. Confirm that the project is the lab checkout above, then select **Trust repository** only if you trust its files. You can choose **Skip for now** instead and review individual tool requests.

!IMAGE[xgvtpq5h.png](instructions359897/xgvtpq5h.png)

Copilot is instructed to show each CU CLI command in chat before running it and report the result afterward. Check the analyzer ID, input file, endpoint when present, and operation before approving. If a chat preview is missing, ask Copilot to show the full command before continuing. You can expand tool cards to inspect commands that already ran; missing chat text does not mean they were not executed.

Review Copilot's initial proposal before approving a disposable repair-analyzer copy and **two analyses** of `data\documents\packet-08\05-estimate.pdf`: one before the fix and one after.

!IMAGE[mfyfxprq.png](instructions359897/mfyfxprq.png)

Illustrative approval prompt (edited example).

Review Copilot's proposed changes. It will ask again before replacing its copy of the analyzer. Your original stays unchanged.

### Review the comparison

For packet 8, use these reference checks:

- Each row has `PartsAmount` and `LaborAmount`, with a numeric `TotalAmount`.
- Row totals are **1,203.20, 186.00 and 210.80**, adding to the **1,600.00 subtotal**.
- The gap drops from **496.00 to 0.00**; the document total stays **1,691.08**.

If values differ, ask Copilot to explain before rerunning.

### More prompts to try

Stay in the same session. The first prompt needs approval for **four new document analyses**. The second uses saved results only.

**Check other packets**

> Can you try the repair estimates from packets 1 and 3 with both analyzers? Check if the fix changed anything else, like the vehicle, VIN or odometer. Show me the files and ask before running the four analyses.

Use the individual repair estimates, not the full packets. Changed values are potential regressions to review, not proof that either result is correct.

**Review the changes - no new Azure calls**

> Other than the amounts we fixed, did anything change or go missing? Show me the old and new values using the saved results. Don't run anything again.

===

## Summary

Congratulations! You have successfully completed the lab.

In this lab, you explored how to turn insurance documents into structured, source-linked information for claims review. You:

- Compared layout extraction with prebuilt schema-based analyzers.
- Customized repair estimate and Statement analyzers, then classified, split and routed mixed document packets.
- Used the **Insurance Workbench app** to inspect extracted fields, review business-rule findings and compare an updated repair analyzer with the original.
- Checked claim facts against policy evidence retrieved through **Azure Search (Foundry IQ)** and asked an agent follow-up questions.
- Optionally used **GitHub Copilot and the Content Understanding CLI** to improve a disposable analyzer copy and compare before/after results with explicit approvals.