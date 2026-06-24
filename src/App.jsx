import { createContext, Fragment, useContext, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { downloadBlob } from './downloadResult'
import { previewPdf, processPdf } from './api'
import { AdminLayout, AdminLogin } from './AdminPanel'
import { PublicSettingsContext, applyPublicSettings, defaultPublicSettings, installTracking, loadPublicSettings, trackEvent } from './appSettings'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import {
  ArrowRight, Check, ChevronRight, Download, FileImage, FileLock2,
  FileMinus2, FileOutput, Files, ImagePlus, LockKeyhole, Menu, Plus,
  RotateCw, Scissors, ShieldCheck, Upload, X, Zap, CircleHelp, SlidersHorizontal,
  FileText, Trash2, LoaderCircle,
} from 'lucide-react'

const UNSAVED_MESSAGE = 'Your data has not been saved. Do you still want to continue?'
const NavigationStateContext = createContext({ dirty: false, setDirty: () => {} })
const ADSENSE_CLIENT = import.meta.env.VITE_ADSENSE_CLIENT || ''
const ADSENSE_SLOTS = {
  leaderboard: import.meta.env.VITE_ADSENSE_SLOT_LEADERBOARD || '',
  content: import.meta.env.VITE_ADSENSE_SLOT_CONTENT || '',
  footer: import.meta.env.VITE_ADSENSE_SLOT_FOOTER || '',
}

const tools = [
  { slug: 'compress', name: 'Compress PDF', desc: 'Make files lighter without the quality cliff.', icon: FileMinus2, accept: '.pdf' },
  { slug: 'merge', name: 'Merge PDFs', desc: 'Combine documents in the order you choose.', icon: Files, accept: '.pdf', multiple: true },
  { slug: 'split', name: 'Split PDF', desc: 'Extract ranges or separate every page.', icon: Scissors, accept: '.pdf' },
  { slug: 'rotate', name: 'Rotate PDF', desc: 'Turn individual pages or the whole document.', icon: RotateCw, accept: '.pdf' },
  { slug: 'pdf-to-images', name: 'PDF to Images', desc: 'Export crisp PNG or JPG files.', icon: FileImage, accept: '.pdf' },
  { slug: 'images-to-pdf', name: 'Images to PDF', desc: 'Build one PDF from JPG, PNG or WebP.', icon: ImagePlus, accept: 'image/png,image/jpeg,image/webp', multiple: true },
  { slug: 'word-to-pdf', name: 'Word to PDF', desc: 'Convert DOCX documents into downloadable PDFs.', icon: FileText, accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { slug: 'pdf-to-word', name: 'PDF to Word', desc: 'Extract readable PDF text into a DOCX file.', icon: FileOutput, accept: '.pdf' },
  { slug: 'delete-pages', name: 'Delete PDF Pages', desc: 'Remove selected pages and keep the rest.', icon: Trash2, accept: '.pdf' },
  { slug: 'watermark', name: 'Watermark', desc: 'Add controlled text marks across pages.', icon: FileOutput, accept: '.pdf' },
  { slug: 'protect', name: 'Protect PDF', desc: 'Lock sensitive documents with a password.', icon: FileLock2, accept: '.pdf' },
  { slug: 'unlock', name: 'Unlock PDF', desc: 'Remove a password you already know.', icon: LockKeyhole, accept: '.pdf' },
]

const formatSize = (bytes) => bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

const compressionOptions = {
  quality: ['Low', 'Medium', 'High'],
  resolution: ['72', '100', '144', '200', '300', '720'],
  conversion: ['None', 'Grayscale'],
  multimedia: ['Discard', 'Keep'],
  fonts: ['Leave unchanged', 'Optimize'],
}

function RouteProgress() {
  const location = useLocation()
  const [active, setActive] = useState(false)

  useEffect(() => {
    setActive(true)
    const timer = window.setTimeout(() => setActive(false), 520)
    return () => window.clearTimeout(timer)
  }, [location.pathname])

  return <div className={`route-loader ${active ? 'is-active' : ''}`} aria-hidden="true" />
}

function PageRoutes() {
  const location = useLocation()

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
    trackEvent('page_view')
  }, [location.pathname])

  return <AnimatePresence mode="wait">
    <motion.div
      key={location.pathname}
      className="page-transition"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.24, ease: 'easeOut' }}
    >
      <Routes location={location}>
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin/*" element={<AdminLayout />} />
        <Route path="/" element={<HomePage />} />
        <Route path="/:slug" element={<RoutedToolPage />} />
        <Route path="/about" element={<LegalPage type="about" />} />
        <Route path="/privacy" element={<LegalPage type="privacy" />} />
        <Route path="/terms" element={<LegalPage type="terms" />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </motion.div>
  </AnimatePresence>
}

function AdSlot({ placement = 'content', className = '' }) {
  const publicSettings = useContext(PublicSettingsContext)
  const ads = publicSettings.ads || defaultPublicSettings.ads
  const placementKey = placement === 'footer' ? 'footer' : placement === 'leaderboard' ? 'belowIntro' : placement === 'afterResult' ? 'afterResult' : 'belowTool'
  const placementAllowed = ads.placements?.[placementKey] !== false
  const configuredSlot = (ads.slots || []).find(item => item.placement === placementKey || item.name === placement)
  const publisherId = configuredSlot?.publisherId || ads.publisherId || ADSENSE_CLIENT
  const slot = configuredSlot?.slotId || ADSENSE_SLOTS[placement] || ADSENSE_SLOTS.content
  const canRenderAdSense = Boolean(ads.enabled && publisherId && slot)

  useEffect(() => {
    if (!placementAllowed) trackEvent('ad_slot_blocked', { placement, reason: 'placement_disabled' })
  }, [placementAllowed, placement])

  if (!placementAllowed) {
    return null
  }

  useEffect(() => {
    if (!canRenderAdSense || document.getElementById('adsbygoogle-script')) return
    const script = document.createElement('script')
    script.id = 'adsbygoogle-script'
    script.async = true
    script.crossOrigin = 'anonymous'
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${publisherId}`
    document.head.appendChild(script)
  }, [canRenderAdSense, publisherId])

  useEffect(() => {
    if (!canRenderAdSense) return
    try {
      window.adsbygoogle = window.adsbygoogle || []
      window.adsbygoogle.push({})
    } catch {
      // Ad blockers and local development can prevent AdSense from rendering.
    }
    trackEvent('ad_slot_rendered', { placement, slot })
  }, [canRenderAdSense, slot, placement])

  return <aside className={`ad-slot ad-slot--${placement} ${className}`} aria-label="Advertisement">
    <span>Advertisement</span>
    {canRenderAdSense ? <ins
      className="adsbygoogle"
      style={{ display: 'block' }}
      data-ad-client={publisherId}
      data-ad-slot={slot}
      data-ad-format="auto"
      data-full-width-responsive="true"
    /> : <div className="ad-slot__placeholder"><small>Ad space</small></div>}
  </aside>
}

function NavigationGuard({ children }) {
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    const guardLink = event => {
      const anchor = event.target.closest?.('a[href]')
      if (!dirty || !anchor) return
      const destination = new URL(anchor.href, window.location.href)
      if (destination.origin !== window.location.origin || destination.pathname === window.location.pathname) return
      if (!window.confirm(UNSAVED_MESSAGE)) {
        event.preventDefault()
        event.stopPropagation()
      } else {
        setDirty(false)
      }
    }
    const guardUnload = event => {
      if (!dirty) return
      event.preventDefault()
      event.returnValue = UNSAVED_MESSAGE
    }
    document.addEventListener('click', guardLink, true)
    window.addEventListener('beforeunload', guardUnload)
    return () => {
      document.removeEventListener('click', guardLink, true)
      window.removeEventListener('beforeunload', guardUnload)
    }
  }, [dirty])

  return <NavigationStateContext.Provider value={{ dirty, setDirty }}>{children}</NavigationStateContext.Provider>
}

function getBrandParts(title = 'PDFSnitch') {
  const cleanTitle = String(title || 'PDFSnitch').trim()
  if (cleanTitle.replace(/\s+/g, '').toLowerCase() === 'pdfsnitch') return ['PDF', 'Snitch']
  const pieces = cleanTitle.split(/\s+/)
  if (pieces.length > 1) return [pieces[0], pieces.slice(1).join(' ')]
  return ['PDF', 'Snitch']
}

function Brand({ dark = false }) {
  const publicSettings = useContext(PublicSettingsContext)
  if (publicSettings.logoUrl) return <Link to="/" className={`brand brand--image ${dark ? 'brand--dark' : ''}`} aria-label={`${publicSettings.siteTitle} home`}><img src={publicSettings.logoUrl} alt={publicSettings.siteTitle} /><span>{publicSettings.siteTitle}</span></Link>
  const [first, second] = getBrandParts(publicSettings.siteTitle)
  return <Link to="/" className={`brand ${dark ? 'brand--dark' : ''}`} aria-label={`${publicSettings.siteTitle} home`}><span>{first}</span><span>{second}</span><Zap size={25} fill="currentColor" strokeWidth={1.5} /></Link>
}

function OptionGroup({ label, name, options, value, onChange, hint }) {
  return <fieldset className="option-group">
    <legend>{label}{hint ? <span>{hint}</span> : null}</legend>
    <div className="segmented">
      {options.map(option => <button type="button" key={option} className={value === option ? 'is-active' : ''} aria-pressed={value === option} onClick={() => onChange(name, option)}>{option}{option === 'Best' || option === 'Optimize' ? <CircleHelp size={13} /> : null}</button>)}
    </div>
  </fieldset>
}

function CompressPanel({ file, onChoose, onDirty, onSaved, standalone = false }) {
  const publicSettings = useContext(PublicSettingsContext)
  const [settings, setSettings] = useState({ quality: 'Medium', resolution: '144', conversion: 'None', multimedia: 'Discard', fonts: 'Leave unchanged' })
  const [status, setStatus] = useState('idle')
  const [showMore, setShowMore] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => { setStatus('idle'); setResult(null); setError('') }, [file])
  useEffect(() => {
    setSettings(current => ({
      ...current,
      quality: String(publicSettings.defaultQuality || 'medium').replace(/^./, letter => letter.toUpperCase()),
      resolution: String(publicSettings.defaultResolution || '144'),
      conversion: String(publicSettings.defaultConversion || 'none') === 'grayscale' ? 'Grayscale' : 'None',
      multimedia: String(publicSettings.defaultMultimedia || 'discard') === 'keep' ? 'Keep' : 'Discard',
      fonts: String(publicSettings.defaultFonts || 'unchanged') === 'optimize' ? 'Optimize' : 'Leave unchanged',
    }))
  }, [publicSettings.defaultQuality, publicSettings.defaultResolution, publicSettings.defaultConversion, publicSettings.defaultMultimedia, publicSettings.defaultFonts])
  const updateSetting = (name, value) => { setSettings(current => ({ ...current, [name]: value })); setResult(null); setStatus('idle'); onDirty?.() }
  const compress = async () => {
    if (!file || status === 'processing') return
    setStatus('processing')
    setError('')
    trackEvent('compress_click', { filename: file.name, size: file.size })
    try {
      const response = await processPdf('compress', file, { level: settings.quality.toLowerCase(), resolution: settings.resolution, conversion: settings.conversion, multimedia: settings.multimedia, fonts: settings.fonts })
      setResult({ ...response, originalSize: Number(response.headers.get('x-original-size') || file.size), compressedSize: Number(response.headers.get('x-compressed-size') || response.blob.size), reduction: Number(response.headers.get('x-compression-percent') || 0) })
      setStatus('done')
      trackEvent('compress_success', { filename: file.name })
    } catch (problem) {
      setError(problem.message)
      setStatus('error')
      trackEvent('compress_failed', { filename: file.name, message: problem.message })
    }
  }

  return <motion.section className="compress-panel container" id="compress" initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .2 }}>
    {standalone ? null : <div className="compress-panel__heading"><FileMinus2 /><div><h2>Compress PDF</h2><p>Reduce the size of your PDF</p></div></div>}
    <button type="button" className="selected-file" onClick={onChoose}>
      <span>{file ? 'Selected' : 'Select a file'}</span>
      <strong>{file ? file.name : 'Choose a PDF to customize compression'}</strong>
      <small>{file ? formatSize(file.size) : 'PDF up to 50 MB'}</small>
      <Upload size={18} />
    </button>
    <div className="compress-options">
      <OptionGroup label="Image quality" name="quality" options={compressionOptions.quality} value={settings.quality} onChange={updateSetting} />
      <OptionGroup label="Image resolution (ppi)" name="resolution" options={compressionOptions.resolution} value={settings.resolution} onChange={updateSetting} />
      <OptionGroup label="Image conversion" name="conversion" options={compressionOptions.conversion} value={settings.conversion} onChange={updateSetting} />
      <OptionGroup label="Multimedia files" name="multimedia" options={compressionOptions.multimedia} value={settings.multimedia} onChange={updateSetting} />
      <OptionGroup label="Fonts" hint="Experimental" name="fonts" options={compressionOptions.fonts} value={settings.fonts} onChange={updateSetting} />
    </div>
    {showMore ? <div className="advanced-options" onChange={onDirty}><label><input type="checkbox" defaultChecked /> Remove hidden metadata</label><label><input type="checkbox" /> Flatten form fields</label></div> : null}
    {error ? <div className="tool-message tool-message--error" role="alert">{error}</div> : null}
    {result ? <div className="compression-result" aria-live="polite"><span><small>Original size</small><strong>{formatSize(result.originalSize)}</strong></span><span><small>Compressed size</small><strong>{formatSize(result.compressedSize)}</strong></span><span><small>Reduced by</small><strong>{result.reduction.toFixed(1)}%</strong></span></div> : null}
    <div className="compress-panel__actions">
      <button type="button" className="btn btn--primary" disabled={!file || status === 'processing'} onClick={compress}>{status === 'done' ? <Check size={18} /> : status === 'processing' ? <LoaderCircle className="spin-icon" size={18} /> : <FileMinus2 size={18} />}{status === 'processing' ? 'Compressing PDF…' : status === 'done' ? 'Compress again' : publicSettings.buttonText || 'Compress PDF'}</button>
      {result ? <button type="button" className="btn btn--outline" onClick={() => { downloadBlob(result.blob, result.filename); trackEvent('download_click', { filename: result.filename }); onSaved?.() }}><Download size={18} />Download result</button> : null}
      <button type="button" className="btn btn--soft" aria-expanded={showMore} onClick={() => { setShowMore(value => !value); onDirty?.() }}><SlidersHorizontal size={17} />{showMore ? 'Fewer options' : 'More options'}</button>
      <span><ShieldCheck size={16} />Temporary files are deleted automatically</span>
    </div>
  </motion.section>
}

function ToolHeader() {
  const [open, setOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  return <header className="nav-shell"><nav className="nav container" aria-label="Main navigation">
    <Brand />
    <div className="nav__links nav__links--tools">
      <div className={`tools-menu ${toolsOpen ? 'is-open' : ''}`}><button type="button" className="tools-menu__trigger" aria-expanded={toolsOpen} onClick={() => setToolsOpen(value => !value)}>All tools<ChevronRight size={15} /></button>{toolsOpen ? <div className="tools-menu__panel">{tools.map(tool => { const Icon = tool.icon; return <NavLink key={tool.slug} to={`/${tool.slug}`} onClick={() => setToolsOpen(false)}><Icon size={19} /><span>{tool.name}<small>{tool.desc}</small></span></NavLink> })}</div> : null}</div>
      <NavLink to="/compress">Compress</NavLink><NavLink to="/merge">Merge</NavLink><NavLink to="/split">Split</NavLink><NavLink to="/pdf-to-images">PDF to Images</NavLink><NavLink to="/word-to-pdf">Word to PDF</NavLink><NavLink to="/pdf-to-word">PDF to Word</NavLink>
    </div>
    <Link className="btn btn--primary nav__cta" to="/compress">Compress a PDF</Link>
    <button className="menu-btn" aria-label="Toggle navigation" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? <X /> : <Menu />}</button>
  </nav>{open ? <div className="mobile-menu">{tools.map(tool => <Link key={tool.slug} to={`/${tool.slug}`}>{tool.name}</Link>)}</div> : null}</header>
}

function ImageFilePreview({ file }) {
  const [source] = useState(() => URL.createObjectURL(file))
  useEffect(() => () => URL.revokeObjectURL(source), [source])
  return <img src={source} alt={`Preview of ${file.name}`} />
}

function PdfFilePreview({ file }) {
  const canvasRef = useRef(null)
  const [state, setState] = useState('loading')

  useEffect(() => {
    let cancelled = false
    let loadingTask
    const renderPreview = async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker
        const bytes = await file.arrayBuffer()
        if (cancelled) return
        loadingTask = pdfjs.getDocument({ data: bytes })
        const pdf = await loadingTask.promise
        const page = await pdf.getPage(1)
        const baseViewport = page.getViewport({ scale: 1 })
        const scale = Math.min(1.35, 220 / baseViewport.width)
        const viewport = page.getViewport({ scale })
        const canvas = canvasRef.current
        if (!canvas || cancelled) return
        const context = canvas.getContext('2d', { alpha: false })
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        await page.render({ canvasContext: context, viewport }).promise
        if (!cancelled) setState('ready')
      } catch {
        if (!cancelled) setState('error')
      }
    }
    renderPreview()
    return () => {
      cancelled = true
      loadingTask?.destroy()
    }
  }, [file])

  return <div className={`pdf-canvas-preview is-${state}`}>
    <canvas ref={canvasRef} aria-label={`First page preview of ${file.name}`} />
    {state === 'loading' ? <span><LoaderCircle />Rendering first page…</span> : null}
    {state === 'error' ? <span><FileText />Preview unavailable</span> : null}
  </div>
}

function PreviewItem({ file, onRemove }) {
  const isImage = file.type.startsWith('image/')
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
  const isWord = file.name.toLowerCase().endsWith('.docx')

  return <article className="preview-item">
    <div className="preview-item__media">{isImage ? <ImageFilePreview file={file} /> : isPdf ? <PdfFilePreview file={file} /> : <div className="document-file-preview"><FileText /><strong>{isWord ? 'DOCX' : 'FILE'}</strong><span>Ready to convert</span></div>}</div>
    <div className="preview-item__info"><strong title={file.name}>{file.name}</strong><span>{formatSize(file.size)} · {isImage ? 'Image' : isWord ? 'Word document' : 'PDF document'}</span></div>
    <button type="button" onClick={onRemove} aria-label={`Remove ${file.name}`}><Trash2 /></button>
  </article>
}

function PreviewSection({ files, onRemove, onAdd, mergeMode = false }) {
  if (!files.length) return null
  return <section className="preview-section" aria-label="Selected file previews">
    <div className="preview-section__heading"><div><span>Preview section</span><h2>{mergeMode ? 'PDF merge order' : 'Document preview'}</h2></div><small>{files.length} file{files.length > 1 ? 's' : ''} ready</small></div>
    <div className={`preview-list ${mergeMode ? 'preview-list--merge' : ''}`}>
      {files.map((file, index) => <Fragment key={`${file.name}-${file.size}-${index}`}><PreviewItem file={file} onRemove={() => onRemove(index)} />{mergeMode ? <span className="merge-plus" aria-hidden="true"><Plus /></span> : null}</Fragment>)}
      {mergeMode ? <button type="button" className="add-pdf-card" onClick={onAdd}><Plus /><strong>Add another PDF</strong><span>Choose more files</span></button> : null}
    </div>
  </section>
}

function PagePreviewGrid({ preview, loading, selectedPages, onToggle, selectable = false }) {
  if (loading) return <section className="page-preview-grid page-preview-grid--loading"><LoaderCircle className="spin-icon" /><strong>Rendering PDF pages…</strong></section>
  if (!preview?.previews?.length) return null
  return <section className="page-preview-section" aria-label="PDF page previews">
    <div className="preview-section__heading"><div><span>Page preview</span><h2>{selectable ? 'Select pages to delete' : 'PDF pages'}</h2></div><small>{preview.page_count} page{preview.page_count === 1 ? '' : 's'}</small></div>
    <div className="page-preview-grid">
      {preview.previews.map(item => {
        const selected = selectedPages.includes(item.page)
        return <button type="button" key={item.page} className={`page-preview-card ${selected ? 'is-selected' : ''}`} onClick={() => selectable && onToggle(item.page)} aria-pressed={selectable ? selected : undefined}>
          <img src={item.src} alt={`Page ${item.page} preview`} /><span>Page {item.page}</span>{selected ? <b><Trash2 />Remove</b> : null}
        </button>
      })}
    </div>
    {preview.truncated ? <p className="preview-note">Showing the first 50 pages.</p> : null}
  </section>
}

function SiteFooter() {
  return <footer><AdSlot placement="footer" className="ad-slot--footer" /><div className="container footer-grid">
    <div className="footer-brand"><Brand dark /><p>Reliable PDF tools with secure temporary processing.</p><span><ShieldCheck size={16} />Temporary files are automatically deleted</span></div>
    <div className="footer-column"><h3>Popular tools</h3><Link to="/compress">Compress PDF</Link><Link to="/merge">Merge PDFs</Link><Link to="/split">Split PDF</Link><Link to="/pdf-to-images">PDF to Images</Link><Link to="/word-to-pdf">Word to PDF</Link><Link to="/pdf-to-word">PDF to Word</Link></div>
    <div className="footer-column"><h3>More tools</h3><Link to="/rotate">Rotate PDF</Link><Link to="/watermark">Watermark</Link><Link to="/protect">Protect PDF</Link><Link to="/unlock">Unlock PDF</Link></div>
    <div className="footer-column"><h3>PDFSnitch</h3><Link to="/about">About</Link><Link to="/privacy">Privacy policy</Link><Link to="/terms">Terms of service</Link><Link to="/">All tools</Link></div>
  </div><div className="container footer-bottom"><span>© 2026 PDFSnitch. All rights reserved.</span><span>Validated uploads · Automatic cleanup · Made with care in <b>India.</b></span></div></footer>
}

function ToolControls({ slug, options, update }) {
  if (slug === 'merge') return <div className="tool-config"><h2>Arrange your PDFs</h2><p>Add two or more PDFs. Files are merged in the preview order.</p></div>
  if (slug === 'split') return <div className="tool-config"><h2>Split method</h2><label><input type="radio" name="split" checked={options.mode === 'ranges'} onChange={() => update('mode', 'ranges')} /> Extract selected page ranges</label><input className="text-field" aria-label="Page ranges" value={options.ranges} onChange={event => update('ranges', event.target.value)} disabled={options.mode !== 'ranges'} placeholder="Example: 1–3, 5, 8–10" /><label><input type="radio" name="split" checked={options.mode === 'individual'} onChange={() => update('mode', 'individual')} /> Split every page into a separate PDF</label></div>
  if (slug === 'rotate') return <div className="tool-config"><h2>Rotation</h2><div className="config-row">{[['-90', '90° left'], ['90', '90° right'], ['180', '180°']].map(([value, label]) => <button className={options.degrees === value ? 'config-choice is-active' : 'config-choice'} type="button" onClick={() => update('degrees', value)} key={value}>{label}</button>)}</div><p>Rotation is applied to every page.</p></div>
  if (slug === 'pdf-to-images') return <div className="tool-config"><h2>Image export</h2><div className="config-row"><button className={options.format === 'png' ? 'config-choice is-active' : 'config-choice'} type="button" onClick={() => update('format', 'png')}>PNG</button><button className={options.format === 'jpg' ? 'config-choice is-active' : 'config-choice'} type="button" onClick={() => update('format', 'jpg')}>JPG</button></div><label>Resolution<select className="text-field" value={options.dpi} onChange={event => update('dpi', event.target.value)}><option value="72">72 ppi</option><option value="150">150 ppi</option><option value="300">300 ppi</option></select></label></div>
  if (slug === 'images-to-pdf') return <div className="tool-config"><h2>PDF output</h2><p>Images are kept in the selected order and converted at high quality.</p></div>
  if (slug === 'word-to-pdf') return <div className="tool-config"><h2>Word conversion</h2><p>Upload a .docx file. The backend converts readable text and basic tables into a PDF.</p></div>
  if (slug === 'pdf-to-word') return <div className="tool-config"><h2>Word output</h2><p>Readable PDF text is extracted page-by-page into a downloadable .docx file. Scanned image PDFs need OCR and may contain little text.</p></div>
  if (slug === 'delete-pages') return <div className="tool-config"><h2>Pages to delete</h2><p>{options.pages.length ? `${options.pages.length} page${options.pages.length > 1 ? 's' : ''} selected: ${options.pages.join(', ')}` : 'Select pages in the preview above.'}</p></div>
  if (slug === 'watermark') return <div className="tool-config"><h2>Watermark settings</h2><input className="text-field" aria-label="Watermark text" value={options.text} onChange={event => update('text', event.target.value)} placeholder="Watermark text" /><label>Opacity: {options.opacity}%<input type="range" min="10" max="100" value={options.opacity} onChange={event => update('opacity', event.target.value)} /></label></div>
  if (slug === 'protect') return <div className="tool-config"><h2>Set a password</h2><input className="text-field" type="password" aria-label="Password" value={options.password} onChange={event => update('password', event.target.value)} placeholder="At least 6 characters" /><input className="text-field" type="password" aria-label="Confirm password" value={options.confirmPassword} onChange={event => update('confirmPassword', event.target.value)} placeholder="Confirm password" /></div>
  if (slug === 'unlock') return <div className="tool-config"><h2>Enter the current password</h2><input className="text-field" type="password" aria-label="Current PDF password" value={options.password} onChange={event => update('password', event.target.value)} placeholder="PDF password" /><p>The unlocked file is created securely by the backend.</p></div>
  return null
}

function ToolPage({ slug }) {
  const tool = tools.find(item => item.slug === slug)
  const [files, setFiles] = useState([])
  const [status, setStatus] = useState('idle')
  const [hasEdits, setHasEdits] = useState(false)
  const [options, setOptions] = useState({ mode: 'ranges', ranges: '1', degrees: '90', format: 'png', dpi: '150', pages: [], text: '', opacity: '35', password: '', confirmPassword: '' })
  const [preview, setPreview] = useState(null)
  const [resultPreview, setResultPreview] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const inputRef = useRef(null)
  const { setDirty } = useContext(NavigationStateContext)

  useEffect(() => { setDirty(files.length > 0 || hasEdits) }, [files.length, hasEdits, setDirty])
  useEffect(() => () => setDirty(false), [setDirty])

  if (!tool) return <NotFound />
  const Icon = tool.icon
  const choose = () => inputRef.current?.click()
  const previewRoutes = ['split', 'delete-pages', 'pdf-to-images', 'pdf-to-word']
  const loadPreview = async file => {
    if (!file || !previewRoutes.includes(slug)) return
    setPreviewLoading(true)
    setPreview(null)
    try {
      setPreview(await previewPdf(file))
    } catch (problem) {
      setError(problem.message)
    } finally {
      setPreviewLoading(false)
    }
  }
  const onFiles = async event => {
    const incoming = Array.from(event.target.files || [])
    event.target.value = ''
    const oversized = incoming.find(file => file.size > 50 * 1024 * 1024)
    if (oversized) { setError(`${oversized.name} is larger than 50 MB.`); return }
    setError('')
    setFiles(current => {
      if (!tool.multiple) return incoming.slice(0, 1)
      const existing = new Set(current.map(file => `${file.name}-${file.size}-${file.lastModified}`))
      return [...current, ...incoming.filter(file => !existing.has(`${file.name}-${file.size}-${file.lastModified}`))]
    })
    setStatus('idle')
    setResult(null)
    setResultPreview(null)
    setOptions(current => ({ ...current, pages: [] }))
    await loadPreview(incoming[0])
  }
  const removeFile = index => { setFiles(current => current.filter((_, itemIndex) => itemIndex !== index)); setStatus('idle'); setResult(null); setResultPreview(null); if (index === 0) setPreview(null) }
  const updateOptions = (name, value) => { setOptions(current => ({ ...current, [name]: value })); setHasEdits(true); setResult(null); setStatus('idle') }
  const togglePage = page => updateOptions('pages', options.pages.includes(page) ? options.pages.filter(item => item !== page) : [...options.pages, page].sort((a, b) => a - b))
  const canProcess = slug === 'merge' ? files.length >= 2 : slug === 'delete-pages' ? files.length === 1 && options.pages.length > 0 : files.length >= 1
  const fieldsForOperation = () => {
    if (slug === 'split') return { mode: options.mode, ranges: options.ranges }
    if (slug === 'rotate') return { degrees: options.degrees }
    if (slug === 'pdf-to-images') return { format: options.format, dpi: options.dpi }
    if (slug === 'delete-pages') return { pages: options.pages.join(',') }
    if (slug === 'watermark') return { text: options.text, opacity: options.opacity }
    if (slug === 'protect' || slug === 'unlock') return { password: options.password }
    return {}
  }
  const process = async () => {
    if (!canProcess || status === 'processing') return
    if (slug === 'protect' && (options.password.length < 6 || options.password !== options.confirmPassword)) { setError('Passwords must match and contain at least 6 characters.'); return }
    setStatus('processing')
    setError('')
    setResultPreview(null)
    try {
      const response = await processPdf(slug, tool.multiple ? files : files[0], fieldsForOperation())
      setResult(response)
      setStatus('done')
      if ((slug === 'delete-pages' || (slug === 'split' && options.mode === 'ranges')) && response.blob.type === 'application/pdf') {
        const generatedFile = new File([response.blob], response.filename, { type: 'application/pdf' })
        setResultPreview(await previewPdf(generatedFile))
      }
    } catch (problem) {
      setError(problem.message)
      setStatus('error')
    }
  }
  const download = () => { downloadBlob(result?.blob, result?.filename); trackEvent('download_click', { filename: result?.filename, tool: slug }); setDirty(false) }
  return <div className="tool-page"><ToolHeader /><main className="tool-page__main container">
    <input ref={inputRef} className="sr-only" type="file" accept={tool.accept} multiple={tool.multiple} onChange={onFiles} aria-label={`Choose files for ${tool.name}`} />
    <div className="tool-page__title"><Icon /><h1>{tool.name}</h1><p>{tool.desc}</p></div>
    {slug === 'compress' ? <div className={`compress-page-layout ${files.length ? 'has-preview' : ''}`}><PreviewSection files={files} onRemove={removeFile} onAdd={choose} /><CompressPanel standalone file={files[0]} onChoose={choose} onDirty={() => setHasEdits(true)} onSaved={() => setDirty(false)} /></div> : <div className="tool-workspace">
      <button className={`tool-dropzone ${files.length ? 'has-files' : ''}`} type="button" onClick={choose}><Upload /><strong>{files.length ? `${files.length} file${files.length > 1 ? 's' : ''} selected` : `Choose ${tool.multiple ? 'files' : 'a file'}`}</strong><span>{files.length ? files.map(file => file.name).join(', ') : 'Click to browse · Secure temporary processing'}</span></button>
      <PreviewSection files={files} onRemove={removeFile} onAdd={choose} mergeMode={slug === 'merge'} />
      {previewRoutes.includes(slug) ? <PagePreviewGrid preview={preview} loading={previewLoading} selectedPages={options.pages} onToggle={togglePage} selectable={slug === 'delete-pages'} /> : null}
      <ToolControls slug={slug} options={options} update={updateOptions} />
      {error ? <div className="tool-message tool-message--error" role="alert">{error}</div> : null}
      {resultPreview ? <div className="result-preview"><PagePreviewGrid preview={resultPreview} loading={false} selectedPages={[]} onToggle={() => {}} /><strong>Result preview updated successfully.</strong></div> : null}
      <div className="tool-action"><button className="btn btn--primary" disabled={!canProcess || status === 'processing'} onClick={process}>{status === 'done' ? <Check /> : status === 'processing' ? <LoaderCircle className="spin-icon" /> : <Icon />}{status === 'processing' ? 'Processing securely…' : status === 'done' ? 'Process again' : slug === 'merge' && files.length < 2 ? 'Add at least 2 PDFs' : slug === 'delete-pages' && !options.pages.length ? 'Select pages to delete' : tool.name}</button>{result ? <button className="btn btn--outline" type="button" onClick={download}><Download />Download {result.filename}</button> : null}<small><ShieldCheck />Temporary files are deleted automatically</small></div>
    </div>}
    <AdSlot placement="content" />
    <section className="related-tools"><h2>More PDF tools</h2><div>{tools.filter(item => item.slug !== slug).slice(0,4).map(item => <Link to={`/${item.slug}`} key={item.slug}>{item.name}<ArrowRight /></Link>)}</div></section>
  </main><SiteFooter /></div>
}

function RoutedToolPage() {
  const { slug } = useParams()
  return <ToolPage key={slug} slug={slug} />
}

function InfoPage({ title, children }) { return <><ToolHeader /><main className="info-page container"><h1>{title}</h1><p>{children}</p><AdSlot placement="content" /><Link className="btn btn--primary" to="/">Back to PDFSnitch</Link></main><SiteFooter /></> }
function NotFound() { return <InfoPage title="Page not found">That PDF tool is not here yet. Head home to choose another one.</InfoPage> }

const legalPages = {
  about: {
    title: 'About PDFSnitch',
    intro: 'PDFSnitch is a focused set of PDF and image tools designed to turn common document jobs into clear, dependable workflows.',
    sections: [
      { title: 'What PDFSnitch does', body: ['PDFSnitch lets you compress, merge, split, rotate, convert, watermark, protect, unlock and remove pages from documents. The interface is built to keep each task separate so files selected for one tool do not appear in another.'] },
      { title: 'How processing works', body: ['When you choose a tool, the selected file is sent to the configured PDFSnitch processing service. The service validates the file type and size, performs the requested operation in an isolated temporary job, returns the result and removes temporary job files.', 'PDFSnitch does not require an account in the current version. Deployments may use their own hosting, logging and security controls.'] },
      { title: 'Product principles', bullets: ['Real document processing rather than simulated results.', 'Clear previews before destructive operations.', 'Automatic cleanup of temporary job files.', 'Useful validation and human-readable error messages.', 'No sale of uploaded document content.'] },
      { title: 'Important limitations', body: ['Always keep a backup of important documents. Conversion and compression can change visual quality, metadata, links, forms, signatures or advanced PDF features. Password removal is available only when you already know and are authorised to use the password.'] },
    ],
  },
  privacy: {
    title: 'Privacy Policy',
    intro: 'This policy explains how PDFSnitch handles files and related information when you use the service.',
    notice: 'Launch requirement: before publishing PDFSnitch commercially, add the operator’s legal name, postal address, privacy email and grievance-contact details.',
    sections: [
      { title: '1. Scope and operator', body: ['This policy applies to the PDFSnitch website, frontend and configured processing API. The person or organisation deploying the public service is responsible for identifying itself as the data controller or data fiduciary and providing valid contact details.'] },
      { title: '2. Information processed', bullets: ['Files and images you intentionally upload for processing.', 'Tool settings such as selected pages, image format, resolution, passwords or watermark text.', 'Basic technical records that hosting infrastructure may create, such as IP address, request time, response status and diagnostic logs.', 'No user account or payment information is collected by the current application.'] },
      { title: '3. Why information is used', body: ['Uploaded content is used only to perform the operation you request, return a result, prevent abuse, diagnose failures and protect the service. A public operator should document the applicable lawful basis or consent mechanism for its jurisdiction.'] },
      { title: '4. Storage and retention', body: ['Uploads are validated in unique temporary job directories. The current backend removes those directories immediately after validation and keeps generated results in memory only long enough to return the response. Hosting providers, reverse proxies or server logs may have separate retention periods that the public operator must disclose and configure.'] },
      { title: '5. Sharing and sale', body: ['PDFSnitch does not sell uploaded document content. Information may be processed by infrastructure providers strictly to host and secure the service, or disclosed when required by applicable law. The operator should list any production hosting or analytics providers before launch.'] },
      { title: '6. Security', body: ['The application validates extensions and file contents, limits upload size, sanitises output names and isolates temporary jobs. No internet service can guarantee absolute security. Do not upload documents if the risk is unacceptable for their sensitivity.'] },
      { title: '7. Your choices and rights', body: ['Depending on applicable law, you may have rights to information, access, correction, erasure, grievance redressal, withdrawal of consent or complaint to a regulator. Requests must be sent to the privacy or grievance contact published by the operator.'] },
      { title: '8. Children and sensitive documents', body: ['PDFSnitch is not directed to children. Do not upload a child’s personal data without appropriate authority. Consider using a locally hosted deployment for highly sensitive, regulated or confidential documents.'] },
      { title: '9. International use', body: ['If the service is hosted or used across borders, the operator is responsible for lawful international transfers, processor contracts and any additional notices required in relevant countries.'] },
      { title: '10. Changes', body: ['Material changes should be posted on this page with an updated effective date. Continued use after a change means the revised policy applies to future use, subject to applicable law.'] },
    ],
  },
  terms: {
    title: 'Terms of Service',
    intro: 'These terms govern access to and use of PDFSnitch. Use the service only if you agree to them.',
    notice: 'Launch requirement: the final terms must identify the operating legal entity, governing location, contact details and any paid-service terms. Have local counsel review them before commercial launch.',
    sections: [
      { title: '1. The service', body: ['PDFSnitch provides automated PDF and image processing tools. Features may change, be suspended or be limited to protect reliability, security or legal compliance.'] },
      { title: '2. Your files and authority', body: ['You retain ownership of your files and results. You confirm that you own the content or have all permissions needed to upload, process and download it. You grant the operator a limited, temporary permission to process the content solely to provide the requested operation.'] },
      { title: '3. Acceptable use', bullets: ['Do not upload illegal, harmful, infringing or malicious content.', 'Do not use the service to bypass access controls or remove a password without authorisation.', 'Do not attack, overload, probe or interfere with the service or other users.', 'Do not use automated traffic that materially disrupts availability.', 'Comply with privacy, copyright, employment, confidentiality and records laws that apply to your documents.'] },
      { title: '4. Backups and output review', body: ['Keep the original file and review every result before relying on it. Processing may alter quality, metadata, fonts, forms, layers, signatures, links, accessibility structure or other advanced features.'] },
      { title: '5. Password tools', body: ['You are responsible for remembering passwords used to protect files. PDFSnitch cannot recover a forgotten password. Unlock tools may be used only when you know the password and have authority to remove protection.'] },
      { title: '6. Availability and warranties', body: ['The service is provided on an “as available” basis. To the extent permitted by law, no guarantee is made that every file will process successfully, that results will be error-free or that the service will always be available. Statutory consumer rights that cannot lawfully be excluded remain unaffected.'] },
      { title: '7. Liability', body: ['To the extent permitted by law, the operator is not responsible for indirect or consequential loss, loss of data, lost profits or decisions made using an unreviewed output. Any liability limitation must be completed and reviewed for the operator’s jurisdiction before commercial launch.'] },
      { title: '8. Privacy and security', body: ['Use of the service is also governed by the Privacy Policy. You are responsible for deciding whether a document is appropriate to process through the selected deployment.'] },
      { title: '9. Intellectual property', body: ['PDFSnitch’s software, branding and interface are protected by applicable intellectual-property laws. Open-source components remain governed by their respective licences. These terms do not transfer ownership of your files or the operator’s software.'] },
      { title: '10. Suspension and termination', body: ['Access may be suspended or terminated for misuse, security risk, legal requirements or material breach of these terms. Provisions that naturally survive termination, including ownership, disclaimers and liability terms, continue to apply.'] },
      { title: '11. Governing law and disputes', body: ['Unless mandatory law provides otherwise, the final public terms should specify the law and courts connected to the operator’s registered location. This information must be completed before launch.'] },
      { title: '12. Changes', body: ['Updated terms should be posted with a revised effective date. Material changes should be communicated as required by applicable law.'] },
    ],
  },
}

function LegalPage({ type }) {
  const page = legalPages[type]
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'auto' }) }, [type])
  return <div className="legal-page"><ToolHeader /><main className="legal-page__main container">
    <header className="legal-hero"><span>PDFSnitch</span><h1>{page.title}</h1><p>{page.intro}</p><small>Effective date: 20 June 2026</small></header>
    <nav className="legal-nav" aria-label="Company and legal pages"><Link className={type === 'about' ? 'active' : ''} to="/about">About</Link><Link className={type === 'privacy' ? 'active' : ''} to="/privacy">Privacy policy</Link><Link className={type === 'terms' ? 'active' : ''} to="/terms">Terms of service</Link></nav>
    {page.notice ? <aside className="legal-notice" role="note"><ShieldCheck /><div><strong>Complete before public launch</strong><p>{page.notice}</p></div></aside> : null}
    <AdSlot placement="leaderboard" />
    <div className="legal-layout"><aside className="legal-summary"><strong>On this page</strong>{page.sections.map(section => <a key={section.title} href={`#${section.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>{section.title}</a>)}</aside><article className="legal-content">
      {page.sections.map(section => <section key={section.title} id={section.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}><h2>{section.title}</h2>{section.body?.map(paragraph => <p key={paragraph}>{paragraph}</p>)}{section.bullets ? <ul>{section.bullets.map(item => <li key={item}>{item}</li>)}</ul> : null}</section>)}
      <div className="legal-contact"><h2>Questions or requests</h2><p>The public operator must publish a working privacy and support contact here before launch.</p><Link className="btn btn--outline" to="/">Return to PDFSnitch</Link></div>
    </article></div>
  </main><SiteFooter /></div>
}

function HomePage() {
  const navigate = useNavigate()
  const selectedTool = 'Compress PDF'
  const chooseFile = () => navigate('/compress')

  return (
    <div id="top" className="home-page">
      <ToolHeader />

      <main>
        <section className="hero container">
          <motion.div className="hero__copy" initial={{ opacity: 0, y: 22 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .65 }}>
            <h1>Your PDFs.<br />Your device.<br />Your business.</h1>
            <p>Compress, merge, split and convert files with secure processing, validated uploads and automatic cleanup.</p>
            <div className="hero__actions"><button className="btn btn--primary" onClick={chooseFile}><Upload size={18} />Choose a PDF</button><a className="btn btn--outline" href="#tools">Explore all tools<ArrowRight size={18} /></a></div>
          </motion.div>
          <motion.div className="route-demo hero-product" id="local-demo" initial={{ opacity: 0, x: 35 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: .7, delay: .12 }}>
            <div className="hero-product__file" aria-hidden="true"><span>PDF</span><strong>report.pdf</strong><small>4.21 MB</small><i /><i /><i /></div>
            <div className="hero-product__lock" aria-hidden="true"><LockKeyhole /></div>
            <div className="hero-product__window">
              <div className="hero-product__bar"><span /><span /><span /><ShieldCheck /></div>
              <button className="hero-product__drop" onClick={chooseFile}><Upload /><strong>Choose a PDF</strong><small>or drop your file here</small></button>
              <div className="hero-product__ready"><ShieldCheck /><span><strong>Ready when you are</strong><small>Temporary files are deleted after processing.</small></span></div>
            </div>
            <div className="hero-product__tools" aria-label="Popular PDF tools">
              {tools.slice(0, 4).map((tool) => { const Icon = tool.icon; return <Link to={`/${tool.slug}`} key={tool.slug}><Icon /><span><strong>{tool.name}</strong><small>{tool.desc}</small></span><ChevronRight /></Link> })}
            </div>
          </motion.div>
        </section>

        <section className="proof container" id="privacy">
          <article><div className="proof__icon"><ShieldCheck /></div><div><h2>Secure processing</h2><p>Files are validated before every operation.</p></div></article>
          <article><div className="proof__icon"><Zap /></div><div><h2>No sign-up</h2><p>Use every tool instantly. No account required.</p></div></article>
          <article><div className="proof__icon proof__icon--violet"><LockKeyhole /></div><div><h2>Automatic cleanup</h2><p>Temporary files are deleted after processing.</p></div></article>
        </section>

        <AdSlot placement="leaderboard" />

        <section className="tools-section container" id="tools">
          <div className="section-heading"><h2>Every PDF job,<br />handled securely.</h2><p>Pick a tool, process the real file and download the generated result.</p></div>
          <div className="featured-converters" aria-label="Featured conversion tools">
            <Link to="/word-to-pdf"><FileText /><span><strong>Word to PDF</strong><small>Convert DOCX documents into downloadable PDFs.</small></span><ArrowRight /></Link>
            <Link to="/pdf-to-word"><FileOutput /><span><strong>PDF to Word</strong><small>Extract readable PDF text into a DOCX file.</small></span><ArrowRight /></Link>
          </div>
          <div className="tool-directory">
            {tools.map((tool, i) => { const Icon = tool.icon; return <Link to={`/${tool.slug}`} key={tool.name} className={`tool-row ${i === 0 ? 'tool-row--featured' : ''} ${selectedTool === tool.name ? 'is-selected' : ''}`}><span className="tool-row__icon"><Icon /></span><span><strong>{tool.name}</strong><small>{tool.desc}</small></span><ChevronRight className="tool-row__arrow" /></Link> })}
          </div>
        </section>

        <section className="steps container" id="how">
          <h2>Three steps. Real results.</h2>
          <div className="step-line" />
          <div className="step-grid">
            <article><span className="step-no">01</span><div className="step-icon"><Plus /></div><h3>Choose a file</h3><p>Drop in a PDF or select one from your device.</p></article>
            <article><span className="step-no">02</span><div className="step-icon"><ShieldCheck /></div><h3>Process securely</h3><p>The backend validates and transforms your file in temporary storage.</p></article>
            <article><span className="step-no">03</span><div className="step-icon"><Download /></div><h3>Download</h3><p>Save the finished file and carry on.</p></article>
          </div>
        </section>

        <AdSlot placement="content" />

        <section className="final-cta"><div className="container"><h2>Give your PDF the quiet treatment.</h2><p>Fast tools, no account and secure temporary processing.</p><button className="btn btn--primary" onClick={chooseFile}>Choose a PDF<ArrowRight size={19} /></button></div></section>
      </main>

      <SiteFooter />
    </div>
  )
}

function App() {
  const [publicSettings, setPublicSettings] = useState(defaultPublicSettings)

  useEffect(() => {
    let cancelled = false
    installTracking()
    loadPublicSettings().then(settings => {
      if (cancelled) return
      setPublicSettings(settings)
      applyPublicSettings(settings)
      window.PDFC_RENDER_AD = slotName => {
        const slot = settings.ads?.slots?.find(item => item.name === slotName)
        return slot ? `Ad Placeholder: ${slot.name}` : ''
      }
    })
    return () => { cancelled = true }
  }, [])

  return <PublicSettingsContext.Provider value={publicSettings}><BrowserRouter><NavigationGuard><RouteProgress /><PageRoutes /></NavigationGuard></BrowserRouter></PublicSettingsContext.Provider>
}

export default App
