const getApiBase = () => (
  window.PDFC_SETTINGS?.apiBaseUrl ||
  import.meta.env.VITE_API_URL ||
  'http://127.0.0.1:8000'
).replace(/\/$/, '')

const getCompressEndpoint = () => window.PDFC_SETTINGS?.compressEndpoint || '/api/compress'

const filenameFromHeaders = (headers, fallback) => {
  const disposition = headers.get('content-disposition') || ''
  const match = disposition.match(/filename="?([^";]+)"?/i)
  return match?.[1] || fallback
}

const request = async (path, formData, responseType = 'blob') => {
  let response
  try {
    response = await fetch(`${getApiBase()}${path}`, { method: 'POST', body: formData })
  } catch {
    throw new Error('Cannot reach the PDF processing service. Start the backend and try again.')
  }
  if (!response.ok) {
    let message = 'Processing failed. Check the file and try again.'
    try {
      const payload = await response.json()
      message = payload.detail || message
    } catch {
      // Keep the safe fallback message for non-JSON failures.
    }
    throw new Error(message)
  }
  if (responseType === 'json') return response.json()
  return {
    blob: await response.blob(),
    filename: filenameFromHeaders(response.headers, 'pdfsnitch-result'),
    headers: response.headers,
  }
}

export const previewPdf = (file) => {
  const form = new FormData()
  form.append('file', file)
  form.append('max_pages', '50')
  return request('/api/preview', form, 'json')
}

export const processPdf = (operation, files, fields = {}) => {
  const form = new FormData()
  const list = Array.isArray(files) ? files : [files]
  const fieldName = operation === 'merge' || operation === 'images-to-pdf' ? 'files' : 'file'
  list.filter(Boolean).forEach(file => form.append(fieldName, file))
  Object.entries(fields).forEach(([key, value]) => form.append(key, String(value)))
  return request(operation === 'compress' ? getCompressEndpoint() : `/api/${operation}`, form)
}

export const API_BASE = getApiBase()
