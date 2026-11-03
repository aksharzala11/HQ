// GET  /api/auth                      -> the signed-in user, or 401
// POST /api/auth {action: ...}
//   signup  {email, password}           -> creates the account, returns a one-time recovery code
//   login   {email, password}
//   logout
//   reset   {email, code, password}     -> new password via recovery code, returns a new code
//   delete  {password}                  -> deletes the account and all its data
//   calendar {reset?}                   -> private calendar-feed URL (reset makes a new one, old stops working)
const crypto = require('crypto');
const L = require('./_lib');

module.exports = L.handler(async (req, res) => {
  if (req.method === 'GET') {
    const s = await L.requireUser(req);
    return L.send(res, 200, { id: s.id, email: s.email });
  }
  if (req.method !== 'POST') return L.send(res, 405, { error: 'Method not allowed' });

  const b = await L.readBody(req, 16 * 1024);
  const ip = L.clientIp(req);
  const email = L.normEmail(b.email);
  const password = String(b.password || '');
  const checkPassword = pw => {
    if (pw.length < 8) throw new L.HttpError(400, 'Password needs at least 8 characters.');
    if (pw.length > 200) throw new L.HttpError(400, 'Password is too long.');
  };

  switch (b.action) {
    case 'signup': {
      if (!L.validEmail(email)) throw new L.HttpError(400, 'Enter a valid email address.');
      checkPassword(password);
      await L.rateLimit('signup:' + ip, 10, 3600);
      // Single-owner app: the first account closes sign-ups (set ALLOW_SIGNUPS=true in Vercel to reopen).
      if (process.env.ALLOW_SIGNUPS !== 'true') {
        const claimed = await L.db(`insert into meta (key, value) values ('owner', $1) on conflict do nothing returning key`, [email]);
        if (!claimed.length) throw new L.HttpError(403, 'Sign-ups are closed. This HQ already has an owner — sign in instead.');
      }
      const code = L.recoveryCode();
      const user = { id: crypto.randomUUID(), email };
      const made = await L.db(`insert into users (id, email, pw, rc) values ($1, $2, $3, $4) on conflict (email) do nothing returning id`,
        [user.id, email, await L.hashSecret(password), await L.hashSecret(L.normCode(code))]);
      if (!made.length) throw new L.HttpError(409, 'An account with this email already exists. Sign in instead.');
      return L.send(res, 200, { id: user.id, email, recoveryCode: code }, { 'Set-Cookie': await L.createSession(user) });
    }
    case 'login': {
      await L.rateLimit(`login:${ip}:${email}`, 10, 900);
      const user = await L.findUser(email);
      const good = await L.verifySecret(password, user ? user.pw : L.DUMMY_HASH);
      if (!user || !good) throw new L.HttpError(401, 'Wrong email or password.');
      return L.send(res, 200, { id: user.id, email }, { 'Set-Cookie': await L.createSession(user) });
    }
    case 'logout': {
      const s = await L.getSession(req);
      if (s) await L.db(`delete from sessions where hash = $1`, [s.hash]);
      return L.send(res, 200, { ok: true }, { 'Set-Cookie': L.cookieHeader('', 0) });
    }
    case 'reset': {
      checkPassword(password);
      await L.rateLimit(`reset:${ip}:${email}`, 5, 900);
      const user = await L.findUser(email);
      const good = await L.verifySecret(L.normCode(b.code), user ? user.rc : L.DUMMY_HASH);
      if (!user || !good) throw new L.HttpError(401, "That email and recovery code don't match.");
      const code = L.recoveryCode();
      await L.db(`update users set pw = $2, rc = $3 where id = $1`, [user.id, await L.hashSecret(password), await L.hashSecret(L.normCode(code))]);
      await L.endAllSessions(user.id); // sign out every other device
      return L.send(res, 200, { id: user.id, email, recoveryCode: code }, { 'Set-Cookie': await L.createSession(user) });
    }
    case 'delete': {
      const s = await L.requireUser(req);
      await L.rateLimit(`delete:${s.id}`, 5, 900);
      const user = await L.findUser(s.email);
      if (!user || !(await L.verifySecret(password, user.pw))) throw new L.HttpError(401, 'Wrong password.');
      await L.db(`delete from users where id = $1`, [user.id]); // sessions + data go with it
      await L.db(`delete from meta where key = 'owner' and value = $1`, [user.email]); // owner left: allow a fresh sign-up
      return L.send(res, 200, { ok: true }, { 'Set-Cookie': L.cookieHeader('', 0) });
    }
    case 'calendar': {
      const s = await L.requireUser(req);
      let [row] = await L.db(`select cal from users where id = $1`, [s.id]);
      let token = row && row.cal;
      if (!token || b.reset) {
        token = crypto.randomBytes(24).toString('base64url');
        await L.db(`update users set cal = $2 where id = $1`, [s.id, token]);
      }
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      return L.send(res, 200, { url: `https://${host}/api/calendar?t=${token}` });
    }
    default:
      throw new L.HttpError(400, 'Unknown action');
  }
});
