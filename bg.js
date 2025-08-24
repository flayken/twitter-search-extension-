(function(){
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  let currentTabId=null, searchTabId=null, miniWinId=null;

  async function setStatus(obj){ try{ await chrome.storage.local.set({jobStatus:obj}); }catch{} }
  function ymd(d){ const y=d.getUTCFullYear(); const m=String(d.getUTCMonth()+1).padStart(2,'0'); const da=String(d.getUTCDate()).padStart(2,'0'); return `${y}-${m}-${da}`; }

  function buildUrl(p){
    const parts=[];
    if(p.keyword) parts.push(p.keyword);
    if(p.applyAge!==false && Number.isFinite(p.ageDays) && p.ageDays>0){
      const now=new Date();
      const since=new Date(now.getTime()-p.ageDays*86400*1000);
      const until=new Date(now.getTime()+86400*1000);
      parts.push(`since:${ymd(since)}`); parts.push(`until:${ymd(until)}`);
    }
    if(p.excludeRTs!==false) parts.push('-filter:retweets');
    if(Number.isFinite(p.minLikes) && p.minLikes>0) parts.push(`min_faves:${Math.round(p.minLikes)}`);
    if(Number.isFinite(p.minRetweets) && p.minRetweets>0) parts.push(`min_retweets:${Math.round(p.minRetweets)}`);
    if(Number.isFinite(p.minReplies) && p.minReplies>0) parts.push(`min_replies:${Math.round(p.minReplies)}`);
    const q = encodeURIComponent(parts.join(' ').replace(/\s+/g,' ').trim());
    const live=(p.mode==='latest') ? '&f=live' : '';
    return `https://x.com/search?q=${q}${live}`;
  }

  async function waitReady(tabId, timeout=30000){
    const start=Date.now();
    while(Date.now()-start<timeout){
      try{ const r=await chrome.tabs.sendMessage(tabId,{type:"PING"}); if(r&&r.ok) return true; }catch{}
      await sleep(300);
    }
    return false;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse)=>{
    if(msg?.type==='START_JOB'){ (async()=>{ await startJob(msg); sendResponse({ok:true}); })(); return true; }
    if(msg?.type==='STOP_JOB'){ (async()=>{ await stopJob(); sendResponse({ok:true}); })(); return true; }
  });

  async function openMini(url){
    if(miniWinId){ try{ await chrome.windows.remove(miniWinId);}catch{} miniWinId=null; }
    const win = await chrome.windows.create({url, type:'popup', width:430, height:760, focused:true});
    miniWinId = win.id;
    return (await chrome.tabs.query({windowId:miniWinId}))[0].id;
  }

  async function startJob(payload){
    if(!payload.keyword || !payload.keyword.trim()){ await setStatus({state:'error', message:'Enter a keyword.'}); return; }
    const url = buildUrl(payload);

    if(searchTabId){ try{ await chrome.tabs.remove(searchTabId);}catch{} searchTabId=null; }

    let tabId;
    if(payload.pinWin){
      tabId = await openMini(url);
    } else {
      const tabs = await chrome.tabs.query({active:true,lastFocusedWindow:true});
      const base = tabs && tabs[0];
      const tab = await chrome.tabs.create({url, active:true, index: (base && base.index!=null) ? base.index+1 : undefined});
      tabId = tab.id;
    }
    currentTabId = tabId; searchTabId = tabId;
    await setStatus({state:'opening', tabId, message: payload.pinWin?'Opening mini window…':'Opening X…'});

    await sleep(1000);
    const ready = await waitReady(tabId, 30000);
    if(!ready){ await setStatus({state:'error', tabId, message:'Could not initialize on X.'}); return; }
    await setStatus({state:'scraping', tabId, message: payload.autoScroll ? 'Scanning…' : 'Manual mode: scroll the page; press Stop to finish.'});

    try{
      const resp = await chrome.tabs.sendMessage(tabId, {type:"SCROLL_AND_SCRAPE", options:{
        excludeRTs: payload.excludeRTs!==false,
        ageSeconds: (payload.applyAge!==false && Number.isFinite(payload.ageDays)) ? Math.round(payload.ageDays*86400) : null,
        minFaves: Number.isFinite(payload.minLikes)?payload.minLikes:null,
        minRetweets: Number.isFinite(payload.minRetweets)?payload.minRetweets:null,
        minReplies: Number.isFinite(payload.minReplies)?payload.minReplies:null,
        autoScroll: payload.autoScroll!==false,
        maxIdleMs: payload.autoScroll!==false ? 15000 : 0,
        limit: payload.limit||3
      }});
      if(resp && resp.data){
        try{ await chrome.storage.local.set({lastTop:{timestamp:Date.now(), data:resp.data}});}catch{}
        await setStatus({state:'done', tabId, message:`Done. Scanned ${resp.data.scanned||0} tweets.`});
      }else{
        await setStatus({state:'done', tabId, message:'Stopped.'});
      }
    }catch(e){
      await setStatus({state:'error', tabId, message:'Scrape start failed.'});
    }
  }

  async function stopJob(){
    const tabId = searchTabId || currentTabId;
    await setStatus({state:'stopping', tabId, message:'Stopping…'});
    if(tabId){
      try{ await chrome.tabs.sendMessage(tabId,{type:'ABORT_SCROLL'}); }catch{}
      try{
        const resp = await chrome.tabs.sendMessage(tabId,{type:'GET_TOP'});
        if(resp && resp.data){
          try{ await chrome.storage.local.set({lastTop:{timestamp:Date.now(), data:resp.data}});}catch{}
          await setStatus({state:'done', tabId, message:`Done. Scanned ${resp.data.scanned||0} tweets.`});
          return;
        }
      }catch{}
    }
    await setStatus({state:'done', tabId, message:'Stopped.'});
  }
})();
