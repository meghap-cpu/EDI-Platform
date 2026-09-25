"""Find equipment on a P&ID page.

Rule (observed in Binder1): each piece of equipment has a large-font title
(16-20pt) on the sheet where it is drawn, e.g. "0751-V-101", with its name
printed just below it ("ACID GAS K.O. DRUM"). References to the same
equipment on other sheets use ~10pt text, so they are ignored here.
"""

import re

import pymupdf

# Prefix meanings, taken from the names printed under the titles in Binder1.
CATEGORIES = {
    "B": "Blower",
    "E": "Heat exchanger",
    "F": "Filter",
    "H": "Furnace / incinerator",
    "HB": "Burner",
    "J": "Ejector",
    "ME": "Equipment package",
    "P": "Pump",
    "PM": "Pump motor",
    "R": "Reactor",
    "S": "Stack",
    "SU": "Sump",
    "TK": "Tank",
    "V": "Vessel / drum",
    "X": "Miscellaneous item",  # seal traps, silencer, attemperators
}

TITLE_MIN_FONT_SIZE = 15
NAME_MIN_FONT_SIZE = 12
NAME_MAX_GAP = 40  # max distance (points) between title and the name below it

# Optional unit, prefix, 3-digit number, optional spare letters: "0751-P-201A/B"
TAG_RE = re.compile(r"^(?:(\d{4})-)?([A-Z]{1,3})-(\d{3})([A-Z](?:/[A-Z])*)?$")
UNIT_RE = re.compile(r"UNIT\s+(\d{4})")


def page_unit(page):
    """Return the unit number from the title block, e.g. '0751', or None."""
    match = UNIT_RE.search(page.get_text())
    return match.group(1) if match else None


def expand_tag(unit, prefix, number, letters):
    """'P', '201', 'A/B' -> ['0751-P-201A', '0751-P-201B']."""
    base = f"{unit}-{prefix}-{number}" if unit else f"{prefix}-{number}"
    if not letters:
        return [base]
    return [base + letter for letter in letters.split("/")]


def find_equipment(page):
    """Return a list of {'tag', 'category', 'name'} for equipment titled on this page."""
    default_unit = page_unit(page)
    spans = [
        span
        for block in page.get_text("dict")["blocks"]
        for line in block.get("lines", [])
        for span in line["spans"]
    ]

    found = []
    for span in spans:
        if span["size"] < TITLE_MIN_FONT_SIZE:
            continue
        match = TAG_RE.match(span["text"].strip())
        if not match:
            continue
        unit, prefix, number, letters = match.groups()
        name = _name_below(page, span, spans)
        for tag in expand_tag(unit or default_unit, prefix, number, letters):
            found.append({
                "tag": tag,
                "category": CATEGORIES.get(prefix, "Unknown"),
                "name": name,
            })
    return found


def _name_below(page, title, spans):
    """Return the text printed directly below a title, as seen on screen, or ''."""
    # Most sheets are rotated, so compare positions in on-screen coordinates.
    title_rect = pymupdf.Rect(title["bbox"]) * page.rotation_matrix
    best, best_gap = "", NAME_MAX_GAP
    for span in spans:
        text = span["text"].strip()
        if span is title or span["size"] < NAME_MIN_FONT_SIZE or TAG_RE.match(text):
            continue
        rect = pymupdf.Rect(span["bbox"]) * page.rotation_matrix
        gap = rect.y0 - title_rect.y1
        overlaps = min(rect.x1, title_rect.x1) > max(rect.x0, title_rect.x0)
        if 0 <= gap < best_gap and overlaps:
            best, best_gap = text, gap
    return best
