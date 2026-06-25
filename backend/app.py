from __future__ import annotations

import base64
import html
import io
import logging
import os
import re
import shutil
import subprocess
import tempfile
import uuid
import zipfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable

import fitz
from docx import Document
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from PIL import Image, UnidentifiedImageError
from pypdf import PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.lib.colors import Color
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.pdfgen import canvas
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

logger = logging.getLogger("pdfsnitch")

MAX_UPLOAD_BYTES = int(os.getenv("PDFSNITCH_MAX_UPLOAD_MB", "50")) * 1024 * 1024
MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES * 10
TEMP_ROOT = Path(os.getenv("PDFSNITCH_TEMP_DIR", str(Path(tempfile.gettempdir()) / "pdfsnitch"))).resolve()
TEMP_ROOT.mkdir(parents=True, exist_ok=True)

PDF_EXTENSIONS = {".pdf"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
DOCX_EXTENSIONS = {".docx"}

app = FastAPI(title="PDFSnitch API", version="1.0.0")
origins = [item.strip() for item in os.getenv(
    "PDFSNITCH_FRONTEND_ORIGINS",
    "http://127.0.0.1:4173,http://localhost:4173,http://127.0.0.1:5173,http://localhost:5173",
).split(",") if item.strip()]
origin_regex = os.getenv("PDFSNITCH_FRONTEND_ORIGIN_REGEX", r"https://.*\.vercel\.app").strip() or None
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_origin_regex=origin_regex,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)


@app.middleware("http")
async def reject_oversized_requests(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_REQUEST_BYTES:
        return JSONResponse({"detail": "The upload is too large."}, status_code=413)
    return await call_next(request)


@app.exception_handler(Exception)
async def unexpected_error(_request: Request, _error: Exception):
    logger.exception("Unhandled PDFSnitch processing error", exc_info=_error)
    return JSONResponse({"detail": "Processing failed. Check the file and try again."}, status_code=500)


@contextmanager
def isolated_job():
    with tempfile.TemporaryDirectory(prefix="job-", dir=TEMP_ROOT) as directory:
        yield Path(directory)


def safe_stem(filename: str | None, fallback: str = "document") -> str:
    stem = Path(filename or fallback).stem
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip(".-")
    return cleaned[:80] or fallback


async def read_upload(upload: UploadFile, allowed: set[str]) -> tuple[bytes, str]:
    filename = Path(upload.filename or "upload").name
    extension = Path(filename).suffix.lower()
    if extension not in allowed:
        raise HTTPException(415, f"Unsupported file type: {extension or 'unknown'}")
    data = await upload.read(MAX_UPLOAD_BYTES + 1)
    if not data:
        raise HTTPException(400, "The uploaded file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"Each file must be {MAX_UPLOAD_BYTES // 1024 // 1024} MB or smaller.")
    with isolated_job() as job:
        upload_path = job / f"{uuid.uuid4().hex}{extension}"
        upload_path.write_bytes(data)
        if extension == ".pdf":
            if not data.startswith(b"%PDF"):
                raise HTTPException(415, "The uploaded file is not a valid PDF.")
            try:
                reader = PdfReader(upload_path)
                if not reader.pages:
                    raise ValueError("No pages")
            except Exception as exc:
                raise HTTPException(422, "The PDF is damaged, empty, or password protected.") from exc
        elif extension in IMAGE_EXTENSIONS:
            try:
                with Image.open(upload_path) as image:
                    image.verify()
            except (UnidentifiedImageError, OSError) as exc:
                raise HTTPException(415, "The uploaded file is not a valid image.") from exc
        elif extension == ".docx":
            if not data.startswith(b"PK"):
                raise HTTPException(415, "The uploaded file is not a valid DOCX file.")
            try:
                document = Document(upload_path)
                if not document.paragraphs and not document.tables:
                    raise ValueError("No readable content")
            except Exception as exc:
                raise HTTPException(422, "The Word document is damaged, empty, or unsupported. Please upload a .docx file.") from exc
    return data, filename


def parse_pages(value: str, page_count: int) -> list[int]:
    if not value.strip():
        raise HTTPException(400, "Enter at least one page number or range.")
    pages: set[int] = set()
    for token in value.replace(" ", "").split(","):
        if not token:
            continue
        if "-" in token:
            pieces = token.split("-", 1)
            if not all(piece.isdigit() for piece in pieces):
                raise HTTPException(400, f"Invalid page range: {token}")
            start, end = map(int, pieces)
            if start > end:
                raise HTTPException(400, f"Page range must increase: {token}")
            pages.update(range(start, end + 1))
        elif token.isdigit():
            pages.add(int(token))
        else:
            raise HTTPException(400, f"Invalid page number: {token}")
    if not pages or min(pages) < 1 or max(pages) > page_count:
        raise HTTPException(400, f"Pages must be between 1 and {page_count}.")
    return sorted(page - 1 for page in pages)


def pdf_bytes(writer: PdfWriter) -> bytes:
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def attachment(data: bytes, filename: str, media_type: str, headers: dict[str, str] | None = None) -> Response:
    response_headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    response_headers.update(headers or {})
    return Response(data, media_type=media_type, headers=response_headers)


def zip_files(entries: Iterable[tuple[str, bytes]]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for filename, data in entries:
            archive.writestr(filename, data)
    return output.getvalue()


def docx_to_pdf_bytes(data: bytes) -> bytes:
    source = Document(io.BytesIO(data))
    output = io.BytesIO()
    pdf = SimpleDocTemplate(
        output,
        pagesize=letter,
        rightMargin=42,
        leftMargin=42,
        topMargin=48,
        bottomMargin=48,
        title="PDFSnitch Word conversion",
    )
    styles = getSampleStyleSheet()
    story = []

    for paragraph in source.paragraphs:
        text = paragraph.text.strip()
        if not text:
            story.append(Spacer(1, 8))
            continue
        style_name = "Heading1" if paragraph.style and "Heading" in paragraph.style.name else "BodyText"
        story.append(Paragraph(html.escape(text), styles[style_name]))
        story.append(Spacer(1, 8))

    for table in source.tables:
        rows = []
        for row in table.rows:
            rows.append([Paragraph(html.escape(cell.text.strip() or " "), styles["BodyText"]) for cell in row.cells])
        if rows:
            story.append(Spacer(1, 10))
            table_node = Table(rows, repeatRows=1)
            table_node.setStyle(TableStyle([
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#bfd8d2")),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8fff8")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]))
            story.append(table_node)
            story.append(Spacer(1, 12))

    if not story:
        story.append(Paragraph("No readable text found in this Word document.", styles["BodyText"]))
    pdf.build(story)
    return output.getvalue()


def normalized_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def page_has_selectable_text(page: fitz.Page) -> bool:
    text = normalized_text(page.get_text("text"))
    return len(text) >= 12


def extract_page_blocks(page: fitz.Page, textpage=None) -> list[str]:
    blocks = page.get_text("blocks", sort=True, textpage=textpage) if textpage else page.get_text("blocks", sort=True)
    content: list[str] = []
    for block in blocks:
        if len(block) < 5:
            continue
        text = str(block[4] or "").strip()
        if not text:
            continue
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        if lines:
            content.append("\n".join(lines))
    if not content:
        fallback = page.get_text("text", textpage=textpage).strip() if textpage else page.get_text("text").strip()
        if fallback:
            content.append(fallback)
    return content


def tesseract_status() -> dict[str, Any]:
    command = os.getenv("TESSERACT_CMD", "tesseract").strip() or "tesseract"
    binary = shutil.which(command)
    status: dict[str, Any] = {
        "available": False,
        "binary": binary or "",
        "version": "",
        "languages": [],
        "required_language": os.getenv("PDFSNITCH_OCR_LANG", "eng").strip() or "eng",
        "tessdata_prefix": os.getenv("TESSDATA_PREFIX", ""),
        "error": "",
    }
    if not binary:
        status["error"] = f"Tesseract command not found: {command}"
        return status
    try:
        version = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=10)
        status["version"] = (version.stdout or version.stderr).splitlines()[0].strip()
    except Exception as exc:
        status["error"] = f"Cannot run Tesseract: {exc}"
        return status
    try:
        languages = subprocess.run([binary, "--list-langs"], capture_output=True, text=True, timeout=10)
        listed = [
            line.strip()
            for line in (languages.stdout or "").splitlines()
            if line.strip() and not line.lower().startswith("list of")
        ]
        status["languages"] = listed
        required = status["required_language"]
        required_parts = [part for part in re.split(r"[+,\s]+", required) if part]
        status["available"] = all(part in listed for part in required_parts) if listed else True
        if not status["available"]:
            status["error"] = f"Required OCR language is missing: {required}"
    except Exception as exc:
        status["available"] = True
        status["error"] = f"Tesseract is installed, but languages could not be listed: {exc}"
    return status


def tesseract_ocr_page_blocks(page: fitz.Page, language: str, dpi: int) -> tuple[list[str], str | None]:
    command = os.getenv("TESSERACT_CMD", "tesseract").strip() or "tesseract"
    binary = shutil.which(command)
    if not binary:
        return [], f"Tesseract command not found: {command}"

    timeout = int(os.getenv("PDFSNITCH_OCR_TIMEOUT", "60"))
    page_dpi = max(100, min(dpi, 300))
    with tempfile.TemporaryDirectory(prefix="ocr-page-", dir=TEMP_ROOT) as directory:
        image_path = Path(directory) / f"page-{page.number + 1}.png"
        try:
            pixmap = page.get_pixmap(dpi=page_dpi, alpha=False, colorspace=fitz.csRGB)
            pixmap.save(image_path)
        except Exception as exc:
            return [], f"Could not render page for OCR: {exc}"

        command_args = [
            binary,
            str(image_path),
            "stdout",
            "-l",
            language,
            "--psm",
            os.getenv("PDFSNITCH_OCR_PSM", "6").strip() or "6",
        ]
        try:
            completed = subprocess.run(command_args, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return [], f"Tesseract OCR timed out after {timeout} seconds"
        except Exception as exc:
            return [], f"Tesseract OCR failed to start: {exc}"

        if completed.returncode != 0:
            return [], (completed.stderr or completed.stdout or "Tesseract OCR failed.").strip()

        text = completed.stdout.strip()
        if not text:
            return [], "Tesseract OCR did not detect text on this page."
        blocks = [block.strip() for block in re.split(r"\n\s*\n+", text) if block.strip()]
        return blocks or [text], None


def ocr_page_blocks(page: fitz.Page) -> tuple[list[str], str | None]:
    language = os.getenv("PDFSNITCH_OCR_LANG", "eng").strip() or "eng"
    dpi = int(os.getenv("PDFSNITCH_OCR_DPI", "200"))
    pymupdf_error: str | None = None
    try:
        textpage = page.get_textpage_ocr(language=language, dpi=max(100, min(dpi, 300)), full=True)
        blocks = extract_page_blocks(page, textpage=textpage)
        if blocks:
            return blocks, None
        pymupdf_error = "PyMuPDF OCR did not detect text on this page."
    except Exception as exc:
        pymupdf_error = str(exc)
        logger.warning("PyMuPDF OCR failed on page %s: %s", page.number + 1, exc)

    fallback_blocks, fallback_error = tesseract_ocr_page_blocks(page, language, dpi)
    if fallback_blocks:
        return fallback_blocks, None
    combined_error = fallback_error or pymupdf_error or "OCR could not detect text."
    logger.warning("Tesseract OCR failed on page %s: %s", page.number + 1, combined_error)
    return [], combined_error


def add_blocks_to_docx(output_doc: Document, blocks: list[str], source: str) -> None:
    if not blocks:
        output_doc.add_paragraph(f"[{source} could not detect clear text on this page.]")
        return
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if not lines:
            continue
        first = lines[0]
        if len(lines) == 1 and len(first) <= 90 and not first.endswith("."):
            output_doc.add_heading(first, level=3)
            continue
        paragraph = output_doc.add_paragraph()
        for index, line in enumerate(lines):
            if index:
                paragraph.add_run().add_break()
            paragraph.add_run(line)


def pdf_to_docx_bytes(data: bytes) -> tuple[bytes, dict[str, Any]]:
    document = fitz.open(stream=data, filetype="pdf")
    metadata = {"text_pages": [], "ocr_pages": [], "ocr_failed_pages": [], "page_count": 0}
    try:
        output_doc = Document()
        output_doc.add_heading("Converted from PDF", level=1)
        metadata["page_count"] = document.page_count
        for page_index, page in enumerate(document, start=1):
            if page_index > 1:
                output_doc.add_page_break()
            output_doc.add_heading(f"Page {page_index}", level=2)
            if page_has_selectable_text(page):
                metadata["text_pages"].append(page_index)
                add_blocks_to_docx(output_doc, extract_page_blocks(page), "PDF text extraction")
                continue
            metadata["ocr_pages"].append(page_index)
            blocks, ocr_error = ocr_page_blocks(page)
            if ocr_error:
                metadata["ocr_failed_pages"].append(page_index)
            add_blocks_to_docx(output_doc, blocks, "OCR")
    finally:
        document.close()
    if metadata["ocr_pages"] and len(metadata["ocr_failed_pages"]) == len(metadata["ocr_pages"]):
        raise HTTPException(
            503,
            "OCR is not available or failed on the backend server. Open /api/ocr-status to verify Tesseract, then redeploy the Docker backend.",
        )
    output = io.BytesIO()
    output_doc.save(output)
    return output.getvalue(), metadata


@app.get("/api/health")
def health():
    return {"status": "ok", "max_upload_mb": MAX_UPLOAD_BYTES // 1024 // 1024}


@app.get("/api/ocr-status")
def ocr_status():
    return tesseract_status()


@app.post("/api/preview")
async def preview_pdf(file: UploadFile = File(...), max_pages: int = Form(50)):
    data, _ = await read_upload(file, PDF_EXTENSIONS)
    try:
        document = fitz.open(stream=data, filetype="pdf")
        limit = min(max(1, max_pages), 100, document.page_count)
        previews = []
        for index in range(limit):
            pixmap = document[index].get_pixmap(matrix=fitz.Matrix(0.8, 0.8), alpha=False)
            encoded = base64.b64encode(pixmap.tobytes("png")).decode("ascii")
            previews.append({"page": index + 1, "src": f"data:image/png;base64,{encoded}"})
        return {"page_count": document.page_count, "previews": previews, "truncated": limit < document.page_count}
    except Exception as exc:
        raise HTTPException(422, "Unable to render this PDF.") from exc


@app.post("/api/split")
async def split_pdf(file: UploadFile = File(...), mode: str = Form("individual"), ranges: str = Form("")):
    data, filename = await read_upload(file, PDF_EXTENSIONS)
    reader = PdfReader(io.BytesIO(data))
    stem = safe_stem(filename)
    if mode == "individual":
        outputs = []
        for index, page in enumerate(reader.pages, start=1):
            writer = PdfWriter()
            writer.add_page(page)
            outputs.append((f"{stem}-page-{index}.pdf", pdf_bytes(writer)))
        return attachment(zip_files(outputs), f"{stem}-split-pages.zip", "application/zip")
    if mode != "ranges":
        raise HTTPException(400, "Split mode must be individual or ranges.")
    selected = parse_pages(ranges, len(reader.pages))
    writer = PdfWriter()
    for page_index in selected:
        writer.add_page(reader.pages[page_index])
    return attachment(pdf_bytes(writer), f"{stem}-pages.pdf", "application/pdf")


@app.post("/api/pdf-to-images")
async def pdf_to_images(file: UploadFile = File(...), format: str = Form("png"), dpi: int = Form(150)):
    data, filename = await read_upload(file, PDF_EXTENSIONS)
    image_format = format.lower()
    if image_format not in {"png", "jpg", "jpeg"}:
        raise HTTPException(400, "Image format must be PNG or JPG.")
    dpi = min(max(dpi, 72), 300)
    stem = safe_stem(filename)
    entries = []
    extension = "jpg" if image_format in {"jpg", "jpeg"} else "png"
    try:
        document = fitz.open(stream=data, filetype="pdf")
        try:
            for index, page in enumerate(document, start=1):
                last_error = None
                for render_dpi in dict.fromkeys((dpi, min(dpi, 150), 96)):
                    try:
                        pixmap = page.get_pixmap(dpi=render_dpi, alpha=False, colorspace=fitz.csRGB)
                        payload = pixmap.tobytes("jpeg", jpg_quality=90) if extension == "jpg" else pixmap.tobytes("png")
                        entries.append((f"{stem}-page-{index}.{extension}", payload))
                        break
                    except Exception as exc:
                        last_error = exc
                else:
                    raise HTTPException(422, f"Page {index} could not be converted. Try a lower resolution.") from last_error
        finally:
            document.close()
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("PDF-to-image conversion failed for %s", filename)
        raise HTTPException(422, "This PDF could not be converted. It may contain unsupported or damaged page data.") from exc
    return attachment(zip_files(entries), f"{stem}-{extension}-images.zip", "application/zip")


@app.post("/api/images-to-pdf")
async def images_to_pdf(files: list[UploadFile] = File(...)):
    if not files:
        raise HTTPException(400, "Choose at least one image.")
    images: list[Image.Image] = []
    try:
        for upload in files:
            data, _ = await read_upload(upload, IMAGE_EXTENSIONS)
            with Image.open(io.BytesIO(data)) as source:
                frame = source.convert("RGB")
                frame.load()
                images.append(frame)
        output = io.BytesIO()
        images[0].save(output, "PDF", save_all=True, append_images=images[1:], resolution=150, quality=95)
        return attachment(output.getvalue(), f"images-{uuid.uuid4().hex[:8]}.pdf", "application/pdf")
    finally:
        for image in images:
            image.close()


@app.post("/api/word-to-pdf")
async def word_to_pdf(file: UploadFile = File(...)):
    data, filename = await read_upload(file, DOCX_EXTENSIONS)
    converted = docx_to_pdf_bytes(data)
    return attachment(converted, f"{safe_stem(filename)}.pdf", "application/pdf")


@app.post("/api/pdf-to-word")
async def pdf_to_word(file: UploadFile = File(...)):
    data, filename = await read_upload(file, PDF_EXTENSIONS)
    converted, metadata = pdf_to_docx_bytes(data)
    headers = {
        "X-PDFSNITCH-Text-Pages": ",".join(map(str, metadata["text_pages"])),
        "X-PDFSNITCH-OCR-Pages": ",".join(map(str, metadata["ocr_pages"])),
        "X-PDFSNITCH-OCR-Failed-Pages": ",".join(map(str, metadata["ocr_failed_pages"])),
        "Access-Control-Expose-Headers": "Content-Disposition, X-PDFSNITCH-Text-Pages, X-PDFSNITCH-OCR-Pages, X-PDFSNITCH-OCR-Failed-Pages",
    }
    return attachment(
        converted,
        f"{safe_stem(filename)}.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers,
    )


@app.post("/api/compress")
async def compress_pdf(
    file: UploadFile = File(...),
    level: str = Form("medium"),
    resolution: int = Form(144),
    conversion: str = Form("None"),
    multimedia: str = Form("Discard"),
    fonts: str = Form("Leave unchanged"),
):
    data, filename = await read_upload(file, PDF_EXTENSIONS)
    presets = {"low": (150, 86), "medium": (110, 70), "high": (84, 52)}
    if level not in presets:
        raise HTTPException(400, "Compression level must be low, medium, or high.")
    preset_dpi, quality = presets[level]
    dpi = min(max(resolution or preset_dpi, 72), 300)
    grayscale = conversion.lower() == "grayscale"
    document = fitz.open(stream=data, filetype="pdf")
    try:
        document.rewrite_images(dpi_threshold=dpi + 1, dpi_target=dpi, quality=quality, lossy=True, lossless=True, set_to_gray=grayscale)
        compressed = document.tobytes(garbage=4, deflate=True, deflate_images=True, deflate_fonts=True, use_objstms=1)
    finally:
        document.close()
    if len(compressed) >= len(data):
        compressed = data
    original_size = len(data)
    compressed_size = len(compressed)
    reduction = max(0.0, (1 - compressed_size / original_size) * 100)
    headers = {
        "X-Original-Size": str(original_size),
        "X-Compressed-Size": str(compressed_size),
        "X-Compression-Percent": f"{reduction:.1f}",
        "Access-Control-Expose-Headers": "Content-Disposition, X-Original-Size, X-Compressed-Size, X-Compression-Percent",
    }
    return attachment(compressed, f"{safe_stem(filename)}-{level}-compressed.pdf", "application/pdf", headers)


@app.post("/api/delete-pages")
async def delete_pages(file: UploadFile = File(...), pages: str = Form(...)):
    data, filename = await read_upload(file, PDF_EXTENSIONS)
    reader = PdfReader(io.BytesIO(data))
    deleted = set(parse_pages(pages, len(reader.pages)))
    if len(deleted) >= len(reader.pages):
        raise HTTPException(400, "At least one page must remain in the PDF.")
    writer = PdfWriter()
    for index, page in enumerate(reader.pages):
        if index not in deleted:
            writer.add_page(page)
    return attachment(pdf_bytes(writer), f"{safe_stem(filename)}-pages-removed.pdf", "application/pdf")


@app.post("/api/merge")
async def merge_pdfs(files: list[UploadFile] = File(...)):
    if len(files) < 2:
        raise HTTPException(400, "Choose at least two PDFs to merge.")
    writer = PdfWriter()
    for upload in files:
        data, _ = await read_upload(upload, PDF_EXTENSIONS)
        writer.append(io.BytesIO(data))
    return attachment(pdf_bytes(writer), f"merged-{uuid.uuid4().hex[:8]}.pdf", "application/pdf")


@app.post("/api/rotate")
async def rotate_pdf(file: UploadFile = File(...), degrees: int = Form(90)):
    if degrees not in {-90, 90, 180}:
        raise HTTPException(400, "Rotation must be -90, 90, or 180 degrees.")
    data, filename = await read_upload(file, PDF_EXTENSIONS)
    reader = PdfReader(io.BytesIO(data))
    writer = PdfWriter()
    for page in reader.pages:
        page.rotate(degrees)
        writer.add_page(page)
    return attachment(pdf_bytes(writer), f"{safe_stem(filename)}-rotated.pdf", "application/pdf")


def watermark_page(width: float, height: float, text: str, opacity: float) -> bytes:
    output = io.BytesIO()
    layer = canvas.Canvas(output, pagesize=(width, height))
    layer.saveState()
    layer.setFillColor(Color(0.08, 0.42, 0.34, alpha=opacity))
    layer.setFont("Helvetica-Bold", max(18, min(width, height) / 13))
    layer.translate(width / 2, height / 2)
    layer.rotate(35)
    layer.drawCentredString(0, 0, text[:120])
    layer.restoreState()
    layer.save()
    return output.getvalue()


@app.post("/api/watermark")
async def watermark_pdf(file: UploadFile = File(...), text: str = Form(...), opacity: int = Form(35)):
    if not text.strip():
        raise HTTPException(400, "Enter watermark text.")
    data, filename = await read_upload(file, PDF_EXTENSIONS)
    reader = PdfReader(io.BytesIO(data))
    writer = PdfWriter()
    alpha = min(max(opacity, 10), 100) / 100
    for page in reader.pages:
        box = page.mediabox
        overlay = PdfReader(io.BytesIO(watermark_page(float(box.width), float(box.height), text.strip(), alpha))).pages[0]
        page.merge_page(overlay)
        writer.add_page(page)
    return attachment(pdf_bytes(writer), f"{safe_stem(filename)}-watermarked.pdf", "application/pdf")


@app.post("/api/protect")
async def protect_pdf(file: UploadFile = File(...), password: str = Form(...)):
    if len(password) < 6:
        raise HTTPException(400, "Password must contain at least 6 characters.")
    data, filename = await read_upload(file, PDF_EXTENSIONS)
    reader = PdfReader(io.BytesIO(data))
    writer = PdfWriter()
    writer.append_pages_from_reader(reader)
    writer.encrypt(password)
    return attachment(pdf_bytes(writer), f"{safe_stem(filename)}-protected.pdf", "application/pdf")


@app.post("/api/unlock")
async def unlock_pdf(file: UploadFile = File(...), password: str = Form(...)):
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "The PDF is too large.")
    try:
        reader = PdfReader(io.BytesIO(data))
        if not reader.is_encrypted or reader.decrypt(password) == 0:
            raise HTTPException(400, "The password is incorrect or the PDF is not encrypted.")
        writer = PdfWriter()
        writer.append_pages_from_reader(reader)
        return attachment(pdf_bytes(writer), f"{safe_stem(file.filename)}-unlocked.pdf", "application/pdf")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(422, "Unable to unlock this PDF.") from exc


try:
    from .admin_api import init_admin_storage, router as admin_router
except ImportError:
    from admin_api import init_admin_storage, router as admin_router

init_admin_storage()
app.include_router(admin_router)
