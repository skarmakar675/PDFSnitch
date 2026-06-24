from __future__ import annotations

import base64
import io
import logging
import os
import re
import tempfile
import uuid
import zipfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterable

import fitz
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from PIL import Image, UnidentifiedImageError
from pypdf import PdfReader, PdfWriter
from reportlab.lib.colors import Color
from reportlab.pdfgen import canvas

logger = logging.getLogger("pdfsnitch")

MAX_UPLOAD_BYTES = int(os.getenv("PDFSNITCH_MAX_UPLOAD_MB", "50")) * 1024 * 1024
MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES * 10
TEMP_ROOT = Path(os.getenv("PDFSNITCH_TEMP_DIR", str(Path(tempfile.gettempdir()) / "pdfsnitch"))).resolve()
TEMP_ROOT.mkdir(parents=True, exist_ok=True)

PDF_EXTENSIONS = {".pdf"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}

app = FastAPI(title="PDFSnitch API", version="1.0.0")
origins = [item.strip() for item in os.getenv(
    "PDFSNITCH_FRONTEND_ORIGINS",
    "http://127.0.0.1:4173,http://localhost:4173,http://127.0.0.1:5173,http://localhost:5173",
).split(",") if item.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST", "DELETE"], allow_headers=["*"])


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
        else:
            try:
                with Image.open(upload_path) as image:
                    image.verify()
            except (UnidentifiedImageError, OSError) as exc:
                raise HTTPException(415, "The uploaded file is not a valid image.") from exc
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


@app.get("/api/health")
def health():
    return {"status": "ok", "max_upload_mb": MAX_UPLOAD_BYTES // 1024 // 1024}


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
