/*
 * XuperTV webOS service: portal catalog + playback resolver.
 *
 * Why a service: the Magis portal sends no Access-Control-Allow-Origin and
 * rejects OPTIONS, so a packaged web app cannot POST to it directly. Node
 * services are not bound by the page's CORS rules, so the encrypted protocol
 * runs here and the app receives plain JSON through Luna.
 */
'use strict';

var Service = require('webos-service');
var pkg = require('./package.json');
var magis = require('./magis');
var proxy = require('./proxy');
var relay = require('./ffmpeg-relay');
var dnsx = require('./dnsx');
var netdiag = require('./netdiag');
var urlmod = require('url');

var service = new Service(pkg.name);

/* Intercept process.exit so idle timers in webos-service do not kill the proxy */
try {
  process.exit = function (code) {
    console.log('[xuper-service] blocked process.exit(' + code + ') to keep streaming alive');
  };
} catch (eExit) { /* ignore */ }

/* Prolong idleTimeout to 24h and create a persistent activity */
if (service.activityManager) {
  try {
    service.activityManager.idleTimeout = 86400;
    service.activityManager.create('keepAlive', function (act) {
      console.log('[xuper-service] persistent activity created');
    });
  } catch (eAct) {
    console.log('[xuper-service] activityManager init note: ' + (eAct && eAct.message));
  }
}

function fail(message, err, code) {
  message.respond({
    returnValue: false,
    errorText: (err && err.message) || err || 'error',
    errorCode: code || (err && err.portalCode) || 1
  });
}

function respond(message, err, payload) {
  if (err) { return fail(message, err); }
  var out = payload || {};
  out.returnValue = true;
  message.respond(out);
}

service.register('ping', function (message) {
  message.respond({
    returnValue: true,
    service: pkg.name,
    version: pkg.version,
    portalHosts: magis.constants.ROOT_CODES ? 'magis' : 'none',
    proxyPort: proxy.port(),
    relayAvailable: relay.available(),
    ffmpegPath: relay.path(),
    relayPort: relay.port()
  });
});

/* keepAlive subscription keeps the Luna bus connection alive so the service never terminates */
service.register('keepAlive', function (message) {
  message.respond({
    returnValue: true,
    subscribed: !!message.isSubscription
  });
});

/* heartbeat method for periodic pings */
service.register('heartbeat', function (message) {
  message.respond({
    returnValue: true,
    alive: true,
    proxyPort: proxy.port(),
    timestamp: Date.now()
  });
});

/* home({root}) -> { items:[...] } for one portal root */
service.register('home', function (message) {
  var root = (message.payload && message.payload.root) || 'movies';
  magis.home(root, function (err, data) { respond(message, err, data); });
});

/* search({value}) -> { items:[...], total } */
service.register('search', function (message) {
  var value = (message.payload && message.payload.value) || '';
  magis.search(value, function (err, data) { respond(message, err, data); });
});

/* detail({contentId}) -> { item, episodes, seasons } */
service.register('detail', function (message) {
  var id = message.payload && message.payload.contentId;
  magis.detail(id, function (err, data) { respond(message, err, data); });
});

/* Subtitle files live on a CDN without CORS headers, so the page cannot read
 * them directly.  Rewrite every subtitle URL to a loopback proxy URL. */
function attachSubtitles(payload) {
  if (!payload || !payload.subtitles || !payload.subtitles.length) { return payload; }
  payload.subtitles = payload.subtitles.map(function (sub) {
    return {
      lang: sub.lang,
      format: sub.format,
      url: proxy.addSubtitle(sub.url)
    };
  });
  return payload;
}

/* resolve({contentId, seriesContentId, playbackMode, trackIndex}) */
function resolveStream(message, forceRelay) {
  var payload = message.payload || {};
  var options = { trackIndex: payload.trackIndex };
  magis.resolve(payload.contentId, payload.seriesContentId, options, function (err, stream) {
    if (err) { return fail(message, err); }

    var isHevc = /hevc|h\.?265/i.test(stream.codec || '') || /hevc|h\.?265/i.test(stream.mime || '');
    /* 1.4.2 renamed the UI modes to direct/relay; accept both spellings so an
       older app build and the current one both reach the relay. */
    var useSmoothMode = forceRelay || payload.forceRelay === true || payload.forceRelay === 'true' ||
      payload.playbackMode === 'smooth' || payload.playbackMode === 'relay';
    /* When smooth mode (Modo Fluido) is requested by the user, always route via
       the on-device FFmpeg relay so the native player receives clean fragmented MP4. */
    if (useSmoothMode && !relay.available()) {
      return fail(message, new Error('Modo Fluido no disponible: ffmpeg no es ejecutable en esta TV'));
    }
    var streamHost = (urlmod.parse(stream.url || '').hostname) || '';
    dnsx.resolve(streamHost, function (dnsErr, dnsRes) {
      var resolvedIp = (dnsRes && dnsRes.ips && dnsRes.ips[0]) || '';

      if (useSmoothMode) {
        proxy.start(function (perr, port) {
          if (perr) { return fail(message, perr); }
          var token = proxy.add(stream.url, stream.headers, stream.duration, resolvedIp);
          var loopbackUrl = proxy.baseUrl() + '/media/' + token + '/stream.ts';
          var relayUrl = relay.register({ url: loopbackUrl, headers: {} }, { hevc: isHevc, audio: Number(payload.audioTrack) || 0 });
          console.log('[xuper-service] routing stream via ffmpeg relay: ' + relayUrl + ' (source via loopback proxy: ' + loopbackUrl + ')');
          stream.proxyPath = relayUrl;
          stream.mime = 'video/mp4';
          stream.isRelay = true;
          stream.isHls = false;
          respond(message, null, attachSubtitles(stream));
        });
        return;
      }

      proxy.start(function (perr, port) {
        if (perr) { return fail(message, perr); }
        var token = proxy.add(stream.url, stream.headers, stream.duration, resolvedIp);
        var extension = stream.mime === 'video/mp4' ? 'mp4' : 'ts';
        stream.proxyPath = proxy.baseUrl() + '/media/' + token + '/stream.' + extension;
        stream.isHls = false;
        attachSubtitles(stream);
        respond(message, null, stream);
      });
    });
  });
}
service.register('resolve', function (message) { resolveStream(message, false); });
/* Separate Luna method: avoids older webOS bridges dropping custom boolean
   fields from a resolve payload. */
service.register('resolveSmooth', function (message) { resolveStream(message, true); });

/* mediaInfo({contentId, seriesContentId}) -> { audio, subtitles, tracks }
 * Audio languages and subtitle files for the in-player dialog.  It runs
 * before playback and returns no playable URL, license or headers. */
service.register('mediaInfo', function (message) {
  var payload = message.payload || {};
  magis.mediaInfo(payload.contentId, payload.seriesContentId, function (err, info) {
    if (err) { return fail(message, err); }
    proxy.start(function (perr) {
      if (perr) { return fail(message, perr); }
      respond(message, null, attachSubtitles(info));
    });
  });
});

service.register('liveChannels', function (message) {
  var payload = message.payload || {};
  magis.getLiveChannels(payload.columnId, payload.pageNum, payload.pageSize, function (err, channels, hasMore) {
    if (err) { return fail(message, err); }
    respond(message, null, {
      channels: channels || [],
      pageNum: Math.max(1, parseInt(payload.pageNum, 10) || 1),
      hasMore: !!hasMore
    });
  });
});

service.register('liveCategories', function (message) {
  magis.getLiveCategories(function (err, categories) {
    if (err) { return fail(message, err); }
    respond(message, null, { categories: categories || [] });
  });
});

service.register('fetchM3u', function (message) {
  var payload = message.payload || {};
  if (!payload.url) { return fail(message, new Error('url requerida')); }
  magis.fetchM3u(payload.url, function (err, channels) {
    if (err) { return fail(message, err); }
    respond(message, null, { channels: channels || [] });
  });
});

service.register('resolveLive', function (message) {
  var payload = message.payload || {};
  if (payload.streamUrl) {
    return respond(message, null, { url: payload.streamUrl, proxyPath: payload.streamUrl, isHls: true });
  }
  if (!payload.channelCode) { return fail(message, new Error('channelCode requerido')); }
  magis.resolveLive(payload.channelCode, function (err, stream) {
    if (err) { return fail(message, err); }
    var streamHost = (urlmod.parse(stream.url || '').hostname) || '';
    dnsx.resolve(streamHost, function (dnsErr, dnsRes) {
      var resolvedIp = (dnsRes && dnsRes.ips && dnsRes.ips[0]) || '';
      proxy.start(function (perr) {
        if (perr) { return fail(message, perr); }
        var token = proxy.add(stream.url, stream.headers, 0, resolvedIp);
        stream.proxyPath = proxy.baseUrl() + '/media/' + token + '/stream.m3u8';
        stream.isHls = true;
        respond(message, null, stream);
      });
    });
  });
});

/* abortMedia(): immediately kills all upstream sockets and buffers in proxy & relay */
service.register('abortMedia', function (message) {
  try { relay.stop(); } catch (eRelay) { /* ignore */ }
  try {
    proxy.killActiveStreams();
  } catch (eKill) { /* ignore */ }
  message.respond({ returnValue: true });
});

/* prewarm(): start the anonymous session so the first home call is fast */
service.register('prewarm', function (message) {
  magis.ensureSession(function (err) {
    if (err) { return fail(message, err); }
    message.respond({ returnValue: true, sn: magis.session.sn, userId: magis.session.userId });
  });
});

/* netdiag(): read-only report used by "Diagnóstico de red".
 * It resolves the portal/CDN hostnames with the TV resolver and with DoH,
 * then tests TCP/TLS, so a blocked DNS can be told apart from a dead server. */
service.register('netdiag', function (message) {
  var payload = message.payload || {};
  var hosts = [];
  var constants = magis.constants || {};
  if (constants.HOSTS && constants.HOSTS.length) {
    hosts = constants.HOSTS.slice(0);
  }
  /* CDN hosts seen recently are the ones that actually serve the video.  Stale
     entries would make an old, already-changed CDN look like a network fault. */
  var cached = dnsx.summary();
  for (var i = 0; i < cached.length; i++) {
    if (cached[i] && cached[i].host && cached[i].ageMs < 120000 && hosts.indexOf(cached[i].host) === -1) {
      hosts.push(cached[i].host);
    }
  }
  if (payload.hosts && payload.hosts.length) {
    hosts = payload.hosts.concat(hosts);
  }
  /* The page reports its real viewport so a cropped UI can be diagnosed from
     a photo of this screen (720p / 2K / 4K sets differ). */
  var screen = null;
  if (Number(payload.screenW) > 0 && Number(payload.screenH) > 0) {
    screen = {
      w: Number(payload.screenW),
      h: Number(payload.screenH),
      scale: Number(payload.screenScale) || 0,
      panelW: Number(payload.panelW) || 0,
      panelH: Number(payload.panelH) || 0
    };
  }
  netdiag.run({ hosts: hosts, screen: screen }, function (err, report) {
    if (err) { return fail(message, err); }
    report.version = pkg.version;
    respond(message, null, report);
  });
});

console.log('[xuper-service] started ' + pkg.name + ' v' + pkg.version);
