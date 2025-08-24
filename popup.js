(()=>{
  const $ = sel => document.querySelector(sel);
  const $$ = sel => [...document.querySelectorAll(sel)];

  const startBtn = $('#start');
  const statusEl = $('#status');
  const results = $('#results');
  const tpl = $('#tweetTemplate');
  const app = document.querySelector('.app');

  // theme toggle
  const themeToggle = $('#themeToggle');
  const savedTheme = localStorage.getItem('xsearch:theme');
  if(savedTheme){ document.documentElement.setAttribute('data-theme', savedTheme); }
  themeToggle.addEventListener('click', ()=>{
    const cur = document.documentElement.getAttribute('data-theme');
    const nxt = cur === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', nxt);
    localStorage.setItem('xsearch:theme', nxt);
  });

  const inputs = {
    q: $('#q'),
    excludeRTs: $('#excludeRTs'),
    applyAge: $('#applyAge'),
    autoScroll: $('#autoScroll'),
    pinWindow: $('#pinWindow'),
    maxAge: $('#maxAge'),
    minReplies: $('#minReplies'),
    minRetweets: $('#minRetweets'),
    minLikes: $('#minLikes'),
    pinMinutes: $('#pinMinutes'),
    limit: $('#limit')
  };

  const segs = $$('.segmented .seg');
  let mode = 'top';
  segs.forEach(b=> b.addEventListener('click', ()=>{
    segs.forEach(x=>x.setAttribute('aria-pressed','false'));
    b.setAttribute('aria-pressed','true');
    mode = b.dataset.mode || 'top';
    saveSettings();
  }));

  function attachHoverTracking(el){
    el.addEventListener('pointermove', (e)=>{
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      el.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
  }
  $$('.num input').forEach(attachHoverTracking);

  const SETTINGS_KEY='t3_settings_v1';

  // auto-fit popup height to content
  function fitHeight(){
    document.documentElement.style.height='auto';
    document.body.style.height='auto';
    const h=document.documentElement.scrollHeight;
    document.documentElement.style.height=h+'px';
    document.body.style.height=h+'px';
  }

  function validateLimit(){
    const v = parseInt(inputs.limit.value,10);
    startBtn.disabled = !(v > 0) && !running;
  }

  async function openSidePanel(){
    if(!chrome.sidePanel) return;
    try{
      const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
      if(tab){
        try{ await chrome.sidePanel.setOptions({tabId:tab.id, path:'popup.html', enabled:true}); }catch{}
        try{ await chrome.sidePanel.open({tabId:tab.id}); }catch{}
      }
    }catch{}
  }

  async function saveSettings(){
    const obj={
      q:inputs.q.value||'',
      excludeRTs:inputs.excludeRTs.checked,
      applyAge:inputs.applyAge.checked,
      autoScroll:inputs.autoScroll.checked,
      pinWindow:inputs.pinWindow.checked,
      maxAge:inputs.maxAge.value,
      minReplies:inputs.minReplies.value,
      minRetweets:inputs.minRetweets.value,
      minLikes:inputs.minLikes.value,
      pinMinutes:inputs.pinMinutes.value,
      limit:inputs.limit.value,
      mode
    };
    try{ await chrome.storage.local.set({[SETTINGS_KEY]:obj}); }catch(e){}
  }

  async function loadSettings(){
    try{
      const res = await chrome.storage.local.get(SETTINGS_KEY);
      const s = res && res[SETTINGS_KEY];
      if(s){
        inputs.q.value = s.q || '';
        inputs.excludeRTs.checked = !!s.excludeRTs;
        inputs.applyAge.checked = !!s.applyAge;
        inputs.autoScroll.checked = !!s.autoScroll;
        inputs.pinWindow.checked = !!s.pinWindow;
        inputs.maxAge.value = s.maxAge!=null?s.maxAge:5;
        inputs.minReplies.value = s.minReplies!=null?s.minReplies:0;
        inputs.minRetweets.value = s.minRetweets!=null?s.minRetweets:0;
        inputs.minLikes.value = s.minLikes!=null?s.minLikes:100;
        inputs.pinMinutes.value = s.pinMinutes!=null?s.pinMinutes:0;
        inputs.limit.value = s.limit!=null?s.limit:'';
        mode = s.mode || 'top';
        segs.forEach(x=>x.setAttribute('aria-pressed', String(x.dataset.mode===mode)));
      }
    }catch(e){}
  }
  loadSettings().then(()=>{ validateLimit(); if(inputs.pinWindow.checked) openSidePanel(); });
  fitHeight();

  Object.values(inputs).forEach(el=>{
    el.addEventListener('change', saveSettings);
    el.addEventListener('input', saveSettings);
  });
  inputs.limit.addEventListener('input', validateLimit);
  inputs.pinWindow.addEventListener('change', ()=>{ if(inputs.pinWindow.checked) openSidePanel(); });
  
  function esc(s){
    const map = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;'};
    return String(s||'').replace(/[&<>\"']/g, c=>map[c]);
  }

  function renderSkeleton(n){
    results.innerHTML='';
    for(let i=1;i<=n;i++){
      const el = tpl.content.firstElementChild.cloneNode(true);
      el.querySelector('.rank').textContent = `#${i}`;
      el.querySelector('.user').textContent = 'Loading…';
      el.querySelector('.handle').textContent = '';
      el.querySelector('.t-b p').textContent = 'Fetching…';
      attachHoverTracking(el);
      results.appendChild(el);
    }
    fitHeight();
  }

  function render(data){
    const arr = data?.top || [];
    results.innerHTML='';
    arr.forEach((t,i)=>{
      const el = tpl.content.firstElementChild.cloneNode(true);
      el.querySelector('.rank').textContent = `#${i+1}`;
      el.querySelector('.user').textContent = esc(t.authorName||'');
      el.querySelector('.handle').textContent = `@${esc(t.handle||'')} · ${esc(t.ageLabel||'')}`;
      el.querySelector('.t-b p').textContent = esc(t.text||'');
      el.querySelector('[aria-label="Replies"]').lastChild.textContent = ' '+(t.replyCount||0);
      el.querySelector('[aria-label="Retweets"]').lastChild.textContent = ' '+(t.retweetCount||0);
      el.querySelector('[aria-label="Likes"]').lastChild.textContent = ' '+(t.likeCount||0);
      el.querySelector('.score-value').textContent = (t.score||0).toLocaleString();
      const openBtn = el.querySelector('[data-action="open"]');
      openBtn.addEventListener('click', ()=>{ if(t.url) window.open(t.url,'_blank'); });
      const saveBtn = el.querySelector('[data-action="save"]');
      saveBtn.addEventListener('click', ()=>{ saveBtn.textContent='Saved ✓'; });
      attachHoverTracking(el);
      results.appendChild(el);
    });
    fitHeight();
  }

  let running=false;
  let scanned=0;
  let idleSecs=0;

  function updateStartButton(){
    startBtn.setAttribute('aria-busy', running);
    startBtn.querySelector('.txt').textContent = running ? 'Scanning…' : 'Start';
    app.classList.toggle('scanning', running);
  }

  startBtn.addEventListener('mouseenter', ()=>{ if(running) startBtn.querySelector('.txt').textContent='Stop scan'; });
  startBtn.addEventListener('mouseleave', ()=>{ if(running) startBtn.querySelector('.txt').textContent='Scanning…'; });

  startBtn.addEventListener('click', ()=>{
    if(running){ chrome.runtime.sendMessage({type:'STOP_JOB'}); return; }
    if(!(inputs.q.value||'').trim()){ statusEl.textContent='Enter a keyword to start.'; inputs.q.focus(); return; }
    const limitInput = parseInt(inputs.limit.value,10);
    if(!(limitInput>0)){ statusEl.textContent='Enter a max tweets number.'; inputs.limit.focus(); return; }
    const limit = limitInput;
    inputs.limit.value=limit;
    const payload={ type:'START_JOB', keyword:inputs.q.value.trim(),
      excludeRTs:inputs.excludeRTs.checked, mode,
      applyAge:inputs.applyAge.checked, ageDays:inputs.applyAge.checked?parseInt(inputs.maxAge.value,10)||null:null,
      minLikes:parseInt(inputs.minLikes.value,10), minRetweets:parseInt(inputs.minRetweets.value,10), minReplies:parseInt(inputs.minReplies.value,10),
      autoScroll:inputs.autoScroll.checked, pinWin:inputs.pinWindow.checked, limit };
    chrome.storage.local.set({partialTop:null});
    chrome.runtime.sendMessage(payload, ()=>{});
    scanned=0; idleSecs=0;
    statusEl.textContent = inputs.pinWindow.checked ? 'Scraping in mini window…' : 'Starting…';
    running=true; updateStartButton();
    renderSkeleton(limit);
  });

  chrome.storage.onChanged.addListener((changes, area)=>{
    if(area!=='local') return;
    if(changes.jobStatus?.newValue?.message){
      const st = changes.jobStatus.newValue.state;
      const run = ['opening','initializing','exploring','scraping','stopping'].includes(st);
      running = run; updateStartButton();
      if(running && st==='scraping'){
        statusEl.textContent = `Scanning… ${scanned} tweets (${idleSecs}s)`;
      }else{
        statusEl.textContent = changes.jobStatus.newValue.message;
      }
    }
    if(changes.partialTop?.newValue){
      const data = changes.partialTop.newValue.data || changes.partialTop.newValue;
      scanned = data.scanned || 0;
      idleSecs = data.idleFor || 0;
      if(running) statusEl.textContent = `Scanning… ${scanned} tweets (${idleSecs}s)`;
      render(data);
    }
    if(changes.lastTop?.newValue?.data){
      const data = changes.lastTop.newValue.data;
      scanned = data.scanned || 0;
      render(data);
      running=false; updateStartButton();
      statusEl.textContent = `Done. Scanned ${scanned} tweets.`;
    }
  });

  (async()=>{
    try{
      const {jobStatus,lastTop} = await chrome.storage.local.get(['jobStatus','lastTop']);
      if(lastTop?.data){ render(lastTop.data); }
      if(jobStatus){
        const st=jobStatus.state;
        statusEl.textContent=jobStatus.message||'';
        const run=['opening','initializing','exploring','scraping','stopping'].includes(st);
        running=run; updateStartButton();
      }else{
        statusEl.textContent='Ready.'; updateStartButton();
      }
    }catch(e){ statusEl.textContent='Ready.'; }
  })();

  document.addEventListener('keydown', (e)=>{ if(e.key==='Enter' && !e.metaKey && !e.ctrlKey && !startBtn.disabled){ startBtn.click(); } });
})();
