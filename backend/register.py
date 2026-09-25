"""Build an equipment register from a binder PDF.

Usage: python register.py Binder1.pdf [assets.db]
"""

import os
import sqlite3
import sys
from collections import Counter

import pymupdf

from equipment import find_equipment
from pages import classify_page


def build_register(pdf_path):
    """Return (page_types, assets).

    page_types: {page_no: 'text' | 'stroke-text' | 'raster'}
    assets:     {tag: {'category', 'name', 'pages': set of page numbers}}
    """
    page_types, assets = {}, {}
    with pymupdf.open(pdf_path) as doc:
        for page_no, page in enumerate(doc, start=1):
            page_types[page_no] = classify_page(page)
            if page_types[page_no] != "text":
                continue  # not readable yet (OCR comes in a later milestone)
            for item in find_equipment(page):
                asset = assets.setdefault(
                    item["tag"],
                    {"category": item["category"], "name": "", "pages": set()},
                )
                asset["pages"].add(page_no)
                if not asset["name"]:
                    asset["name"] = item["name"]
    _fill_spare_names(assets)
    return page_types, assets


def _fill_spare_names(assets):
    """Spares share one printed name: give '0751-P-201B' the name of '0751-P-201A'."""
    names_by_base = {}
    for tag, asset in assets.items():
        if asset["name"]:
            names_by_base.setdefault(_base_tag(tag), asset["name"])
    for tag, asset in assets.items():
        if not asset["name"]:
            asset["name"] = names_by_base.get(_base_tag(tag), "")


def _base_tag(tag):
    """'0751-P-201B' -> '0751-P-201'."""
    return tag.rstrip("ABCDEFGHIJKLMNOPQRSTUVWXYZ")


def save(db_path, page_types, assets):
    """Write pages and equipment to a fresh SQLite database."""
    if os.path.exists(db_path):
        os.remove(db_path)
    with sqlite3.connect(db_path) as db:
        db.execute("CREATE TABLE pages (page_no INTEGER PRIMARY KEY, type TEXT)")
        db.execute(
            "CREATE TABLE equipment (tag TEXT PRIMARY KEY, category TEXT, name TEXT, pages TEXT)"
        )
        db.executemany("INSERT INTO pages VALUES (?, ?)", page_types.items())
        db.executemany(
            "INSERT INTO equipment VALUES (?, ?, ?, ?)",
            [
                (tag, a["category"], a["name"], ",".join(map(str, sorted(a["pages"]))))
                for tag, a in sorted(assets.items())
            ],
        )


def print_summary(page_types, assets):
    print(f"Pages: {len(page_types)}")
    for ptype, count in Counter(page_types.values()).most_common():
        print(f"  {ptype:12} {count}")
    unread = [n for n, t in page_types.items() if t != "text"]
    if unread:
        print(f"  Not read yet (need OCR): pages {unread}")

    print(f"\nEquipment by category ({len(assets)} tags in total):")
    for category, count in Counter(a["category"] for a in assets.values()).most_common():
        print(f"  {category:24} {count}")

    unknown = sorted(t for t, a in assets.items() if a["category"] == "Unknown")
    if unknown:
        print(f"\nUnknown prefixes, please review: {unknown}")


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    pdf_path = sys.argv[1]
    db_path = sys.argv[2] if len(sys.argv) == 3 else "assets.db"
    page_types, assets = build_register(pdf_path)
    save(db_path, page_types, assets)
    print_summary(page_types, assets)
    print(f"\nSaved to {db_path}")
