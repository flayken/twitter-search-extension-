// v37 content script: keep-alive + mutation observer + monotonic top3 + visibility-aware scrolling
(() => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();

  // PING handler to signal readiness
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse)=>{
    if (msg && msg.type === 'PING'){ sendResponse({ok:true, href:location.href, ready:document.readyState}); return true; }
  });

  // keep-alive to avoid background throttling
  let _keepAliveCtx=null;
  async function ensureKeepAlive(){
    try{
      if (_keepAliveCtx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.00001;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(); await ctx.resume();
      _keepAliveCtx = ctx;
    }catch{}
  }

  const spinnerPresent = () => !!document.querySelector('div[role="progressbar"], [aria-busy="true"]');

  function parseAbbrev(n){
    if (n==null) return 0;
    const s = String(n).trim().toLowerCase();
    if (!s) return 0;
    if (/^\d{1,3}(,\d{3})+$/.test(s)) return Number(s.replace(/,/g,""));
    const m = s.match(/([\d.]+)\s*([kmb])?/i);
    if (!m) return Number(s) || 0;
    const val = parseFloat(m[1]); const u=(m[2]||"").toLowerCase();
    if (u==='k') return Math.round(val*1e3);
    if (u==='m') return Math.round(val*1e6);
    if (u==='b') return Math.round(val*1e9);
    return Math.round(val);
  }

  function extractCount(root, ids){
    for (let i=0;i<ids.length;i++){
      const el = root.querySelector('[data-testid="'+ids[i]+'"]');
      if (!el) continue;
      const num = el.querySelector("span");
      if (num && num.textContent){ const v=parseAbbrev(num.textContent); if (!Number.isNaN(v)) return v; }
      const btn = el.closest("button") || el;
      const aria = btn && btn.getAttribute("aria-label");
      if (aria){
        const m = aria.match(/([\d.,]+|[\d.]+\s*[kmbKMB])\s+(Like|Likes|Retweet|Retweets|Reply|Replies|Quote|Quotes|Bookmark|Bookmarks)/i);
        if (m) return parseAbbrev(m[1]);
      }
    }
    return 0;
  }

  function isRetweet(article){
    const sc = article.querySelector('[data-testid="socialContext"]');
    if (!sc) return false;
    const t = (sc.textContent || "").toLowerCase();
    return t.includes("reposted") || t.includes("retweet");
  }

  function extractTweetFromArticle(article){
    try{
      const link = article.querySelector('a[href*="/status/"]');
      const href = link ? link.getAttribute('href') : null;
      const url = href ? (href.startsWith('http') ? href : ("https://x.com" + href)) : "";
      const user = article.querySelector('[data-testid="User-Name"]');
      let authorName = "", handle = "";
      if (user) {
        const spans = [...user.querySelectorAll("span")].map(s => s.textContent || "").filter(Boolean);
        const h = spans.find(s => s.trim().startsWith("@"));
        handle = (h || "").replace(/^@/, "");
        authorName = spans.find(s => s && s[0] !== "@" && s !== "·") || "";
      }
      const textContainer = article.querySelector('[data-testid="tweetText"]') || article;
      const text = textContainer ? ((textContainer.textContent || "").trim()) : "";
      const toolbar = article.querySelector('[role="group"]') || article;
      const replyCount = extractCount(toolbar, ['reply']);
      const retweetCount = extractCount(toolbar, ['retweet','unretweet']);
      const likeCount = extractCount(toolbar, ['like','unlike']);
      const bookmarkCount = extractCount(toolbar, ['bookmark','unbookmark']);
      let quoteCount = 0;
      const ariaGroup = toolbar.getAttribute('aria-label') || '';
      const qm = ariaGroup.match(/(\d[\d.,]*\s*[kmbKMB]?)\s+Quote/i);
      if (qm) quoteCount = parseAbbrev(qm[1]);
      const timeEl = article.querySelector('time');
      const createdAt = timeEl ? (timeEl.getAttribute('datetime') || '') : '';
      const score = likeCount + 2*retweetCount + replyCount + quoteCount + bookmarkCount;

      return {
        id: url || Math.random().toString(36).slice(2),
        authorName: authorName || handle || "",
        handle: handle || "",
        text, url, createdAt,
        likeCount, retweetCount, replyCount, quoteCount, bookmarkCount,
        score
      };
    }catch(e){ return null; }
  }

  // monotonic model
  const Best = new Map();
  let scanned = 0;

  function ageLabel(iso){
    if (!iso) return '';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const s = Math.max(1, Math.floor((Date.now() - t)/1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s/60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m/60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h/24);
    return `${d}d`;
  }

  function publishPartial() {
    const arr = [...Best.values()].sort((a,b)=>b.score-a.score).slice(0,3)
      .map(t => ({ ...t, ageLabel: ageLabel(t.createdAt) }));
    chrome.storage.local.set({ partialTop3: { data: { scanned, top3: arr } } }).catch(()=>{});
  }
  let lastPartial = 0;

  function considerTweet(t){
    if (!t || !t.url) return;
    scanned++;
    const prev = Best.get(t.url);
    if (!prev || t.score > prev.score){
      Best.set(t.url, { ...t });
      const n = now();
      if (n - lastPartial > 800){ publishPartial(); lastPartial = n; }
    }
  }

  function lastArticle(){
    const all = document.querySelectorAll('article[data-testid="tweet"]');
    return all[all.length-1] || null;
  }

  function observeTimeline(){
    const tl = document.querySelector('[aria-label*="imeline"]') || document.body;
    const mo = new MutationObserver(muts => {
      for (const m of muts){
        m.addedNodes && m.addedNodes.forEach(n => {
          if (n.nodeType !== 1) return;
          if (n.matches && n.matches('article[data-testid="tweet"]')) {
            if (!isRetweet(n)){ const t = extractTweetFromArticle(n); if (t) considerTweet(t); }
          }
          if (n.querySelectorAll){
            n.querySelectorAll('article[data-testid="tweet"]').forEach(a => {
              if (!isRetweet(a)){ const t = extractTweetFromArticle(a); if (t) considerTweet(t); }
            });
          }
        });
      }
    });
    mo.observe(tl, { childList:true, subtree:true });
    return mo;
  }

  let abort=false;
  function setAbort(v){ abort=!!v; }

  async function humanScrollLoop({ auto=true, maxIdleMs=60000 } = {}){
    // initial harvest
    document.querySelectorAll('article[data-testid="tweet"]').forEach(a => {
      if (!isRetweet(a)){ const t=extractTweetFromArticle(a); if (t) considerTweet(t); }
    });

    const mo = observeTimeline();
    let lastNew = now();

    const pace = () => (document.hidden ? 900 + Math.random()*450 : 420 + Math.random()*300);
    let lastSize = Best.size;

    while(!abort){
      if (auto){
        try{
          const a = lastArticle();
          if (a) a.scrollIntoView({ block:'end', behavior:'auto' });
          window.scrollBy({ top: (document.hidden?500:800), behavior:'auto' });
        }catch{}
      }
      await sleep(pace());

      // idle detection
      if (Best.size !== lastSize){ lastSize = Best.size; lastNew = now(); }
      if (auto && !spinnerPresent() && (now() - lastNew) > maxIdleMs) break;
      if (!auto){ /* manual mode never auto-stops */ }
    }

    try{ mo.disconnect(); }catch{}
    return scanned;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'SCROLL_AND_SCRAPE'){
      (async () => {
        try{
          abort=false;
          if (msg.options && msg.options.keepAlive) await ensureKeepAlive();
          const auto = !!(msg.options && msg.options.autoScroll !== false);
          const maxIdleMs = (msg.options && msg.options.maxIdleMs) || 60000;
          await humanScrollLoop({ auto, maxIdleMs });
          const arr = [...Best.values()].sort((a,b)=>b.score-a.score).slice(0,3)
            .map(t => ({ ...t, ageLabel: ageLabel(t.createdAt) }));
          sendResponse({ ok:true, data:{ scanned, top3:arr } });
        }catch(e){ sendResponse({ ok:false, error:String(e && e.message || e) }); }
      })();
      return true;
    }
    if (msg.type === 'ABORT_SCROLL'){ setAbort(true); sendResponse({ ok:true }); return true; }
    if (msg.type === 'GET_TOP3'){
      const arr = [...Best.values()].sort((a,b)=>b.score-a.score).slice(0,3)
        .map(t => ({ ...t, ageLabel: ageLabel(t.createdAt) }));
      sendResponse({ ok:true, data:{ scanned, top3:arr } });
      return true;
    }
  });
})();
