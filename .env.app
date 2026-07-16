# The app itself (login + admin portal) — deploy to your app domain (e.g. app.bilisops.com).
# Starts at the login screen; no marketing landing.
# Used by: npm run build:app
VITE_APP_MODE=app

# Supabase backend (anon key is public by design - it ships in the JS bundle)
VITE_SUPABASE_URL=https://maukvyulmvozahyelsvv.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1hdWt2eXVsbXZvemFoeWVsc3Z2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxNjgwNDAsImV4cCI6MjA5OTc0NDA0MH0.I60IrlB1B_eg4-UI3WRDlIBPSkdzdMQu2PD-F3c4r9k
