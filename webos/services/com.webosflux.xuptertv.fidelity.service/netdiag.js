/*
 * Network diagnostics for the XuperTV webOS port.
 *
 * WHY
 * ---
 * When a carrier blocks the service it does not usually block the video: it
 * poisons the DNS answer for the catalogue/CDN hostnames.  The TV then reports
 * a generic "stream could not be opened" error and there is no way for the
 * user to tell a blocked DNS from a dead server or a dead Wi-Fi link.
 *
 * This module answers, from inside the TV:
 *   - what the local (ISP) resolver says for every host,
 *   - what Cloudflare/Google DoH say for the same host,
 *   - whether a TCP connection to each address actually opens,
 *   - whether the DoH resolvers themselves are reachable.
 *
 * It only reads and reports.  It never changes playback and never resolves a
 * stream by itself: the DoH bypass lives in dnsx.js.
 *
 * ES5/CommonJS on purpose: webOS 4 ships an old Node.js inside its services.
 */
'use strict';

var https = require('https');
var dnsx = require('./dnsx');

var TCP_TIMEOUT = 4000;
var HTTP_TIMEOUT = 6000;
var MAX_HOSTS = 8;

function now() { return Date.now(); }

function parallel(tasks, done) {
  var pending = tasks.length;
  var results = [];
  if (!pending) { return done(results); }
  tasks.forEach(function (task, index) {
    var settled = false;
    task(function (value) {
      if (settled) { return; }
      settled = true;
      results[index] = value;
      pending--;
      if (pending === 0) { done(results); }
    });
  });
}

/* TCP: does the address accept a connection at all? */
function tcpCheck(ip, port, done) {
  if (!ip) { return done({ ip: ip, port: port, ok: false, error: 'sin direccion' }); }
  dnsx.probe(ip, port, function (err, ms) {
    done({
      ip: ip,
      port: port,
      ok: !err,
      ms: ms,
      error: err ? (err.code || err.message) : ''
    });
  });
}

/* TLS + HTTP: is the service answering on this address with this SNI? */
function httpsCheck(host, ip, done) {
  var finished = false;
  var t0 = now();

  function finish(value) {
    if (finished) { return; }
    finished = true;
    done(value);
  }

  var req = https.request({
    hostname: ip,
    servername: host,
    rejectUnauthorized: false,
    port: 443,
    path: '/',
    method: 'GET',
    headers: {
      'User-Agent': 'XuperTV/webOS',
      Host: host,
      Connection: 'close'
    }
  }, function (res) {
    var status = res.statusCode;
    res.resume();
    res.on('end', function () {
      finish({ host: host, ip: ip, ok: status > 0, status: status, ms: now() - t0 });
    });
  });

  req.setTimeout(HTTP_TIMEOUT, function () {
    try { req.abort(); } catch (eAbort) { /* ignore */ }
    finish({ host: host, ip: ip, ok: false, error: 'tiempo agotado', ms: now() - t0 });
  });
  req.on('error', function (err) {
    finish({ host: host, ip: ip, ok: false, error: err.code || err.message, ms: now() - t0 });
  });
  req.end();
}

function first(list) { return list && list.length ? list[0] : ''; }

/* A poisoned answer has NOTHING in common with the real one.  Cloudflare
 * rotates a subset of its two addresses, so a partial difference is normal and
 * must not be reported as a block. */
function hasCommon(a, b) {
  if (!a || !b) { return false; }
  for (var i = 0; i < a.length; i++) {
    if (b.indexOf(a[i]) !== -1) { return true; }
  }
  return false;
}

/* One host: local DNS, DoH, TCP and TLS on both answers. */
function checkHost(host, done) {
  var result = {
    host: host,
    system: { ok: false, ips: [], ms: 0, error: '' },
    doh: { ok: false, ips: [], ms: 0, error: '' },
    mismatch: false,
    tcp443: null,
    http: null,
    verdict: 'unknown'
  };
  var t0 = now();

  function onSystem(err, ips) {
    result.system.ms = now() - t0;
    if (err) {
      result.system.error = err.code || err.message;
    } else {
      result.system.ok = true;
      result.system.ips = ips;
    }
    var t1 = now();
    dnsx.queryDoh(host, function (dohErr, dohIps) {
      result.doh.ms = now() - t1;
      if (dohErr) {
        result.doh.error = dohErr.message;
      } else {
        result.doh.ok = true;
        result.doh.ips = dohIps;
      }
      result.mismatch = result.system.ok && result.doh.ok && !hasCommon(result.system.ips, result.doh.ips);

      /* Prefer the DoH answer: it is the one the bypass will use. */
      var dialIp = first(result.doh.ips) || first(result.system.ips);
      tcpCheck(dialIp, 443, function (tcp) {
        result.tcp443 = tcp;
        if (!tcp.ok) {
          result.verdict = 'sin-tcp';
          return done(result);
        }
        httpsCheck(host, dialIp, function (http) {
          result.http = http;
          if (!http.ok) { result.verdict = 'tls-falla'; return done(result); }
          if (result.mismatch) { result.verdict = 'dns-distinto'; return done(result); }
          if (!result.system.ok) { result.verdict = 'dns-local-falla'; return done(result); }
          result.verdict = 'ok';
          done(result);
        });
      });
    });
  }

  dnsx.systemLookup(host, onSystem);
}

/* A single query per provider, measured, to know whether DoH itself works. */
function checkProvider(provider, done) {
  var t0 = now();
  tcpCheck(provider.ip, 443, function (tcp) {
    if (!tcp.ok) {
      return done({
        ip: provider.ip,
        sni: provider.sni,
        reachable: false,
        ms: tcp.ms,
        error: tcp.error
      });
    }
    done({
      ip: provider.ip,
      sni: provider.sni,
      reachable: true,
      ms: tcp.ms,
      queryMs: 0,
      error: ''
    });
  });
}

function verdictOf(hosts, providers) {
  var reachable = 0;
  var anyDoh = false;
  var anyMismatch = false;
  var anyLocalFail = false;
  var anyTcpFail = false;
  var tcpFailCount = 0;
  for (var i = 0; i < providers.length; i++) {
    if (providers[i].reachable) { reachable++; }
  }
  for (var j = 0; j < hosts.length; j++) {
    if (hosts[j].doh.ok) { anyDoh = true; }
    if (hosts[j].mismatch) { anyMismatch = true; }
    if (hosts[j].verdict === 'dns-local-falla') { anyLocalFail = true; }
    if (hosts[j].verdict === 'sin-tcp' || hosts[j].verdict === 'tls-falla') {
      anyTcpFail = true;
      tcpFailCount++;
    }
  }
  if (!reachable) { return 'doh-bloqueado'; }
  /* A rotating CDN always leaves one address cold; only a total failure means
     the network cannot reach the service at all. */
  if (anyTcpFail && tcpFailCount >= hosts.length) { return 'sin-salida'; }
  if (anyMismatch) { return 'dns-distinto'; }
  /* The ISP resolver answered nothing at all: that is a DNS block even when
     DoH saves the day, and the viewer must be told so. */
  if (anyLocalFail) { return 'dns-local-falla'; }
  if (anyTcpFail) { return 'algun-servidor'; }
  if (!anyDoh) { return 'doh-sin-respuesta'; }
  return 'ok';
}

/* run({hosts:[...], screen:{w,h,scale}}, cb) -> report */
function run(options, cb) {
  options = options || {};
  var hosts = (options.hosts || []).filter(function (h) { return typeof h === 'string' && h; });
  var extra = options.dnsxHosts || [];
  for (var e = 0; e < extra.length; e++) {
    if (hosts.indexOf(extra[e]) === -1) { hosts.push(extra[e]); }
  }
  hosts = hosts.slice(0, MAX_HOSTS);

  var t0 = now();
  var hostTasks = hosts.map(function (host) {
    return function (done) { checkHost(host, done); };
  });
  var providerTasks = dnsx.providers.map(function (provider) {
    return function (done) { checkProvider(provider, done); };
  });

  parallel(providerTasks, function (providers) {
    parallel(hostTasks, function (hostResults) {
      cb(null, {
        at: now(),
        tookMs: now() - t0,
        mode: dnsx.mode(),
        verdict: verdictOf(hostResults, providers),
        providers: providers,
        hosts: hostResults,
        cache: dnsx.summary(),
        screen: options.screen || null
      });
    });
  });
}

module.exports = {
  run: run,
  checkHost: checkHost,
  checkProvider: checkProvider
};
