# Getting the app live — 3 steps

You already use Supabase, GitHub, and Vercel, so this is quick. Two one-time
setups, then every phone just opens the link.

---

## Step 1 · Supabase (the shared database)

1. Go to [supabase.com](https://supabase.com) → **New project**
   (any name, e.g. `coal-mine-app`; pick a region near the mine; the free plan is fine).
2. When it finishes, open **SQL Editor** (left sidebar) → **New query**.
3. Open `supabase/schema.sql` from this folder, copy **everything**, paste it in, hit **Run**.
   You should see "Success. No rows returned."
4. Go to **Project Settings → API** and copy two things:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - **anon public** key (the long one)
5. Paste both into `js/config.js`:

```js
SUPABASE_URL: 'https://abcdefgh.supabase.co',
SUPABASE_ANON_KEY: 'eyJhbGciOi…',
```

> Also in `js/config.js`: change `OWNER_CODE` from `innerearth` to whatever
> secret code you want. That code is what unlocks **your** private Job tab
> (billing / runs / hours) — don't share it with the other crews.

## Step 2 · Vercel (puts the app on a link)

1. Push this folder to a GitHub repo (it's already a git repo with a commit).
2. On [vercel.com](https://vercel.com) → **Add New → Project** → import that repo.
3. Framework preset: **Other**. No build command, no output directory — it's
   plain static files. Deploy.
4. You get a URL like `https://coal-mine-app.vercel.app` — **that's the app.**

Any future change: push to GitHub, Vercel redeploys automatically.

## Step 3 · Phones

Text the Vercel link to anyone who needs it. They open it, type their name, done.

- **iPhone:** Share button → **Add to Home Screen** → it installs like an app.
- **Android:** browser menu (⋮) → **Install app**.

On your own phone, go to **Settings → Unlock Job tab** and enter your owner
code — that shows the private billing/runs/hours tab (only on phones with the code).

---

## Good to know

- **Offline:** the app keeps working with no signal — pins, notes, runs, and
  hours save on the phone and sync automatically when coverage returns. Map
  imagery you've already looked at while online stays viewable offline, so
  pan/zoom around the mine site once while you have signal.
- **Mine name:** once you know it, set it in **Settings → Mine / project name** —
  it updates the app title for everyone.
- **Deleting:** only unlocked (owner-code) phones can delete boreholes and
  contacts. Everyone can add and edit. People can delete their own notes.
- **Privacy note:** there are no passwords — anyone with the link can read and
  write the shared data, and the connection details live in the app's source.
  For borehole pins and notes on a job site that's the right tradeoff (that's
  also how the crew-share works). Just don't reuse this Supabase project for
  anything sensitive.
- **Free tiers:** Supabase's and Vercel's free plans comfortably cover a crew
  posting pins, notes, and photos for months. Photos are compressed on the
  phone before upload to keep storage small.
