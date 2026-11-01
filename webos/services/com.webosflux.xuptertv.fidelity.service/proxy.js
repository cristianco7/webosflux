/*
 * Loopback media proxy for the webOS port.
 *
 * The CDN only serves a title with two headers (Content-Auth and
 * Content-License) that an HTML5 <video> element cannot set. This tiny server
 * listens on 127.0.0.1 and replays the request with those headers, so the app
 * can use a plain URL. Range requests are forwarded verbatim.
 *
 * The tokens live in memory only and expire with the service process.
 */
'use strict';

var http = require('http');
var https = require('https');
var crypto = require('crypto');
var urlmod = require('url');
var tsIndexer = require('./ts-indexer');
var dnsx = require('./dnsx');

var MAX_TOKENS = 6;
var tokens = {};      // token -> { url, headers, at }
var order = [];
/* Subtitle files are small text downloads that must not disturb the active
 * media stream, so they get their own token table and route. */
var subtitleTokens = {};
var subtitleOrder = [];
var MAX_SUBTITLES = 12;
var server = null;
var port = 0;

var httpAgent = new http.Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 15000 });
var httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 15000, rejectUnauthorized: false });

var activeToken = null;
var activeUpstreams = [];

/* Keep virtual HLS ranges on MPEG-TS packet boundaries.  The CDN already
 * supports Range and the proxy keeps its required headers private. */
var TS_PACKET_BYTES = 188;
var HLS_SEGMENT_SECONDS = 10;

function destroyConnection(c) {
  if (!c) { return; }
  if (c.up) {
    try { c.up.unpipe(); } catch (e1) { /* ignore */ }
    try { if (typeof c.up.destroy === 'function') c.up.destroy(); } catch (e2) { /* ignore */ }
    try { if (c.up.socket) c.up.socket.destroy(); } catch (e3) { /* ignore */ }
    c.up = null;
  }
  try { if (c.upstream) c.upstream.abort(); } catch (e4) { /* ignore */ }
  try { if (c.upstream && c.upstream.socket) c.upstream.socket.destroy(); } catch (e5) { /* ignore */ }
  try { if (c.res && !c.res.finished) c.res.destroy(); } catch (e6) { /* ignore */ }
  c.upstream = null;
  c.res = null;
  c.req = null;
}

function killActiveStreams() {
  while (activeUpstreams.length > 0) {
    var c = activeUpstreams.shift();
    destroyConnection(c);
  }
}

function remember(token, entry) {
  tokens[token] = entry;
  order.push(token);
  while (order.length > MAX_TOKENS) {
    var old = order.shift();
    if (old) { delete tokens[old]; }
  }
}

function isCacheFlyIp(ip) {
  if (!ip) { return false; }
  return /^66\.225\./.test(ip) || /^205\.234\./.test(ip) || /^167\.99\./.test(ip);
}

function resolveHostIp(entry, cb) {
  if (!entry) { return cb(''); }
  if (entry.resolvedIp && dnsx.isIpv4(entry.resolvedIp)) {
    return cb(entry.resolvedIp);
  }
  var parsed = urlmod.parse(entry.url || '');
  var host = parsed.hostname;
  if (!host || dnsx.isIpv4(host)) {
    entry.resolvedIp = host || '';
    return cb(entry.resolvedIp);
  }
  var hit = dnsx.cached(host);
  if (hit && hit.ips && hit.ips.length) {
    entry.resolvedIp = dnsx.dial(host, hit.ips);
    return cb(entry.resolvedIp);
  }
  dnsx.resolve(host, function (err, res) {
    if (!err && res && res.ips && res.ips.length) {
      entry.resolvedIp = dnsx.dial(host, res.ips);
    } else {
      entry.resolvedIp = host;
    }
    cb(entry.resolvedIp);
  });
}

function add(target, headers, duration, resolvedIp) {
  var token = crypto.randomBytes(12).toString('hex');
  var entry = {
    url: target,
    headers: headers || {},
    duration: Number(duration) || 0,
    contentLength: 0,
    lengthWaiters: null,
    resolvedIp: resolvedIp || '',
    at: Date.now()
  };
  remember(token, entry);

  var parsed = urlmod.parse(target || '');
  if (parsed.hostname && !dnsx.isIpv4(parsed.hostname) && !entry.resolvedIp) {
    var hit = dnsx.cached(parsed.hostname);
    if (hit && hit.ips && hit.ips.length) {
      entry.resolvedIp = dnsx.dial(parsed.hostname, hit.ips);
    }
    dnsx.resolve(parsed.hostname, function (err, res) {
      if (!err && res && res.ips && res.ips.length) {
        entry.resolvedIp = dnsx.dial(parsed.hostname, res.ips);
      }
    });
  }

  return token;
}

/* Registers a subtitle URL and returns a loopback URL the page can XHR.
 * The page cannot read the CDN directly (no Access-Control-Allow-Origin). */
function addSubtitle(target) {
  var token = crypto.randomBytes(12).toString('hex');
  subtitleTokens[token] = { url: target, at: Date.now() };
  subtitleOrder.push(token);
  while (subtitleOrder.length > MAX_SUBTITLES) {
    var old = subtitleOrder.shift();
    if (old) { delete subtitleTokens[old]; }
  }
  return baseUrl() + '/sub/' + token + '.srt';
}

function sendSubtitle(req, res, entry) {
  resolveHostIp(entry, function (ip) {
    var parsed = urlmod.parse(entry.url || '');
    var secure = parsed.protocol === 'https:';
    var host = parsed.hostname;
    var connectHost = ip || host;
    var defaultPort = secure ? 443 : 80;
    var port = parsed.port || defaultPort;
    var options = {
      hostname: connectHost,
      host: connectHost,
      servername: host,
      rejectUnauthorized: false,
      port: port,
      path: parsed.path,
      method: 'GET',
      headers: {
        'User-Agent': 'Ranger/4.9.4-17294ac0',
        'Accept': '*/*',
        Host: parsed.host || (host + (port !== defaultPort ? ':' + port : ''))
      },
      agent: secure ? httpsAgent : httpAgent
    };
    var failed = false;
    var upstream = (secure ? https : http).request(options, function (up) {
      var parts = [];
      up.on('data', function (chunk) { parts.push(chunk); });
      up.on('end', function () {
        if (failed) { return; }
        var body = Buffer.concat(parts);
        var ok = up.statusCode >= 200 && up.statusCode < 300;
        res.writeHead(ok ? 200 : 502, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': body.length,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'private, max-age=300'
        });
        res.end(body);
      });
    });
    upstream.setTimeout(20000, function () { try { upstream.abort(); } catch (eAbort) { /* ignore */ } });
    upstream.on('error', function () {
      if (failed) { return; }
      failed = true;
      try {
        res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('subtitle upstream error');
      } catch (e502) { /* ignore */ }
    });
    upstream.end();
  });
}

function mediaRequest(entry, method, extraHeaders, resolvedIp) {
  var parsed = urlmod.parse(entry.url || '');
  var host = parsed.hostname;
  var connectHost = resolvedIp || entry.resolvedIp;
  if (!connectHost && host) {
    var hit = dnsx.cached(host);
    if (hit && hit.ips && hit.ips.length) {
      connectHost = dnsx.dial(host, hit.ips);
      entry.resolvedIp = connectHost;
    }
  }
  if (!connectHost) {
    connectHost = host;
  }

  var secure = parsed.protocol === 'https:';

  /* In restrictive jurisdictions (e.g. Chile), carriers inspect unencrypted port 80
     Host headers to block streams. VOD CDNs on CacheFly support HTTPS on port 443,
     which encrypts the entire connection and circumvents DPI. */
  var isCacheFly = isCacheFlyIp(connectHost) || /swzablvpm|kyalbhxgw|m3x8o50te|qnrgmzpcw|faolmbghu/i.test(host || '');
  if (isCacheFly) {
    secure = true;
  }

  var headers = {};
  var k;
  for (k in entry.headers) {
    if (Object.prototype.hasOwnProperty.call(entry.headers, k)) { headers[k] = entry.headers[k]; }
  }
  for (k in extraHeaders || {}) {
    if (Object.prototype.hasOwnProperty.call(extraHeaders, k)) { headers[k] = extraHeaders[k]; }
  }

  var defaultPort = secure ? 443 : 80;
  var port = (secure && parsed.port === '80') ? 443 : (parsed.port || defaultPort);
  headers.Host = parsed.host || (host + (port !== defaultPort ? ':' + port : ''));

  var servername = host;
  if (isCacheFly) {
    servername = 'cachefly.net';
  }

  return {
    secure: secure,
    options: {
      hostname: connectHost,
      host: connectHost,
      servername: servername,
      rejectUnauthorized: false,
      port: port,
      path: parsed.path,
      method: method,
      headers: headers,
      agent: secure ? httpsAgent : httpAgent
    }
  };
}

function sourceLength(entry, done) {
  if (entry.contentLength > 0) { return done(null, entry.contentLength); }
  if (entry.lengthWaiters) { entry.lengthWaiters.push(done); return; }
  entry.lengthWaiters = [done];
  resolveHostIp(entry, function (ip) {
    var requestInfo = mediaRequest(entry, 'GET', { Range: 'bytes=0-0' }, ip);
    var req = (requestInfo.secure ? https : http).request(requestInfo.options, function (up) {
      var match = /\/(\d+)$/.exec(String(up.headers['content-range'] || ''));
      var length = match ? parseInt(match[1], 10) : parseInt(up.headers['content-length'], 10);
      up.resume();
      var waiters = entry.lengthWaiters || [];
      entry.lengthWaiters = null;
      if (length > 0) { entry.contentLength = length; }
      for (var i = 0; i < waiters.length; i++) {
        waiters[i](length > 0 ? null : new Error('el CDN no informó el tamaño'), length);
      }
    });
    req.setTimeout(15000, function () { try { req.abort(); } catch (eAbort) {} });
    req.on('error', function (err) {
      var waiters = entry.lengthWaiters || [];
      entry.lengthWaiters = null;
      for (var i = 0; i < waiters.length; i++) { waiters[i](err); }
    });
    req.end();
  });
}

function readRange(entry, start, end, done) {
  resolveHostIp(entry, function (ip) {
    var info = mediaRequest(entry, 'GET', { Range: 'bytes=' + start + '-' + end }, ip);
    var req = (info.secure ? https : http).request(info.options, function (up) {
      var parts = []; up.on('data', function (c) { parts.push(c); });
      up.on('end', function () { done(up.statusCode >= 200 && up.statusCode < 300 ? null : new Error('rango rechazado'), Buffer.concat(parts)); });
    });
    req.setTimeout(25000, function () { try { req.abort(); } catch (eAbort) {} });
    req.on('error', function (err) { done(err); }); req.end();
  });
}

function sendVirtualHls(req, res, token, entry) {
  sourceLength(entry, function (err, length) {
    if (err) {
      res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('no se pudo crear el manifiesto HLS');
      return;
    }
    if (!entry.indexer) { entry.indexer = tsIndexer.create(length, function (start, end, cb) { readRange(entry, start, end, cb); }); entry.indexer.start(); }
    var indexer = entry.indexer;
    if (!indexer.segments.length && !indexer.complete) { indexer.when(function () { sendVirtualHls(req, res, token, entry); }); return; }
    var lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:4',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-TARGETDURATION:' + HLS_SEGMENT_SECONDS,
      '#EXT-X-MEDIA-SEQUENCE:0'
    ];
    for (var i = 0; i < indexer.segments.length; i++) {
      var segment = indexer.segments[i];
      lines.push('#EXTINF:' + segment.duration.toFixed(3) + ',');
      lines.push('#EXT-X-BYTERANGE:' + (segment.end - segment.start + 1) + '@' + segment.start);
      lines.push('stream.ts');
    }
    if (indexer.complete) { lines.push('#EXT-X-ENDLIST'); }
    var body = lines.join('\n') + '\n';
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  });
}

/* Modern webOS HLS players strictly resolve a playlist's relative segment,
 * key and nested-playlist URLs against the loopback manifest URL.  Those
 * child requests must keep the portal's authorization headers too.  Rewrite
 * every URI to an opaque local route and proxy it with the parent token. */
function base64Url(value) {
  return new Buffer(String(value), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  var raw = String(value).replace(/-/g, '+').replace(/_/g, '/');
  while (raw.length % 4) { raw += '='; }
  return new Buffer(raw, 'base64').toString('utf8');
}

function hlsChildUrl(token, manifestUrl, reference) {
  if (!reference || reference.indexOf('data:') === 0) { return reference; }
  return baseUrl() + '/hls/' + token + '/' + base64Url(urlmod.resolve(manifestUrl, reference));
}

function rewriteHlsManifest(body, token, manifestUrl) {
  var lines = String(body || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) { continue; }
    if (line.charAt(0) !== '#') {
      lines[i] = hlsChildUrl(token, manifestUrl, line);
    } else if (line.indexOf('URI=') !== -1) {
      lines[i] = line.replace(/URI=("|')([^"']+)\1/g, function (all, quote, reference) {
        return 'URI=' + quote + hlsChildUrl(token, manifestUrl, reference) + quote;
      });
    }
  }
  return lines.join('\n');
}

function forward(req, res, entry, token) {
  /* When switching to a different movie or episode, immediately abort all previous video streams */
  if (activeToken !== token) {
    killActiveStreams();
    activeToken = token;
  }

  var rangeHeaders = {};
  if (req.headers.range) { rangeHeaders.Range = req.headers.range; }
  if (req.headers['if-range']) { rangeHeaders['If-Range'] = req.headers['if-range']; }

  resolveHostIp(entry, function (ip) {
    if (res.finished) { return; }

    var requestInfo = mediaRequest(entry, req.method === 'HEAD' ? 'HEAD' : 'GET', rangeHeaders, ip);
    var secure = requestInfo.secure;
    var opts = requestInfo.options;

    if (res.socket) {
      try { res.socket.setNoDelay(true); } catch (eNd1) { /* ignore */ }
    }

    var connRecord = { upstream: null, res: res, req: req, up: null };
    activeUpstreams.push(connRecord);

    function cleanup() {
      var idx = activeUpstreams.indexOf(connRecord);
      if (idx !== -1) { activeUpstreams.splice(idx, 1); }
      destroyConnection(connRecord);
    }

    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
    res.on('finish', cleanup);
    res.on('error', cleanup);

    var upstream = (secure ? https : http).request(opts, function (up) {
      connRecord.up = up;
      if (up.socket) {
        try { up.socket.setNoDelay(true); } catch (eNd2) { /* ignore */ }
      }
      upstream.setTimeout(0);
      if (upstream.socket) {
        try { upstream.socket.setTimeout(0); } catch (e1) { /* ignore */ }
      }

      var rawMime = (up.headers['content-type'] || '').toLowerCase();
      var contentType = 'video/mp2t';
      if (rawMime.indexOf('mp4') !== -1) {
        contentType = 'video/mp4';
      } else if (rawMime.indexOf('mpegurl') !== -1 || (entry.url && entry.url.indexOf('.m3u8') !== -1)) {
        contentType = 'application/vnd.apple.mpegurl';
      }
      var isM3u8 = (contentType === 'application/vnd.apple.mpegurl');

      var out = {
        'Content-Type': contentType,
        'Accept-Ranges': up.headers['accept-ranges'] || 'bytes',
        'Access-Control-Allow-Origin': '*',
        /* This is a loopback-only authenticated proxy.  no-store makes the
           webOS media pipeline discard every received range, leaving it with a
           tiny buffer and visible micro-pauses.  A short private cache permits
           normal read-ahead/retry without sharing the licensed response. */
        'Cache-Control': isM3u8 ? 'no-cache, no-store' : 'private, max-age=120',
        'Connection': 'keep-alive'
      };
      if (up.headers['content-length']) { out['Content-Length'] = up.headers['content-length']; }
      if (up.headers['content-range']) { out['Content-Range'] = up.headers['content-range']; }

      if (req.method === 'HEAD') {
        res.writeHead(up.statusCode || 200, out);
        res.end();
        up.resume();
        return;
      }

      if (isM3u8) {
        var chunks = [];
        up.on('data', function (chunk) { chunks.push(chunk); });
        up.on('error', function () { cleanup(); });
        up.on('end', function () {
          var body = rewriteHlsManifest(Buffer.concat(chunks).toString('utf8'), token, entry.url);
          delete out['Content-Length'];
          delete out['Content-Range'];
          out['Content-Length'] = Buffer.byteLength(body);
          try {
            res.writeHead(up.statusCode || 200, out);
            res.end(body);
          } catch (eManifest) { cleanup(); }
        });
        return;
      }

      res.writeHead(up.statusCode || 200, out);

      up.on('error', function () { cleanup(); });
      up.on('close', function () { cleanup(); });
      up.on('end', function () { cleanup(); });

      up.pipe(res);
    });

    connRecord.upstream = upstream;

    if (upstream.socket) {
      try { upstream.socket.setNoDelay(true); } catch (eNd3) { /* ignore */ }
    }

    /* Connect timeout only - aborted only if headers do not arrive in 25s */
    upstream.setTimeout(25000, function () {
      if (!res.headersSent) {
        try { upstream.abort(); } catch (e) { /* ignore */ }
        try {
          res.writeHead(504, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
          res.end('gateway timeout');
        } catch (e504) { /* ignore */ }
      }
      cleanup();
    });

    upstream.on('error', function () {
      if (!res.headersSent) {
        try {
          res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
          res.end('upstream error');
        } catch (e502) { /* ignore */ }
      }
      cleanup();
    });

    upstream.end();
  });
}

function handler(req, res) {
  try { req.setTimeout(0); } catch (eT1) { /* ignore */ }
  try { res.setTimeout(0); } catch (eT2) { /* ignore */ }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range'
    });
    res.end();
    return;
  }
  if (req.url === '/media/abort') {
    killActiveStreams();
    activeToken = null;
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('aborted');
    return;
  }
  var sub = /^\/sub\/([a-f0-9]{24})\.srt$/.exec(req.url || '');
  if (sub) {
    var subEntry = subtitleTokens[sub[1]];
    if (!subEntry) {
      res.writeHead(410, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('expired');
      return;
    }
    sendSubtitle(req, res, subEntry);
    return;
  }
  var hls = /^\/hls\/([a-f0-9]{24})\/([A-Za-z0-9_-]+)$/.exec((req.url || '').split('?')[0]);
  if (hls) {
    var hlsEntry = tokens[hls[1]];
    if (!hlsEntry) {
      res.writeHead(410, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('expired');
      return;
    }
    var childUrl = fromBase64Url(hls[2]);
    if (!/^https?:\/\//i.test(childUrl)) {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('invalid hls child');
      return;
    }
    forward(req, res, {
      url: childUrl,
      headers: hlsEntry.headers,
      duration: 0
    }, hls[1]);
    return;
  }
  var m = /^\/media\/([a-f0-9]{24})(?:\/([^\?#]*))?(?:[?#].*)?$/.exec(req.url || '');
  if (!m) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('not found');
    return;
  }
  var token = m[1];
  var subpath = m[2] || '';
  var entry = tokens[token];
  if (!entry) {
    res.writeHead(410, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('expired');
    return;
  }
  if (entry.url.indexOf('.m3u8') === -1 && subpath.indexOf('.m3u8') !== -1) {
    sendVirtualHls(req, res, token, entry);
    return;
  }
  forward(req, res, entry, token);
}

function start(cb) {
  if (server && port) { return cb(null, port); }
  server = http.createServer(handler);
  server.timeout = 0;
  if (typeof server.setTimeout === 'function') {
    server.setTimeout(0);
  }
  server.on('error', function (err) { cb(err); });
  server.listen(0, function () {
    port = server.address().port;
    cb(null, port);
  });
}

function baseUrl() {
  return port ? 'http://127.0.0.1:' + port : '';
}

module.exports = {
  start: start,
  add: add,
  addSubtitle: addSubtitle,
  baseUrl: baseUrl,
  port: function () { return port; },
  killActiveStreams: killActiveStreams
};

