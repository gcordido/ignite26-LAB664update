"""Build the synthetic rental v2 figure/table/OCR corpus; no cloud calls."""

from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
from xml.sax.saxutils import escape

import fitz
from docx import Document
from docx.shared import Inches, Pt
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, Table, TableStyle


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "policies" / "rental" / "ocr-comparison-v2"
RUN = "6e3b62d2-abe5-4ea7-9898-d2d11f4dc5f1"
VERSION = "2.0"
STATES = [
    ("TX", "Texas", "75.00", 7, "Personal collision", "Named mandatory rental tax"),
    ("WA", "Washington", "60.00", 5, "Personal collision", "Generic local levies require clarification"),
    ("AZ", "Arizona", "70.00", 5, "Personal comprehensive / theft", "Named mandatory rental tax"),
    ("CO", "Colorado", "80.00", 5, "Personal comprehensive / hail", "Named mandatory rental tax"),
    ("FL", "Florida", "75.00", 7, "Personal collision", "Separate flat towing from rental charges"),
    ("IL", "Illinois", "80.00", 5, "Personal collision", "Policy premium is not a rental expense"),
    ("LA", "Louisiana", "70.00", 5, "Personal comprehensive / flood", "Total-loss assessment is not a rental bill"),
    ("CA", "California", "85.00", 3, "Personal comprehensive / glass", "Glass/calibration invoice is not a rental bill"),
    ("NY", "New York", "75.00", 5, "Personal comprehensive / animal strike", "Named state/regional rental taxes; no legal-rate certification"),
    ("OH", "Ohio", "80.00", 5, "Commercial delivery with rental endorsement", "Downtime worksheet is not a rental invoice"),
]
SECTIONS = {
    "1. Scope and authority": 1,
    "2. Five-rule decision matrix": 2,
    "3. Rate, duration and charge schedules": 3,
    "4. Applicability and reviewer worksheet": 4,
}
BLUE = colors.HexColor("#173E61")
PALE = colors.HexColor("#EAF0F5")
BODY = ParagraphStyle("body", fontName="Sop", fontSize=10, leading=13)
CELL = ParagraphStyle("cell", fontName="Sop", fontSize=9, leading=12)
HEAD = ParagraphStyle("head", parent=CELL, fontName="SopBold", textColor=colors.white)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def paragraph(text: str, style: ParagraphStyle = BODY) -> Paragraph:
    return Paragraph(escape(text).replace("\n", "<br/>"), style)


def box(c: canvas.Canvas, text: str, x: int, top: float, width: int = 522) -> float:
    p = paragraph(text)
    _, height = p.wrap(width, 700)
    p.drawOn(c, x, top - height)
    return top - height - 12


def table(c: canvas.Canvas, rows: list[list[str]], widths: list[int], top: float,
          spans: list[tuple[int, int, int, int]] | None = None) -> float:
    cells = [[paragraph(text, HEAD if i < 2 else CELL) for text in row]
             for i, row in enumerate(rows)]
    t = Table(cells, colWidths=widths, hAlign="LEFT")
    commands = [
        ("BACKGROUND", (0, 0), (-1, 1), BLUE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#A8B9C8")),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]
    for i in range(2, len(rows), 2):
        commands.append(("BACKGROUND", (0, i), (-1, i), PALE))
    for x1, y1, x2, y2 in spans or []:
        commands.append(("SPAN", (x1, y1), (x2, y2)))
    t.setStyle(TableStyle(commands))
    _, height = t.wrap(522, 700)
    if top - height < 58:
        raise ValueError("Rule table does not fit a legible single page.")
    t.drawOn(c, 45, top - height)
    return top - height - 14


def heading(c: canvas.Canvas, title: str) -> float:
    c.setFont("SopBold", 17)
    c.setFillColor(BLUE)
    c.drawString(45, 733, title)
    c.setFillColor(colors.black)
    return 707


def decorate(c: canvas.Canvas, document_id: str, page: int, pages: int = 4) -> None:
    c.setFont("Sop", 8)
    c.setFillColor(colors.HexColor("#536575"))
    c.drawString(45, 768, f"LAB664 | Synthetic processing SOP | {document_id} v{VERSION}")
    c.drawString(45, 26, "Fictional training rules only. Not law, coverage approval or payment authority.")
    c.drawRightString(567, 26, f"Page {page} of {pages}")
    c.setFillColor(colors.black)


def state_content(state: tuple) -> tuple[list[str], list[list[list[str]]]]:
    code, label, rate, days, scope, fees = state
    texts = [
        f"{label} rental review SOP. Document {code}-RENTAL-002, version {VERSION}. "
        f"Loss state: {code}. Product and peril scope: {scope}. "
        "Benefit: rental reimbursement only where the supplied policy expressly includes it. "
        "Effective for loss dates 2024-01-01 through 2026-12-31 inclusive.",
        "This is a new synthetic demonstration version, not an amendment to an actual policy. "
        "Select this corpus alone; do not mix its rules with the legacy v1 corpus. "
        "The claim's contractual daily and cumulative limits always apply independently. "
        "This SOP never supplies a missing policy benefit, endorsement, loss date or state.",
        "This is a rental-only processing review. A confirmed towing-only, repair-only, glass-service-only, "
        "valuation-only or commercial downtime-only packet has no rental request: all five rental checks "
        "are NOT APPLICABLE, not approved or satisfied. A policy's rental limit or premium is not a request. "
        "Absence of extracted fields or a classifier label alone does not confirm no request.",
        "Use SHARED-EVIDENCE-002 v2.0 with this SOP. The controlling decision matrix, numeric schedules, "
        "exception conditions and checkbox worksheet are on pages 2-4. They must be read together. "
        "A retrieval path that returns only this cover has insufficient rule evidence; request review.",
    ]
    matrix = [
        ["Five-rule decision matrix: apply the applicability gate first", "", ""],
        ["Check / rule", "Satisfied only when", "Review required when"],
        [f"{code}-R1\nEligibility and need",
         "Policy benefit and dates confirmed; rental linked to the claim; non-drivable evidence OR "
         "dated actual shop intake/release supports rental need.",
         "Coverage or routing unknown; drivable vehicle has only scheduled repair; no supported loss of use. "
         "A rental vehicle being different from the insured vehicle is normal."],
        [f"{code}-R2\nDaily rate",
         "Each day's BASE rate meets BOTH the contractual cap and the routine row in schedule A, "
         "or an applicable signed internal exception. Compare without mandatory tax.",
         "Any day exceeds a cap; exception not signed. Never divide a tax-inclusive total to invent "
         "a base rate. A policy limit or annual premium is not a billed daily rate."],
        [f"{code}-R3\nDuration and repair alignment",
         "Actual units meet BOTH remaining policy days and schedule A; full interval supported by actual "
         "repair downtime; prior loss-specific rental usage known (including explicit none).",
         "Scheduled repairs used as actual downtime; prior usage unknown; unsupported early pickup, "
         "late return or extension. Returned vehicle alone does not prove repair completion."],
        [f"{code}-R4\nCharges and reimbursement calculation",
         "Days x base + supported mandatory taxes/fees - credits = invoice total to $0.01; "
         "use schedule B to keep different bill types separate.",
         "Unexplained charge, unsupported mandatory status, duplicate line or arithmetic mismatch. "
         "Never add a total summary line to its itemized details twice."],
        [f"{code}-R5\nAuthorization and payment readiness",
         "Final bill and completed return, plus insurer authorization covering dates and amount; "
         "any schedule A exception has required supervisor signature.",
         "No insurer authorization, pending/None/not-authorized status or unsigned exception. "
         "A customer's signature and a final bill do not authorize insurer payment."],
        ["Missing evidence is review, never an assumed pass. NOT APPLICABLE is a distinct outcome.", "", ""],
    ]
    schedule = [
        ["Schedule A: independent limits (inclusive); USD base only", "", ""],
        ["Authority band", "Daily base rate", "Days and approver"],
        ["Routine handling", f"<= ${rate}/day AND <= actual policy daily cap",
         f"<= {days} days AND <= remaining policy days; normal adjuster handling"],
        ["Internal exception", f"> ${rate}/day up to actual policy cap",
         f"> {days} days up to remaining policy days; documented rental-supervisor approval "
         "for rate AND/OR duration, whichever is exceeded"],
        ["Contractual boundary", "Above actual policy daily cap: no SOP authority to waive",
         "Above remaining policy days: no SOP authority to waive. Refer for coverage review."],
        ["Use the column and row headers together. An internal exception never enlarges the contract.", "", ""],
    ]
    charges = [
        ["Schedule B: bill-type and charge treatment", "", ""],
        ["Observed item", "Treatment for rental review", "Exception / action"],
        ["Daily rental + named tax", "Reconcile base separately; mandatory tax is additional only if policy says so",
         fees],
        ["Towing / recovery", "Not rental base, tax or rental-day evidence",
         "Confirmed towing-only packet: NOT APPLICABLE; mixed packet: evaluate rental separately"],
        ["Repair / glass / valuation", "Not a rental bill; policy premium and benefit cap are not incurred charges",
         "Misfiled amounts under Rental: review extraction/entity contradiction, not automatic N/A"],
    ]
    worksheet = [
        ["Applicability gate and reviewer worksheet (blank; not claim evidence)", "", ""],
        ["Gate / checkbox", "Required evidence", "Result / precedence"],
        ["[ ] Confirmed rental request", "Actual rental agreement, supplier bill or explicit reimbursement request",
         "Apply R1-R5 individually; partial pass is not payment approval"],
        ["[ ] Confirmed no rental request", "Full document inventory and substantive invoice/request fields agree; "
         "no rental agreement/request; non-rental bill identities established",
         "NOT APPLICABLE for all five; cite each state rule and shared E-02; never call it paid or satisfied"],
        ["[ ] Unknown / conflicting", "Missing request flag, incomplete extraction, unmatched entities or non-rental "
         "invoice amount labelled Rental",
         "REVIEW REQUIRED. Missing fields alone cannot select no-request"],
        ["[ ] Payment authority checked", "Insurer dates/amount and relevant supervisor signature",
         "Unchecked = unanswered, not no. Selected boxes here are examples only."],
        ["Precedence: actual policy terms > explicit exception conditions > routine table. "
         "Missing rule text or ambiguous row/header association requires review.", "", ""],
    ]
    if code == "AZ":
        texts[-1] += " AZ-R1 eligibility is controlled by Figure 1 on page 5."
        matrix[2][1] = "Follow Figure 1 on page 5; its labelled branches control AZ-R1."
        matrix[2][2] = "Use the review and not-applicable terminals in Figure 1. Do not infer eligibility."
    if code == "TX":
        schedule = [
            ["Schedule A: independent limits (inclusive); USD base only", "", ""],
            ["Authority band", "Daily base rate", "Days and approver"],
            ["Routine handling", "<= $75.00/day AND <= actual policy daily cap",
             "<= 7 days AND <= remaining policy days; normal adjuster handling"],
            ["Internal exception", "> $75.00/day up to actual policy cap; "
             "documented rental-supervisor rate approval", ""],
            ["", "", "> 7 days up to remaining policy days; "
             "documented rental-supervisor duration approval"],
            ["Contractual boundary", "Above actual policy daily cap: no SOP authority to waive",
             "Above remaining policy days: no SOP authority to waive. Refer for coverage review."],
            ["Blank-cell key: a blank Authority band continues the last nonblank band above. "
             "A blank Daily base rate or Days and approver cell grants NO additional authority "
             "for that dimension: its routine limit still applies. Blank is not zero, unlimited "
             "or permission to copy a numeric limit from an adjacent cell. If both routine "
             "limits are exceeded, both documented supervisor approvals are required.", "", ""],
        ]
    return texts, [matrix, schedule, charges, worksheet]


def shared_content() -> tuple[list[str], list[list[list[str]]]]:
    texts = [
        "Shared rental evidence standard. Document SHARED-EVIDENCE-002 version 2.0. "
        "Applies to TX, WA, AZ, CO, FL, IL, LA, CA, NY and OH state SOPs in this corpus only. "
        "Effective loss dates 2024-01-01 through 2026-12-31 inclusive.",
        "Use personal collision, comprehensive/theft, hail, flood, glass and animal-strike scopes, or "
        "commercial delivery only where the applicable supplied policy expressly includes rental benefits. "
        "Do not convert comprehensive into collision or infer commercial eligibility.",
        "This standard preserves the boundary between extracted facts and retrieved rules. "
        "Rules cannot manufacture approvals, missing dates, prior usage or a rental request. "
        "Not applicable, satisfied and review required are three distinct outcomes.",
        "Controlling evidence, output and table-reading rules are in scanned pages 2-4. "
        "Do not answer from cover metadata alone. Knowledge sources must exclude claim facts, "
        "expected outcomes, editable duplicates and control PDFs.",
    ]
    matrix = [
        ["Shared evidence rules: keep facts, scope and outcomes distinct", "", ""],
        ["Rule", "Required handling", "Never do this"],
        ["E-01\nSource selection", "Match loss state, policy product/peril, benefit, version and inclusive loss date; "
         "retrieve one matching state SOP and this standard", "Do not route by supplier address or pick the nearest state"],
        ["E-02\nApplicability", "Confirm actual rental request versus confirmed non-rental packet using invoice "
         "identity AND document inventory; preserve unknown/conflict as review", "No request is NOT APPLICABLE, "
         "not satisfied. Missing extraction alone never proves no request"],
        ["E-03\nEvidence and chronology", "Final return supersedes pickup's return-pending field; actual shop "
         "dates remain separate; explicit no prior usage differs from unknown", "Do not infer actual downtime, "
         "zero prior days or insurer approval from completed return"],
        ["E-04\nTables and checkboxes", "Read merged table title, column headers, authority row, footnote and "
         "checkbox label/state together", "Do not join routine rate to exception days; unchecked is unanswered"],
        ["E-05\nEntity and charge identity", "Match claim/insured/agreement; keep rental vehicle distinct; "
         "reconcile only rental invoice lines", "Do not treat tow/repair/glass/valuation/premium as rental "
         "or copy values from unrelated tax forms"],
        ["E-06\nHonest output", "Five ordered checks with outcome, expected, actual, concise reason and exact "
         "rule-file citation. Unknowns remain explicit", "No missing rule text = pass; no fabricated sources; "
         "no payment decision"],
    ]
    schedule = [
        ["Evidence hierarchy and duplicate-line reconciliation", "", ""],
        ["Question", "Preferred evidence", "Does not establish it"],
        ["Actual rental charge", "Agreement-linked final supplier bill; itemized per-day base and final total",
         "Policy $85/day maximum, premium, repair estimate, towing flat fee"],
        ["Actual repair downtime", "Shop intake AND release/completion for the insured vehicle",
         "Appointment, scheduled estimate, rental return or drivable checkbox alone"],
        ["Authority", "Insurer authorization for dates and amount; supervisor signature for relevant exception",
         "Customer signature, invoice marked final or blank checkbox"],
        ["Totals", "Use either a base summary or its per-day lines once; add supported taxes and subtract credits",
         "Adding the summary and the itemization together; inventing a legal tax rate"],
    ]
    charges = [
        ["Three outcomes; do not collapse absence into approval", "", ""],
        ["Outcome", "ReviewRequired mapping", "Meaning"],
        ["Satisfied", "false", "Applicable check, all conditions supported; not payment approval"],
        ["Review required", "true", "Applicable/uncertain check missing a condition, rule or reliable routing"],
        ["Not applicable", "false, ONLY with explicit Outcome = NotApplicable",
         "Confirmed no rental request; no rental decision or reimbursement approval was made"],
    ]
    worksheet = [
        ["Output and table-retrieval worksheet", "", ""],
        ["Field / check", "Requirement", "Validation"],
        ["Outcome", "Satisfied | ReviewRequired | NotApplicable", "ReviewRequired boolean agrees; "
         "N/A requires affirmative no-request evidence; never infer it from absent fields"],
        ["ExpectedValue / ActualValue", "Short plain text; units; contract cap versus state routine cap separate",
         "Missing fact = Unknown/Not supplied; missing rule = Not established"],
        ["Citation", "File, DocumentId, Version, RuleId, Section; one state rule per check plus relevant shared rule",
         "Exact indexed PDF filename and printed heading; no example or claim-packet citations"],
        ["Five checks", "Eligibility; rate; duration; charges; authorization, always in that order",
         "For N/A say no rental request for each check, not numeric zero"],
        ["[ ] Source text sufficient", "Retrieved matrix AND relevant schedules/notes", "If not checked due "
         "to missing retrieval text, review; do not fill rules from model memory"],
    ]
    return texts, [matrix, schedule, charges, worksheet]


def eligibility_figure() -> bytes:
    """Rasterize the controlling AZ eligibility branches without a text fallback."""
    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=(522, 610), invariant=1)

    def label(text: str, x: float, y: float, width: float) -> None:
        p = paragraph(text, CELL)
        _, height = p.wrap(width, 80)
        p.drawOn(c, x - width / 2, y - height / 2)

    def arrow(x1: float, y1: float, x2: float, y2: float, text: str) -> None:
        c.setStrokeColor(BLUE)
        c.line(x1, y1, x2, y2)
        if x1 == x2:
            c.line(x2, y2, x2 - 4, y2 + 7)
            c.line(x2, y2, x2 + 4, y2 + 7)
            label(text, x1 + 22, (y1 + y2) / 2, 35)
        else:
            c.line(x2, y2, x2 - 7, y2 + 4)
            c.line(x2, y2, x2 - 7, y2 - 4)
            label(text, (x1 + x2) / 2, y1 + 13, 35)

    nodes = [
        ("Confirmed no rental request?", "Yes", "NOT APPLICABLE\nNo rental decision", "No"),
        ("Rental request, claim link and state/product routing established?",
         "No", "REVIEW REQUIRED\nResolve request / routing", "Yes"),
        ("Express rental benefit and policy dates confirmed?",
         "No", "REVIEW REQUIRED\nResolve coverage / dates", "Yes"),
        ("Non-drivable evidence supports loss of use?",
         "Yes", "R1 SATISFIED\nNeed supported", "No"),
        ("Dated actual shop intake / release supports rental need?",
         "No", "REVIEW REQUIRED\nScheduled repair alone is insufficient", "Yes"),
    ]
    for index, (question, branch, outcome, down) in enumerate(nodes):
        y = 555 - index * 105
        path = c.beginPath()
        path.moveTo(165, y + 37)
        path.lineTo(315, y)
        path.lineTo(165, y - 37)
        path.lineTo(15, y)
        path.close()
        c.setFillColor(PALE)
        c.setStrokeColor(BLUE)
        c.drawPath(path, stroke=1, fill=1)
        label(question, 165, y, 193)
        c.roundRect(375, y - 35, 140, 70, 5, stroke=1, fill=0)
        label(outcome, 445, y, 123)
        arrow(315, y, 375, y, branch)
        arrow(165, y - 37, 165, y - (68 if index < 4 else 77), down)
    c.roundRect(40, 16, 250, 42, 5, stroke=1, fill=0)
    label("R1 SATISFIED: need supported.\nR2-R5 remain separate checks.", 165, 37, 235)
    c.showPage()
    c.save()
    with fitz.open(stream=buffer.getvalue(), filetype="pdf") as source:
        return source[0].get_pixmap(dpi=180, colorspace=fitz.csGRAY, alpha=False).tobytes("png")


def document_sections(document_id: str) -> dict[str, int]:
    sections = dict(SECTIONS)
    if document_id == "AZ-RENTAL-002":
        sections["5. Figure 1: rental eligibility (AZ-R1)"] = 5
    return sections


def build_document(document_id: str, stem: str, texts: list[str],
                   grids: list[list[list[str]]]) -> tuple[str, str]:
    """Keep content identical across editable, digital-control and scanned PDFs."""
    doc = Document()
    doc.styles["Normal"].font.name = "Segoe UI"
    doc.styles["Normal"].font.size = Pt(10)
    for section in doc.sections:
        section.left_margin = section.right_margin = Inches(0.6)
    doc.core_properties.title = texts[0].split(". Document")[0]
    doc.core_properties.author = "LAB664 synthetic training corpus"
    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=(612, 792), invariant=1)
    c.setTitle(f"{document_id} v{VERSION}")
    c.setAuthor("LAB664 synthetic training corpus")
    sections = document_sections(document_id)
    for page, section in enumerate(sections, 1):
        doc.add_heading(section, level=1)
        decorate(c, document_id, page, len(sections))
        y = heading(c, section)
        if page == 1:
            for text in texts:
                doc.add_paragraph(text)
                y = box(c, text, 45, y)
        elif page == 5:
            image = eligibility_figure()
            c.drawImage(ImageReader(io.BytesIO(image)), 45, 80, width=522, height=610)
            doc.add_picture(io.BytesIO(image), width=Inches(6.5))
            y = 80
        else:
            indexes = {2: [0], 3: [1, 2], 4: [3]}[page]
            for index in indexes:
                rows = grids[index]
                merged_end = index in [0, 1, 3]
                spans = [(0, 0, 2, 0)]
                if merged_end and rows[-1][1:] == ["", ""]:
                    spans.append((0, len(rows) - 1, 2, len(rows) - 1))
                y = table(c, rows, [104, 209, 209], y, spans)
                t = doc.add_table(rows=0, cols=3)
                t.style = "Table Grid"
                for row in rows:
                    for cell, value in zip(t.add_row().cells, row):
                        cell.text = value
                t.rows[0].cells[0].merge(t.rows[0].cells[2])
                if len(spans) > 1:
                    t.rows[-1].cells[0].merge(t.rows[-1].cells[2])
                doc.add_paragraph()
        if y < 55:
            raise ValueError(f"Page overflow: {document_id} page {page}")
        c.showPage()
        if page < len(sections):
            doc.add_page_break()
    c.save()
    digital = buffer.getvalue()
    control = OUT / "controls" / f"{stem}-text-control.pdf"
    control.write_bytes(digital)
    doc.save(OUT / "editable" / f"{stem}.docx")
    # TX isolates table structure; AZ isolates a raster flowchart. WA is entirely
    # scanned; other SOPs keep only the routing cover selectable.
    scanned = fitz.open()
    with fitz.open(stream=digital, filetype="pdf") as source:
        for index, page in enumerate(source):
            if document_id in {"TX-RENTAL-002", "AZ-RENTAL-002"} or (
                    index == 0 and document_id != "WA-RENTAL-002"):
                scanned.insert_pdf(source, from_page=index, to_page=index)
            else:
                image = page.get_pixmap(dpi=180, colorspace=fitz.csGRAY, alpha=False)
                target = scanned.new_page(width=612, height=792)
                target.insert_image(target.rect, stream=image.tobytes("png"))
    scanned.set_metadata({"title": f"{document_id} v{VERSION}",
                          "author": "LAB664 synthetic training corpus",
                          "subject": "Synthetic extraction comparison SOP; not law or payment authority"})
    pdf = OUT / f"{stem}.pdf"
    scanned.save(pdf, garbage=4, deflate=True, no_new_id=True)
    scanned.close()
    return digest(pdf.read_bytes()), digest(digital)


def expected_fixture() -> dict:
    meta = json.loads((ROOT / "data" / "packets.json").read_text(encoding="utf-8"))
    source_run = json.loads(
        (ROOT / "data" / "results" / RUN / "manifest.json").read_text(encoding="utf-8"))
    if source_run["status"] != "completed" or source_run["datasetHash"] != meta["datasetHash"]:
        raise ValueError("The fixture source run must be completed and match the current packet dataset.")
    non_rental = {
        "packet-03": ("07-invoice",),
        "packet-04": ("07-claim_form",),
        "packet-05": ("07-invoice",),
        "packet-06": ("03-claim_form", "07-claim_form"),
        "packet-07": ("07-invoice",),
        "packet-08": ("07-invoice",),
        "packet-10": ("07-claim_form",),
    }
    results = []
    names = ["Rental eligibility and need", "Daily rate", "Duration and repair alignment",
             "Charges and reimbursement calculation", "Authorization and payment readiness"]
    statuses = {
        "packet-01": ["ReviewRequired", "Satisfied", "ReviewRequired", "Satisfied", "ReviewRequired"],
        "packet-02": ["ReviewRequired"] * 5,
        "packet-09": ["Satisfied", "Satisfied", "ReviewRequired", "Satisfied", "ReviewRequired"],
    }
    reasons = {
        "packet-01": [
            "Drivable; actual shop intake/release not established.",
            "$54/day <= TX $75 routine and supplied $85 contract cap.",
            "4 billed days <= 7 routine; prior usage and actual downtime still unknown.",
            "4 x $54 + $21.60 named rental tax = $237.60; policy allows mandatory tax additional.",
            "Final return/bill does not establish insurer authorization.",
        ],
        "packet-02": [
            "Actual shop downtime supporting rental need not established.",
            "$61/day > WA $60 routine, below $85 policy cap; supervisor exception missing.",
            "5 billed days <= 5 routine; prior usage and actual downtime still unknown.",
            "$305 + $53.99 = $358.99 reconciles; $5.49 generic local levy needs mandatory-status support.",
            "No insurer authorization; rate exception also requires supervisor approval.",
        ],
        "packet-09": [
            "Non-drivable due to lighting damage; rental benefit and loss within supplied policy term.",
            "$73/day <= NY $75 routine and supplied $85 policy cap.",
            "4 billed days <= 5 routine; prior usage and full actual repair interval not established.",
            "$292 + $23.36 + $17.52 + $17.52 = $350.40; separately named taxes, "
            "not a certification of legal rates or location.",
            "Insurer authorization pending/absent; final return is not payment authority.",
        ],
    }
    for packet in meta["packets"]:
        packet_id, state = packet["id"], packet["region"]
        documents = {document["sourceId"]: document for document in packet["expectedDocuments"]}
        evidence = [documents[source_id] for source_id in non_rental.get(packet_id, ("07-invoice",))]
        pages = sorted({page for document in evidence
                        for page in range(document["start"], document["end"] + 1)})
        if packet_id in non_rental:
            label = "; ".join(document["title"] for document in evidence)
            outcomes = ["NotApplicable"] * 5
            explanations = [f"Confirmed {label}; no rental request. Do not treat policy premium, "
                            "limit or non-rental invoice as rental charges."] * 5
        else:
            outcomes, explanations = statuses[packet_id], reasons[packet_id]
        checks = []
        for index, (name, outcome, reason) in enumerate(zip(names, outcomes, explanations), 1):
            checks.append({
                "Check": name, "Outcome": outcome, "ReviewRequired": outcome == "ReviewRequired",
                "Reason": reason, "RuleId": f"{state}-R{index}",
            })
        results.append({
            "packetId": packet_id, "state": state, "stateSop": f"{state}-RENTAL-002",
            "version": VERSION, "sourcePages": pages,
            "sourceCu": f"../results/{RUN}/{packet_id}.cu.json",
            "outcome": "ReviewRequired" if any(c["ReviewRequired"] for c in checks) else "NotApplicable",
            "checks": checks,
        })
    return {
        "synthetic": True, "corpusId": "lab664-rental-ocr-comparison-v2",
        "sourceRun": RUN, "sourceDatasetHash": meta["datasetHash"], "executedAgentEvaluation": False,
        "evidenceBasis": "Current packet document inventory and saved root OCR, not an assertion "
        "that the current field-only claim-summary extraction is complete or correct.",
        "criticalCaveat": "Seven packets have no rental request in source evidence. Field-only CU summaries "
        "can misplace non-rental values under Rental. Until resolved, those "
        "contradictions require review, NOT NotApplicable. Do not insert this fixture into claim facts.",
        "target": {
            "cases": 10, "confirmedNonRentalCases": 7, "rentalCasesRequiringReview": 3,
            "checks": 50, "notApplicable": 35, "satisfied": 5, "reviewRequired": 10,
            "interpretation": "40/50 checks have no rental-review action, but 35 are N/A, not passes. "
            "No claim is approved for payment. These are conditional source-evidence expectations.",
        },
        "scenarios": results,
    }


def comparison_probes() -> dict:
    probes = []
    for code, _, rate, days, _, _ in STATES:
        stem = f"{code.lower()}-rental-review-sop-v2.pdf"
        probes.extend([
            {
                "id": f"{code}-routine-boundary",
                "source": stem, "page": 3, "ruleId": f"{code}-R2",
                "question": f"What routine daily base limit applies in {code}, and does equality pass? "
                "Distinguish that internal limit from the supplied $85/day contractual cap.",
                "expected": {"routineUsdPerDay": rate, "inclusive": True,
                             "policyCapUsdPerDay": "85.00", "atRoutineBoundary": "Satisfied"},
                "score": "One point only if value, inclusivity and independent contractual cap all match.",
            },
            {
                "id": f"{code}-duration-and-exception",
                "source": stem, "page": 3, "ruleId": f"{code}-R3",
                "question": f"How many rental days can {code} handle routinely, and can a supervisor "
                "approve an extension beyond the remaining policy benefit?",
                "expected": {"routineDays": days, "inclusive": True,
                             "supervisorCanExceedRemainingPolicyDays": False},
                "score": "One point only if correct duration row and non-waivable contractual boundary match.",
            },
        ])
    probes.extend([
        {
            "id": "WA-rate-exception", "source": "wa-rental-review-sop-v2.pdf", "page": 3,
            "ruleId": "WA-R2",
            "question": "WA rental base is $61/day; contract cap $85/day; no supervisor approval. "
            "Is the rate check satisfied, and why?",
            "expected": {"Outcome": "ReviewRequired", "routineUsdPerDay": "60.00",
                         "policyCapExceeded": False, "requiredAuthority": "rental supervisor"},
        },
        {
            "id": "WA-generic-levy", "source": "wa-rental-review-sop-v2.pdf", "page": 3,
            "ruleId": "WA-R4",
            "question": "WA invoice arithmetic reconciles but includes $5.49 of generically described "
            "local rental levies with no mandatory-status support. Does arithmetic alone satisfy R4?",
            "expected": {"Outcome": "ReviewRequired", "reason": "Mandatory status needs clarification"},
        },
        {
            "id": "FL-tow-identity", "source": "fl-rental-review-sop-v2.pdf", "page": 3,
            "ruleId": "FL-R2",
            "question": "A confirmed towing-only FL packet has a $283 flat tow bill and an $85/day "
            "rental benefit limit, but no rental request. Is $283 an over-limit rental rate?",
            "expected": {"Outcome": "NotApplicable", "towChargeIsRentalRate": False},
        },
        {
            "id": "OH-commercial-scope", "source": "oh-rental-review-sop-v2.pdf", "page": 1,
            "ruleId": "OH-R1",
            "question": "Does the OH SOP automatically exclude commercial delivery vehicles that have "
            "an express rental endorsement? Does fleet downtime alone establish a rental request?",
            "expected": {"commercialRentalEndorsementInScope": True, "downtimeIsRentalRequest": False},
            "supportingPage": 4,
        },
        {
            "id": "shared-unknown-not-na", "source": "shared-rental-evidence-standard-v2.pdf", "page": 2,
            "ruleId": "E-02",
            "question": "The extraction has no rental fields and does not establish the request type. "
            "Can the agent select NotApplicable?",
            "expected": {"Outcome": "ReviewRequired", "missingFieldsProveNoRequest": False},
        },
        {
            "id": "shared-checkbox-state", "source": "shared-rental-evidence-standard-v2.pdf", "page": 2,
            "ruleId": "E-04",
            "question": "A payment-authority checkbox is blank. Does that mean payment was denied, "
            "approved, or that the answer is unknown?",
            "expected": {"checkboxMeaning": "Unknown / unanswered", "impliesApproval": False},
        },
        {
            "id": "AZ-figure-scheduled-only", "source": "az-rental-review-sop-v2.pdf", "page": 5,
            "ruleId": "AZ-R1",
            "question": "A linked AZ rental request has valid coverage and routing. The vehicle is "
            "drivable and has only scheduled repairs, with no actual shop intake/release. "
            "Follow Figure 1: what is the eligibility outcome?",
            "expected": {"Outcome": "ReviewRequired", "scheduledRepairsEstablishNeed": False},
        },
        {
            "id": "AZ-figure-non-drivable", "source": "az-rental-review-sop-v2.pdf", "page": 5,
            "ruleId": "AZ-R1",
            "question": "A linked AZ rental request has confirmed routing, express benefit and valid "
            "policy dates. Non-drivable evidence supports loss of use; shop dates are absent. "
            "Follow Figure 1: does AZ-R1 pass, and does that approve all five checks?",
            "expected": {"Outcome": "Satisfied", "allFiveChecksApproved": False},
        },
        {
            "id": "AZ-figure-no-request", "source": "az-rental-review-sop-v2.pdf", "page": 5,
            "ruleId": "AZ-R1",
            "question": "Full AZ packet evidence confirms towing only and no rental request. "
            "Which Figure 1 terminal applies: Satisfied, NotApplicable or ReviewRequired?",
            "expected": {"Outcome": "NotApplicable", "rentalApproved": False},
        },
        {
            "id": "TX-blank-authority-band", "source": "tx-rental-review-sop-v2.pdf", "page": 3,
            "ruleId": "TX-R3",
            "question": "In TX Schedule A, the row allowing more than 7 days has a blank Authority "
            "band cell. Which band applies and who must approve the duration exception?",
            "expected": {"authorityBand": "Internal exception",
                         "requiredAuthority": "rental supervisor", "remainingPolicyDaysStillApply": True},
        },
        {
            "id": "TX-blank-duration-cell", "source": "tx-rental-review-sop-v2.pdf", "page": 3,
            "ruleId": "TX-R3",
            "question": "TX has a documented rate-only exception for $80/day within an $85 cap. "
            "Its Schedule A Days and approver cell is blank. Does that also authorize 9 days "
            "within a 14-day remaining policy benefit?",
            "expected": {"Outcome": "ReviewRequired", "blankMeansUnlimitedDays": False,
                         "routineDaysStillApply": 7, "durationApprovalRequired": True},
        },
        {
            "id": "TX-blank-rate-cell", "source": "tx-rental-review-sop-v2.pdf", "page": 3,
            "ruleId": "TX-R2",
            "question": "TX has a documented duration-only exception for 9 days. That Schedule A "
            "row has a blank Daily base rate cell. Does that also authorize $80/day below an "
            "$85/day contractual cap, without rate approval?",
            "expected": {"Outcome": "ReviewRequired", "blankMeansUnlimitedRate": False,
                         "routineUsdPerDayStillApply": "75.00", "rateApprovalRequired": True},
        },
    ])
    return {
        "synthetic": True, "executed": False, "includeInKnowledgeIndex": False,
        "purpose": "Score extraction/retrieval independently of claim-field completeness.",
        "scoring": "One point per complete expected object (32 total). Unknown/missing retrieval must "
        "abstain/review, not guess. Report correct, abstained and incorrect separately. "
        "Record citations and whether scanned rule text was actually retrieved.",
        "experiments": [
            "Standard versus Minimal on identical manifest PDFs (mixed figure/table/scan comparison).",
            "Standard versus Minimal on identical text controls (WA OCR control; AZ figure remains raster).",
        ],
        "probes": probes,
    }


def main() -> None:
    fonts = Path(r"C:\Windows\Fonts")
    pdfmetrics.registerFont(TTFont("Sop", str(fonts / "segoeui.ttf")))
    pdfmetrics.registerFont(TTFont("SopBold", str(fonts / "segoeuib.ttf")))
    for folder in [OUT, OUT / "editable", OUT / "controls"]:
        folder.mkdir(parents=True, exist_ok=True)
    entries, citations = [], []
    for state in STATES:
        code, _, rate, days, scope, _ = state
        document_id, stem = f"{code}-RENTAL-002", f"{code.lower()}-rental-review-sop-v2"
        pdf_hash, control_hash = build_document(document_id, stem, *state_content(state))
        rules = [f"{code}-R{i}" for i in range(1, 6)]
        entries.append({
            "documentId": document_id, "version": VERSION, "documentType": "state_sop",
            "states": [code], "productScope": scope, "benefit": "rental_reimbursement",
            "effectiveFrom": "2024-01-01", "effectiveThrough": "2026-12-31",
            "pdf": f"{stem}.pdf", "sha256": pdf_hash,
            "docx": f"editable/{stem}.docx",
            "textControl": f"controls/{stem}-text-control.pdf", "textControlSha256": control_hash,
            "ruleIds": rules, "requires": ["SHARED-EVIDENCE-002"],
            "routineAuthority": {"dailyBaseRateUsd": rate, "rentalDays": days,
                                 "inclusive": True, "contractualBenefit": False},
            "rulePages": list(range(2, len(document_sections(document_id)) + 1)),
            "pdfTextLayer": {"AZ": "digital-text-with-raster-eligibility-figure",
                             "TX": "digital-text-with-intentional-blank-table-cells",
                             "WA": "none"}.get(code, "routing-cover-only"),
        })
        citations.append({"documentId": document_id, "version": VERSION, "pdf": f"{stem}.pdf",
                          "sha256": pdf_hash, "ruleIds": rules, "sections": document_sections(document_id)})
    stem, document_id = "shared-rental-evidence-standard-v2", "SHARED-EVIDENCE-002"
    pdf_hash, control_hash = build_document(document_id, stem, *shared_content())
    rules = [f"E-0{i}" for i in range(1, 7)]
    entries.append({
        "documentId": document_id, "version": VERSION, "documentType": "shared_standard",
        "states": [s[0] for s in STATES], "benefit": "rental_reimbursement",
        "effectiveFrom": "2024-01-01", "effectiveThrough": "2026-12-31",
        "pdf": f"{stem}.pdf", "sha256": pdf_hash, "docx": f"editable/{stem}.docx",
        "textControl": f"controls/{stem}-text-control.pdf", "textControlSha256": control_hash,
        "ruleIds": rules, "rulePages": [2, 3, 4], "pdfTextLayer": "routing-cover-only",
    })
    citations.append({"documentId": document_id, "version": VERSION, "pdf": f"{stem}.pdf",
                      "sha256": pdf_hash, "ruleIds": rules, "sections": SECTIONS})
    manifest = {
        "corpusId": "lab664-rental-ocr-comparison-v2", "synthetic": True,
        "description": "Fictional figure/table/OCR test corpus; not law, policy benefits or payment approval.",
        "defaultIndexFormat": "pdf", "applicabilityDateField": "loss_date",
        "effectiveDateBounds": "inclusive", "status": "local-artifacts-not-deployed",
        "ingestOnly": "The eleven manifest pdf paths; not editable/, controls/, fixture or guides.",
        "documents": entries,
    }
    for name, value in [("manifest.json", manifest), ("citations.json", citations)]:
        (OUT / name).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    fixture = expected_fixture()
    (ROOT / "data" / "scenarios" / "rental-review-v2.expected.json").write_text(
        json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    (ROOT / "data" / "scenarios" / "rental-ocr-comparison.probes.json").write_text(
        json.dumps(comparison_probes(), indent=2) + "\n", encoding="utf-8")
    validate(manifest, fixture)


def validate(manifest: dict, fixture: dict) -> None:
    assert len(manifest["documents"]) == 11
    assert len({entry["documentId"] for entry in manifest["documents"]}) == 11
    assert len({entry["pdf"] for entry in manifest["documents"]}) == 11
    assert {p["region"] for p in json.loads((ROOT / "data" / "packets.json").read_text())["packets"]} \
        == {state for entry in manifest["documents"] for state in entry["states"]}
    for entry in manifest["documents"]:
        with fitz.open(OUT / entry["pdf"]) as scanned, fitz.open(OUT / entry["textControl"]) as control:
            assert len(scanned) == len(control) == len(document_sections(entry["documentId"]))
            if entry["documentId"] != "WA-RENTAL-002":
                assert entry["documentId"] in scanned[0].get_text()
            raster_pages = [] if entry["states"] == ["TX"] or entry["states"] == ["AZ"] else (
                [0, 1, 2, 3] if entry["states"] == ["WA"] else [1, 2, 3])
            for index in raster_pages:
                assert scanned[index].get_text().strip() == "", entry["pdf"]
                assert len(scanned[index].get_images()) == 1, entry["pdf"]
                assert len(control[index].get_text().strip()) > 300, entry["textControl"]
                xref = scanned[index].get_images()[0][0]
                assert fitz.Pixmap(scanned, xref).samples == control[index].get_pixmap(
                    dpi=180, colorspace=fitz.csGRAY, alpha=False).samples
            assert scanned.embfile_count() == 0
            for rule in entry["ruleIds"]:
                assert rule in "".join(p.get_text() for p in control)
            assert digest((OUT / entry["pdf"]).read_bytes()) == entry["sha256"]
            assert digest((OUT / entry["textControl"]).read_bytes()) == entry["textControlSha256"]
            assert len(Document(OUT / entry["docx"]).tables) == 4
            if entry["states"] == ["AZ"]:
                assert len(scanned[4].get_images()) == 1
                assert all(not scanned[i].get_images() for i in range(4))
                assert "Confirmed no rental request?" not in "".join(p.get_text() for p in scanned)
                assert len(Document(OUT / entry["docx"]).inline_shapes) == 1
                assert "5. Figure 1: rental eligibility (AZ-R1)" in scanned[4].get_text()
                assert "R1 SATISFIED" not in control[4].get_text()
                assert fitz.Pixmap(scanned, scanned[4].get_images()[0][0]).samples == fitz.Pixmap(
                    control, control[4].get_images()[0][0]).samples
            if entry["states"] == ["TX"]:
                assert all(not page.get_images() and page.get_text().strip() for page in scanned)
                rows = Document(OUT / entry["docx"]).tables[1].rows
                assert rows[3].cells[2].text == ""
                assert rows[4].cells[0].text == rows[4].cells[1].text == ""
                text = scanned[2].get_text()
                assert "Blank-cell key" in text and "$75.00" in text and "> 7 days" in text
            if entry["states"] in [["TX"], ["AZ"]]:
                for index in range(len(scanned)):
                    assert scanned[index].get_pixmap().samples == control[index].get_pixmap().samples
            if "routineAuthority" in entry and entry["states"] != ["TX"]:
                assert entry["routineAuthority"]["dailyBaseRateUsd"] not in scanned[0].get_text()
    outcomes = [check["Outcome"] for scenario in fixture["scenarios"] for check in scenario["checks"]]
    for outcome, key in [("NotApplicable", "notApplicable"), ("Satisfied", "satisfied"),
                         ("ReviewRequired", "reviewRequired")]:
        assert outcomes.count(outcome) == fixture["target"][key]
    print("Validated 11 documents / 45 pages: AZ raster flowchart, TX blank-cell table, "
          "WA four image-only pages, and eight routing-cover-only SOPs.")
    print("Conditional oracle: 35 NotApplicable, 5 Satisfied, 10 ReviewRequired; no payment approvals.")
    assert len(comparison_probes()["probes"]) == 32
    print("Created 32 extraction/retrieval probes; no service-performance claim or cloud changes.")


if __name__ == "__main__":
    main()
