// ── App configuration ──────────────────────────────────────────────
// Fill in SUPABASE_URL and SUPABASE_ANON_KEY after creating the
// Supabase project (see SETUP.md). Until then the app runs in
// local-only mode on each device.

export const CONFIG = {
  SUPABASE_URL: 'https://omhxfumnbidadlzjnwjn.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9taHhmdW1uYmlkYWRsempud2puIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2MzQ4NTAsImV4cCI6MjEwMjIxMDg1MH0.S-HLcgPgOYqnwyTDWNwrK4BWxpY6E-zGFIPPx8DwtWU',

  // Code that unlocks the private "My Job" tab (billing / runs / hours).
  // Change this to anything you like before sharing the app.
  OWNER_CODE: 'innerearth',

  // Shown until a mine/project name is set in Settings.
  DEFAULT_PROJECT_NAME: 'Mine',

  APP_VERSION: '1.0.0',
};
