/*
 * DNS-over-HTTPS resolver for the webOS service.
 *
 * WHY
 * ---
 * In some countries (Chile, for example) the carriers block the catalogue and
 * CDN hostnames by poisoning the DNS answer: the TV asks its router, the ISP
 * returns a dead IP, and every request fails even though the servers are up.
 * The portal hostnames rotate (Hydra style), but a poisoned resolver never
 * sees the fresh addresses.
 *
 * DoH asks Cloudflare/Google for the same A record over HTTPS to a well known
 * IP, so the ISP's DNS never participates.  The rest of the service keeps using
 * the hostname for TLS SNI and the HTTP Host header; only the address used for
 * the TCP connection changes.
 *
 * ES5 on purpose: webOS 4 ships an old Node.js inside its services.
 */
'use strict';

var dns = require('dns');
var https = require('https');
var net = require('net');

var CACHE_MS = 10 * 60 * 1000;
var SYSTEM_CACHE_MS = 60 * 1000;
var DOH_TIMEOUT = 5000;
var PROBE_TIMEOUT = 4000;

/* Resolvers are addressed by IP so reaching them never depends on the DNS we
   are trying to bypass.  SNI/Host carry the real certificate name. */
var PROVIDERS = [
  { ip: '1.1.1.1', sni: 'cloudflare-dns.com', path: '/dns-query' },
  { ip: '1.0.0.1', sni: 'cloudflare-dns.com', path: '/dns-query' },
  { ip: '8.8.8.8', sni: 'dns.google', path: '/resolve' },
  { ip: '8.8.4.4', sni: 'dns.google', path: '/resolve' },
  { ip: '94.140.14.14', sni: 'dns.adguard-dns.com', path: '/resolve' },
  { ip: '94.140.15.15', sni: 'dns.adguard-dns.com', path: '/resolve' }
];

var cache = {};        // host -> { ips:[], at, ttl, source }
var dialIndex = {};    // host -> round robin cursor
var mode = 'auto';     // 'auto' | 'doh' | 'system'

function now() { return Date.now(); }

function isIpv4(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(host || ''));
}

function uniq(list) {
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && out.indexOf(list[i]) === -1) { out.push(list[i]); }
  }
  return out;
}

function keep(host, ips, source, ttl) {
  cache[host] = {
    ips: uniq(ips),
    at: now(),
    ttl: ttl || CACHE_MS,
    source: source
  };
  return cache[host];
}

function cached(host) {
  var hit = cache[host];
  if (!hit) { return null; }
  if (now() - hit.at > hit.ttl) { return null; }
  return hit;
}

/* --------------------------------------------------------------- transports */
function dohQuery(host, provider, done) {
  var path = provider.path + '?name=' + encodeURIComponent(host) + '&type=A';
  var finished = false;
  var t0 = now();

  function finish(err, ips) {
    if (finished) { return; }
    finished = true;
    done(err, ips || [], now() - t0);
  }

  var req = https.request({
    hostname: provider.ip,
    servername: provider.sni,
    rejectUnauthorized: false,
    path: path,
    method: 'GET',
    headers: {
      accept: 'application/dns-json',
      host: provider.sni,
      'User-Agent': 'XuperTV/webOS'
    }
  }, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () {
      if (res.statusCode !== 200) {
        return finish(new Error('DoH ' + provider.ip + ': HTTP ' + res.statusCode));
      }
      var answer;
      try {
        answer = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (eJson) {
        return finish(new Error('DoH ' + provider.ip + ': respuesta no JSON'));
      }
      var rows = (answer && answer.Answer) || [];
      var ips = [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i] && rows[i].type === 1 && isIpv4(rows[i].data)) { ips.push(rows[i].data); }
      }
      if (!ips.length) { return finish(new Error('DoH ' + provider.ip + ': sin registros A')); }
      finish(null, ips);
    });
  });
  req.setTimeout(DOH_TIMEOUT, function () { try { req.abort(); } catch (eAbort) { /* ignore */ } });
  req.on('timeout', function () { finish(new Error('DoH ' + provider.ip + ': tiempo agotado')); });
  req.on('error', function (err) { finish(err); });
  req.end();
  return req;
}

function systemLookup(host, done) {
  var finished = false;
  function finish(err, ips) {
    if (finished) { return; }
    finished = true;
    done(err, ips || []);
  }
  try {
    dns.lookup(host, { all: true, family: 4 }, function (err, addrs) {
      if (err) { return finish(err); }
      var ips = [];
      /* Old Node builds ignore {all:true} and answer (address, family) with a
         string, so handle both shapes. */
      if (typeof addrs === 'string') {
        if (isIpv4(addrs)) { ips.push(addrs); }
      } else {
        for (var i = 0; i < (addrs || []).length; i++) {
          var a = addrs[i];
          var ip = typeof a === 'string' ? a : (a && a.address);
          if (isIpv4(ip)) { ips.push(ip); }
        }
      }
      if (!ips.length) { return finish(new Error('DNS del televisor: sin respuesta')); }
      finish(null, ips);
    });
  } catch (e) {
    finish(e);
  }
}

/* -------------------------------------------------------------------- query */
/* Several resolvers are asked at the same time and the first answer wins, so a
 * blocked or slow resolver costs milliseconds instead of a full timeout.  When
 * every resolver fails the network is remembered as "DoH not available" for a
 * while and the system resolver is used, which is the pre-1.6 behaviour. */
var DOH_DOWN_MS = 5 * 60 * 1000;
var dohDownUntil = 0;

function queryDoh(host, done) {
  if (now() < dohDownUntil) { return done(new Error('DoH no disponible en esta red'), []); }

  var pending = PROVIDERS.length;
  var finished = false;
  var errors = [];
  var requests = [];

  function finish(err, ips, provider) {
    if (finished) { return; }
    finished = true;
    for (var i = 0; i < requests.length; i++) {
      try { requests[i].abort(); } catch (eAbort) { /* ignore */ }
    }
    if (err) {
      dohDownUntil = now() + DOH_DOWN_MS;
      return done(err, []);
    }
    dohDownUntil = 0;
    done(null, ips, provider);
  }

  PROVIDERS.forEach(function (provider) {
    var req = dohQuery(host, provider, function (err, ips) {
      pending--;
      if (err) {
        errors.push(err.message);
        if (pending === 0) { finish(new Error(errors.join(' | ')), []); }
        return;
      }
      finish(null, ips, provider);
    });
    requests.push(req);
  });
}

/* resolve(host, cb) -> cb(err, { host, ips, source, at }) */
function resolve(host, cb) {
  host = String(host || '');
  if (!host) { return cb(new Error('host vacio')); }
  if (isIpv4(host)) {
    return cb(null, { host: host, ips: [host], source: 'ip', at: now() });
  }
  var hit = cached(host);
  if (hit) { return cb(null, { host: host, ips: hit.ips, source: hit.source, at: hit.at }); }

  function useSystem(previousError) {
    if (mode === 'doh') { return cb(previousError || new Error('DoH sin respuesta')); }
    systemLookup(host, function (err, ips) {
      if (err) { return cb(previousError || err); }
      var entry = keep(host, ips, 'system', SYSTEM_CACHE_MS);
      cb(null, { host: host, ips: entry.ips, source: entry.source, at: entry.at });
    });
  }

  if (mode === 'system') { return useSystem(null); }

  queryDoh(host, function (err, ips) {
    if (err || !ips.length) { return useSystem(err); }
    var entry = keep(host, ips, 'doh', CACHE_MS);
    cb(null, { host: host, ips: entry.ips, source: entry.source, at: entry.at });
  });
}

function dial(host, ips) {
  if (!ips || !ips.length) { return ''; }
  if (ips.length === 1) { return ips[0]; }
  dialIndex[host] = ((dialIndex[host] || 0) + 1) % ips.length;
  return ips[dialIndex[host]];
}

/* prepare(options, cb)
 * Takes the options object of http/https.request and returns a copy that
 * connects to the resolved IP while keeping the original name for SNI and for
 * the HTTP Host header. */
function prepare(options, cb) {
  var host = String(options && (options.hostname || options.host) || '');
  if (!host) { return cb(new Error('sin host para conectar')); }
  if (isIpv4(host)) { return cb(null, options); }

  resolve(host, function (err, res) {
    if (err) { return cb(err); }
    var out = {};
    var k;
    for (k in options) {
      if (Object.prototype.hasOwnProperty.call(options, k)) { out[k] = options[k]; }
    }
    out.hostname = dial(host, res.ips);
    if (out.host !== undefined) { out.host = out.hostname; }
    if (!out.servername) { out.servername = host; }

    var headers = {};
    for (k in (options.headers || {})) {
      if (Object.prototype.hasOwnProperty.call(options.headers, k)) { headers[k] = options.headers[k]; }
    }
    var secure = String(options.protocol || '') === 'https:' || options.secure === true;
    var port = String(options.port || (secure ? '443' : '80'));
    var defaultPort = secure ? '443' : '80';
    headers.Host = host + (port !== defaultPort ? ':' + port : '');
    out.headers = headers;
    out._ip = out.hostname;
    out._hostname = host;
    cb(null, out);
  });
}

/* lookup(hostname, [options], cb)
 * Drop-in replacement for dns.lookup so http/https/net connect through the
 * address obtained by DoH.  It is passed as the `lookup` option, which keeps
 * the original hostname for SNI and for the Host header.  On runtimes that
 * ignore the option nothing changes: the system resolver is used as before. */
function lookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  options = options || {};
  resolve(hostname, function (err, res) {
    if (err) { return cb(err); }
    var ip = dial(hostname, res.ips);
    if (options.all) { return cb(null, [{ address: ip, family: 4 }]); }
    cb(null, ip, 4);
  });
}

/* probe(ip, port, cb): TCP connect test used by the network diagnostics. */
function probe(ip, port, cb) {
  var t0 = now();
  var finished = false;
  var socket = net.connect({ host: ip, port: port });
  function finish(err) {
    if (finished) { return; }
    finished = true;
    try { socket.destroy(); } catch (eDestroy) { /* ignore */ }
    cb(err, now() - t0);
  }
  socket.setTimeout(PROBE_TIMEOUT, function () { finish(new Error('tiempo agotado')); });
  socket.on('connect', function () { finish(null); });
  socket.on('error', function (err) { finish(err); });
}

function setMode(value) {
  mode = (value === 'doh' || value === 'system') ? value : 'auto';
  return mode;
}

function clearCache(host) {
  if (host) { delete cache[host]; return; }
  cache = {};
  dialIndex = {};
}

function summary() {
  var out = [];
  for (var host in cache) {
    if (Object.prototype.hasOwnProperty.call(cache, host)) {
      out.push({
        host: host,
        ips: cache[host].ips,
        source: cache[host].source,
        ageMs: now() - cache[host].at
      });
    }
  }
  return out;
}

module.exports = {
  resolve: resolve,
  prepare: prepare,
  lookup: lookup,
  probe: probe,
  systemLookup: systemLookup,
  queryDoh: queryDoh,
  setMode: setMode,
  mode: function () { return mode; },
  clearCache: clearCache,
  cached: cached,
  dial: dial,
  summary: summary,
  isIpv4: isIpv4,
  providers: PROVIDERS
};
