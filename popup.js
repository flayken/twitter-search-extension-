(() => {
  const $ = id => document.getElementById(id);
  const kw=$('kw'), go=$('go'), stopBtn=$('stop');
  const rt=$('rt'), ageD=$('ageD'), ageApply=$('ageApply'), autoScroll=$('autoScroll'), pinWin=$('pinWin'), mode=$('mode');
  const minF=$('minF'), minR=$('minR'), minC=$('minC');
  const statusEl=$('status'), results=$('results');
  const SETTINGS_KEY='t3_settings_v1';

  function updateStartEnabled(){ go.disabled = !((kw.value||'').trim()); }
  kw.addEventListener('input', updateStartEnabled);

  async function saveSettings(){
    const obj={ excludeRTs:rt.checked, ageApply:ageApply.checked, ageDays:ageD.value,
                autoScroll:autoScroll.checked, pinWin:pinWin.checked, mode:mode.value,
                minLikes:minF.value, minRetweets:minR.value, minReplies:minC.value };
    try{ await chrome.storage.local.set({[SETTINGS_KEY]:obj}); }catch(e){}
  }
  async function loadSettings(){
    try{
      const res=await chrome.storage.local.get(SETTINGS_KEY); const s=res && res[SETTINGS_KEY];
      if(s){
        if(typeof s.excludeRTs==='boolean') rt.checked=s.excludeRTs;
        if(typeof s.ageApply==='boolean') ageApply.checked=s.ageApply;
        if(s.ageDays!=null) ageD.value=s.ageDays;
        if(typeof s.autoScroll==='boolean') autoScroll.checked=s.autoScroll;
        if(typeof s.pinWin==='boolean') pinWin.checked=s.pinWin;
        if(s.mode) mode.value=s.mode;
        if(s.minLikes!=null) minF.value=s.minLikes;
        if(s.minRetweets!=null) minR.value=s.minRetweets;
        if(s.minReplies!=null) minC.value=s.minReplies;
      }
    }catch(e){}
    updateStartEnabled();
  }
  loadSettings();
  [rt, ageApply, ageD, autoScroll, pinWin, mode, minF, minR, minC].forEach(el=>{
    el.addEventListener('change', saveSettings); el.addEventListener('input', saveSettings);
  });

  function escapeHtml(s){
    return (s||'').replace(/[&<>\"']/g, (c)=>({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;', \"'\":'&#39;' }[c]));
  }

  function render(payload){
    const data=payload?.data || payload; if(!data) return;
    results.innerHTML='';
    (data.top3||[]).forEach((t,i)=>{
      const div=document.createElement('div'); div.className='item';
      div.innerHTML=`
        <div class="h_item">
          <div class="rank">#${i+1}</div>
          <div class="ellip"><b>${escapeHtml(t.authorName||'')}</b> <span class="muted">@${escapeHtml(t.handle||'')}</span></div>
          <span class="muted">${escapeHtml(t.ageLabel||'')}</span>
          <a href="${t.url||'#'}" target="_blank" style="margin-left:auto">View</a>
        </div>
        <div class="txt">${escapeHtml(t.text||'')}</div>
        <div class="metaRow">
          <span>❤ ${t.likeCount||0}</span>
          <span>🔁 ${t.retweetCount||0}</span>
          <span>💬 ${t.replyCount||0}</span>
          <span>🔖 ${t.bookmarkCount||0}</span>
          <span style="margin-left:auto">Score: ${t.score||0}</span>
        </div>`;
      results.appendChild(div);
    });
    if(typeof data.scanned==='number'){ statusEl.textContent=`Scanning… LIVE — ${data.scanned} tweets seen`; }
  }

  go.addEventListener('click', async()=>{
    if(!((kw.value||'').trim())){ statusEl.textContent='Please enter a keyword.'; return; }
    const payload={ type:'START_JOB', keyword:(kw.value||'').trim(),
      excludeRTs:rt.checked, mode:mode.value,
      applyAge:ageApply.checked, ageDays:ageApply.checked ? (parseInt(ageD.value,10)||null):null,
      minLikes:parseInt(minF.value,10), minRetweets:parseInt(minR.value,10), minReplies:parseInt(minC.value,10),
      autoScroll:autoScroll.checked, pinWin:pinWin.checked
    };
    statusEl.textContent = pinWin.checked ? 'Scraping in mini window…' : 'Starting…';
    try{ await chrome.storage.local.set({partialTop3:null}); }catch(e){}
    chrome.runtime.sendMessage(payload, ()=>{});
    go.style.display='none'; stopBtn.style.display='inline-block';
  });
  stopBtn.addEventListener('click', ()=>{ chrome.runtime.sendMessage({type:'STOP_JOB'}); });

  chrome.storage.onChanged.addListener((changes, area)=>{
    if(area!=='local') return;
    if(changes.jobStatus?.newValue?.message){
      statusEl.textContent=changes.jobStatus.newValue.message;
      const st=changes.jobStatus.newValue.state;
      const running=['opening','initializing','exploring','scraping','stopping'].includes(st);
      go.style.display=running?'none':'inline-block';
      stopBtn.style.display=running?'inline-block':'none';
    }
    if(changes.partialTop3?.newValue){
      render(changes.partialTop3.newValue);
    }
    if(changes.lastTop3?.newValue?.data){
      render(changes.lastTop3.newValue.data);
      statusEl.textContent=`Done. Scanned ${changes.lastTop3.newValue.data?.scanned ?? ''} tweets.`;
      go.style.display='inline-block'; stopBtn.style.display='none';
    }
  });

  (async()=>{
    try{
      const {jobStatus,lastTop3}=await chrome.storage.local.get(['jobStatus','lastTop3']);
      if(lastTop3?.data){ render(lastTop3.data); }
      if(!jobStatus){ statusEl.textContent='Ready.'; updateStartEnabled(); return; }
      const st=jobStatus.state;
      statusEl.textContent=jobStatus.message||st||'Ready.';
      const running=['opening','initializing','exploring','scraping','stopping'].includes(st);
      go.style.display=running?'none':'inline-block';
      stopBtn.style.display=running?'inline-block':'none';
    }catch(e){ statusEl.textContent='Ready.'; }
    updateStartEnabled();
  })();
})();
