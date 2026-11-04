"""Generate and register the two-page, fictional repair-authority vector diagram.

Uses the existing rental-corpus ReportLab/PyMuPDF dependencies; no cloud access.
Only this source's PDF and registration entries are written. Existing registry
entries retain their exact serialization, including the manifest's CRLF bytes.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
from pathlib import Path
from xml.sax.saxutils import escape

import fitz
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "policies" / "rental" / "ocr-comparison-v2"
DOCUMENT_ID = "SYNTHETIC-REPAIR-REVIEW-001"
VERSION = "1.0"
PDF_NAME = "synthetic-repair-review-authority-v1.pdf"
STATES = (
    ("TX", 2500), ("WA", 1750), ("AZ", 2500), ("CO", 2500), ("FL", 2000),
    ("IL", 3000), ("LA", 10000), ("CA", 2000), ("NY", 4000), ("OH", 4000),
)
SECTIONS = {
    "Figure RE-1: TX WA AZ CO FL": 1,
    "Figure RE-2: IL LA CA NY OH": 2,
}
PAGE_SIZE = (1008, 792)
INK = colors.HexColor("#173E61")
PALE = colors.HexColor("#EEF4F8")
GREEN = colors.HexColor("#155438")
AMBER = colors.HexColor("#704C00")
RED = colors.HexColor("#822B2B")
DISCLAIMER = (
    "FICTIONAL / SYNTHETIC TRAINING ONLY. Not law, a coverage cap, denial, "
    "or payment approval. Internal routine handling authority only."
)
VALIDATION = (
    "Business rules validation | Compare each distinct relevant quote independently; "
    "never sum alternative quotes. Establish duplicate/supplement relationships from "
    "source evidence before merging, replacing or treating a supplement as incremental. "
    "Different quotes are Business rules validation, not failure.\n"
    "Precedence: any contradiction or established excess -> ReviewRequired, even if "
    "other evidence is missing. Otherwise missing necessary amount, currency, loss state "
    "or loss date -> Waiting. Satisfied requires all relevant comparisons complete and "
    "within routine authority. Retain the COMPLETE diagram, labels and branches in "
    "extraction/projection; a partial figure is unsupported rule evidence -> ReviewRequired."
)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def label(c: canvas.Canvas, text: str, x: float, y: float, width: float,
          height: float, size: float = 10.5, bold: bool = False,
          color: colors.Color = INK, center: bool = False) -> None:
    """Draw extractable text and reject any label that does not fit."""
    style = ParagraphStyle(
        "repair-label", fontName="RepairBold" if bold else "Repair",
        fontSize=size, leading=size * 1.26, textColor=color,
        alignment=1 if center else 0,
    )
    p = Paragraph(escape(text).replace("\n", "<br/>"), style)
    _, actual = p.wrap(width, height)
    if actual > height:
        raise ValueError(f"Label exceeds its diagram bounds: {text}")
    p.drawOn(c, x, y + (height - actual) / 2)


def node(c: canvas.Canvas, text: str, x: float, y: float, width: float,
         height: float, *, color: colors.Color = INK, size: float = 10.5,
         bold: bool = False, center: bool = False) -> None:
    c.setStrokeColor(color)
    c.setFillColor(PALE)
    c.setLineWidth(1.25)
    c.roundRect(x, y, width, height, 8, fill=1, stroke=1)
    label(c, text, x + 10, y + 7, width - 20, height - 14,
          size=size, bold=bold, color=color, center=center)


def line(c: canvas.Canvas, points: list[tuple[float, float]], *,
         color: colors.Color = INK, arrow: bool = True,
         dashed: bool = False) -> None:
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(1.1)
    c.setDash(4, 3) if dashed else c.setDash()
    path = c.beginPath()
    path.moveTo(*points[0])
    for point in points[1:]:
        path.lineTo(*point)
    c.drawPath(path)
    c.setDash()
    if arrow:
        x, y = points[-1]
        px, py = points[-2]
        angle = math.atan2(y - py, x - px)
        path = c.beginPath()
        path.moveTo(x, y)
        for delta in (-0.5, 0.5):
            path.lineTo(x - 7 * math.cos(angle + delta),
                        y - 7 * math.sin(angle + delta))
        path.close()
        c.drawPath(path, fill=1, stroke=0)


def draw_page(c: canvas.Canvas, page: int) -> None:
    group = STATES[(page - 1) * 5:page * 5]
    section = list(SECTIONS)[page - 1]
    other_section = list(SECTIONS)[2 - page]
    label(c, "Synthetic repair review authority", 32, 745, 944, 29,
          size=21, bold=True)
    label(c, f"{DOCUMENT_ID} | Internal claims handling | Gross USD | Version {VERSION}",
          32, 724, 944, 19, size=11)
    label(c, f"{section} | Effective loss dates 2024-01-01 through 2026-12-31 inclusive",
          32, 701, 944, 20, size=11, bold=True)

    node(c, "A. Repair estimate/request present?\n"
         "Yes -> B. Unknown -> W.\n"
         "Affirmative source confirms none -> N.\n"
         "Contradictory evidence -> F.",
         32, 610, 270, 88)
    node(c, "B. Each quote | REPAIR-SCOPE-01\n"
         "Gross stated total including tax BEFORE\n"
         "deductible/payments; confirm USD and\n"
         "loss state/date. Ready -> C; unknown -> W.",
         370, 610, 270, 88)
    node(c, "C. Supported applicable rule?\n"
         "Use version 1.0 and inclusive dates.\n"
         "Supported -> D; missing, ambiguous or\n"
         "unsupported rule / outside dates -> F.",
         708, 610, 270, 88)
    line(c, [(302, 653), (370, 653)])
    label(c, "Yes", 307, 656, 58, 18, size=10, center=True)
    line(c, [(640, 653), (708, 653)])
    label(c, "Ready", 641, 656, 65, 18, size=10, center=True)

    node(c, "N. NotApplicable\nAffirmative source only; missing fields are not proof.",
         32, 520, 270, 54, size=10, bold=True)
    node(c, "W. Waiting\nUnknown necessary facts; unless contradiction/excess -> F.",
         370, 520, 270, 54, size=10, color=AMBER, bold=True)
    node(c, "F. ReviewRequired\nContradiction, excess or unsupported/ambiguous rule.",
         708, 520, 270, 54, size=10, color=RED, bold=True)
    for x, text in ((167, "Affirmative none"), (505, "Unknown"), (843, "Refer")):
        line(c, [(x, 610), (x, 574)])
        label(c, text, x + 6, 575, 126, 28, size=9.5)
    line(c, [(963, 610), (963, 592), (16, 592), (16, 475), (32, 475)])
    label(c, "Supported rule + known loss state/date -> D", 260, 593, 470, 16, size=9.5)

    node(c, "D. Route by LOSS STATE, not shop state. Select exactly one state branch below.\n"
         f"Other listed loss states -> {other_section}. Unsupported state -> F.\n"
         "Unknown state -> W: cite REPAIR-SCOPE-01; no substitute state and no applied threshold.",
         32, 442, 946, 64, bold=True)
    centers = [120 + 192 * i for i in range(5)]
    line(c, [(505, 442), (505, 424)], arrow=False)
    line(c, [(centers[0], 424), (centers[-1], 424)], arrow=False)
    for center, (state, amount) in zip(centers, group):
        line(c, [(center, 424), (center, 390)])
        label(c, state, center + 7, 395, 44, 20, size=10, bold=True)
        c.setFillColor(INK)
        c.circle(center, 424, 2, fill=1, stroke=0)
        node(c, f"{state} | REPAIR-{state}-01\n"
             f"Gross USD <= {amount:,.2f}?\n"
             "YES: <= -> S (pass)\n"
             "NO: > -> R (refer)",
             center - 88, 304, 176, 86, bold=True, center=True, size=10)

    line(c, [(centers[0] - 30, 264), (centers[-1] - 30, 264)],
         color=GREEN, arrow=False)
    line(c, [(centers[0] + 30, 241), (centers[-1] + 30, 241)],
         color=RED, arrow=False, dashed=True)
    for center in centers:
        line(c, [(center - 30, 304), (center - 30, 264)],
             color=GREEN, arrow=False)
        c.setFillColor(GREEN)
        c.circle(center - 30, 264, 2, fill=1, stroke=0)
        # A white-backed bridge crosses the pass rail without joining it.
        line(c, [(center + 30, 304), (center + 30, 270)],
             color=RED, arrow=False, dashed=True)
        c.setStrokeColor(colors.white)
        c.setLineWidth(5)
        bridge = c.beginPath()
        bridge.moveTo(center + 30, 270)
        bridge.curveTo(center + 41, 270, center + 41, 258, center + 30, 258)
        c.drawPath(bridge)
        c.setStrokeColor(RED)
        c.setLineWidth(1.1)
        c.drawPath(bridge)
        line(c, [(center + 30, 258), (center + 30, 241)],
             color=RED, arrow=False, dashed=True)
        c.setFillColor(RED)
        c.circle(center + 30, 241, 2, fill=1, stroke=0)
    line(c, [(167, 264), (167, 223)], color=GREEN)
    line(c, [(843, 241), (843, 223)], color=RED, dashed=True)
    label(c, "Solid: YES / <= (inclusive) -> S", 312, 195, 390, 18,
          size=10, bold=True, color=GREEN, center=True)
    label(c, "Dashed: NO / > -> R | bridges are not junctions",
          290, 174, 430, 17, size=9.5, color=RED, center=True)
    node(c, "S. Satisfied | Pass routine handling check\n"
         "Only if all relevant quote checks are complete.\nNot payment approval.",
         32, 165, 270, 58, color=GREEN, size=10, bold=True)
    node(c, "R. ReviewRequired | Refer for human review\n"
         "Any established excess; not a failure,\ndenial or payment decision.",
         708, 165, 270, 58, color=RED, size=10, bold=True)
    node(c, VALIDATION, 32, 49, 946, 101, size=10)
    label(c, DISCLAIMER, 32, 24, 944, 20, size=10, bold=True, color=RED)
    label(c, f"Self-contained controlling diagram | Page {page} of 2",
          32, 8, 944, 14, size=9)
    c.showPage()


def build_pdf() -> bytes:
    fonts = Path(r"C:\Windows\Fonts")
    pdfmetrics.registerFont(TTFont("Repair", str(fonts / "segoeui.ttf")))
    pdfmetrics.registerFont(TTFont("RepairBold", str(fonts / "segoeuib.ttf")))
    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=PAGE_SIZE, invariant=1, pageCompression=1)
    c.setTitle(f"{DOCUMENT_ID} v{VERSION} - Synthetic repair review authority")
    c.setAuthor("LAB664 synthetic training corpus")
    c.setSubject(DISCLAIMER)
    for page in (1, 2):
        draw_page(c, page)
    c.save()
    data = buffer.getvalue()
    with fitz.open(stream=data, filetype="pdf") as pdf:
        if len(pdf) != 2 or any(p.get_images() for p in pdf):
            raise ValueError("The authority source must be a two-page vector PDF.")
        for page, section in zip(pdf, SECTIONS):
            if section not in page.get_text():
                raise ValueError("The complete diagram must remain extractable.")
    return data


def registrations(pdf_hash: str) -> tuple[dict, dict]:
    shared = {
        "documentId": DOCUMENT_ID, "version": VERSION, "pdf": PDF_NAME,
        "sha256": pdf_hash,
        "ruleIds": ["REPAIR-SCOPE-01", *[f"REPAIR-{s}-01" for s, _ in STATES]],
        "stateRules": {state: {"page": index // 5 + 1, "ruleId": f"REPAIR-{state}-01"}
                       for index, (state, _) in enumerate(STATES)},
    }
    manifest = {
        **shared, "documentType": "repair_review_sop", "role": "repair_review",
        "states": [s for s, _ in STATES],
        "effectiveFrom": "2024-01-01", "effectiveThrough": "2026-12-31",
        "effectiveDateBounds": "inclusive", "applicabilityDateField": "loss_date",
        "authorityBasis": "fictional_internal_gross_usd_routine_handling",
        "diagramAuthority": "controlling", "rulePages": [1, 2],
        "pdfTextLayer": "complete-vector-diagram",
        "extractionRequirement": "Retain each complete page diagram, all state values, "
        "labels and decision branches in extraction/projection; partial rule evidence "
        "requires review.",
    }
    return manifest, {**shared, "sections": SECTIONS}


def upsert_registration(raw: bytes, entry: dict, *, manifest: bool) -> bytes:
    """Change only our array element; leave all original entries byte-for-byte."""
    text = raw.decode("utf-8")
    if not manifest:
        text = text.replace("\r\n", "\n")
    newline = "\r\n" if manifest else "\n"
    if text.replace(newline, "").find("\n") != -1:
        raise ValueError("Unexpected registry line endings.")
    value = json.loads(text)
    if manifest:
        if not isinstance(value, dict) or not isinstance(value.get("documents"), list):
            raise ValueError("The manifest must have a documents list.")
        offset = text.index("[", text.index('"documents"')) + 1
        indent = "    "
    else:
        if not isinstance(value, list):
            raise ValueError("Citations must be a list.")
        offset = text.index("[") + 1
        indent = "  "
    decoder = json.JSONDecoder()
    matches = []
    last_end = None
    while True:
        while text[offset].isspace() or text[offset] == ",":
            offset += 1
        if text[offset] == "]":
            break
        item, end = decoder.raw_decode(text, offset)
        if item.get("documentId") == DOCUMENT_ID:
            matches.append((offset, end))
        last_end, offset = end, end
    if len(matches) > 1:
        raise ValueError("Duplicate repair source registrations.")
    formatted = json.dumps(entry, indent=2)
    formatted = formatted.replace("\n", newline + indent)
    if matches:
        start, end = matches[0]
        result = text[:start] + formatted + text[end:]
    else:
        position = last_end if last_end is not None else offset
        addition = ("," if last_end is not None else "") + newline + indent + formatted
        result = text[:position] + addition + text[position:]
    json.loads(result)
    return result.encode("utf-8")


def main() -> None:
    original_pdfs = {p: digest(p.read_bytes()) for p in OUT.rglob("*.pdf")
                     if p != OUT / PDF_NAME}
    manifest_path, citations_path = OUT / "manifest.json", OUT / "citations.json"
    manifest_raw, citations_raw = manifest_path.read_bytes(), citations_path.read_bytes()
    for entry in json.loads(manifest_raw)["documents"]:
        if entry["documentId"] != DOCUMENT_ID:
            if digest((OUT / entry["pdf"]).read_bytes()) != entry["sha256"]:
                raise ValueError(f"Existing PDF differs from its manifest: {entry['pdf']}")
    data = build_pdf()
    manifest_entry, citation_entry = registrations(digest(data))
    updates = {
        OUT / PDF_NAME: data,
        manifest_path: upsert_registration(manifest_raw, manifest_entry, manifest=True),
        citations_path: upsert_registration(citations_raw, citation_entry, manifest=False),
    }
    for path, content in updates.items():
        if not path.exists() or path.read_bytes() != content:
            path.write_bytes(content)
    if any(digest(path.read_bytes()) != expected for path, expected in original_pdfs.items()):
        raise ValueError("An existing PDF changed during generation.")
    print(f"{PDF_NAME}: 2 vector pages; 15 nodes per page; SHA-256 {digest(data)}")
    print(f"Registered {DOCUMENT_ID}; {len(original_pdfs)} original PDFs unchanged.")


if __name__ == "__main__":
    main()
