(function(){
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  function pingable(){ return true; }



  function abbreviateParse(s){
    if(!s) return 0; s=String(s).trim();
    if(/^\d{1,3}(,\d{3})+$/.test(s)) return Number(s.replace(/,/g,''));
    const m = s.toLowerCase().match(/([\d.]+)\s*([kmb])?/);
    if(!m) return Number(s)||0;
    let v=parseFloat(m[1]); const u=m[2];
    if(u==='k') v*=1e3; else if(u==='m') v*=1e6; else if(u==='b') v*=1e9;
    return Math.round(v);
  }

  function extractTweet(article){
    try{
      const link = article.querySelector('a[href*="/status/"]');
      const href = link ? link.getAttribute('href') : null;
      const url = href ? (href.startsWith('http') ? href : ("https://x.com"+href)) : "";
      const name = article.querySelector('[data-testid="User-Name"]');
      let authorName="", handle="";
      if(name){
        const spans = Array.from(name.querySelectorAll('span')).map(s=>s.textContent||'').filter(Boolean);
        const h = spans.find(t=>t.trim().startsWith('@'));
        handle = (h||'').replace(/^@/, '');
        authorName = spans.find(t=>t && t[0]!=='@' && t!=='·') || "";
      }
      const textNode = article.querySelector('[data-testid="tweetText"]') || article;
      const text = (textNode.textContent||'').trim();
      const toolbar = article.querySelector('[role="group"]') || article;
      const replyCount = getCount(toolbar,['reply']);
      const retweetCount = getCount(toolbar,['retweet','unretweet']);
      const likeCount = getCount(toolbar,['like','unlike']);
      const bookmarkCount = getCount(toolbar,['bookmark','unbookmark']);
      let quoteCount = 0;
      const aria = toolbar.getAttribute('aria-label')||'';
      const qm = aria.match(/(\d[\d.,]*\s*[kmbKMB]?)\s+Quote/i);
      if(qm) quoteCount = abbreviateParse(qm[1]);
      const timeEl = article.querySelector('time');
      const createdAt = timeEl ? (timeEl.getAttribute('datetime')||'') : '';
      return { id:url||Math.random().toString(36).slice(2), authorName:authorName||handle||"", handle:handle||"", text, url,
        likeCount, retweetCount, replyCount, quoteCount, bookmarkCount, createdAt };
    }catch(e){ return null; }
  }

  function getCount(root, ids){
    for(const id of ids){
      const el = root.querySelector(`[data-testid="${id}"]`);
      if(!el) continue;
      const span = el.querySelector('span');
      if(span && span.textContent) {
        const v = abbreviateParse(span.textContent);
        if(!Number.isNaN(v)) return v;
      }
      const btn = el.closest('button')||el;
      const aria = btn.getAttribute('aria-label');
      if(aria){
        const m = aria.match(/([\d.,]+|[\d.]+\s*[kmbKMB])\s+(Like|Likes|Retweet|Retweets|Reply|Replies)/i);
        if(m) return abbreviateParse(m[1]);
      }
    }
    return 0;
  }

  function ageLabel(iso){
    if(!iso) return "";
    const ts = Date.parse(iso);
    if(Number.isNaN(ts)) return "";
    const s = Math.max(0, Math.floor((Date.now()-ts)/1000));
    if(s<60) return `${s}s`;
    const m=Math.floor(s/60); if(m<60) return `${m}m`;
    const h=Math.floor(m/60); if(h<24) return `${h}h`;
    const d=Math.floor(h/24); return `${d}d`;
  }

  const state = { map:new Map(), scanned:0, lastEmit:0, lastNewAt:Date.now() };
  let topLimit = 3;

  function ingest(art, filters){
    const t = extractTweet(art);
    if(!t || !t.url) return;
    if(filters.ageSeconds && t.createdAt){
      const ts = Date.parse(t.createdAt);
      if(!Number.isNaN(ts)){
        const age=Math.floor((Date.now()-ts)/1000);
        if(age>filters.ageSeconds) return;
      }
    }
    if(filters.minFaves && t.likeCount < filters.minFaves) return;
    if(filters.minRetweets && t.retweetCount < filters.minRetweets) return;
    if(filters.minReplies && t.replyCount < filters.minReplies) return;

    const prev = state.map.get(t.url);
    if(prev){
      prev.likeCount = Math.max(prev.likeCount, t.likeCount);
      prev.retweetCount = Math.max(prev.retweetCount, t.retweetCount);
      prev.replyCount = Math.max(prev.replyCount, t.replyCount);
      prev.quoteCount = Math.max(prev.quoteCount, t.quoteCount);
      prev.bookmarkCount = Math.max(prev.bookmarkCount, t.bookmarkCount);
      prev.createdAt = prev.createdAt || t.createdAt;
    }else{
      state.map.set(t.url, {...t});
      state.scanned++;
      state.lastNewAt = Date.now();
    }
  }

  function score(t){ return t.likeCount + 2*t.retweetCount + t.replyCount + t.quoteCount + t.bookmarkCount; }

  function emitPartial(){
    const items = Array.from(state.map.values()).map(x=>({...x, score:score(x), ageLabel:ageLabel(x.createdAt)}));
    items.sort((a,b)=>b.score-a.score);
    const top = items.slice(0,topLimit);
    const idleFor = Math.floor((Date.now() - state.lastNewAt) / 1000);
    chrome.storage.local.set({partialTop:{timestamp:Date.now(), data:{top, scanned:state.scanned, idleFor}}});
  }

  async function loop(filters){
    let lastEmit=0;
    while(!window.__t3_abort){
      const arts = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
      for(const a of arts) ingest(a, filters);
      const now=Date.now();
      if(now-lastEmit>1000){ emitPartial(); lastEmit=now; }
      await sleep(500);
    }
    emitPartial();
    const items = Array.from(state.map.values()).map(x=>({...x,score:score(x),ageLabel:ageLabel(x.createdAt)})).sort((a,b)=>b.score-a.score).slice(0,topLimit);
    return {top:items, scanned:state.scanned};
  }

  async function scroller(auto, maxIdleMs){
    if(!auto) return;
    const speed = 225; // pixels per second, approx same average speed as before
    let prevCount = document.querySelectorAll('article[data-testid="tweet"]').length;
    state.lastNewAt = Date.now();
    let lastTick = performance.now();
    while(!window.__t3_abort){
      const now = performance.now();
      const dt = now - lastTick; // ms since last frame
      lastTick = now;
      const dist = speed * dt / 1000;
      window.scrollBy({top:dist, left:0});
      await sleep(16);
      const c = document.querySelectorAll('article[data-testid="tweet"]').length;
      if(c>prevCount){ prevCount=c; state.lastNewAt=Date.now(); }
      if(maxIdleMs>0 && (Date.now()-state.lastNewAt)>=maxIdleMs){
        window.__t3_abort=true;
        break;
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse)=>{
    if(msg?.type==='PING'){ sendResponse({ok:true}); return true; }
    if(msg?.type==='SCROLL_AND_SCRAPE'){
      (async()=>{
        try{
          window.__t3_abort=false;
          const o = msg.options||{};
          const filters = {
            ageSeconds: o.ageSeconds||null,
            minFaves: o.minFaves||null,
            minRetweets: o.minRetweets||null,
            minReplies: o.minReplies||null
          };
          topLimit = o.limit || 3;
          state.map.clear(); state.scanned=0;
          emitPartial();
          await Promise.race([
            loop(filters),
            scroller(o.autoScroll!==false, o.maxIdleMs||30000)
          ]).catch(()=>{});
          emitPartial();
          const items = Array.from(state.map.values()).map(x=>({...x, score:score(x), ageLabel:ageLabel(x.createdAt)})).sort((a,b)=>b.score-a.score).slice(0,topLimit);
          sendResponse({ok:true, data:{top:items, scanned:state.scanned}});
        }catch(e){ sendResponse({ok:false, error:String(e&&e.message||e)}); }
      })();
      return true;
    }
    if(msg?.type==='GET_TOP'){
      const items = Array.from(state.map.values()).map(x=>({...x,score:score(x),ageLabel:ageLabel(x.createdAt)})).sort((a,b)=>b.score-a.score).slice(0,topLimit);
      sendResponse({ok:true, data:{top:items, scanned:state.scanned}});
      return true;
    }
    if(msg?.type==='ABORT_SCROLL'){
      window.__t3_abort=true; sendResponse({ok:true}); return true;
    }
  });
})();
