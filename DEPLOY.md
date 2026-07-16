# BilisOps — Go live on Supabase + Cloudflare + Render

Three domains, one shared database:

| Piece | Host | Build command | Publish folder |
|---|---|---|---|
| Landing (marketing + Register) | **Cloudflare Pages** | `npm run build:landing` | `dist-landing` |
| App (login → dashboard) | **Render** (static site) | `npm run build:app` | `dist-app` |
| Admin (Registrations backoffice) | **Render** (static site) | `npm run build:admin` | `dist-admin` |
| Kiosk APK (QR / Facial) | Android device | `npm run android:apk` | — |

Push this project to a GitHub repo first — Cloudflare and Render both deploy from Git.

---

## Step 1 — Supabase (the shared backend)

1. **https://supabase.com** → New project (pick a region near you, save the DB password).
2. When it's ready: **SQL Editor** → paste the whole of [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
   This creates every table (employees, attendance, leaves, roles, notifications, audit log, admin accounts, **registrations**), enables realtime, and seeds the first login: **admin / admin** — change it after first sign-in (Accounts page).
3. **Project Settings → API** — copy two values:
   - `Project URL` → `VITE_SUPABASE_URL`
   - `anon public` key → `VITE_SUPABASE_ANON_KEY`
4. For local dev against the live DB: copy `.env.example` to `.env` and paste them there.

> No keys set? The app silently falls back to a browser-local stub — fine for offline dev, but nothing syncs between devices. If a deployed site shows the stub behaviour, the env vars are missing from that host's build settings.

## Step 2 — Cloudflare Pages (landing)

1. **dash.cloudflare.com** → Workers & Pages → **Create → Pages → Connect to Git** → pick the repo.
2. Build settings:
   - Build command: `npm run build:landing`
   - Build output directory: `dist-landing`
3. Environment variables (Production): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
4. Deploy, then attach your domain (e.g. `bilisops.com`) under **Custom domains**.
5. **After the app URL exists** (Step 3): edit `.env.landing` → set `VITE_APP_URL` to the real app URL (e.g. `https://app.bilisops.com`), commit, redeploy. That's what the landing's *Sign in / Register / kiosk* buttons link to.

## Step 3 — Render (app + admin)

1. **dashboard.render.com** → **New → Blueprint** → pick the repo. Render reads [`render.yaml`](render.yaml) and creates **two static sites**: `bilisops-app` and `bilisops-admin`.
2. When prompted, fill `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for **each** service.
3. Deploy, then add custom domains: `app.bilisops.com` → bilisops-app, `admin.bilisops.com` → bilisops-admin.

(Or skip the blueprint and create two static sites by hand with the build commands / publish folders from the table above.)

## Step 4 — Kiosk APK, connected to the live site

Two options:

- **Bundled (works offline-first):** the APK ships its own copy of the app and talks straight to Supabase. Put the two Supabase values in `.env`, then `npm run android:apk` and rebuild the APK (`android/` → `gradlew assembleDebug`, JDK 21).
- **Thin wrapper (always mirrors the website):** make the APK load the live app domain instead — in `capacitor.config.json` add
  ```json
  "server": { "url": "https://app.bilisops.com/?mode=kiosk", "cleartext": true }
  ```
  then `npx cap sync android` and rebuild. Updates ship by redeploying the website; no APK rebuild.

## Step 5 — Smoke test

1. Open the landing → **Register** → submit a sign-up.
2. Open the admin domain → sign in (`admin`/`admin`) → **Registrations** → the sign-up is there (proves all domains share Supabase) → **Approve**.
3. Sign in on the app domain with the new account → dashboard loads.
4. Change the seeded admin password (Accounts → Change password).

## Notes

- All three sites build from the same repo; they differ only by `--mode`, so one commit updates everything on the next deploy.
- `netlify.toml` is legacy from the old stack — ignore or delete it.
- RLS is currently permissive (the front-end owns login with the anon key). Before storing anything sensitive, move auth server-side and tighten the policies in `schema.sql`.
