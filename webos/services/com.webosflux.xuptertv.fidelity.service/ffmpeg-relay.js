'use strict';
// ffmpeg-relay.js  (solo ES5: el Node de la TV es muy antiguo)
// Remuxea TS -> MP4 fragmentado (sin recodificar) y lo sirve por HTTP local,
// para que el <video> use el reproductor nativo de la TV con un MP4 en vez del TS.

var http = require('http');
var fs = require('fs');
var crypto = require('crypto');
var urlmod = require('url');
var spawn = require('child_process').spawn;
var dnsx = require('./dnsx');

/* Services run in a restricted namespace where /media/developer may not be
 * visible even though it is visible through SSH. Keep the executable next to
 * this service so the spawned process sees the same filesystem. */
var FFMPEG = __dirname + '/ffmpeg';
var HOST = '127.0.0.1';   // solo local: no es un relay abierto
var PORT = 8787;

var sessions = {};        // token -> { url, headers, audio, hevc }
var current = null;       // { ff } stream activo (solo uno a la vez)

function log() {
  var args = Array.prototype.slice.call(arguments);
  try { fs.appendFileSync('/tmp/xuper-relay.log', args.join(' ') + '\n'); } catch (eLog) { /* diagnostic log is optional */ }
  console.log.apply(console, ['[relay]'].concat(args));
}

/* The packaged mode is already 0755 (tools/fix_ipk_modes.py). Try chmod only
   when it is missing, so a root-owned install does not log a false alarm. */
try {
  var mode = fs.statSync(FFMPEG).mode;
  if (!(mode & parseInt('111', 8))) {
    fs.chmodSync(FFMPEG, parseInt('755', 8));
  }
} catch (e) {
  /* Installed packages are owned by root; the service user cannot chmod them.
     Record it: if the packaged mode is wrong, spawn() would fail with EACCES. */
  log('no se pudo aplicar permiso de ejecucion a ffmpeg:', e.message);
}

function stopCurrent() {
  if (current) {
    try { current.ff.kill('SIGKILL'); } catch (e) { /* ya termino */ }
    current = null;
  }
}

// Separa User-Agent (ffmpeg lo quiere en -user_agent) del resto de cabeceras.
function splitHeaders(h) {
  var ua = null;
  var rest = [];
  Object.keys(h || {}).forEach(function (k) {
    if (k.toLowerCase() === 'user-agent') ua = h[k];
    else rest.push(k + ': ' + h[k] + '\r\n');
  });
  return { ua: ua, rest: rest.join('') };
}

// Registra una sesion y devuelve la URL local para el <video>.
// stream: { url, headers } tal como lo devuelve magis.resolve
function register(stream, opts) {
  opts = opts || {};
  var token = crypto.randomBytes(8).toString('hex');
  sessions[token] = {
    url: stream.url,
    headers: stream.headers || {},
    audio: opts.audio || 0,
    hevc: !!opts.hevc
  };
  return 'http://' + HOST + ':' + PORT + '/s/' + token + '.mp4';
}

function buildArgs(s, start, audio) {
  var h = splitHeaders(s.headers);
  var args = [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    '-probesize', '2M', '-analyzeduration', '2M'
  ];
  if (/^https?:\/\//i.test(s.url)) {   // estas opciones solo existen para entradas HTTP(S)
    /*
     * No retry loop here.  On some webOS 4 sets a rejected upstream HTTPS
     * connection made ffmpeg reconnect continuously, which can exhaust the
     * TV/router connection table.  A user can simply retry playback; that is
     * safer than an invisible, unbounded reconnect loop.
     */
    args.push('-rw_timeout', '15000000');
    if (h.ua) args.push('-user_agent', h.ua);
    if (h.rest) args.push('-headers', h.rest);
  }
  if (start > 0) args.push('-ss', String(start));
  args.push(
    '-i', s.url,
    '-map', '0:v:0', '-map', '0:a:' + audio + '?',
    '-c', 'copy'
  );
  if (s.hevc) args.push('-tag:v', 'hvc1');   // hvc1 es la etiqueta que el reproductor nativo acepta bien
  args.push(
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1'
  );
  return args;
}

/*
 * The bundled static ffmpeg occasionally cannot use webOS's local DNS stub
 * (127.0.0.1), while the platform resolver can. Resolve HTTP CDN names with
 * DoH (dnsx) or the platform utility and preserve the original Host header for the CDN.
 */
function resolveForFfmpeg(s, done) {
  var parsed = urlmod.parse(s.url || '');
  if (parsed.protocol !== 'http:' || !parsed.hostname || /^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)) {
    return done(s);
  }

  dnsx.resolve(parsed.hostname, function (err, res) {
    var ip = (res && res.ips && res.ips[0]) || '';
    if (!err && ip) {
      var headers = {};
      Object.keys(s.headers || {}).forEach(function (key) {
        if (key.toLowerCase() !== 'host') headers[key] = s.headers[key];
      });
      headers.Host = parsed.host;
      parsed.hostname = ip;
      parsed.host = ip + (parsed.port ? ':' + parsed.port : '');
      parsed.href = null;
      log('CDN resuelto por DoH (' + (res && res.source) + ') para ffmpeg: ' + parsed.hostname + ' -> ' + ip);
      return done({
        url: urlmod.format(parsed),
        headers: headers,
        audio: s.audio,
        hevc: s.hevc
      });
    }

    log('DoH no devolvio IP para ' + parsed.hostname + ' (' + (err && err.message) + '), probando DNS nativo...');
    var lookup;
    try { lookup = spawn('/usr/bin/getent', ['ahostsv4', parsed.hostname]); } catch (eSpawn) { return done(s); }
    var out = '';
    lookup.stdout.on('data', function (chunk) { out += String(chunk); });
    lookup.on('error', function () { done(s); });
    lookup.on('close', function () {
      var match = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(out);
      if (!match) {
        log('DNS nativo no devolvio IPv4; se usa hostname');
        return done(s);
      }
      var headers2 = {};
      Object.keys(s.headers || {}).forEach(function (key) {
        if (key.toLowerCase() !== 'host') headers2[key] = s.headers[key];
      });
      headers2.Host = parsed.host;
      parsed.hostname = match[1];
      parsed.host = match[1] + (parsed.port ? ':' + parsed.port : '');
      parsed.href = null;
      log('CDN resuelto por webOS para ffmpeg');
      done({
        url: urlmod.format(parsed),
        headers: headers2,
        audio: s.audio,
        hevc: s.hevc
      });
    });
  });
}

var server = http.createServer(function (req, res) {
  var u = urlmod.parse(req.url, true);

  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    return res.end();
  }

  if (u.pathname === '/abort' || u.pathname === '/media/abort') {
    stopCurrent();
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end('aborted');
  }

  var m = /^\/s\/([0-9a-f]+)\.mp4$/.exec(u.pathname || '');
  var s = m && sessions[m[1]];
  if (!s) {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'none',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end();
  }

  var start = Math.max(0, Number(u.query.start) || 0);
  var audio = Number(u.query.a != null ? u.query.a : s.audio) || 0;

  stopCurrent();   // el player a veces abre y aborta peticiones; no dejamos procesos huerfanos

  resolveForFfmpeg(s, function (input) {
    var ff = spawn(FFMPEG, buildArgs(input, start, audio), { stdio: ['ignore', 'pipe', 'pipe'] });
    current = { ff: ff };
    var started = false;

  ff.on('error', function (e) {
    log('no se pudo lanzar ffmpeg:', e.message);
    if (!started) {
      res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
      started = true;
    }
    res.end();
  });

  ff.stderr.on('data', function (d) { log('ffmpeg:', String(d).trim()); });

  ff.stdout.on('data', function (chunk) {
    if (!started) {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'none',
        'Cache-Control': 'no-cache',
        'Connection': 'close',
        'Access-Control-Allow-Origin': '*'
      });
      started = true;
    }
    // backpressure: si el player va lento, ffmpeg deja de leer del portal
    if (!res.write(chunk)) {
      ff.stdout.pause();
      res.once('drain', function () { ff.stdout.resume(); });
    }
  });

  ff.on('close', function (code) {
    if (current && current.ff === ff) current = null;
    if (!started) {
      res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
      started = true;
    }   // ffmpeg no produjo nada
    res.end();
    if (code) log('ffmpeg termino con codigo', code);
  });

    res.on('close', function () { try { ff.kill('SIGKILL'); } catch (e) { /* ya termino */ } });
  });
});

server.on('error', function (e) { log('error del servidor:', e.message); });
server.listen(PORT, HOST, function () { log('escuchando en', HOST + ':' + PORT); });

module.exports = {
  register: register,
  stop: stopCurrent,
  available: function () {
    /* A packaged file can exist but lack +x (ares-package on Windows writes
       0666). Report that as unavailable instead of letting spawn() fail later
       and silently falling back to direct playback. */
    try {
      fs.accessSync(FFMPEG, (fs.constants && fs.constants.X_OK) || fs.X_OK || 1);
      return true;
    } catch (eAccess) {
      return false;
    }
  },
  path: function () { return FFMPEG; },
  port: function () { return PORT; }
};
