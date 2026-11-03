// GET /api/data[?v=N]   -> {data, version}; with ?v equal to the stored version, just {version, unchanged: true}
// GET /api/data?backups=1      -> automatic backups: [{id, saved, tasks}]
// GET /api/data?backup=ID      -> {data} of one backup
// PUT /api/data {data, version}
//   Saves only if the stored version still equals `version` (a single conditional
//   UPDATE/INSERT), so two devices can't overwrite each other. Otherwise 409 and the
//   client re-fetches, merges and tries again.
const L = require('./_lib');

module.exports = L.handler(async (req, res) => {
  const user = await L.requireUser(req);

  if (req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    if (q.get('backups')) {
      const rows = await L.db(`select id, saved, coalesce(jsonb_array_length(data->'tasks'), 0) as tasks from state_history where user_id = $1 order by saved desc limit 100`, [user.id]);
      return L.send(res, 200, { backups: rows.map(r => ({ id: String(r.id), saved: r.saved, tasks: Number(r.tasks) })) });
    }
    if (q.get('backup')) {
      if (!/^\d{1,18}$/.test(q.get('backup'))) throw new L.HttpError(404, 'Backup not found');
      const [row] = await L.db(`select data from state_history where user_id = $1 and id = $2`, [user.id, q.get('backup')]);
      if (!row) throw new L.HttpError(404, 'Backup not found');
      return L.send(res, 200, { data: row.data });
    }
    const have = q.get('v');
    if (have != null) {
      const [row] = await L.db(`select version from state where user_id = $1`, [user.id]);
      const v = row ? Number(row.version) : 0;
      if (String(v) === have) return L.send(res, 200, { version: v, unchanged: true });
    }
    const [row] = await L.db(`select data, version from state where user_id = $1`, [user.id]);
    return L.send(res, 200, { data: row ? row.data : null, version: row ? Number(row.version) : 0 });
  }

  if (req.method === 'PUT') {
    const b = await L.readBody(req);
    if (!b.data || typeof b.data !== 'object' || !Number.isInteger(b.version) || b.version < 0) throw new L.HttpError(400, 'Bad request');
    const json = JSON.stringify(b.data);
    // restoring a backup: first keep the current data as a backup too, so the restore can be undone
    if (b.restore) await L.db(`insert into state_history (user_id, version, data) select user_id, version, data from state where user_id = $1`, [user.id]);
    const rows = b.version === 0
      ? await L.db(`insert into state (user_id, data, version) values ($1, $2::jsonb, 1) on conflict (user_id) do nothing returning version`, [user.id, json])
      : await L.db(`update state set data = $2::jsonb, version = version + 1, updated = now() where user_id = $1 and version = $3 returning version`, [user.id, json, b.version]);
    if (!rows.length) return L.send(res, 409, { error: 'Changed on another device', conflict: true });
    const version = Number(rows[0].version);
    // automatic backups: at most one an hour, kept for 30 days
    await L.db(`insert into state_history (user_id, version, data)
      select $1, $2, $3::jsonb where not exists (select 1 from state_history where user_id = $1 and saved > now() - interval '1 hour')`, [user.id, version, json]);
    await L.db(`delete from state_history where user_id = $1 and saved < now() - interval '30 days'`, [user.id]);
    return L.send(res, 200, { version });
  }

  L.send(res, 405, { error: 'Method not allowed' });
});
