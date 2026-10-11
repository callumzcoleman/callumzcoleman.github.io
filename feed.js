/* ======================================================================
   Substack feed loader (resilient)
   Order of attempts:
     1. posts.json  — a same-origin static cache, if present (always works).
     2. WORKER_URL  — a Cloudflare Worker that fetches the feed at the edge
        and returns JSON (reliable; set WORKER_URL below once deployed).
     3. CORS proxies in parallel (first success wins) — Substack blocks
        direct browser fetches, so we read its RSS through a proxy.
     4. last-good result cached in this browser's localStorage.
     5. graceful fallback link.
   Usage: loadSubstack({ containerId, limit, variant })
   ====================================================================== */
(function () {
  var FEED = 'https://narrowwindow.substack.com/feed';
  var CACHE_KEY = 'nw_feed_cache_v1';

  // Paste your deployed Cloudflare Worker URL here (returns JSON). Leave
  // empty to skip. When set, it is tried before the public CORS proxies.
  var WORKER_URL = '';

  var readers = [
    function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); },
    function (u) { return 'https://corsproxy.io/?url=' + encodeURIComponent(u); },
    function (u) { return 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(u); },
    function (u) { return 'https://thingproxy.freeboard.io/fetch/' + u; }
  ];

  function fmtDate(d) {
    if (!d) return '';
    var dt = new Date(d);
    if (isNaN(dt)) return '';
    return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  function stripHtml(html) {
    var t = document.createElement('div');
    t.innerHTML = html || '';
    return (t.textContent || t.innerText || '').replace(/\s+/g, ' ').trim();
  }
  function esc(s) {
    return (s || '').toString()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fetchTimeout(url, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var opts = { cache: 'no-store' };
    if (ctrl) opts.signal = ctrl.signal;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms);
    return fetch(url, opts).then(function (r) { clearTimeout(timer); return r; },
      function (e) { clearTimeout(timer); throw e; });
  }

  function parseXml(text) {
    var xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('bad xml');
    return Array.prototype.slice.call(xml.querySelectorAll('item')).map(function (item) {
      function get(tag) { var e = item.querySelector(tag); return e ? e.textContent : ''; }
      return {
        title: stripHtml(get('title')) || 'Untitled',
        link: get('link') || 'https://narrowwindow.substack.com',
        date: get('pubDate')
      };
    });
  }

  function saveCache(posts) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(posts)); } catch (e) {}
  }
  function loadCache() {
    try {
      var v = localStorage.getItem(CACHE_KEY);
      var a = v ? JSON.parse(v) : null;
      return Array.isArray(a) ? a : null;
    } catch (e) { return null; }
  }

  function viaProxies() {
    var tasks = readers.map(function (mk) {
      return fetchTimeout(mk(FEED), 7000).then(function (res) {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.text();
      }).then(function (txt) {
        var posts = parseXml(txt);
        if (!posts.length) throw new Error('empty');
        return posts;
      });
    });
    if (Promise.any) return Promise.any(tasks);
    // Fallback for older engines: resolve on first success.
    return new Promise(function (resolve, reject) {
      var left = tasks.length;
      tasks.forEach(function (t) {
        t.then(resolve, function () { if (--left === 0) reject(new Error('all failed')); });
      });
    });
  }

  function render(el, posts, variant) {
    if (!posts || !posts.length) { fallback(el); return; }
    if (variant === 'selected') {
      var s = '<ul class="sel">';
      posts.forEach(function (p) {
        s += '<li><a class="sel-title" href="' + p.link + '" target="_blank" rel="noopener">'
          + esc(p.title) + '</a>'
          + (p.date ? '<div class="sel-sub">' + fmtDate(p.date) + '</div>' : '')
          + '</li>';
      });
      s += '</ul>'
        + '<a class="sel-more" href="https://narrowwindow.substack.com" target="_blank" rel="noopener">'
        + 'More on Britain’s Narrow Window →</a>';
      el.innerHTML = s;
      return;
    }
    var html = '<ul class="posts">';
    posts.forEach(function (p) {
      html += '<li><a class="post" href="' + p.link + '" target="_blank" rel="noopener">'
        + (p.date ? '<div class="post-meta"><span>' + fmtDate(p.date) + '</span></div>' : '')
        + '<h3>' + esc(p.title) + '</h3></a></li>';
    });
    el.innerHTML = html + '</ul>';
  }

  function fallback(el) {
    el.innerHTML = '<p class="feed-note">Read the latest on '
      + '<a href="https://narrowwindow.substack.com" target="_blank" rel="noopener">Britain’s Narrow Window ↗</a>.</p>';
  }

  function slice(posts, limit) { return limit ? posts.slice(0, limit) : posts; }

  // Fetch a JSON endpoint that returns an array of {title, link, date}.
  function tryJson(url) {
    return fetchTimeout(url, 6000).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (data) {
      if (!Array.isArray(data) || !data.length) throw new Error('empty');
      return data;
    });
  }

  window.loadSubstack = function (opts) {
    opts = opts || {};
    var el = document.getElementById(opts.containerId);
    if (!el) return;
    var variant = opts.variant || 'list';
    var limit = opts.limit;

    function done(posts) { saveCache(posts); render(el, slice(posts, limit), variant); }

    // JSON sources first (same-origin static cache, then the Worker if set).
    var jsonSources = ['posts.json?ts=' + Date.now()];
    if (WORKER_URL) jsonSources.push(WORKER_URL);

    function tryJsonSources(i) {
      if (i >= jsonSources.length) return viaProxies().then(done).catch(lastResort);
      return tryJson(jsonSources[i]).then(done).catch(function () { return tryJsonSources(i + 1); });
    }

    function lastResort() {
      var cached = loadCache();
      if (cached && cached.length) render(el, slice(cached, limit), variant);
      else fallback(el);
    }

    tryJsonSources(0);
  };
})();
