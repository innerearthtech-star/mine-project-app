// ── Read-only report feed ──────────────────────────────────────────
// One JSON document with every borehole, its depths/status marks,
// notes, and inspection links — for outside report tools (a customer
// pasting the URL into ChatGPT, Excel, etc.). Strictly read-only:
// this function only SELECTs; nothing here can write, and the feed
// key below is share-with-the-customer level, not an admin secret.
//
//   GET /api/report-feed?key=<FEED_KEY>          → everything
//   GET /api/report-feed?key=<FEED_KEY>&since=<ISO or YYYY-MM-DD>
//        → only rows updated at/after that moment (daily-report use)

const SUPABASE_URL = 'https://omhxfumnbidadlzjnwjn.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9taHhmdW1uYmlkYWRsempud2puIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2MzQ4NTAsImV4cCI6MjEwMjIxMDg1MH0.S-HLcgPgOYqnwyTDWNwrK4BWxpY6E-zGFIPPx8DwtWU';
const FEED_KEY = 'iet-feed-2481';

const pub = (bucket, path) => `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`;

async function rows(table, params) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: { apikey: ANON_KEY, authorization: `Bearer ${ANON_KEY}` },
  });
  if (!r.ok) throw new Error(`${table}: ${r.status}`);
  return r.json();
}

const STATUS_WORD = { clear: 'Clear', partial: 'Partially obstructed', obstructed: 'Obstructed' };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('key') !== FEED_KEY) {
    res.status(401).json({ error: 'missing or wrong key' });
    return;
  }
  // optional change-window filter (a bare date means "that day onward")
  let since = url.searchParams.get('since') || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(since)) since += 'T00:00:00';
  if (since && isNaN(new Date(since))) { res.status(400).json({ error: 'bad since value' }); return; }
  const win = since ? `&updated_at=gte.${encodeURIComponent(new Date(since).toISOString())}` : '';

  try {
    const [holes, notes, videos] = await Promise.all([
      rows('boreholes', `select=*&deleted=eq.false&order=name${win}`),
      rows('notes', `select=*&deleted=eq.false&order=created_at${win}`),
      rows('videos', `select=*&deleted=eq.false&order=ts${win}`),
    ]);
    // when a window is set, notes/videos may reference holes edited earlier —
    // pull those parent holes too so every note has its well attached
    const haveIds = new Set(holes.map(h => h.id));
    const missing = [...new Set([...notes, ...videos].map(x => x.borehole_id))]
      .filter(id => id && !haveIds.has(id));
    if (missing.length) {
      const extra = await rows('boreholes',
        `select=*&deleted=eq.false&id=in.(${missing.join(',')})`);
      holes.push(...extra);
      holes.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
    }

    const boreholes = holes.map(b => ({
      id: b.id,
      name: b.name,
      type: (b.kind || 'well') === 'well' ? 'borehole' : 'landmark',
      status: STATUS_WORD[b.status] || null,
      seals_set: Boolean(b.seals_set),
      monitor_hole: Boolean(b.monitor),
      roof_level_ft: b.roof_level || null,
      bottom_of_casing_ft: b.casing_bottom || null,
      mine_floor_ft: b.mine_floor || null,
      latitude: b.lat,
      longitude: b.lng,
      added_by: b.created_by || null,
      created_at: b.created_at,
      updated_at: b.updated_at,
      notes: notes.filter(n => n.borehole_id === b.id).map(n => ({
        text: n.text || '',
        author: n.author || null,
        created_at: n.created_at,
        photo_urls: (n.photos || []).map(p => pub('photos', p)),
      })),
      inspections: videos.filter(v => v.borehole_id === b.id).map(v => ({
        id: v.id,
        inspected_at: v.ts,
        note: v.note || '',
        uploaded_by: v.uploaded_by || null,
        video_url: v.path ? pub('videos', v.path) : null,
        screenshot_urls: (v.screenshots || []).map(s =>
          pub('photos', typeof s === 'string' ? s : s.path)),
      })),
    }));

    res.status(200).json({
      project: 'Mine Project — Inner Earth Tech',
      generated_at: new Date().toISOString(),
      since: since ? new Date(since).toISOString() : null,
      counts: {
        boreholes: boreholes.filter(b => b.type === 'borehole').length,
        landmarks: boreholes.filter(b => b.type === 'landmark').length,
        notes: notes.length,
        inspections: videos.length,
      },
      boreholes,
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
};
