# HQ

Tasks, calendar, focus, habits, Matrix, Plans, accounts + sync, calendar feed.
Static page + small API routes in `api/`, data in a free Neon Postgres database. No build step.

## Deploy
1. Push this folder to a new GitHub repo.
2. vercel.com → Add New → Project → import repo → Framework preset "Other" → Deploy.
3. Project → Storage → Create Database → Neon → Free → connect to this project.
4. Deployments → ⋯ → Redeploy.
5. Settings → Deployment Protection → Standard Protection.
6. Open the site → ⋯ → Settings → Sync → Create an account. Save the recovery code.
   First account = owner; sign-ups then close (set ALLOW_SIGNUPS=true to reopen).

## Phone
iPhone Safari: Share → Add to Home Screen. Android Chrome: menu → Install app.

## Calendar reminders
Settings → Calendar feed → Add to Apple Calendar (or paste link into Google Calendar).

## Files
- index.html: the app (built from source/HQ App.dc.html)
- api/: auth, data sync, calendar feed
- sw.js, manifest.json, icons/: install + offline
