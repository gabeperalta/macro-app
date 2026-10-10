# Macro Bot — free macro-tracking PWA

Tracks protein / carbs / fat. Type what you ate, AI estimates macros, you review and save.
Everything runs on free tiers: GitHub Pages (app), Supabase (login + database + AI function), Google Gemini (AI).

## Files
- `index.html`, `styles.css`, `app.js` – the app (no build step)
- `config.js` – put your Supabase URL + anon key here
- `manifest.json`, `sw.js`, `icons/` – make it installable on iPhone
- `supabase/schema.sql` – database table + security rules
- `supabase/functions/parse-meal/` – the AI function (`index.ts`, `logic.js`, `test.mjs`)

## 1. Create a Supabase project (free)
1. Go to https://supabase.com, sign up, click **New project**. Pick any name and a database password; choose a region near you.
2. When it's ready, open **Project Settings → API**. Copy the **Project URL** and the **anon public** key.
3. Paste both into `config.js`. (The anon key is meant to be public; the security rules protect the data.)

## 2. Create the database table
1. In Supabase open **SQL Editor → New query**.
2. Paste all of `supabase/schema.sql` and click **Run**.
This creates `meal_items` with Row Level Security, so each user can only see and change their own rows.

## 3. Turn off email confirmation (important)
Usernames are stored as fake emails (`alex` → `alex@macro.local`), so no email is ever sent.
1. Go to **Authentication → Sign In / Providers → Email** (older dashboards: Authentication → Providers → Email).
2. Make sure **Email** is enabled and turn **Confirm email** OFF. Save.
If you skip this, new accounts can't log in.

Optional: once you and your friends have accounts, turn off **Allow new users to sign up** (Authentication → Sign In / Providers) so strangers can't create accounts.

## 4. Get a free Gemini API key
1. Go to https://aistudio.google.com/apikey and sign in with a Google account.
2. Click **Create API key** and copy it.
Optional: get a free USDA key at https://fdc.nal.usda.gov/api-key-signup (otherwise the shared, heavily rate-limited `DEMO_KEY` is used).

## 5. Deploy the AI function
### Option A — dashboard (no installs)
1. Supabase → **Edge Functions → Deploy a new function → Via Editor**.
2. Name it exactly `parse-meal`.
3. Paste `index.ts`, then add a second file named `logic.js` with the contents of `logic.js`. Deploy.
4. Go to **Edge Functions → Secrets** and add `GEMINI_API_KEY` (and optionally `USDA_API_KEY`).

### Option B — Supabase CLI
```bash
npm install -g supabase          # or: brew install supabase/tap/supabase
supabase login
supabase link --project-ref YOUR-PROJECT-REF   # run from this folder
supabase functions deploy parse-meal
supabase secrets set GEMINI_API_KEY=your-key USDA_API_KEY=your-usda-key
```
Leave "Verify JWT" on (default): only logged-in users can call the AI.

Optional secrets: `GEMINI_MODEL` (default `gemini-2.5-flash`; change if Google renames models), `DB_LOOKUP=off` to skip the food database lookups.

How it works: Gemini splits your text into items and estimates grams + macros. Then for branded items it checks Open Food Facts, for generic items USDA FoodData Central, and uses the database numbers only if they're in the same ballpark as the AI's estimate (guards against bad matches). You always review before saving.

## 6. Put the app on GitHub Pages (free)
1. Create a GitHub account and a new **public** repository (e.g. `macro-bot`). (Pages on private repos needs a paid plan.)
2. Upload all files in this folder (web: **Add file → Upload files**, drag everything in, commit). The `supabase/` folder can be included; it isn't served as part of the app.
3. Repo **Settings → Pages** → Source: **Deploy from a branch**, Branch: `main`, folder `/ (root)`. Save.
4. After a minute your app is at `https://YOUR-USERNAME.github.io/macro-bot/`.
Note: the repo is public, so anyone can see the code and `config.js`. That's fine; the anon key is public by design and RLS protects data. Never put the Gemini key in the repo.

## 7. Add to iPhone home screen
1. Open the GitHub Pages URL in **Safari**.
2. Tap **Share → Add to Home Screen → Add**.
3. Open it from the home screen, tap **Create account**, pick a username + password.
Friends do the same with their own username.

## Voice input
Tap the 🎤 button next to the chat box, say your meal, then edit the text if needed and tap Send. It uses the iPhone's built-in speech recognition (free, iOS 14.5+). The first time, iOS asks for **Microphone** and **Speech Recognition** permission — tap Allow. If you denied it: Settings → Safari → Microphone (Allow), and Settings → Privacy & Security → Speech Recognition, and make sure Siri & Dictation is enabled. The button is hidden on browsers that don't support it.

## 12-month data retention
`schema.sql` already includes this; for an existing project run `supabase/retention.sql` in the SQL Editor (safe to run again). It enables the free `pg_cron` extension (also toggleable under Database → Extensions) and schedules a daily job at 03:15 UTC that deletes `meal_items` older than 12 months. Check it with `select * from cron.job;` and runs with `select * from cron.job_run_details order by start_time desc limit 5;`.

## Account approval + signup alerts (ntfy, free)
New accounts start as **pending** and only see a "Waiting for approval" screen; the database won't let them read or save meals until you approve them.

1. Install the free **ntfy** app (App Store / Google Play).
2. Pick a hard-to-guess topic name, e.g. `macro-gabe-7f3k9q2x`. Anyone who knows the topic can read its alerts, so don't use something obvious.
3. In the ntfy app tap **+**, enter that topic (server `ntfy.sh`), and subscribe. Allow notifications.
4. In Supabase **SQL Editor**, run [`supabase/approval.sql`](supabase/approval.sql) (safe to re-run; it also approves everyone who already has an account). Fresh installs get this from `schema.sql` already.
5. Save your topic (replace the name with yours):
   ```sql
   insert into public.app_settings (key, value) values ('ntfy_topic', 'macro-gabe-7f3k9q2x')
   on conflict (key) do update set value = excluded.value;
   ```
6. When someone signs up you get a push. **Approve:** Table Editor → `profiles` → tick `approved` for their row → Save. They tap **Refresh** in the app. **Reject:** Authentication → Users → delete that user (their profile is removed automatically).

To approve all current users at once: `select public.approve_existing_users();`

## Free-tier limits (as of 2026; check the pricing pages)
- **Supabase free:** 2 projects, 500 MB database, 50,000 monthly active users, 500k Edge Function calls/month. **Projects pause after ~7 days with no activity** — click "Restore" in the dashboard to wake it.
- **Gemini free tier:** limited requests per minute/day (plenty for a few people). Google may use free-tier prompts to improve its products — don't type anything private.
- **USDA DEMO_KEY:** ~30 requests/hour shared; get your own free key for 1,000/hour.
- **GitHub Pages:** free for public repos, 100 GB bandwidth/month.
- **No password reset by email.** If someone forgets a password: Supabase → Authentication → Users → find `name@macro.local` → delete the user (deletes their data) or use the dashboard to set a new password.
- AI macros are estimates; check the review list.

## Updating the app
Edit files, re-upload to GitHub. If your phone shows the old version, close and reopen the app (the service worker fetches fresh files when online). Bump `CACHE` in `sw.js` for big changes.

## Testing the AI helper locally
```bash
cd supabase/functions/parse-meal && node test.mjs
```
