# Coal Mine Project · field app

Shared borehole map for drilling jobs — by **Inner Earth Tech**.

- 🗺 Esri satellite map with named borehole pins, notes, and photos — shared
  live between every crew on the job
- 🧭 Tap any borehole → turn-by-turn directions
- 🕐 Private "My Job" tab (owner code): runs per well, leave-hotel/back-at-hotel
  field hours, automatic night-stay counting, CSV export
- ☎️ Shared mine contacts with search and tap-to-call
- 📴 Works offline in the field, syncs when signal returns
- 📱 Installs to the home screen on iPhone and Android (PWA)

**Setup:** see [SETUP.md](SETUP.md). Stack: plain HTML/JS/CSS + Leaflet +
Supabase (Postgres, Realtime, Storage), deployed as static files on Vercel.

No build step: edit, push, Vercel redeploys.
