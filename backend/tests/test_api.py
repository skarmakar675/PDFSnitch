import io
import zipfile

from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfReader
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

from backend.app import app

client = TestClient(app)


def sample_pdf(page_count=3):
    output = io.BytesIO()
    document = canvas.Canvas(output, pagesize=letter)
    for page in range(1, page_count + 1):
        document.setFillColorRGB(0.04 * page, 0.35, 0.55)
        document.rect(0, 0, 612, 792, fill=1, stroke=0)
        document.setFillColorRGB(1, 1, 1)
        document.setFont("Helvetica-Bold", 34)
        document.drawString(72, 650, f"PDFSnitch fixture page {page}")
        for row in range(12):
            document.drawString(72, 600 - row * 30, f"Test content line {row + 1}")
        document.showPage()
    document.save()
    return output.getvalue()


def sample_image(color, fmt="PNG"):
    output = io.BytesIO()
    Image.new("RGB", (900, 700), color).save(output, fmt, quality=95)
    return output.getvalue()


def pdf_file(data=None, name="fixture.pdf"):
    return {"file": (name, data or sample_pdf(), "application/pdf")}


def assert_pdf(data, pages):
    reader = PdfReader(io.BytesIO(data))
    assert len(reader.pages) == pages
    return reader


def test_health_and_preview():
    assert client.get("/api/health").json()["status"] == "ok"
    response = client.post("/api/preview", files=pdf_file(), data={"max_pages": "10"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["page_count"] == 3
    assert len(payload["previews"]) == 3
    assert payload["previews"][0]["src"].startswith("data:image/png;base64,")


def test_split_individual_and_ranges():
    individual = client.post("/api/split", files=pdf_file(), data={"mode": "individual"})
    assert individual.status_code == 200
    with zipfile.ZipFile(io.BytesIO(individual.content)) as archive:
        assert len(archive.namelist()) == 3
        assert_pdf(archive.read(archive.namelist()[0]), 1)
    ranges = client.post("/api/split", files=pdf_file(), data={"mode": "ranges", "ranges": "1,3"})
    assert ranges.status_code == 200
    assert_pdf(ranges.content, 2)


def test_pdf_to_png_and_jpg():
    for image_format in ("png", "jpg"):
        response = client.post("/api/pdf-to-images", files=pdf_file(), data={"format": image_format, "dpi": "72"})
        assert response.status_code == 200
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            assert len(archive.namelist()) == 3
            with Image.open(io.BytesIO(archive.read(archive.namelist()[0]))) as image:
                assert image.width > 500


def test_images_to_pdf():
    files = [
        ("files", ("one.png", sample_image("red"), "image/png")),
        ("files", ("two.jpg", sample_image("blue", "JPEG"), "image/jpeg")),
    ]
    response = client.post("/api/images-to-pdf", files=files)
    assert response.status_code == 200
    assert_pdf(response.content, 2)


def test_compression_returns_metrics_and_valid_pdf():
    source = sample_pdf()
    response = client.post("/api/compress", files=pdf_file(source), data={"level": "high"})
    assert response.status_code == 200
    assert int(response.headers["x-original-size"]) == len(source)
    assert int(response.headers["x-compressed-size"]) == len(response.content)
    assert float(response.headers["x-compression-percent"]) >= 0
    assert_pdf(response.content, 3)


def test_delete_pages_and_merge():
    deleted = client.post("/api/delete-pages", files=pdf_file(), data={"pages": "2"})
    assert deleted.status_code == 200
    assert_pdf(deleted.content, 2)
    merge_files = [
        ("files", ("one.pdf", sample_pdf(2), "application/pdf")),
        ("files", ("two.pdf", sample_pdf(1), "application/pdf")),
    ]
    merged = client.post("/api/merge", files=merge_files)
    assert merged.status_code == 200
    assert_pdf(merged.content, 3)


def test_rotate_watermark_protect_and_unlock():
    rotated = client.post("/api/rotate", files=pdf_file(sample_pdf(1)), data={"degrees": "90"})
    assert rotated.status_code == 200
    assert assert_pdf(rotated.content, 1).pages[0].rotation == 90
    watermarked = client.post("/api/watermark", files=pdf_file(sample_pdf(1)), data={"text": "CONFIDENTIAL", "opacity": "35"})
    assert watermarked.status_code == 200
    assert_pdf(watermarked.content, 1)
    protected = client.post("/api/protect", files=pdf_file(sample_pdf(1)), data={"password": "secret12"})
    assert protected.status_code == 200
    assert PdfReader(io.BytesIO(protected.content)).is_encrypted
    unlocked = client.post("/api/unlock", files=pdf_file(protected.content, "protected.pdf"), data={"password": "secret12"})
    assert unlocked.status_code == 200
    assert_pdf(unlocked.content, 1)


def test_validation_errors_are_safe():
    invalid = client.post("/api/split", files={"file": ("bad.pdf", b"not a pdf", "application/pdf")}, data={"mode": "individual"})
    assert invalid.status_code in {415, 422}
    assert "detail" in invalid.json()
    all_deleted = client.post("/api/delete-pages", files=pdf_file(sample_pdf(1)), data={"pages": "1"})
    assert all_deleted.status_code == 400
