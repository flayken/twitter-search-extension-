/* v37 background orchestrator */
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

let currentJobTabId = null;
let searchTabId = null;
let pinnedWinId = null;

async function updateStatus(obj){ try{ await chrome.storage.local.set({jobStatus: obj}); }catch{} }

function ymd(d){ const y=d.getUTCFullYear(); const m=String(d.getUTCMonth()+1).padStart(2,'0'); const day=String(d.getUTCDate()).padStart(2,'0'); return `${y}-${m}-${day}`; }

function buildSearchUrl(p){
  const parts=[];
  if (p.keyword) parts.push(p.keyword);
  if (p.applyAge!==false && typeof p.ageDays==='number' && p.ageDays>0){
    const now=new Date();
    const since=new Date(now.getTime()-p.ageDays*86400*1000);
    const until=new Date(now.getTime()+86400*1000);
    parts.push(`since:${ymd(since)}`); parts.push(`until:${ymd(until)}`);
  }
  if (p.excludeRTs!==false) parts.push('-filter:retweets');
  if (Number.isFinite(p.minLikes) && p.minLikes>0) parts.push(`min_faves:${Math.round(p.minLikes)}`);
  if (Number.isFinite(p.minRetweets) && p.minRetweets>0) parts.push(`min_retweets:${Math.round(p.minRetweets)}`);
  if (Number.isFinite(p.minReplies) && p.minReplies>0) parts.push(`min_replies:${Math.round(p.minReplies)}`);
  const q = encodeURIComponent(parts.join(' ').replace(/\s+/g,' ').trim());
  const live = (p.mode==='latest') ? '&f=live' : '';
  return `https://x.com/search?q=${q}${live}`;
}

async function waitForTabComplete(tabId, timeout=120000){
  const start=Date.now();
  return await new Promise((resolve)=>{
    const listener = (id, info) => { if (id===tabId && info.status==='complete') { try{chrome.tabs.onUpdated.removeListener(listener);}catch{} resolve(true);} };
    chrome.tabs.onUpdated.addListener(listener);
    const t = setInterval(()=>{
      if (Date.now()-start>timeout){
        try{chrome.tabs.onUpdated.removeListener(listener);}catch{} clearInterval(t); resolve(false);
      }
    }, 500);
  });
}

async function waitForContentReady(tabId, timeout=30000){
  const start=Date.now();
  while(Date.now()-start<timeout){
    try{ const resp=await chrome.tabs.sendMessage(tabId,{type:'PING'}); if (resp&&resp.ok) return true; }catch{}
    await sleep(350);
  }
  return false;
}

async function openMini(url){
  const win = await chrome.windows.create({url, type:'popup', width:460, height:720, focused:true});
  pinnedWinId = win.id;
  const [tab] = await chrome.tabs.query({windowId: win.id, active: true});
  return tab;
}

async function runJob(payload){
  try{
    if (!payload || !payload.keyword || !payload.keyword.trim()){
      await updateStatus({state:'error', message:'Enter a keyword to search.'}); return;
    }

    // Close prior search tab we own
    if (searchTabId){ try{ await chrome.tabs.remove(searchTabId); }catch{} searchTabId=null; }

    const url = buildSearchUrl(payload);
    let tab;
    if (payload.pinWin){
      tab = await openMini(url);
    } else {
      const [active] = await chrome.tabs.query({active:true, lastFocusedWindow:true});
      tab = await chrome.tabs.create({ url, active:true, index: (active && active.index!=null) ? active.index+1 : undefined });
    }
    const tabId = tab.id;
    currentJobTabId = tabId; searchTabId = tabId;
    await updateStatus({state:'opening', tabId, message:'Opening X…'});
    await waitForTabComplete(tabId, 120000);

    await updateStatus({state:'initializing', tabId, message:'Preparing page…'});
    const ready = await waitForContentReady(tabId, 30000);
    if (!ready){ await updateStatus({state:'error', tabId, message:'Content script not ready.'}); return; }

    await updateStatus({state:'scraping', tabId, message: payload.pinWin ? 'Scraping in mini window…' : 'Scanning…'});

    const opts = {
      excludeRTs: payload.excludeRTs!==false,
      ageSeconds: (payload.applyAge!==false && typeof payload.ageDays==='number' && payload.ageDays>0) ? Math.round(payload.ageDays*86400) : null,
      minLikes: (typeof payload.minLikes==='number' && payload.minLikes>0) ? Math.round(payload.minLikes) : null,
      minRetweets: (typeof payload.minRetweets==='number' && payload.minRetweets>0) ? Math.round(payload.minRetweets) : null,
      minReplies: (typeof payload.minReplies==='number' && payload.minReplies>0) ? Math.round(payload.minReplies) : null,
      maxIdleMs: payload.autoScroll ? 20000 : 0, // 20s idle stop when auto-scroll is ON
      autoScroll: payload.autoScroll !== false,
      keepAlive: !!payload.pinWin
    };

    // fire and wait for completion in auto mode; in manual mode we leave it running until STOP
    if (opts.autoScroll){
      let resp=null;
      try{ resp = await chrome.tabs.sendMessage(tabId,{type:'SCROLL_AND_SCRAPE', options: opts}); }catch{}
      if (!resp || resp.ok===false){ await updateStatus({state:'error', tabId, message:'Scrape failed (page not ready).'}); return; }
      const data = resp.data || {};
      try{ await chrome.storage.local.set({lastTop3:{timestamp: Date.now(), data}}); }catch{}
      await updateStatus({state:'done', tabId, message:`Done. Scanned ${data.scanned ?? 0} tweets.`});
      try{
        await chrome.notifications.create({
          type:'basic',
          iconUrl: 'icons/icon128.png',
          title:'Top 3 Tweets',
          message:`Finished "${payload.keyword}" • scanned ${data.scanned ?? 0} tweets`
        });
      }catch{}
    } else {
      try{ chrome.tabs.sendMessage(tabId,{type:'SCROLL_AND_SCRAPE', options: opts}); }catch{}
      await updateStatus({state:'scraping', tabId, message:'Manual mode: scroll the page; press Stop to finish.'});
    }
  }catch(e){
    await updateStatus({state:'error', message:String(e)});
  }
}

async function stopJob(){
  try{
    const tabId = searchTabId || currentJobTabId;
    await updateStatus({state:'stopping', tabId, message:'Stopping…'});
    if (tabId){
      try{ await chrome.tabs.sendMessage(tabId,{type:'ABORT_SCROLL'});}catch{}
      try{
        const resp = await chrome.tabs.sendMessage(tabId,{type:'GET_TOP3'});
        if (resp && resp.ok){
          const data = resp.data || {};
          try{ await chrome.storage.local.set({lastTop3:{timestamp: Date.now(), data}}); }catch{}
          await updateStatus({state:'done', tabId, message:`Done. Scanned ${data.scanned ?? 0} tweets.`});
          return;
        }
      }catch{}
    }
    await updateStatus({state:'done', tabId, message:'Stopped.'});
  }catch(e){
    await updateStatus({state:'error', message:String(e)});
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse)=>{
  try{
    if (msg?.type==='START_JOB'){ runJob(msg); sendResponse({ok:true}); return true; }
    if (msg?.type==='STOP_JOB'){ stopJob(); sendResponse({ok:true}); return true; }
  }catch(e){ try{ sendResponse({ok:false, error:String(e)});}catch{} return true; }
});

updateStatus({state:'ready', message:'Ready.'});
