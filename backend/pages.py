"""Classify binder pages by how their text can be read."""

# A page mostly covered by an embedded image is a scan.
RASTER_MIN_IMAGE_COVERAGE = 0.5
# A page with almost no text but many drawn paths has its text drawn as lines
# (CAD stroke fonts). Page 132 of Binder1: 0 words, ~17,500 paths.
STROKE_MAX_WORDS = 50
STROKE_MIN_PATHS = 1000


def classify_page(page):
    """Return 'raster', 'stroke-text' or 'text' for a PyMuPDF page."""
    page_area = abs(page.rect)
    image_area = sum(
        abs(rect)
        for image in page.get_images()
        for rect in page.get_image_rects(image[0])
    )
    if image_area > RASTER_MIN_IMAGE_COVERAGE * page_area:
        return "raster"

    word_count = len(page.get_text("words"))
    # get_drawings() is slow, so only call it when the page has little text.
    if word_count < STROKE_MAX_WORDS and len(page.get_drawings()) > STROKE_MIN_PATHS:
        return "stroke-text"

    return "text"
