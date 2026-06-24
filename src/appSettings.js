import { createContext } from 'react'

export const BACKEND_ORIGIN = (import.meta.env.VITE_API_URL || 'https://pdfsnitch-api-4z7h.onrender.com').replace(/\/$/, '')

export const defaultPublicSettings = {
  siteTitle: 'PDFSnitch',
  siteTagline: 'Make files lighter without the quality cliff.',
  logoUrl: '',
  faviconUrl: '',
  primaryColor: '#00b894',
  secondaryColor: '#e8fff8',
  buttonText: 'Compress PDF',
  footerText: '',
  apiBaseUrl: BACKEND_ORIGIN,
  compressEndpoint: '/api/compress',
  maxUploadSize: 25,
  defaultQuality: 'medium',
  defaultResolution: 144,
  defaultConversion: 'none',
  defaultMultimedia: 'discard',
  defaultFonts: 'unchanged',
  successMessage: 'Your PDF is ready to download.',
  errorMessage: 'Cannot reach the PDF processing service. try again Sometime.',
  seo: {
    title: 'PDFSnitch',
    description: 'Compress PDF files online.',
    keywords: 'pdf compressor, compress pdf, reduce pdf size',
    canonicalUrl: '',
    robotsIndex: true,
    googleSearchConsoleMeta: '',
    bingWebmasterMeta: '',
  },
  ads: {
    enabled: false,
    mode: 'auto',
    publisherId: '',
    autoAdsEnabled: false,
    manualAdsEnabled: false,
    placements: { belowIntro: true, belowTool: true, afterResult: true, footer: true, sidebar: false },
    safety: { minButtonDistance: 250, disableDuringCompression: true },
    slots: [],
  },
  scripts: { header: '', footer: '' },
}

export const PublicSettingsContext = createContext(defaultPublicSettings)

export async function loadPublicSettings() {
  try {
    const response = await fetch(`${BACKEND_ORIGIN}/api/public/settings`)
    if (!response.ok) throw new Error('Settings unavailable')
    return { ...defaultPublicSettings, ...(await response.json()) }
  } catch {
    return defaultPublicSettings
  }
}

function setMeta(name, content, attr = 'name') {
  if (!content) return
  let element = document.head.querySelector(`meta[${attr}="${name}"]`)
  if (!element) {
    element = document.createElement('meta')
    element.setAttribute(attr, name)
    document.head.appendChild(element)
  }
  element.setAttribute('content', content)
}

function injectHtml(html, mountId, target = document.head) {
  document.querySelectorAll(`[data-pdfc-mount="${mountId}"]`).forEach(node => node.remove())
  if (!html) return
  const template = document.createElement('template')
  template.innerHTML = html
  Array.from(template.content.childNodes).forEach(node => {
    let element
    if (node.nodeName.toLowerCase() === 'script') {
      element = document.createElement('script')
      Array.from(node.attributes || []).forEach(attr => element.setAttribute(attr.name, attr.value))
      element.text = node.textContent || ''
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      element = node.cloneNode(true)
    }
    if (element) {
      element.setAttribute('data-pdfc-mount', mountId)
      target.appendChild(element)
    }
  })
}

export function applyPublicSettings(settings) {
  window.PDFC_SETTINGS = settings
  window.PDFC_ADS = settings.ads || defaultPublicSettings.ads
  document.documentElement.style.setProperty('--blue', settings.primaryColor || '#00b894')
  document.documentElement.style.setProperty('--blue-dark', settings.primaryColor || '#00b894')
  document.documentElement.style.setProperty('--pale', settings.secondaryColor || '#e8fff8')
  if (settings.faviconUrl) {
    let favicon = document.querySelector('link[rel="icon"]')
    if (!favicon) {
      favicon = document.createElement('link')
      favicon.rel = 'icon'
      document.head.appendChild(favicon)
    }
    favicon.href = settings.faviconUrl
  }
  const seo = settings.seo || {}
  document.title = seo.title || settings.siteTitle || 'PDFSnitch'
  setMeta('description', seo.description)
  setMeta('keywords', seo.keywords)
  setMeta('robots', seo.robotsIndex === false ? 'noindex,nofollow' : 'index,follow')
  setMeta('og:title', seo.ogTitle || seo.title, 'property')
  setMeta('og:description', seo.ogDescription || seo.description, 'property')
  setMeta('og:image', seo.ogImage, 'property')
  setMeta('twitter:title', seo.twitterTitle || seo.title)
  setMeta('twitter:description', seo.twitterDescription || seo.description)
  setMeta('twitter:image', seo.twitterImage)
  if (seo.googleSearchConsoleMeta) setMeta('google-site-verification', seo.googleSearchConsoleMeta)
  if (seo.bingWebmasterMeta) setMeta('msvalidate.01', seo.bingWebmasterMeta)
  if (seo.canonicalUrl) {
    let canonical = document.querySelector('link[rel="canonical"]')
    if (!canonical) {
      canonical = document.createElement('link')
      canonical.rel = 'canonical'
      document.head.appendChild(canonical)
    }
    canonical.href = seo.canonicalUrl
  }
  injectHtml(settings.scripts?.header, 'header-scripts')
  if (settings.ads?.enabled && settings.ads?.autoAdsEnabled) injectHtml(settings.ads.autoAdsCode, 'auto-ads')
  injectHtml(settings.scripts?.footer, 'footer-scripts', document.body)
}

function getVisitorId() {
  const key = 'pdfc_visitor_id'
  let value = localStorage.getItem(key)
  if (!value) {
    value = `v_${Date.now()}_${Math.random().toString(16).slice(2)}`
    localStorage.setItem(key, value)
  }
  return value
}

function browserName() {
  const ua = navigator.userAgent
  if (/Edg/i.test(ua)) return 'Edge'
  if (/Chrome/i.test(ua)) return 'Chrome'
  if (/Firefox/i.test(ua)) return 'Firefox'
  if (/Safari/i.test(ua)) return 'Safari'
  return 'Other'
}

function deviceType() {
  if (/tablet|ipad/i.test(navigator.userAgent)) return 'tablet'
  if (/mobile|android|iphone/i.test(navigator.userAgent)) return 'mobile'
  return 'desktop'
}

export async function trackEvent(eventName, eventData = {}) {
  const payload = {
    event_name: eventName,
    event_data: eventData,
    visitor_id: getVisitorId(),
    page_url: window.location.href,
    referrer: document.referrer,
    browser: browserName(),
    device: deviceType(),
  }
  try {
    await fetch(`${BACKEND_ORIGIN}/api/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    // Tracking should never block the PDF tool.
  }
}

export function installTracking() {
  window.PDFC_TRACK_EVENT = trackEvent
}
