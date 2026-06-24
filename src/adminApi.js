import { BACKEND_ORIGIN } from './appSettings'

const TOKEN_KEY = 'pdfc_admin_token'

export const adminAuth = {
  get token() {
    return localStorage.getItem(TOKEN_KEY) || ''
  },
  set token(value) {
    if (value) localStorage.setItem(TOKEN_KEY, value)
    else localStorage.removeItem(TOKEN_KEY)
  },
}

async function parseResponse(response) {
  const type = response.headers.get('content-type') || ''
  if (!response.ok) {
    let message = 'Request failed.'
    try {
      const payload = await response.json()
      message = payload.detail || message
    } catch {
      // Keep fallback.
    }
    throw new Error(message)
  }
  if (type.includes('application/json')) return response.json()
  return response.blob()
}

export async function adminRequest(path, options = {}) {
  const headers = new Headers(options.headers || {})
  if (!(options.body instanceof FormData) && options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (adminAuth.token) headers.set('Authorization', `Bearer ${adminAuth.token}`)
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs || 30000)
  try {
    const response = await fetch(`${BACKEND_ORIGIN}${path}`, { ...options, headers, signal: controller.signal })
    return parseResponse(response)
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Backend is taking too long to respond. If OTP is enabled, wait one minute and try again.')
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
}

export const loginAdmin = async (username, password) => {
  const payload = await adminRequest('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
    timeoutMs: 60000,
  })
  if (payload.token) adminAuth.token = payload.token
  return payload
}

export const verifyAdminOtp = async (challengeId, otp) => {
  const payload = await adminRequest('/api/admin/login/verify-otp', {
    method: 'POST',
    body: JSON.stringify({ challenge_id: challengeId, otp }),
  })
  adminAuth.token = payload.token
  return payload
}

export const logoutAdmin = async () => {
  try {
    await adminRequest('/api/admin/logout', { method: 'POST' })
  } finally {
    adminAuth.token = ''
  }
}

export const downloadAdminFile = async (path, filename) => {
  const blob = await adminRequest(path)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
