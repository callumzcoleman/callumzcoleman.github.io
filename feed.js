/* ======================================================================
   Substack feed loader (resilient)
   Order of attempts:
     1. posts.json  — a same-origin cache written by a scheduled GitHub
        Action (no CORS, always works when present).
     2. CORS proxies in parallel (first success wins) — Substack blocks
        direct browser fetches, so we read its RSS through a proxy.
     3. last-good result cached in this browser's localStorage.
     4. graceful fallback link.
   Usage: loadSubstack({ containerId, limit, variant })
   ====================================================================== */
(function () {
  var FEED = 'https://narrowwindow.substack.com/feed';
  var CACHE_KEY = 'nw_feed_cache_v1';

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

  window.loadSubstack = function (opts) {
    opts = opts || {};
    var el = document.getElementById(opts.containerId);
    if (!el) return;
    var variant = opts.variant || 'list';
    var limit = opts.limit;

    // 1) same-origin cache (written by the scheduled GitHub Action)
    fetchTimeout('posts.json?ts=' + Date.now(), 6000).then(function (r) {
      if (!r.ok) throw new Error('no posts.json');
      return r.json();
    }).then(function (data) {
      if (!Array.isArray(data) || !data.length) throw new Error('empty posts.json');
      saveCache(data);
      render(el, slice(data, limit), variant);
    }).catch(function () {
      // 2) CORS proxies
      viaProxies().then(function (posts) {
        saveCache(posts);
        render(el, slice(posts, limit), variant);
      }).catch(function () {
        // 3) last-good browser cache, else 4) fallback
        var cached = loadCache();
        if (cached && cached.length) render(el, slice(cached, limit), variant);
        else fallback(el);
      });
    });
  };
})();
