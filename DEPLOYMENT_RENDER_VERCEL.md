# PDFSnitch deployment guide: Render backend + Vercel frontend

This project is split into two live services:

- Backend API: FastAPI from `backend/`, deployed on Render.
- Frontend app: React/Vite from the project root, deployed on Vercel.

Do not put the backend inside Vercel. Vercel should only build the frontend static app.

## Files added for deployment

- `render.yaml` — Render Blueprint for the FastAPI backend.
- `vercel.json` — Vercel SPA/build config for the Vite frontend.
- `.env.vercel.example` — frontend production environment template.
- `backend/.env.render.example` — backend production environment template.
- `runtime.txt` — Python runtime hint for Render.
- `.gitignore` — protects local secrets and runtime files.

## 1. Push project to GitHub

Render and Vercel both deploy most easily from GitHub.

From the project folder:

```bash
git add .
git commit -m "Add Render and Vercel deployment config"
git push
```

If this is not yet connected to GitHub, create a new GitHub repository first and push this folder.

## 2. Deploy backend on Render

Recommended method: Render Blueprint.

1. Open Render.
2. Click **New +**.
3. Choose **Blueprint**.
4. Connect your GitHub repository.
5. Select the `render.yaml` file.
6. Render will create the backend service named `pdfsnitch-api`.

The backend start command is:

```bash
uvicorn backend.app:app --host 0.0.0.0 --port $PORT
```

If you created Render manually and set **Root Directory** to `backend`, use this start command instead:

```bash
uvicorn app:app --host 0.0.0.0 --port $PORT
```

Both start styles are supported by the code now.

For scanned PDF to Word OCR, deploy the backend as **Docker** instead of native Python:

```text
Root Directory: backend
Environment: Docker
Dockerfile Path: ./Dockerfile
```

The Docker backend installs Tesseract OCR, which is required for scanned/image-based PDF pages.

The health check URL is:

```text
/api/health
```

After deployment, your backend URL will look like:

```text
https://pdfsnitch-api-4z7h.onrender.com
```

If Render gives a different URL, use that real URL in the next steps.

## 3. Render environment variables

In Render dashboard, open:

```text
pdfsnitch-api > Environment
```

Set these values:

```env
PDFSNITCH_MAX_UPLOAD_MB=50
PDFSNITCH_PUBLIC_API_BASE_URL=https://pdfsnitch-api-4z7h.onrender.com
PDFSNITCH_FRONTEND_ORIGINS=https://pdfsnitch.vercel.app

PDFSNITCH_DATA_DIR=/var/data
PDFSNITCH_UPLOAD_DIR=/var/data/uploads
PDFSNITCH_MEDIA_DIR=/var/data/media
PDFSNITCH_EXPORT_DIR=/var/data/exports
PDFSNITCH_TEMP_DIR=/tmp/pdfsnitch
PDFSNITCH_OCR_LANG=eng
PDFSNITCH_OCR_DPI=200

ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-strong-admin-password
ADMIN_SECRET_KEY=your-long-random-secret
ADMIN_OTP_ENABLED=true
ADMIN_OTP_EMAIL=your-email@example.com
```

Optional Gmail SMTP for OTP:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=your-email@example.com
SMTP_PASSWORD=your-gmail-app-password-without-spaces
SMTP_FROM_EMAIL=your-email@example.com
SMTP_USE_TLS=true
```

Recommended for Render free services: use Resend API for OTP instead of Gmail SMTP, because free Render web services can block outbound SMTP ports `25`, `465`, and `587`.

```env
RESEND_API_KEY=your-resend-api-key
RESEND_FROM_EMAIL=PDFSnitch <onboarding@resend.dev>
```

If `RESEND_API_KEY` is set, PDFSnitch sends OTP through Resend over HTTPS and ignores SMTP for OTP.

Important:

- Do not put real passwords in GitHub files.
- Put real passwords only in Render environment variables.
- `PDFSNITCH_FRONTEND_ORIGINS` must contain your final Vercel URL.

## 4. Persistent data note

This app uses SQLite for local admin settings and analytics.

The included `render.yaml` uses a persistent disk mounted at:

```text
/var/data
```

That keeps:

- admin settings
- analytics database
- uploaded logo/favicon media

If you change Render to a free service without disk, the backend can still run, but settings and analytics may reset when the service restarts or redeploys.

## 5. Test backend

Open this in your browser:

```text
https://pdfsnitch-api-4z7h.onrender.com/api/health
```

Expected response:

```json
{"status":"ok","max_upload_mb":50}
```

Also test:

```text
https://pdfsnitch-api-4z7h.onrender.com/api/public/settings
```

Make sure `apiBaseUrl` shows your Render URL, not `127.0.0.1`.

## 6. Deploy frontend on Vercel

1. Open Vercel.
2. Click **Add New Project**.
3. Import the same GitHub repository.
4. Framework preset: **Vite**.
5. Build command:

```bash
npm run build
```

6. Output directory:

```text
dist
```

7. Add environment variable:

```env
VITE_API_URL=https://pdfsnitch-api-4z7h.onrender.com
```

8. Deploy.

Important for Google AdSense:

- `vercel.json` rewrites `/ads.txt` to `https://pdfsnitch-api-4z7h.onrender.com/ads.txt`.
- If your Render backend URL is different, edit `vercel.json` and replace that URL before deploying.
- Google checks ads.txt on your frontend domain, for example `https://pdfsnitch.vercel.app/ads.txt`.

## 7. Update Render CORS after Vercel deploy

After Vercel deploy finishes, copy your Vercel URL, for example:

```text
https://pdfsnitch.vercel.app
```

Go back to Render and update:

```env
PDFSNITCH_FRONTEND_ORIGINS=https://pdfsnitch.vercel.app
```

If you have multiple domains, separate them with commas:

```env
PDFSNITCH_FRONTEND_ORIGINS=https://pdfsnitch.vercel.app,https://www.yourdomain.com
```

Redeploy/restart the Render backend after changing CORS.

## 8. Connect frontend admin settings to backend

Open:

```text
https://pdfsnitch.vercel.app/admin/login
```

Login with the Render environment username/password.

Then open:

```text
Admin > Backend/API
```

Set:

```text
API Base URL: https://pdfsnitch-api-4z7h.onrender.com
Compress endpoint: /api/compress
Health endpoint: /api/health
```

Save settings.

## 9. Test live app

Checklist:

- Backend `/api/health` opens.
- Backend `/api/public/settings` shows live Render API URL.
- Frontend Vercel homepage opens.
- `/admin/login` opens on Vercel.
- Admin login works.
- Upload a PDF on Vercel frontend.
- Compress PDF works.
- Download result works.
- PDF preview works.
- Analytics page records page views.
- Logo upload works and remains after redeploy if persistent disk is enabled.
- Browser console has no CORS errors.

## Common problems

### Render installs Python 3.14

If your Render log shows paths like:

```text
python/Python-3.14
cp314
```

set this in Render:

```env
PYTHON_VERSION=3.12.4
```

This project also includes `.python-version` files with:

```text
3.12.4
```

After changing Python version, use:

```text
Manual Deploy > Clear build cache & deploy
```

### Frontend says it cannot reach backend

Check Vercel environment variable:

```env
VITE_API_URL=https://your-render-backend.onrender.com
```

Then redeploy Vercel.

### CORS error in browser console

Update Render:

```env
PDFSNITCH_FRONTEND_ORIGINS=https://pdfsnitch.vercel.app
```

Then restart/redeploy backend.

### Public settings still show localhost

Set Render:

```env
PDFSNITCH_PUBLIC_API_BASE_URL=https://your-render-backend.onrender.com
```

Then restart/redeploy backend.

### Admin settings disappear after redeploy

Use Render persistent disk. Without persistent disk, SQLite data is temporary.
