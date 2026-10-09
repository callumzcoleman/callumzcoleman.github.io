/* ======================================================================
   Substack feed loader (shared by home + writing pages)
   Substack blocks direct browser fetches (CORS), so we read the RSS feed
   through a public CORS proxy, with a fallback, and degrade gracefully.
   Usage:  loadSubstack({ containerId, limit, variant })
     variant: 'list' (full, with excerpts) | 'compact' (home, titles only)
   ====================================================================== */
(function () {
  const FEED = 'https://narrowwindow.substack.com/feed';

  const readers = [
    u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
    u => 'https://corsproxy.io/?url=' + encodeURIComponent(u)
  ];

  const fmtDate = d => {
    if (!d) return '';
    const dt = new Date(d);
    if (isNaN(dt)) return '';
    return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  };
  const stripHtml = html => {
    const t = document.createElement('div');
    t.innerHTML = html || '';
    return (t.textContent || t.innerText || '').replace(/\s+/g, ' ').trim();
  };
  const readingTime = text => {
    const w = (text || '').split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(w / 200)) + ' min read';
  };
  const excerpt = (text, n) => {
    if (!text) return '';
    return text.length <= n ? text : text.slice(0, n).replace(/\s+\S*$/, '') + '…';
  };
  const esc = s => (s || '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function parseXml(text) {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('bad xml');
    return Array.from(xml.querySelectorAll('item')).map(item => {
      const get = s => item.querySelector(s)?.textContent || '';
      const enc = item.getElementsByTagName('content:encoded')[0];
      const body = stripHtml((enc && enc.textContent) || get('description'));
      return {
        title: stripHtml(get('title')) || 'Untitled',
        link: get('link') || 'https://courseconditions.substack.com',
        date: get('pubDate'),
        excerpt: excerpt(body, 170),
        reading: readingTime(body)
      };
    });
  }

  function metaHtml(p) {
    const bits = [];
    if (p.date) bits.push('<span>' + fmtDate(p.date) + '</span>');
    if (p.reading) bits.push('<span>' + p.reading + '</span>');
    return '<div class="post-meta">' + bits.join('<span class="dot">·</span>') + '</div>';
  }

  function render(el, posts, variant) {
    if (!posts.length) { fallback(el); return; }

    if (variant === 'selected') {
      let s = '<ul class="sel">';
      posts.forEach(p => {
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

    let html = '<ul class="posts' + (variant === 'compact' ? ' compact' : '') + '">';
    posts.forEach(p => {
      html += '<li><a class="post" href="' + p.link + '" target="_blank" rel="noopener">'
        + metaHtml(p)
        + '<h3>' + esc(p.title) + '</h3>'
        + (variant !== 'compact' && p.excerpt ? '<p class="excerpt">' + esc(p.excerpt) + '</p>' : '')
        + '</a></li>';
    });
    html += '</ul>';
    el.innerHTML = html;
  }

  function fallback(el) {
    el.innerHTML = '<p class="feed-note">Read the latest on '
      + '<a href="https://narrowwindow.substack.com" target="_blank" rel="noopener">Britain’s Narrow Window ↗</a> '
      + '(the live feed could not load just now).</p>';
  }

  window.loadSubstack = async function (opts) {
    const { containerId, limit, variant = 'list' } = opts || {};
    const el = document.getElementById(containerId);
    if (!el) return;
    for (let i = 0; i < readers.length; i++) {
      try {
        const res = await fetch(readers[i](FEED), { cache: 'no-store' });
        if (!res.ok) throw new Error('http ' + res.status);
        let posts = parseXml(await res.text());
        if (!posts.length) throw new Error('empty');
        if (limit) posts = posts.slice(0, limit);
        render(el, posts, variant);
        return;
      } catch (e) { /* try next reader */ }
    }
    fallback(el);
  };
})();
