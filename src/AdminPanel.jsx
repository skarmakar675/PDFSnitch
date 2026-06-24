import { useEffect, useMemo, useState } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import {
  BarChart3, Brush, CheckCircle2, Code2, Database, Download, FileText, Gauge,
  Home, ImagePlus, KeyRound, LifeBuoy, LogOut, Megaphone, Search, Server,
  Settings, ShieldCheck, Upload, Wrench, XCircle, Zap,
} from 'lucide-react'
import { adminAuth, adminRequest, downloadAdminFile, loginAdmin, logoutAdmin, verifyAdminOtp } from './adminApi'
import { BACKEND_ORIGIN } from './appSettings'

const navItems = [
  ['Dashboard', '/admin/dashboard', Gauge],
  ['Analytics', '/admin/analytics', BarChart3],
  ['Backend/API', '/admin/api', Server],
  ['Branding', '/admin/branding', Brush],
  ['SEO', '/admin/seo', Search],
  ['AdSense Monetization', '/admin/adsense', Megaphone],
  ['Search Console', '/admin/search-console', ShieldCheck],
  ['Scripts', '/admin/scripts', Code2],
  ['Upload Settings', '/admin/upload-settings', Upload],
  ['Security', '/admin/security', KeyRound],
  ['Tools', '/admin/tools', Wrench],
  ['Documentation', '/admin/documentation', LifeBuoy],
]

const defaultSettings = {
  site_title: 'PDFSnitch',
  site_tagline: 'Make files lighter without the quality cliff.',
  primary_color: '#00b894',
  secondary_color: '#e8fff8',
  button_text: 'Compress PDF',
  api_base_url: BACKEND_ORIGIN,
  compress_endpoint: '/api/compress',
  health_endpoint: '/api/health',
  request_timeout: 60,
  max_upload_size: 25,
  default_quality: 'medium',
  default_resolution: 144,
  default_conversion: 'none',
  default_multimedia: 'discard',
  default_fonts: 'unchanged',
  ads_enabled: false,
  auto_ads_enabled: false,
  manual_ads_enabled: false,
  manual_ad_slots: [],
}

const backendAssetUrl = (value) => {
  if (!value) return ''
  if (/^(https?:|data:)/i.test(value)) return value
  return `${BACKEND_ORIGIN}${value.startsWith('/') ? value : `/${value}`}`
}

function useAdminData(path, fallback) {
  const [data, setData] = useState(fallback)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const load = async () => {
    setLoading(true)
    setError('')
    try {
      setData(await adminRequest(path))
    } catch (problem) {
      setError(problem.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [path])
  return { data, setData, loading, error, reload: load }
}

function AdminLogin() {
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [challenge, setChallenge] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  if (adminAuth.token) return <Navigate to="/admin/dashboard" replace />

  const submit = async event => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      if (challenge) {
        await verifyAdminOtp(challenge.challengeId, otp)
      } else {
        const result = await loginAdmin(username, password)
        if (result.requiresOtp) {
          setChallenge(result)
          setOtp('')
          return
        }
      }
      navigate('/admin/dashboard', { replace: true })
    } catch (problem) {
      setError(problem.message)
    } finally {
      setLoading(false)
    }
  }

  return <main className="admin-login">
    <form onSubmit={submit} className="admin-login__card">
      <Link to="/" className="admin-login__brand">PDF<span>Snitch</span><Zap size={20} fill="currentColor" strokeWidth={1.8} /></Link>
      <h1>Admin login</h1>
      <p>Manage analytics, backend settings, branding, SEO and safe monetization.</p>
      {challenge ? <div className="admin-alert admin-alert--success">OTP sent to {challenge.emailMasked}. Enter the 6-digit code to continue.</div> : null}
      {!challenge ? <label>Username<input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" /></label> : null}
      {!challenge ? <label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></label> : null}
      {challenge ? <label>Email OTP<input value={otp} onChange={event => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit OTP" /></label> : null}
      {error ? <div className="admin-alert admin-alert--error">{error}</div> : null}
      <button className="admin-primary" disabled={loading}>{loading ? 'Checking…' : challenge ? 'Verify OTP' : 'Login'}</button>
      {challenge ? <button type="button" className="admin-secondary" onClick={() => { setChallenge(null); setOtp(''); setError('') }}>Back to login</button> : null}
    </form>
  </main>
}

function AdminLayout() {
  const navigate = useNavigate()
  const [ready, setReady] = useState(false)
  const [valid, setValid] = useState(Boolean(adminAuth.token))

  useEffect(() => {
    if (!adminAuth.token) { setReady(true); setValid(false); return }
    adminRequest('/api/admin/me').then(() => setValid(true)).catch(() => { adminAuth.token = ''; setValid(false) }).finally(() => setReady(true))
  }, [])

  if (!ready) return <div className="admin-loading">Loading admin…</div>
  if (!valid) return <Navigate to="/admin/login" replace />

  const logout = async () => {
    await logoutAdmin()
    navigate('/admin/login', { replace: true })
  }

  return <div className="admin-shell">
    <aside className="admin-sidebar">
      <Link className="admin-brand" to="/admin/dashboard">PDF<span>Snitch</span><Zap size={20} fill="currentColor" strokeWidth={1.8} /></Link>
      <nav>{navItems.map(([label, path, Icon]) => <NavLink key={path} to={path}><Icon size={18} />{label}</NavLink>)}</nav>
      <button className="admin-logout" onClick={logout}><LogOut size={18} />Logout</button>
    </aside>
    <section className="admin-main">
      <header className="admin-topbar">
        <span>Local Admin Panel</span>
        <button className="admin-topbar__logout" type="button" onClick={logout}><LogOut size={17} />Logout</button>
      </header>
      <Routes>
        <Route path="/" element={<Navigate to="/admin/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/api" element={<SettingsPage group="api" title="Backend/API Settings" />} />
        <Route path="/branding" element={<SettingsPage group="branding" title="Branding" />} />
        <Route path="/seo" element={<SettingsPage group="seo" title="SEO Settings" />} />
        <Route path="/adsense" element={<AdsensePage />} />
        <Route path="/search-console" element={<SettingsPage group="search" title="Search Console" />} />
        <Route path="/scripts" element={<SettingsPage group="scripts" title="Custom Scripts" />} />
        <Route path="/upload-settings" element={<SettingsPage group="upload" title="Upload Settings" />} />
        <Route path="/security" element={<SecurityPage />} />
        <Route path="/tools" element={<ToolsPage />} />
        <Route path="/documentation" element={<DocumentationPage />} />
      </Routes>
    </section>
  </div>
}

function PageHeader({ title, subtitle, children }) {
  return <header className="admin-page-header"><div><h1>{title}</h1>{subtitle ? <p>{subtitle}</p> : null}</div>{children}</header>
}

function StatCard({ label, value, tone = '' }) {
  return <article className={`admin-stat ${tone}`}><span>{label}</span><strong>{value ?? '—'}</strong></article>
}

function DashboardPage() {
  const { data, loading, error, reload } = useAdminData('/api/admin/dashboard-stats', {})
  const [test, setTest] = useState(null)
  const testBackend = async () => setTest(await adminRequest('/api/admin/test-backend', { method: 'POST' }))
  return <div>
    <PageHeader title="Dashboard" subtitle="Visitor activity, compression usage, backend health and monetization status.">
      <button className="admin-secondary" onClick={reload}>Refresh</button>
    </PageHeader>
    {error ? <div className="admin-alert admin-alert--error">{error}</div> : null}
    <div className="admin-grid admin-grid--stats">
      <StatCard label="Today visitors" value={loading ? '…' : data.todayVisitors} />
      <StatCard label="Yesterday visitors" value={data.yesterdayVisitors} />
      <StatCard label="Last 7 days" value={data.last7DaysVisitors} />
      <StatCard label="This month" value={data.thisMonthVisitors} />
      <StatCard label="Total visitors" value={data.totalVisitors} />
      <StatCard label="Page views" value={data.totalPageViews} />
      <StatCard label="Compress clicks" value={data.totalCompressClicks} />
      <StatCard label="Successful compressions" value={data.totalSuccessfulCompressions} tone="is-good" />
      <StatCard label="Failed compressions" value={data.totalFailedCompressions} tone="is-warn" />
      <StatCard label="Download clicks" value={data.totalDownloadClicks} />
      <StatCard label="Backend" value={data.backendStatus?.connected ? 'Connected' : 'Failed'} tone={data.backendStatus?.connected ? 'is-good' : 'is-warn'} />
      <StatCard label="Ads" value={data.monetizationStatus?.enabled ? 'Enabled' : 'Disabled'} />
    </div>
    <section className="admin-card">
      <h2>Quick actions</h2>
      <div className="admin-actions">
        <button onClick={testBackend}>Test backend</button>
        <Link to="/admin/analytics">Open analytics</Link>
        <Link to="/admin/adsense">Open ads settings</Link>
        <Link to="/admin/branding">Open branding</Link>
        <Link to="/admin/upload-settings">Open upload settings</Link>
      </div>
      {test ? <div className={`admin-alert ${test.connected ? 'admin-alert--success' : 'admin-alert--error'}`}>{test.connected ? 'Backend connected' : 'Backend failed'} · Status {test.statusCode || 'n/a'} · {test.responseTimeMs} ms {test.error ? `· ${test.error}` : ''}</div> : null}
    </section>
  </div>
}

function AnalyticsPage() {
  const [period, setPeriod] = useState('last7')
  const summary = useAdminData(`/api/admin/analytics/summary?period=${period}`, {})
  const daily = useAdminData('/api/admin/analytics/daily', [])
  const weekly = useAdminData('/api/admin/analytics/weekly', [])
  const monthly = useAdminData('/api/admin/analytics/monthly', [])
  const pages = useAdminData('/api/admin/analytics/top-pages', [])
  const referrers = useAdminData('/api/admin/analytics/referrers', [])
  const events = useAdminData('/api/admin/analytics/events?limit=100', [])
  const maxDaily = Math.max(1, ...daily.data.map(row => row.events || 0))
  return <div>
    <PageHeader title="Visitor Analytics" subtitle="Lightweight local analytics for page views, visitors and PDF tool events.">
      <select value={period} onChange={event => setPeriod(event.target.value)}><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="last7">Last 7 days</option><option value="last30">Last 30 days</option><option value="month">This month</option></select>
      <button className="admin-secondary" onClick={() => downloadAdminFile('/api/admin/analytics/export-csv', 'pdfc-analytics.csv')}>Export CSV</button>
    </PageHeader>
    <div className="admin-grid admin-grid--stats">
      <StatCard label="Unique visitors" value={summary.data.uniqueVisitors} />
      <StatCard label="Page views" value={summary.data.pageViews} />
      <StatCard label="Compress clicks" value={summary.data.compressClicks} />
      <StatCard label="Success" value={summary.data.compressSuccess} />
      <StatCard label="Failed" value={summary.data.compressFailed} />
      <StatCard label="Downloads" value={summary.data.downloads} />
    </div>
    <section className="admin-card"><h2>Daily visitors/events</h2><div className="admin-bars">{daily.data.slice(0, 30).map(row => <div key={row.label}><span>{row.label}</span><b style={{ width: `${(row.events / maxDaily) * 100}%` }} /><em>{row.events}</em></div>)}</div></section>
    <div className="admin-two-col">
      <DataTable title="Weekly visitors" rows={weekly.data} columns={['label', 'events', 'visitors']} />
      <DataTable title="Monthly summary" rows={monthly.data} columns={['label', 'events', 'visitors']} />
      <DataTable title="Top pages" rows={pages.data} columns={['page_url', 'views']} />
      <DataTable title="Referrers" rows={referrers.data} columns={['referrer', 'visits']} />
    </div>
    <DataTable title="Latest events" rows={events.data} columns={['event_name', 'page_url', 'created_at']} />
  </div>
}

function DataTable({ title, rows, columns }) {
  return <section className="admin-card admin-table-card"><h2>{title}</h2><table><thead><tr>{columns.map(column => <th key={column}>{column.replaceAll('_', ' ')}</th>)}</tr></thead><tbody>{rows?.length ? rows.map((row, index) => <tr key={index}>{columns.map(column => <td key={column}>{String(row[column] ?? '—')}</td>)}</tr>) : <tr><td colSpan={columns.length}>No data yet.</td></tr>}</tbody></table></section>
}

const fieldGroups = {
  api: [
    ['api_base_url', 'API Base URL', 'url'], ['compress_endpoint', 'Compress endpoint'], ['health_endpoint', 'Health check endpoint'], ['request_timeout', 'Request timeout', 'number'], ['max_upload_size', 'Max upload size MB', 'number'], ['error_message', 'Custom backend error message', 'textarea'],
  ],
  branding: [
    ['site_title', 'Site title'], ['site_tagline', 'Site tagline'], ['primary_color', 'Primary color', 'color'], ['secondary_color', 'Secondary color', 'color'], ['button_text', 'Button text'], ['footer_text', 'Footer text', 'textarea'], ['copyright_text', 'Copyright text'], ['facebook_url', 'Facebook URL'], ['instagram_url', 'Instagram URL'], ['youtube_url', 'YouTube URL'], ['linkedin_url', 'LinkedIn URL'], ['twitter_url', 'X/Twitter URL'],
  ],
  seo: [
    ['seo_title', 'Meta title'], ['seo_description', 'Meta description', 'textarea'], ['seo_keywords', 'Meta keywords'], ['canonical_url', 'Canonical URL'], ['robots_index', 'Robots index', 'toggle'], ['og_title', 'Open Graph title'], ['og_description', 'Open Graph description', 'textarea'], ['og_image', 'Open Graph image URL'], ['twitter_title', 'Twitter title'], ['twitter_description', 'Twitter description', 'textarea'], ['twitter_image', 'Twitter image URL'], ['org_name', 'Organization name'], ['org_logo', 'Organization logo URL'], ['contact_email', 'Contact email'],
  ],
  search: [
    ['google_search_console_meta', 'Google Search Console verification content'], ['bing_webmaster_meta', 'Bing Webmaster verification content'], ['sitemap_url', 'Sitemap URL'], ['search_console_notes', 'Notes / DNS TXT instructions', 'textarea'],
  ],
  scripts: [
    ['header_scripts', 'Header scripts', 'textarea'], ['footer_scripts', 'Footer scripts', 'textarea'],
  ],
  upload: [
    ['max_upload_size', 'Maximum PDF upload size MB', 'number'], ['allowed_file_types', 'Allowed file types'], ['default_quality', 'Default image quality', 'select', ['low', 'medium', 'high']], ['default_resolution', 'Default image resolution', 'select', ['72', '100', '144', '200', '300', '720']], ['default_conversion', 'Default conversion', 'select', ['none', 'grayscale']], ['default_multimedia', 'Default multimedia files', 'select', ['discard', 'keep']], ['default_fonts', 'Default fonts', 'select', ['unchanged', 'optimize']], ['drag_drop_enabled', 'Enable drag and drop', 'toggle'], ['download_button_enabled', 'Enable download button', 'toggle'], ['temporary_notice_enabled', 'Enable temporary file notice', 'toggle'], ['success_message', 'Custom success message', 'textarea'], ['error_message', 'Custom error message', 'textarea'],
  ],
}

function SettingsPage({ group, title }) {
  const { data, setData, loading, error, reload } = useAdminData('/api/admin/settings', defaultSettings)
  const [message, setMessage] = useState('')
  const fields = fieldGroups[group] || []
  const save = async event => {
    event.preventDefault()
    setMessage('')
    setData(await adminRequest('/api/admin/settings', { method: 'POST', body: JSON.stringify(data) }))
    setMessage('Settings saved.')
  }
  return <div>
    <PageHeader title={title} subtitle="Changes are saved to the local SQLite database and exposed to the frontend safely.">{group === 'api' ? <button className="admin-secondary" onClick={async () => setMessage(JSON.stringify(await adminRequest('/api/admin/test-backend', { method: 'POST' })))}>Test connection</button> : null}</PageHeader>
    {error ? <div className="admin-alert admin-alert--error">{error}</div> : null}
    {message ? <div className="admin-alert admin-alert--success">{message}</div> : null}
    <form className="admin-card admin-form" onSubmit={save}>
      {group === 'branding' ? <MediaControls settings={data} setSettings={setData} reload={reload} /> : null}
      {fields.map(field => <Field key={field[0]} field={field} settings={data} setSettings={setData} />)}
      <button className="admin-primary" disabled={loading}>Save settings</button>
    </form>
  </div>
}

function Field({ field, settings, setSettings }) {
  const [key, label, type = 'text', options = []] = field
  const value = settings[key] ?? ''
  const update = next => setSettings(current => ({ ...current, [key]: next }))
  if (type === 'textarea') return <label>{label}<textarea value={value} onChange={event => update(event.target.value)} rows={5} /></label>
  if (type === 'toggle') return <label className="admin-toggle"><input type="checkbox" checked={Boolean(value)} onChange={event => update(event.target.checked)} /><span>{label}</span></label>
  if (type === 'select') return <label>{label}<select value={value} onChange={event => update(event.target.value)}>{options.map(option => <option key={option} value={option}>{option}</option>)}</select></label>
  return <label>{label}<input type={type} value={value} onChange={event => update(type === 'number' ? Number(event.target.value) : event.target.value)} /></label>
}

function MediaControls({ settings, setSettings, reload }) {
  const upload = async (kind, file) => {
    const form = new FormData()
    form.append('file', file)
    setSettings(await adminRequest(`/api/admin/media/upload-${kind}`, { method: 'POST', body: form }))
    await reload()
  }
  const remove = async kind => {
    setSettings(await adminRequest(`/api/admin/media/${kind}`, { method: 'DELETE' }))
    await reload()
  }
  return <div className="admin-media-row">
    {['logo', 'favicon'].map(kind => <div className="admin-media-box" key={kind}>
      <strong>{kind === 'logo' ? 'Logo' : 'Favicon'}</strong>
      {settings[`${kind}_url`] ? <img src={backendAssetUrl(settings[`${kind}_url`])} alt={kind} /> : <span>No {kind} uploaded</span>}
      <label className="admin-file-button"><ImagePlus size={16} />Upload {kind}<input type="file" accept="image/*,.ico,.svg" onChange={event => event.target.files?.[0] && upload(kind, event.target.files[0])} /></label>
      <button type="button" onClick={() => remove(kind)}>Remove</button>
    </div>)}
  </div>
}

function AdsensePage() {
  const { data, setData, error } = useAdminData('/api/admin/settings', defaultSettings)
  const [tab, setTab] = useState('overview')
  const [message, setMessage] = useState('')
  const slots = data.manual_ad_slots || []
  const warnings = useMemo(() => safetyWarnings(data), [data])
  const save = async () => { setData(await adminRequest('/api/admin/settings', { method: 'POST', body: JSON.stringify(data) })); setMessage('Monetization settings saved.') }
  const generatedAdsTxt = data.adsense_publisher_id ? `google.com, ${String(data.adsense_publisher_id).replace('ca-', '')}, DIRECT, f08c47fec0942fa0` : ''
  return <div>
    <PageHeader title="AdSense Monetization" subtitle="Safe local ad controls for Auto Ads, manual slots, placements and ads.txt."><button className="admin-primary" onClick={save}>Save monetization</button></PageHeader>
    {error ? <div className="admin-alert admin-alert--error">{error}</div> : null}
    {message ? <div className="admin-alert admin-alert--success">{message}</div> : null}
    <div className="admin-tabs">{['overview', 'auto ads', 'manual ads', 'ads.txt', 'placements', 'safety check', 'preview', 'documentation'].map(name => <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>)}</div>
    {tab === 'overview' ? <div className="admin-grid admin-grid--stats"><StatCard label="Ads" value={data.ads_enabled ? 'Enabled' : 'Disabled'} /><StatCard label="Auto Ads" value={data.auto_ads_enabled ? 'Enabled' : 'Disabled'} /><StatCard label="Manual Ads" value={data.manual_ads_enabled ? 'Enabled' : 'Disabled'} /><StatCard label="Publisher ID" value={data.adsense_publisher_id || 'Missing'} /><StatCard label="ads.txt" value={data.ads_txt_content || generatedAdsTxt ? 'Configured' : 'Missing'} /><StatCard label="Active slots" value={slots.filter(slot => slot.enabled).length} /></div> : null}
    {tab === 'auto ads' ? <section className="admin-card admin-form"><Field field={['ads_enabled', 'Enable monetization', 'toggle']} settings={data} setSettings={setData} /><Field field={['monetization_mode', 'Monetization mode', 'select', ['auto', 'manual', 'hybrid']]} settings={data} setSettings={setData} /><Field field={['adsense_publisher_id', 'Google AdSense Publisher ID']} settings={data} setSettings={setData} /><Field field={['auto_ads_enabled', 'Enable Auto Ads', 'toggle']} settings={data} setSettings={setData} /><Field field={['auto_generate_adsense_script', 'Auto-generate script from Publisher ID', 'toggle']} settings={data} setSettings={setData} /><Field field={['auto_ads_code', 'Auto Ads script/code', 'textarea']} settings={data} setSettings={setData} /><p className="admin-help">Localhost shows placeholders. Enable real AdSense only on your approved live domain.</p></section> : null}
    {tab === 'manual ads' ? <ManualSlots slots={slots} setSlots={next => setData(current => ({ ...current, manual_ad_slots: next }))} /> : null}
    {tab === 'ads.txt' ? <section className="admin-card admin-form"><Field field={['ads_txt_content', 'ads.txt content', 'textarea']} settings={data} setSettings={setData} /><button type="button" onClick={() => setData(current => ({ ...current, ads_txt_content: generatedAdsTxt }))}>Auto-generate AdSense line</button><p className="admin-help">Preview at <a href={`${BACKEND_ORIGIN}/ads.txt`} target="_blank" rel="noreferrer">{BACKEND_ORIGIN}/ads.txt</a></p></section> : null}
    {tab === 'placements' ? <section className="admin-card admin-form">{[['ad_below_intro', 'Below intro content'], ['ad_below_tool', 'Below tool card'], ['ad_after_result', 'After compression result'], ['ad_footer', 'Footer'], ['ad_sidebar', 'Sidebar desktop only']].map(field => <Field key={field[0]} field={[field[0], field[1], 'toggle']} settings={data} setSettings={setData} />)}<Field field={['min_button_distance', 'Minimum spacing from buttons', 'number']} settings={data} setSettings={setData} /><Field field={['disable_ads_during_compression', 'Disable ads during compression', 'toggle']} settings={data} setSettings={setData} /></section> : null}
    {tab === 'safety check' ? <section className="admin-card"><h2>Policy safety check</h2>{warnings.map(item => <div key={item.text} className={`admin-check admin-check--${item.level}`}>{item.level === 'passed' ? <CheckCircle2 /> : item.level === 'error' ? <XCircle /> : <ShieldCheck />}{item.text}</div>)}</section> : null}
    {tab === 'preview' ? <AdPreview data={data} /> : null}
    {tab === 'documentation' ? <section className="admin-card"><h2>AdSense-safe notes</h2><p>Keep ads away from upload, compress, progress, error and download areas. Never ask users to click ads. Do not track ad clicks. Localhost preview uses placeholders only.</p></section> : null}
  </div>
}

function ManualSlots({ slots, setSlots }) {
  const update = (index, key, value) => setSlots(slots.map((slot, item) => item === index ? { ...slot, [key]: value } : slot))
  const add = () => setSlots([...slots, { name: `slot_${slots.length + 1}`, enabled: false, type: 'display', publisherId: '', slotId: '', format: 'auto', responsive: true, customHtml: '', device: 'all', placement: 'below_tool' }])
  return <section className="admin-card"><div className="admin-card-head"><h2>Manual ad slots</h2><button onClick={add}>Add slot</button></div>{slots.map((slot, index) => <div className="admin-slot" key={index}>
    <input value={slot.name} onChange={event => update(index, 'name', event.target.value)} placeholder="Slot name" />
    <label><input type="checkbox" checked={slot.enabled} onChange={event => update(index, 'enabled', event.target.checked)} />Enabled</label>
    <select value={slot.type} onChange={event => update(index, 'type', event.target.value)}><option value="display">display</option><option value="in_article">in_article</option><option value="multiplex">multiplex</option><option value="custom_html">custom_html</option></select>
    <input value={slot.publisherId} onChange={event => update(index, 'publisherId', event.target.value)} placeholder="Publisher ID" />
    <input value={slot.slotId} onChange={event => update(index, 'slotId', event.target.value)} placeholder="Ad Slot ID" />
    <select value={slot.format} onChange={event => update(index, 'format', event.target.value)}><option value="auto">auto</option><option value="rectangle">rectangle</option><option value="horizontal">horizontal</option><option value="vertical">vertical</option></select>
    <select value={slot.device} onChange={event => update(index, 'device', event.target.value)}><option value="all">all</option><option value="desktop">desktop</option><option value="mobile">mobile</option></select>
    <select value={slot.placement} onChange={event => update(index, 'placement', event.target.value)}><option value="below_intro">below_intro</option><option value="below_tool">below_tool</option><option value="after_result">after_result</option><option value="footer">footer</option><option value="sidebar">sidebar</option><option value="shortcode_only">shortcode_only</option></select>
    <textarea value={slot.customHtml || ''} onChange={event => update(index, 'customHtml', event.target.value)} placeholder="Custom HTML ad code" />
    <small>Frontend helper: window.PDFC_RENDER_AD("{slot.name}")</small>
  </div>)}</section>
}

function safetyWarnings(settings) {
  const warnings = []
  if (!settings.ads_enabled) warnings.push({ level: 'warning', text: 'Monetization is disabled.' })
  if (settings.ads_enabled && !settings.adsense_publisher_id) warnings.push({ level: 'error', text: 'Ads enabled but Publisher ID is missing.' })
  if (settings.ads_enabled && !(settings.ads_txt_content || settings.adsense_publisher_id)) warnings.push({ level: 'warning', text: 'ads.txt is missing.' })
  if (settings.auto_ads_enabled && !(settings.auto_ads_code || (settings.auto_generate_adsense_script && settings.adsense_publisher_id))) warnings.push({ level: 'error', text: 'Auto Ads enabled but script is missing.' })
  ;(settings.manual_ad_slots || []).forEach(slot => { if (slot.enabled && slot.type !== 'custom_html' && !slot.slotId) warnings.push({ level: 'warning', text: `Manual slot "${slot.name}" is enabled but slot ID is missing.` }) })
  if (Number(settings.min_button_distance) < 250) warnings.push({ level: 'warning', text: 'Minimum ad distance from buttons should be at least 250px.' })
  if (!settings.ad_above_tool) warnings.push({ level: 'passed', text: 'Ads are not placed directly above upload/compress controls.' })
  if (warnings.length === 0) warnings.push({ level: 'passed', text: 'No monetization issues detected.' })
  return warnings
}

function AdPreview({ data }) {
  return <section className="admin-card"><h2>Layout preview</h2><div className="admin-ad-preview">
    <div>Header</div>
    {data.ad_below_intro ? <b>Ad: Below Intro</b> : null}
    <main><span>Upload area</span><button>Compress PDF</button><span>Result area</span></main>
    {data.ad_below_tool ? <b>Ad: Below Tool</b> : null}
    {data.ad_after_result ? <b>Ad: After Result</b> : null}
    <footer>{data.ad_footer ? <b>Ad: Footer</b> : 'Footer'}</footer>
  </div><p className="admin-help">Ads are intentionally outside upload, compress, progress and download zones.</p></section>
}

function SecurityPage() {
  const { data, setData, loading, error, reload } = useAdminData('/api/admin/security', { username: '', otpEnabled: false, otpEmail: '', smtpConfigured: false })
  const [passwordForm, setPasswordForm] = useState({ current_password: '', new_password: '', confirm_password: '', username: '' })
  const [otpForm, setOtpForm] = useState({ enabled: false, email: '' })
  const [message, setMessage] = useState('')

  useEffect(() => {
    setPasswordForm(current => ({ ...current, username: data.username || '' }))
    setOtpForm({ enabled: Boolean(data.otpEnabled), email: data.otpEmail || '' })
  }, [data.username, data.otpEnabled, data.otpEmail])

  const changePassword = async event => {
    event.preventDefault()
    setMessage('')
    if (passwordForm.new_password !== passwordForm.confirm_password) {
      setMessage('New password and confirmation do not match.')
      return
    }
    await adminRequest('/api/admin/security/password', {
      method: 'POST',
      body: JSON.stringify({
        current_password: passwordForm.current_password,
        new_password: passwordForm.new_password,
        username: passwordForm.username,
      }),
    })
    setPasswordForm(current => ({ ...current, current_password: '', new_password: '', confirm_password: '' }))
    setMessage('Admin username/password updated. Use the new details next login.')
    await reload()
  }

  const saveOtp = async event => {
    event.preventDefault()
    setMessage('')
    setData(await adminRequest('/api/admin/security/otp', {
      method: 'POST',
      body: JSON.stringify({ enabled: otpForm.enabled, email: otpForm.email }),
    }))
    setMessage('OTP settings saved.')
  }

  return <div>
    <PageHeader title="Security" subtitle="Change admin login details and enable email OTP verification." />
    {error ? <div className="admin-alert admin-alert--error">{error}</div> : null}
    {message ? <div className={message.includes('match') ? 'admin-alert admin-alert--error' : 'admin-alert admin-alert--success'}>{message}</div> : null}
    <div className="admin-two-col">
      <form className="admin-card admin-form admin-form--single" onSubmit={changePassword}>
        <h2>Change admin username/password</h2>
        <label>Admin username<input value={passwordForm.username} onChange={event => setPasswordForm(current => ({ ...current, username: event.target.value }))} /></label>
        <label>Current password<input type="password" value={passwordForm.current_password} onChange={event => setPasswordForm(current => ({ ...current, current_password: event.target.value }))} autoComplete="current-password" /></label>
        <label>New password<input type="password" value={passwordForm.new_password} onChange={event => setPasswordForm(current => ({ ...current, new_password: event.target.value }))} autoComplete="new-password" /></label>
        <label>Confirm new password<input type="password" value={passwordForm.confirm_password} onChange={event => setPasswordForm(current => ({ ...current, confirm_password: event.target.value }))} autoComplete="new-password" /></label>
        <p className="admin-help">Use at least 8 characters. After changing, logout and login with the new details.</p>
        <button className="admin-primary" disabled={loading}>Save password</button>
      </form>
      <form className="admin-card admin-form admin-form--single" onSubmit={saveOtp}>
        <h2>Email OTP verification</h2>
        <label className="admin-toggle"><input type="checkbox" checked={otpForm.enabled} onChange={event => setOtpForm(current => ({ ...current, enabled: event.target.checked }))} /><span>Require email OTP after password login</span></label>
        <label>OTP email address<input type="email" value={otpForm.email} onChange={event => setOtpForm(current => ({ ...current, email: event.target.value }))} placeholder="you@example.com" /></label>
        <div className={data.smtpConfigured ? 'admin-alert admin-alert--success' : 'admin-alert admin-alert--error'}>
          {data.smtpConfigured ? 'SMTP email is configured.' : 'SMTP is not configured yet. Add SMTP settings in backend/.env before enabling OTP.'}
        </div>
        <p className="admin-help">At login, the backend sends a 6-digit OTP to this email. The code expires in 10 minutes.</p>
        <button className="admin-primary" disabled={loading}>Save OTP settings</button>
      </form>
    </div>
  </div>
}

function ToolsPage() {
  const [result, setResult] = useState('')
  const run = async (label, fn) => {
    try { setResult(`${label}: ${JSON.stringify(await fn(), null, 2)}`) } catch (problem) { setResult(`${label}: ${problem.message}`) }
  }
  return <div>
    <PageHeader title="Tools" subtitle="Maintenance, export/import and local system checks." />
    <section className="admin-card"><div className="admin-tool-grid">
      <button onClick={() => run('Backend health', () => adminRequest('/api/admin/test-backend', { method: 'POST' }))}>Check backend health</button>
      <button onClick={() => run('System status', () => adminRequest('/api/admin/tools/system-check'))}>Check system status</button>
      <button onClick={() => run('Clear analytics', () => adminRequest('/api/admin/tools/clear-analytics', { method: 'POST' }))}>Clear analytics</button>
      <button onClick={() => run('Reset settings', () => adminRequest('/api/admin/tools/reset-settings', { method: 'POST' }))}>Reset settings</button>
      <button onClick={() => downloadAdminFile('/api/admin/tools/export-settings', 'pdfc-settings.json')}>Export settings JSON</button>
      <button onClick={() => downloadAdminFile('/api/admin/analytics/export-csv', 'pdfc-analytics.csv')}>Export analytics CSV</button>
      <button onClick={() => window.open(`${BACKEND_ORIGIN}/ads.txt`, '_blank')}>Check ads.txt</button>
    </div>{result ? <pre className="admin-result">{result}</pre> : null}</section>
  </div>
}

function DocumentationPage() {
  const docs = [
    ['How to login admin panel', 'Open /admin/login and use the username and password configured in backend/.env. Change ADMIN_USERNAME, ADMIN_PASSWORD and ADMIN_SECRET_KEY before real deployment.'],
    ['How to change logo', 'Open Branding, upload a logo, then save. The public app loads the logo from /api/public/settings.'],
    ['How to check visitors', 'Open Analytics. Page views and compressor events are tracked anonymously with a local browser visitor ID.'],
    ['How to setup backend URL', 'Open Backend/API settings and set API Base URL to your FastAPI backend, for example https://pdfsnitch-izhk.onrender.com.'],
    ['How to setup AdSense', 'Open AdSense Monetization, enter Publisher ID, enable monetization, choose Auto/Manual/Hybrid, then configure ads.txt. Localhost uses placeholders.'],
    ['Safe ad placements', 'Use below intro, below tool, after result, footer, or desktop sidebar. Never put ads in the upload box, progress area, or near compress/download buttons.'],
    ['How to setup Search Console', 'Paste only the verification content or tag value in Search Console settings. The React app injects meta tags into document head.'],
    ['Troubleshoot backend not reachable', 'Start FastAPI on port 8000, test /api/health, then use the Backend/API Test connection button.'],
  ]
  return <div><PageHeader title="Documentation" subtitle="Beginner-friendly help for running and configuring your local PDFSnitch admin." /><section className="admin-card admin-docs">{docs.map(([title, body]) => <article key={title}><h2>{title}</h2><p>{body}</p></article>)}</section></div>
}

export { AdminLayout, AdminLogin }
