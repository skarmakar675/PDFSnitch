FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PDFSNITCH_OCR_LANG=eng+hin
ENV PDFSNITCH_OCR_DPI=300
ENV PDFSNITCH_OCR_PSM=6,3,11
ENV PDFSNITCH_OCR_TIMEOUT=90
ENV PDFSNITCH_WORD_IMAGE_DPI=180
ENV TESSERACT_CMD=tesseract
ENV TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-hin \
    tesseract-ocr-osd \
    libgomp1 \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
  && pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
