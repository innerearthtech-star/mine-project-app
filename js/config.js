// ── App configuration ──────────────────────────────────────────────
// Fill in SUPABASE_URL and SUPABASE_ANON_KEY after creating the
// Supabase project (see SETUP.md). Until then the app runs in
// local-only mode on each device.

export const CONFIG = {
  SUPABASE_URL: '',        // e.g. 'https://abcdefgh.supabase.co'
  SUPABASE_ANON_KEY: '',   // the long "anon public" key

  // Code that unlocks the private "My Job" tab (billing / runs / hours).
  // Change this to anything you like before sharing the app.
  OWNER_CODE: 'innerearth',

  // Shown until a mine/project name is set in Settings.
  DEFAULT_PROJECT_NAME: 'Coal Mine',

  APP_VERSION: '1.0.0',
};
