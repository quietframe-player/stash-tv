export default async function verifyMultiview(page, options) {
  const results = [], errors = [], modules = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const pass = name => results.push({name, passed:true});
  const observe = () => page.on('pageerror', error => errors.push(error.message));
  observe();
  page.on('request', request => { if (request.url().includes('/multiview.js')) modules.push(request.url()); });
  const api = async (query, variables={}) => {
    const response = await page.request.post(options.baseURL+'/graphql',{data:{query,variables}});
    const body = await response.json(); check(response.ok()&&!body.errors,JSON.stringify(body)); return body.data;
  };
  const sample = () => page.evaluate(() => [...document.querySelectorAll('#views video')].map((v,i)=>({
    id:i?v.parentElement.dataset.scene:new URL(location.href).searchParams.get('scene'),
    time:v.currentTime,duration:v.duration,paused:v.paused,seeking:v.seeking,ready:v.readyState,
    volume:v.volume,muted:v.muted,rate:v.playbackRate,source:v.currentSrc,
  })));
  const ready = count => page.waitForFunction(count => {
    const videos=[...document.querySelectorAll('#views video')];
    return videos.length===count && videos.every(v=>v.readyState>=2&&!v.seeking) &&
      document.getElementById('player').dataset.buffering==='false';
  },count,{timeout:20000});
  const playing = async count => {
    await ready(count);
    await page.waitForFunction(count => {
      const videos=[...document.querySelectorAll('#views video')];
      return videos.length===count&&videos.every(v=>!v.paused);
    },count,{timeout:5000});
    const before=await sample();
    await page.waitForFunction(before => [...document.querySelectorAll('#views video')].every((v,i)=>v.currentTime>before[i].time+0.25),before,{timeout:5000});
    check(new Set((await sample()).map(v=>v.id)).size===count,'Duplicate feeds');
  };
  const click = async selector => {
    await page.mouse.move(10,10);
    if (await page.locator(selector).evaluate(el=>el.closest('#more-panel')?.hidden)) await page.locator('#more').click();
    await page.locator(selector).click();
  };
  const paused = async count => {
    if ((await sample()).some(v=>!v.paused)) await click('#toggle');
    await page.waitForFunction(count => document.querySelectorAll('#views video').length===count&&[...document.querySelectorAll('#views video')].every(v=>v.paused),count);
  };
  const position = async (fraction,count) => {
    await page.locator('#seek').evaluate((el,f)=>{el.value=String(Number(el.max)*f);el.dispatchEvent(new Event('change',{bubbles:true}));},fraction);
    await ready(count);
    const values=await sample();
    check(values.every(v=>Math.abs(v.time-v.duration*fraction)<0.3),'Shared percentage seek: '+JSON.stringify(values));
  };
  const delta = async (key,seconds,count) => {
    const before=await sample(); await page.keyboard.press(key); await ready(count);
    await page.waitForFunction(({before,seconds})=>[...document.querySelectorAll('#views video')].every((v,i)=>Math.abs(v.currentTime-Math.max(0,Math.min(before[i].time+seconds,v.duration-0.1)))<0.35),{before,seconds},{timeout:5000});
    check((await sample()).every(v=>v.paused),'Seeking changed pause intent');
  };
  const snapshot = () => sample().then(v=>v.map(s=>s.id));
  const changed = async (old,count) => {
    await ready(count);
    const now=await snapshot(); check(now.every((id,i)=>id!==old[i]),'Navigation left an old feed: '+JSON.stringify({old,now}));
    check(new Set(now).size===count,'Navigation repeated a feed'); return now;
  };
  const layout = async count => {
    const value=await page.evaluate(()=>{
      const rect=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      const views=document.getElementById('views');
      const buttons=[...document.querySelectorAll('nav button')].filter(b=>b.getClientRects().length);
      return {root:rect(views),gap:getComputedStyle(views).gap,tiles:[...views.children].map(v=>({...rect(v),border:getComputedStyle(v).borderWidth,fit:getComputedStyle(v.querySelector('video')).objectFit})),
        buttons:buttons.map(b=>({...rect(b),id:b.id,icons:[...b.querySelectorAll('.icon')].filter(i=>getComputedStyle(i).display!=='none').map(i=>({width:i.getBoundingClientRect().width,height:i.getBoundingClientRect().height}))})),
        tileControls:document.querySelectorAll('.tile-controls,.tile-surface,.multiview-toolbar').length};
    });
    const area=value.tiles.reduce((n,t)=>n+t.width*t.height,0);
    check(value.tiles.length===count&&Math.abs(area-value.root.width*value.root.height)<1&&value.gap==='0px','Grid gaps: '+JSON.stringify(value));
    check(value.tiles.every(t=>t.border==='0px'&&t.fit==='cover'),'Grid borders or letterboxing');
    check(value.tileControls===0&&value.buttons.length===5,'Per-video controls or redundant buttons: '+JSON.stringify(value.buttons));
    check(value.buttons.every(b=>b.x>=0&&b.right<=value.root.width+0.1&&b.icons.length===1&&b.icons.every(i=>i.width===24&&i.height===24)),'Buttons overflow or icons resize: '+JSON.stringify(value.buttons));
    return value;
  };
  const filled = async count => {
    await page.waitForFunction(count=>document.querySelectorAll('#views > .view').length===count&&[...document.querySelectorAll('#views > .view')].every(v=>Number(v.style.getPropertyValue('--frame-scale'))>1.2),count,{timeout:5000});
  };
  let mobile=null, tv=null;
  try {
    await page.setViewportSize({width:1200,height:800});
    const {findScenes}=await api('{findScenes(filter:{sort:"random_17",direction:DESC,per_page:-1}){scenes{id files{path}}}}');
    const ids=findScenes.scenes.map(s=>s.id);
    check(ids.length===5&&findScenes.scenes.every(s=>s.files[0].path.startsWith('/media/sintel')),'Expected five isolated Sintel fixtures');
    for (const id of ids) await api('mutation($id:ID!){sceneSaveActivity(id:$id,resume_time:3,playDuration:0)}',{id});
    const url=options.baseURL+'/plugin/stash-tv/assets/index.html?autoplay=false&scene='+ids[0]+'&seed=17';
    await page.goto(url); await ready(1);
    check(modules.length===0,'Single view eagerly loaded grid code'); pass('single view keeps the multiview module and extra streams unloaded');
    await click('#toggle'); await click('#layout-two'); await playing(2); const two=await snapshot();
    const landscape=await layout(2); check(landscape.tiles[0].right===landscape.tiles[1].x,'Landscape split has a seam');
    pass('two independent scenes play together with one shared control bar');
    await click('#layout-four'); await playing(4); await layout(4); await filled(4);
    check((await snapshot()).slice(0,2).every((id,i)=>id===two[i]),'Expanding restarted existing feeds');
    await page.screenshot({path:options.reportDir+'/'+options.browser+'-multiview-four.png'});
    pass('four scenes fill a gap-free grid and encoded padding is cropped');
    await page.evaluate(()=>[...document.querySelectorAll('.extra-view video')].forEach(v=>v.dispatchEvent(new Event('waiting'))));
    await page.waitForFunction(()=>document.getElementById('player').dataset.buffering==='false'&&[...document.querySelectorAll('.extra-view')].every(v=>v.dataset.phase==='playing'),null,{timeout:5000});
    pass('advancing video time clears a late waiting event without another canplay event');
    await paused(4);
    check(await page.locator('#seek-videos').evaluate(button => !button.closest('#more-panel')), 'Seek videos is still inside More');
    await page.locator('#seek-videos').hover();
    check(await page.locator('#grid-seek-panel').isVisible(), 'Hover did not open independent seek controls');
    await page.locator('.grid-seek-range').nth(2).hover();
    await page.waitForTimeout(220);
    check(await page.locator('#grid-seek-panel').isVisible(), 'Hover panel closed while entering its seek controls');
    await page.mouse.move(10,10); await page.waitForTimeout(220);
    check(await page.locator('#grid-seek-panel').isHidden(), 'Hover panel did not dismiss after leaving');
    pass('dedicated seek icon opens on hover and retains the panel while using its controls');
    await click('#seek-videos');
    check(await page.locator('#grid-seek-panel').isVisible() && await page.locator('.grid-seek-range').count()===4,'Missing on-demand seek controls');
    for (const [index,fraction] of [[0,0.35],[2,0.6],[1,0.2],[2,0.3]]) {
      const before=await sample();
      await page.locator('.grid-seek-range').nth(index).evaluate((el,f)=>{el.value=String(Number(el.max)*f);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},fraction);
      await ready(4);
      const after=await sample();
      check(after.every((v,i)=>i===index?Math.abs(v.time-v.duration*fraction)<0.3:Math.abs(v.time-before[i].time)<0.05),'Individual seek moved another video: '+JSON.stringify({index,before,after}));
      check(after.every(v=>v.paused),'Individual seek changed pause intent');
    }
    await page.screenshot({path:options.reportDir+'/'+options.browser+'-multiview-seek-panel.png'});
    await page.keyboard.press('Escape');
    check(await page.locator('#grid-seek-panel').isHidden(),'Seek panel did not close');
    pass('on-demand per-video seek controls target one video and preserve the other paused positions');
    for (const [index,fraction] of [[0,0.15],[2,-0.1],[3,0.18]]) {
      const before = await sample();
      const b = await page.locator('#views > .view').nth(index).boundingBox();
      const x = b.x + b.width * 0.5, y = b.y + b.height * 0.35;
      await page.mouse.move(x,y); await page.mouse.down();
      await page.mouse.move(x + b.width * fraction,y + 1,{steps:8});
      check(await page.locator('.tile-seek-feedback').isVisible(), 'Tile scrub did not show its minimal time indicator');
      const moving = await sample();
      check(moving.every((v,i)=>Math.abs(v.time-before[i].time)<0.05), 'Tile scrub requested a seek before release');
      await page.mouse.up(); await ready(4);
      const after = await sample();
      check(after.every((v,i)=>Math.abs(v.time-(i===index?Math.max(0,Math.min(before[i].time+fraction*Math.min(120,v.duration),v.duration-0.1)):before[i].time))<0.3&&v.paused),
        'Mouse tile scrub affected the wrong video or pause intent: '+JSON.stringify({index,before,after}));
    }
    pass('mouse drags scrub the touched tile once on release without tile focus or other playback changes');
    await page.locator('#more').focus();
    await position(0.2,4); await delta('d',10,4); await delta('a',-10,4); await delta('ArrowRight',10,4); await delta('ArrowLeft',-10,4);
    pass('D/A and Left/Right seek all videos without focusing a tile');
    await delta('Shift+d',60,4); await delta('Shift+a',-60,4);
    pass('minute seeking clamps each video to its own duration');
    for (const key of ['2','6','0','9']) {
      await page.keyboard.press(key); await ready(4);
      check((await sample()).every(v=>Math.abs(v.time-v.duration*Number(key)/10)<0.3),'Number shortcut missed a video');
    }
    await position(0.25,4); await position(0.65,4); await position(0.2,4);
    pass('number shortcuts and repeated shared scrubbing seek each video by percentage');
    await click('#mute');
    await page.locator('#volume').evaluate(el=>{el.value='35';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>[...document.querySelectorAll('#views video')].every(v=>Math.abs(v.volume-0.35)<0.001&&!v.muted));
    await page.keyboard.press('Escape');
    await page.locator('#more').focus(); await page.keyboard.press('s');
    await page.waitForFunction(()=>[...document.querySelectorAll('#views video')].every(v=>Math.abs(v.volume-0.3)<0.001));
    await page.keyboard.press('w');
    await page.waitForFunction(()=>[...document.querySelectorAll('#views video')].every(v=>Math.abs(v.volume-0.35)<0.001));
    pass('one desktop slider and W/S apply the same sound setting to every video');
    await click('#toggle'); await playing(4);
    await page.locator('#surface').click({position:{x:900,y:100}}); await paused(4);
    pass('clicking any video pauses the entire grid');
    const old=await snapshot(); await click('#random'); const shuffled=await changed(old,4); await playing(4);
    await click('#previous'); await ready(4); check(JSON.stringify(await snapshot())===JSON.stringify(old),'Previous did not restore complete grid');
    await click('#next'); await ready(4); check(JSON.stringify(await snapshot())===JSON.stringify(shuffled),'Next did not restore complete grid');
    pass('random replaces every feed and Previous/Next restore whole-grid history');
    await page.locator('#more').focus(); const beforeArrow=await snapshot(); await page.keyboard.press('ArrowUp'); await changed(beforeArrow,4);
    await page.keyboard.press('ArrowDown'); await ready(4); check(JSON.stringify(await snapshot())===JSON.stringify(beforeArrow),'Down did not restore group');
    pass('Up/Down navigate the complete grid even after a control has focus');
    await page.mouse.move(500,200); const beforeWheel=await snapshot(); await page.mouse.wheel(0,400); await changed(beforeWheel,4);
    pass('desktop trackpad scrolling replaces every feed');
    await click('#layout-four'); await ready(1);
    check(await page.locator('#views video').count()===1 && await page.locator('#primary-view').evaluate(v=>!v.style.getPropertyValue('--frame-scale')),'Grid teardown left players or crop');
    await click('#layout-two'); await playing(2);
    check((await sample()).every(v=>Math.abs(v.volume-0.35)<0.001&&!v.muted),'New feed lost master audio');
    pass('layout teardown unloads extra players and re-entry inherits master audio');
    await click('#layout-two'); await ready(1);
    await page.goto('about:blank');
    for (const id of ids) await api('mutation($id:ID!){sceneSaveActivity(id:$id,resume_time:3,playDuration:0)}',{id});
    mobile=await page.context().browser().newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block',userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'});
    const desktop=page; page=await mobile.newPage(); observe();
    await page.goto(url); await ready(1); await page.locator('#toggle').tap(); await page.locator('#more').tap(); await page.locator('#layout-four').tap(); await playing(4);
    await filled(4);
    for (const width of [320,390,430]) { await page.setViewportSize({width,height:844}); await layout(4); }
    await page.setViewportSize({width:390,height:844});
    await page.locator('#mute').tap();
    await page.waitForFunction(()=>[...document.querySelectorAll('#views video')].every(v=>v.muted));
    check(await page.locator('#volume-panel').isHidden()&&await page.locator('#mute').getAttribute('aria-label')==='Unmute','Mobile opened a desktop volume popup');
    await page.locator('#mute').tap();
    await page.waitForFunction(()=>[...document.querySelectorAll('#views video')].every((v,i)=>v.muted===(i>0)));
    check(await page.locator('#volume-panel').isHidden(),'Mobile unmute opened a popup');
    await playing(4);
    pass('iPhone unmute keeps one soundtrack and all four videos playing');
    pass('portrait widths 320/390/430 keep five fixed-size controls including the dedicated seek button');
    await page.screenshot({path:options.reportDir+'/'+options.browser+'-multiview-mobile-controls.png'});
    await page.setViewportSize({width:844,height:390}); await layout(4); await page.locator('#mute').tap();
    check(await page.locator('#volume-panel').isHidden(),'Landscape phone exposed volume slider'); await page.locator('#mute').tap();
    pass('landscape touch devices also use a mute button without a slider');
    await page.setViewportSize({width:390,height:844});
    const cdp=options.browser==='chrome'?await mobile.newCDPSession(page):null;
    if (!cdp) await page.evaluate(()=>{Element.prototype.setPointerCapture=function(){};});
    const touch=async(type,x=195,y=350,target='#surface')=>{
      if(cdp) await cdp.send('Input.dispatchTouchEvent',{type:{down:'touchStart',move:'touchMove',up:'touchEnd',cancel:'touchCancel'}[type],touchPoints:['up','cancel'].includes(type)?[]:[{x,y,id:1}]});
      else await page.locator(target).dispatchEvent('pointer'+type,{pointerType:'touch',pointerId:1,isPrimary:true,clientX:x,clientY:y,bubbles:true,cancelable:true});
    };
    await touch('down'); await touch('up'); await page.waitForTimeout(400); await paused(4);
    await position(0.2,4);
    for (const fraction of [0.25,0.65,0.4]) {
      const b=await page.locator('#seek').evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.x+6,y:r.y+r.height/2,width:r.width-12,old:Number(el.value)/Number(el.max)};});
      await touch('down',b.x+b.width*b.old,b.y,'#seek');
      await touch('move',b.x+b.width*fraction,b.y,'#seek'); await touch('up',b.x+b.width*fraction,b.y,'#seek');
      await ready(4); check((await sample()).every(v=>v.paused&&Math.abs(v.time-v.duration*fraction)<0.35),'Repeated touch scrub missed a feed');
    }
    pass('repeated mobile seek drags update all paused videos');
    const beforePanel=await sample();
    await page.locator('#seek-videos').tap();
    check((await sample()).every((v,i)=>v.paused&&Math.abs(v.time-beforePanel[i].time)<0.05),'Opening seek controls triggered a video or timeline underneath');
    const single=page.locator('.grid-seek-range').nth(2);
    for(const fraction of [0.55,0.25,0.45]) {
      const before=await sample();
      const b=await single.evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.x+6,y:r.y+r.height/2,width:r.width-12,old:Number(el.value)/Number(el.max)};});
      if(!cdp) {
        await single.dispatchEvent('pointerdown',{pointerType:'touch',pointerId:1,isPrimary:true,clientX:b.x+b.width*b.old,clientY:b.y,bubbles:true,cancelable:true});
        await single.dispatchEvent('pointermove',{pointerType:'touch',pointerId:1,isPrimary:true,clientX:b.x+b.width*fraction,clientY:b.y,bubbles:true,cancelable:true});
        await single.dispatchEvent('pointerup',{pointerType:'touch',pointerId:1,isPrimary:true,clientX:b.x+b.width*fraction,clientY:b.y,bubbles:true,cancelable:true});
      } else {await touch('down',b.x+b.width*b.old,b.y);await touch('move',b.x+b.width*fraction,b.y);await touch('up',b.x+b.width*fraction,b.y);}
      await ready(4);
      const after=await sample();
      check(after.every((v,i)=>i===2?Math.abs(v.time-v.duration*fraction)<0.3:Math.abs(v.time-before[i].time)<0.05),'Mobile individual scrub affected another video');
      check(after.every(v=>v.paused),'Individual mobile scrub changed pause intent: '+JSON.stringify({fraction,before,after}));
    }
    await page.screenshot({path:options.reportDir+'/'+options.browser+'-multiview-mobile-seek-panel.png'});
    await page.locator('#grid-seek-close').tap();
    check(await page.locator('#grid-seek-panel').isHidden(),'Mobile seek panel did not close');
    check((await sample()).every(v=>v.paused),'Closing mobile seek controls changed pause intent: '+JSON.stringify(await sample()));
    pass('repeated mobile per-video scrubs work without tile focus or changing other videos');
    for (const [index,fraction] of [[1,0.2],[3,-0.15],[0,0.1],[2,-0.12]]) {
      await position(0.4,4);
      const before = await sample();
      const b = await page.locator('#views > .view').nth(index).boundingBox();
      const x = b.x+b.width*0.5, y = b.y+b.height*0.3;
      await touch('down',x,y); await touch('move',x+b.width*fraction,y+1);
      check(await page.locator('.tile-seek-feedback').isVisible(), 'Touch scrub did not show the target time');
      check((await sample()).every((v,i)=>Math.abs(v.time-before[i].time)<0.05), 'Touch scrub sought before release');
      await touch('up',x+b.width*fraction,y+1); await ready(4);
      const after = await sample();
      check(after.every((v,i)=>Math.abs(v.time-(i===index?before[i].time+fraction*Math.min(120,v.duration):before[i].time))<0.35&&v.paused),
        'Touch tile scrub affected another feed or pause intent: '+JSON.stringify({index,before,after}));
      await touch('down',x,y); await touch('move',x+b.width*0.2,y);
      await touch('cancel',x+b.width*0.2,y); await ready(4);
      check((await sample()).every((v,i)=>v.paused&&Math.abs(v.time-after[i].time)<0.05),'Cancelled touch scrub changed playback');
    }
    pass('mobile drags scrub each tile independently and cancellation leaves all positions unchanged');
    await position(0.2,4);
    await page.locator('#toggle').tap(); await playing(4); const beforeTap=await sample();
    await touch('down',335); await touch('up',335); await touch('down',335); await touch('up',335);
    await ready(4); await page.waitForTimeout(250);
    const afterTap=await sample();
    check(afterTap.every((v,i)=>!v.paused&&v.time>beforeTap[i].time+9),'Double tap left a feed behind: '+JSON.stringify({beforeTap,afterTap}));
    pass('side double taps seek every video without changing play intent');
    await touch('down'); await page.waitForFunction(()=>[...document.querySelectorAll('#views video')].every(v=>v.playbackRate===2));
    await touch('up'); await page.waitForFunction(()=>[...document.querySelectorAll('#views video')].every(v=>v.playbackRate===1));
    pass('hold-to-play 2x accelerates every video and restores all rates on release');
    const beforePlayingScrub=await sample();
    const box=await page.locator('#views > .view').nth(1).boundingBox();
    const tx=box.x+box.width*0.4,ty=box.y+box.height*0.3;
    await touch('down',tx,ty); await touch('move',tx+box.width*0.1,ty); await touch('up',tx+box.width*0.1,ty);
    await ready(4); await playing(4);
    const afterPlayingScrub=await sample();
    check(afterPlayingScrub.every((v,i)=>i===1?v.time>beforePlayingScrub[i].time+Math.min(120,v.duration)*0.1-0.35:
      v.time>=beforePlayingScrub[i].time&&v.time<beforePlayingScrub[i].time+2),'Playing tile scrub moved another feed: '+JSON.stringify({beforePlayingScrub,afterPlayingScrub}));
    pass('tile scrubbing preserves playing intent while the other feeds keep advancing');
    const sharedBar=await page.locator('#seek').evaluate(el=>{
      const b=el.getBoundingClientRect(); return {x:b.x+6,y:b.y+b.height/2,width:b.width-12};
    });
    const beforeSharedScrub=await sample();
    await touch('down',sharedBar.x+sharedBar.width*0.3,sharedBar.y,'#seek');
    await touch('move',sharedBar.x+sharedBar.width*0.4,sharedBar.y,'#seek');
    await page.waitForTimeout(700);
    check((await sample()).every((v,i)=>v.paused&&Math.abs(v.time-beforeSharedScrub[i].time)<0.2),
      'Shared scrub kept a feed playing or sought before release');
    await touch('up',sharedBar.x+sharedBar.width*0.4,sharedBar.y,'#seek');
    await playing(4);
    check((await sample()).every(v=>Math.abs(v.time-v.duration*0.4)<1.5),'Shared scrub did not restore all feeds at the target');
    pass('shared touch scrubbing pauses all four feeds and restores their playing intent');
    const beforeSwipe=await snapshot();
    await touch('down',195,550); await touch('move',195,420); await page.waitForTimeout(40);
    const offset=await page.locator('#views').evaluate(el=>new DOMMatrix(getComputedStyle(el).transform).m42);
    check(offset<-100,'Finger movement did not move the whole grid'); await touch('move',195,300); await touch('up',195,300);
    await changed(beforeSwipe,4); await playing(4);
    pass('vertical touch swipe follows the finger and replaces all feeds');
    check(await page.locator('#delete').isHidden(),'Multiview exposes single-video deletion');
    await page.locator('#more').tap(); await page.locator('#layout-two').tap(); await playing(2);
    const portrait=await layout(2); check(portrait.tiles[0].bottom===portrait.tiles[1].y,'Portrait pair has a seam');
    await page.locator('#more').tap(); await page.locator('#layout-two').tap(); await ready(1);
    await page.locator('#mute').tap(); check(await page.locator('#volume-panel').isHidden(),'Single mobile view revived volume popup');
    pass('portrait pairs have no seam and returning to single keeps mobile mute behavior');
    await page.goto('about:blank'); page=desktop;
    tv=await page.context().browser().newContext({userAgent:'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/87.0.4280.88 Large Screen Safari/537.36 SmartTV/6.0'});
    const tvPage=await tv.newPage(),tvRequests=[];
    tvPage.on('request',request=>tvRequests.push(request.url()));
    await tvPage.goto(url+'&layout=4');
    await tvPage.waitForFunction(()=>document.getElementById('player').dataset.videoReady==='true');
    check(await tvPage.locator('video').count()===1&&await tvPage.locator('#layout-two').isHidden()&&await tvPage.locator('#layout-four').isHidden(),
      'webOS entered an unsupported multi-decoder layout');
    check(await tvPage.evaluate(()=>!new URL(location.href).searchParams.has('layout'))&&!tvRequests.some(url=>url.includes('/multiview.js')),
      'webOS kept the split layout or loaded unused split code');
    pass('LG webOS split URLs recover to one stream without loading grid code or unsupported controls');
    check(errors.length===0,JSON.stringify(errors)); pass('no browser JavaScript errors');
    return {browser:options.browser,passed:true,results};
  } catch(error) {
    await page.screenshot({path:options.reportDir+'/'+options.browser+'-multiview-failure.png'}).catch(()=>{});
    return {browser:options.browser,passed:false,results,error:String(error),errors,videos:await sample().catch(()=>[])};
  } finally {if(mobile) await mobile.close();if(tv) await tv.close();}
}
