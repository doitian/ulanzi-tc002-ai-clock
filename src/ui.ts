export function renderUi(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TC002 Pixel Clock</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; max-width: 760px; margin: 0 auto; padding: 24px; background: #111; color: #eee; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.05rem; margin-top: 32px; border-bottom: 1px solid #333; padding-bottom: 6px; }
  label { display: block; margin: 12px 0 4px; font-size: 0.88rem; color: #bbb; }
  input[type=text], textarea {
    width: 100%; box-sizing: border-box; padding: 8px; border-radius: 6px;
    border: 1px solid #444; background: #1c1c1c; color: #eee; font: inherit;
  }
  textarea { min-height: 64px; resize: vertical; }
  button { margin-top: 12px; padding: 8px 16px; border-radius: 6px; border: 0; background: #2b6cb0; color: #fff; cursor: pointer; font: inherit; }
  button.secondary { background: #444; }
  button:hover { filter: brightness(1.15); }
  button:disabled { opacity: 0.5; cursor: wait; }
  a button { margin-top: 4px; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .row > div { flex: 1; min-width: 230px; }
  .status { font-size: 0.85rem; color: #9ad; white-space: pre-wrap; margin-top: 10px; }
  .error { color: #f88; }
  .ok { color: #8f8; }
  .hint { font-size: 0.78rem; color: #888; margin-top: 2px; }
  img.preview { display: block; margin-top: 12px; width: 416px; image-rendering: pixelated; background: #000; border: 1px solid #333; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 0.75rem; margin-left: 8px; }
  .badge.on { background: #1e4620; color: #8f8; }
  .badge.off { background: #4a2222; color: #f88; }
  .checkline { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
  .checkline input { width: auto; }
  .checkline label { margin: 0; }
</style>
</head>
<body>
<h1>TC002 Pixel Clock</h1>

<h2>Account <span class="badge off" id="gcalBadge" style="display:none"></span></h2>
<div class="status" id="acctStatus">Checking sign-in...</div>
<p id="loginRow" style="display:none"><a href="/auth/login"><button>Sign in with Google</button></a></p>
<div id="accountRow" style="display:none">
  <div class="status" id="acctInfo"></div>
  <button id="logout" class="secondary">Log out</button>
  <button id="gcalDisconnect" class="secondary">Disconnect Google calendar</button>
  <div class="hint">Logging out keeps the stored Google tokens, so the clock keeps working.
  Disconnect revokes calendar access for the scheduled runs too.</div>
  <div class="status" id="gcalStatus"></div>
</div>

<div id="app" style="display:none">

<h2>Generate</h2>
<label for="prompt">Prompt (leave empty to use the automatic topic picker)</label>
<textarea id="prompt" placeholder="e.g. a pixel cat waving at a sushi bar"></textarea>
<button id="generate">Generate &amp; Send to TC002</button>
<div class="status" id="genStatus"></div>
<img class="preview" id="preview" style="display:none" alt="last generated pixel art">
<div class="status" id="lastRun"></div>

<h2>Configuration</h2>
<div class="row">
  <div>
    <label for="f_base">OpenAI-compatible endpoint</label>
    <input type="text" id="f_base" placeholder="https://api.openai.com/v1">
  </div>
  <div>
    <label for="f_model">Model</label>
    <input type="text" id="f_model" placeholder="gpt-4o">
  </div>
</div>
<div class="row">
  <div>
    <label for="f_tz">Timezone</label>
    <input type="text" id="f_tz" placeholder="Asia/Shanghai">
  </div>
  <div>
    <label for="f_weather">Weather location (name or lat,lon)</label>
    <input type="text" id="f_weather" placeholder="Beijing">
  </div>
</div>
<div class="row">
  <div>
    <label for="f_agenda">Agenda calendars (comma-separated ids or names)</label>
    <input type="text" id="f_agenda" placeholder="alice@example.com, bob@example.com">
  </div>
  <div>
    <label for="f_holiday">Holiday calendars (comma-separated)</label>
    <input type="text" id="f_holiday" placeholder="Holidays in China">
  </div>
</div>
<div class="row">
  <div>
    <label for="f_exclude">Event exclusion pattern (regex or substring)</label>
    <input type="text" id="f_exclude" placeholder="Focus Time">
  </div>
  <div>
    <label for="f_tc002">TC002 base URL</label>
    <input type="text" id="f_tc002" placeholder="http://192.168.1.100">
  </div>
</div>
<div class="checkline">
  <input type="checkbox" id="f_skipallday">
  <label for="f_skipallday">Skip all-day events in agenda calendars</label>
</div>
<div class="hint" style="margin-top:12px">The worker wakes every 10 minutes, 07:00-23:59 UTC+0800
(fixed cron in wrangler.toml; Cloudflare cron is UTC). Each wake sends an image for a newly
active agenda event (the same event is never re-sent); with no active event, a random-topic
image is sent at most once per hour.</div>
<button id="saveConfig">Save configuration</button>
<div class="status" id="cfgStatus"></div>

</div>

<script>
var FIELDS = ['openaiBaseUrl','openaiModel','timezone','weatherLocation','agendaCalendars','holidayCalendars','eventExclusionPattern','tc002BaseUrl'];
var IDS = { openaiBaseUrl:'f_base', openaiModel:'f_model', timezone:'f_tz', weatherLocation:'f_weather',
  agendaCalendars:'f_agenda', holidayCalendars:'f_holiday', eventExclusionPattern:'f_exclude',
  tc002BaseUrl:'f_tc002' };

function el(id) { return document.getElementById(id); }

function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers);
  if (opts.body && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
    opts.headers['Content-Type'] = 'application/json';
  }
  return fetch(path, opts).then(function (r) {
    return r.text().then(function (t) {
      var d; try { d = JSON.parse(t); } catch (e) { d = { error: t }; }
      if (r.status === 401) { showLoggedOut(); throw new Error('not signed in'); }
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      return d;
    });
  });
}

function say(id, text, cls) {
  var n = el(id);
  n.textContent = text;
  n.className = 'status ' + (cls || '');
}

function showLoggedOut() {
  el('app').style.display = 'none';
  el('accountRow').style.display = 'none';
  el('gcalBadge').style.display = 'none';
  el('loginRow').style.display = 'block';
  say('acctStatus', 'Sign in with the allowed Google account to manage the clock.', '');
}

function describeLastRun(lr) {
  if (!lr) return '';
  var lines = ['Last run: ' + lr.at + (lr.ok ? ' (ok)' : ' (FAILED)')];
  if (lr.kind) lines.push('  kind: ' + lr.kind);
  if (lr.theme) lines.push('  theme: ' + lr.theme);
  if (lr.timeLabel) lines.push('  time: ' + lr.timeLabel);
  if (lr.frames) lines.push('  frames: ' + lr.frames);
  if (lr.skipped) lines.push('  skipped: ' + lr.skipped);
  if (lr.error) lines.push('  error: ' + lr.error);
  return lines.join('\\n');
}

function loadState() {
  api('/api/state').then(function (s) {
    el('loginRow').style.display = 'none';
    el('accountRow').style.display = 'block';
    el('app').style.display = 'block';
    say('acctStatus', '', '');
    say('acctInfo', 'Signed in as ' + s.user +
      '\\nServer time: ' + s.serverTime +
      '\\nSecrets set: OPENAI_API_KEY=' + yesno(s.secrets.openaiApiKey) +
      ', TC002_TOKEN=' + yesno(s.secrets.tc002Token) +
      ', GOOGLE_CLIENT_ID=' + yesno(s.secrets.googleClientId) +
      ', GOOGLE_CLIENT_SECRET=' + yesno(s.secrets.googleClientSecret) +
      ', ALLOWED_EMAIL=' + yesno(s.secrets.allowedEmail), 'ok');
    var b = el('gcalBadge');
    b.style.display = 'inline-block';
    b.textContent = s.googleConnected ? 'calendar connected' : 'calendar not connected';
    b.className = 'badge ' + (s.googleConnected ? 'on' : 'off');
    FIELDS.forEach(function (k) {
      var v = s.config[k];
      el(IDS[k]).value = Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v));
    });
    el('f_skipallday').checked = !!s.config.skipAllDayAgendaEvents;
    say('lastRun', describeLastRun(s.lastRun), s.lastRun && !s.lastRun.ok ? 'error' : '');
    if (s.hasLastGif) refreshPreview();
  }).catch(function (e) {
    if (e.message !== 'not signed in') say('acctStatus', e.message, 'error');
  });
}

function yesno(v) { return v ? 'yes' : 'NO'; }

function refreshPreview() {
  fetch('/api/last.gif')
    .then(function (r) { if (!r.ok) throw new Error('no preview'); return r.blob(); })
    .then(function (blob) {
      el('preview').src = URL.createObjectURL(blob);
      el('preview').style.display = 'block';
    })
    .catch(function () {});
}

el('logout').onclick = function () {
  api('/auth/logout', { method: 'POST' }).then(function () { location.reload(); });
};

el('gcalDisconnect').onclick = function () {
  say('gcalStatus', 'Disconnecting...', '');
  api('/auth/google/disconnect', { method: 'POST' })
    .then(function () { say('gcalStatus', 'Disconnected. Sign in again to restore calendar access.', 'ok'); loadState(); })
    .catch(function (e) { say('gcalStatus', e.message, 'error'); });
};

el('saveConfig').onclick = function () {
  var patch = {};
  FIELDS.forEach(function (k) { patch[k] = el(IDS[k]).value; });
  patch.skipAllDayAgendaEvents = el('f_skipallday').checked;
  say('cfgStatus', 'Saving...', '');
  api('/api/config', { method: 'POST', body: patch })
    .then(function () { say('cfgStatus', 'Saved.', 'ok'); })
    .catch(function (e) { say('cfgStatus', e.message, 'error'); });
};

var genLog = [];
function logLine(text, cls) {
  genLog.push(text);
  say('genStatus', genLog.join('\n'), cls || '');
}

function handleGenEvent(evt) {
  if (evt.type === 'progress') {
    logLine('[' + evt.step + '] ' + (evt.detail || ''));
  } else if (evt.type === 'done') {
    logLine('[done] sent to TC002 - theme: ' + evt.theme.text +
      ' (' + evt.theme.kind + ', ' + evt.frames + ' frame(s))', 'ok');
    refreshPreview();
    api('/api/state').then(function (s) { say('lastRun', describeLastRun(s.lastRun), ''); });
  } else if (evt.type === 'error') {
    logLine('[error] ' + evt.error, 'error');
  }
}

el('generate').onclick = function () {
  var btn = el('generate');
  btn.disabled = true;
  genLog = [];
  logLine('Starting generation...');
  fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: el('prompt').value }),
  }).then(function (res) {
    if (res.status === 401) { showLoggedOut(); throw new Error('not signed in'); }
    if (!res.ok || !res.body) {
      return res.text().then(function (t) { throw new Error(t || ('HTTP ' + res.status)); });
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return;
        buf += decoder.decode(r.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          var raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          raw.split('\n').forEach(function (line) {
            if (line.indexOf('data:') !== 0) return;
            try { handleGenEvent(JSON.parse(line.slice(5))); } catch (e) {}
          });
        }
        return pump();
      });
    }
    return pump();
  }).catch(function (e) {
    if (e.message !== 'not signed in') logLine('[error] ' + e.message, 'error');
  }).finally(function () { btn.disabled = false; });
};

if (new URLSearchParams(location.search).get('auth') === 'ok') {
  history.replaceState(null, '', location.pathname);
}
loadState();
</script>
</body>
</html>`;
}
