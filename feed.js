/* ======================================================================
   Substack feed loader (resilient, multi-feed)
   Merges posts from both Substacks and shows the most recent first.
   Order of attempts:
     1. posts.json  — a same-origin static cache, if present (always works).
     2. WORKER_URL  — a Cloudflare Worker returning merged JSON (reliable;
        set WORKER_URL below once deployed).
     3. CORS proxies in parallel, per feed (Substack blocks direct browser
        fetches, so we read its RSS through a proxy); partial results still
        render.
     4. last-good result cached in this browser's localStorage.
     5. graceful fallback link.
   Usage: loadSubstack({ containerId, limit, variant })
   ====================================================================== */
(function () {
  var FEEDS = [
    'https://narrowwindow.substack.com/feed',
    'https://callumcoleman.substack.com/feed'
  ];
  var CACHE_KEY = 'nw_feed_cache_v2';

  // Paste your deployed Cloudflare Worker URL here (returns merged JSON).
  // Leave empty to skip. When set, it is tried before the public proxies.
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

  // Merge posts from any number of feeds: dedupe by link, newest first.
  function mergePosts(arr) {
    var seen = {}, out = [];
    (arr || []).forEach(function (p) {
      if (p && p.link && !seen[p.link]) { seen[p.link] = 1; out.push(p); }
    });
    out.sort(function (a, b) {
      return (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0);
    });
    return out;
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

  // Normalise rss2json's "YYYY-MM-DD HH:MM:SS" (GMT) to ISO so every browser
  // can parse it; RFC-822 dates from raw RSS are left as-is.
  function normDate(d) {
    if (!d) return '';
    var m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(d);
    return m ? (m[1] + 'T' + m[2] + 'Z') : d;
  }

  // rss2json is CORS-enabled (callable directly from the browser) and built
  // for RSS, so it is the most reliable source.
  function viaRss2json(feedUrl) {
    return fetchTimeout('https://api.rss2json.com/v1/api.json?count=10&rss_url='
      + encodeURIComponent(feedUrl), 8000).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || j.status !== 'ok' || !j.items || !j.items.length) throw new Error('rss2json empty');
      return j.items.map(function (it) {
        return {
          title: stripHtml(it.title) || 'Untitled',
          link: it.link || feedUrl,
          date: normDate(it.pubDate)
        };
      });
    });
  }

  // Race rss2json + the CORS proxies for ONE feed; first success wins.
  function viaProxies(feedUrl) {
    var tasks = [viaRss2json(feedUrl)];
    readers.forEach(function (mk) {
      tasks.push(fetchTimeout(mk(feedUrl), 7000).then(function (res) {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.text();
      }).then(function (txt) {
        var posts = parseXml(txt);
        if (!posts.length) throw new Error('empty');
        return posts;
      }));
    });
    if (Promise.any) return Promise.any(tasks);
    return new Promise(function (resolve, reject) {
      var left = tasks.length;
      tasks.forEach(function (t) {
        t.then(resolve, function () { if (--left === 0) reject(new Error('all failed')); });
      });
    });
  }

  // Fetch ALL feeds via proxies and merge whatever succeeds.
  function fetchAllFeeds() {
    var jobs = FEEDS.map(function (f) {
      return viaProxies(f).then(function (p) { return p; }, function () { return []; });
    });
    return Promise.all(jobs).then(function (lists) {
      var merged = [];
      lists.forEach(function (l) { merged = merged.concat(l); });
      if (!merged.length) throw new Error('all feeds failed');
      return merged;
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

    function done(posts) {
      posts = mergePosts(posts);
      saveCache(posts);
      render(el, slice(posts, limit), variant);
    }

    var jsonSources = ['posts.json?ts=' + Date.now()];
    if (WORKER_URL) jsonSources.push(WORKER_URL);

    function tryJsonSources(i) {
      if (i >= jsonSources.length) return fetchAllFeeds().then(done).catch(lastResort);
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
