export default async function verifyMobile(page, options) {
  const results = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const context = await page.context().browser().newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.mobileEvents = [];
    window.bufferEvents = [];
    document.addEventListener('stash-tv-buffer', event => window.bufferEvents.push(event.detail), true);
    const record = (type, extra = {}) => {
      const video = document.querySelector('#video');
      window.mobileEvents.push({ type, wall:performance.now(), time:video?.currentTime,
        paused:video?.paused, seeking:video?.seeking, ready:video?.readyState,
        phase:document.querySelector('#player')?.dataset.phase, ...extra });
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(...args) {
      record('play-call');
      const result = play.apply(this,args);
      result.then(() => record('play-resolved'),error => record('play-rejected', {name:error.name,message:error.message}));
      return result;
    };
    for (const type of ['pointerdown','pointerup','pointercancel','lostpointercapture','input','change','click'])
      document.addEventListener(type,e=>record(type,{target:e.target.id,trusted:e.isTrusted,primary:e.isPrimary,value:e.target.value}),true);
    for (const type of ['playing','pause','seeking','seeked','waiting','error','ratechange'])
      document.addEventListener(type,()=>record(type,{rate:document.querySelector('#video')?.playbackRate}),true);
    document.addEventListener('transitionrun',e=>record('transitionrun',{
      target:e.target.id, property:e.propertyName,
    }),true);
    document.addEventListener('keydown',e=>queueMicrotask(()=>record('keydown',{
      key:e.key, reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
      swipe:document.querySelector('#player')?.dataset.swipePhase,
      outgoing:document.querySelector('#swipe-outgoing')?.style.transform,
      transition:document.querySelector('#swipe-outgoing') && getComputedStyle(document.querySelector('#swipe-outgoing')).transitionProperty,
    })));
  });
  const api = async (query, variables = {}) => {
    const response = await page.request.post(options.baseURL + '/graphql', { data: { query, variables } });
    const body = await response.json();
    check(response.ok() && !body.errors, JSON.stringify(body));
    return body.data;
  };
    const ready = () => page.waitForFunction(() => {
      const player = document.querySelector('#player');
      return ['ready', 'paused', 'playing'].includes(player.dataset.phase) &&
        player.dataset.buffering === 'false' && !document.querySelector('#video').seeking;
    });
    const settled = () => page.waitForFunction(() => !document.querySelector('#player').dataset.swipePhase);
  try {
    const { findScenes } = await api('{findScenes{scenes{id files{path}}}}');
    check(findScenes.scenes.length === 2 && findScenes.scenes.every(s => s.files[0].path.startsWith('/media/sintel')), 'Expected isolated mobile fixtures');
    await api('mutation($input:Map!){configurePlugin(plugin_id:"stash-tv",input:$input)}', { input: { enableDelete: true } });
    await page.goto(options.baseURL + '/plugin/stash-tv/assets/index.html?autoplay=false&seed=1');
    await ready();
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      const layout = await page.evaluate(() => {
        const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, right:r.right, bottom:r.bottom }; };
        return { seek:rect('seek'), buttons:['previous','toggle','next','random','zoom','mute','delete','fullscreen'].map(rect), viewport:innerWidth,
          icons:[...document.querySelectorAll('nav .icon')].filter(el=>el.getClientRects().length).map(el=>el.getBoundingClientRect().width) };
      });
      check(layout.seek.width >= width * 0.4, 'Portrait seek bar collapsed: ' + JSON.stringify(layout));
      check(layout.buttons.every(b => b.x >= 0 && b.right <= width && b.bottom <= 844), 'Portrait control overflow: ' + JSON.stringify(layout));
      check(layout.buttons.every((b,i,all) => all.every((c,j) => i === j || b.right <= c.x || c.right <= b.x || b.bottom <= c.y || c.bottom <= b.y)), 'Overlapping controls');
      check(layout.icons.every(width=>width===24),'Mobile controls changed icon sizes: '+JSON.stringify(layout.icons));
      await page.screenshot({ path: options.reportDir + '/' + options.browser + '-portrait-' + width + '.png' });
      results.push({ name:'portrait layout ' + width, passed:true });
    }
    await page.setViewportSize({ width:390, height:844 });
    const sample = () => page.evaluate(() => {
      const v = document.querySelector('#video');
      const player = document.querySelector('#player');
      return { time:v.currentTime, paused:v.paused, rate:v.playbackRate,
        phase:player.dataset.phase, buffering:player.dataset.buffering,
        scene:new URL(location.href).searchParams.get('scene') };
    });
    const tap = (x=195,y=350) => page.touchscreen.tap(x,y);
    const position = async seconds => {
      await page.locator('#seek').evaluate((el, value) => { el.value=String(value); el.dispatchEvent(new Event('change', {bubbles:true})); }, seconds);
      await ready();
    };
    const cdp = options.browser === 'chrome' ? await context.newCDPSession(page) : null;
    if (cdp) await cdp.send('Network.setCacheDisabled', {cacheDisabled:true});
    if (!cdp) await page.evaluate(() => {
      // WebKit's automation interface exposes taps but no held touch sequence.
      window.originalCapture = Element.prototype.setPointerCapture;
      Element.prototype.setPointerCapture = function() {};
    });
    const touch = async (type,x=195,y=350,target='#surface') => {
      if(cdp) await cdp.send('Input.dispatchTouchEvent', {
        type:{down:'touchStart',move:'touchMove',up:'touchEnd',cancel:'touchCancel'}[type],
        touchPoints:['up','cancel'].includes(type)?[]:[{x,y,id:1}],
      });
      else await page.locator(target).dispatchEvent('pointer'+type, {
        pointerType:'touch',pointerId:1,isPrimary:true,clientX:x,clientY:y,bubbles:true,cancelable:true,
      });
    };
    const dragSeek = async fraction => {
      const bar = await page.locator('#seek').evaluate(el => {
        const r=el.getBoundingClientRect();
        return {x:r.x+6,y:r.y+r.height/2,width:r.width-12,value:Number(el.value)/Number(el.max),max:Number(el.max)};
      });
      const start=bar.x+bar.width*bar.value, end=bar.x+bar.width*fraction;
      await touch('down',start,bar.y,'#seek');
      for(let step=1;step<=5;step++) {
        await touch('move',start+(end-start)*step/5,bar.y,'#seek');
        await page.waitForTimeout(30);
      }
      await touch('up',end,bar.y,'#seek');
      await ready();
      const after=await sample();
      check(Math.abs(after.time-bar.max*fraction)<1.5,'Touch seek drag did not commit: '+JSON.stringify({fraction,bar,after}));
      return after;
    };
    await tap();
    await page.waitForFunction(() => !document.querySelector('#video').paused);
    await page.waitForTimeout(450);
    await position(20);
    let before = await sample();
    await tap(335); await tap(335);
    check(await page.locator('#seek-feedback').isVisible() &&
      await page.locator('#seek-feedback').getAttribute('data-side') === 'forward', 'Missing forward seek feedback');
    check(await page.locator('#seek-preview').isHidden(),'Double tap opened a scrub preview');
    await page.screenshot({path:options.reportDir+'/'+options.browser+'-seek-forward.png'});
    await page.waitForTimeout(650);
    let after = await sample();
    check(!after.paused && after.time >= before.time+9 && after.time <= before.time+12, 'Right double tap: '+JSON.stringify({before,after}));
    check(!await page.evaluate(() => !!document.fullscreenElement), 'Touch double tap entered fullscreen');
    results.push({name:'trusted double tap seeks forward without pausing or fullscreen',passed:true});
    await page.waitForTimeout(100);
    await position(5);
    before=await sample();
    await tap(335); await tap(335); await tap(335);
    check(await page.locator('#seek-feedback-time').textContent()==='20 seconds','Repeated taps did not accumulate seek feedback');
    await page.waitForTimeout(450);
    after=await sample();
    check(!after.paused && Math.abs(after.time-before.time-20)<2,'Repeated tap sequence did not seek by 20 seconds');
    await page.waitForTimeout(250);
    check(await page.locator('#seek-feedback').isHidden(),'Seek feedback did not clear');
    results.push({name:'directional ripple and repeated taps accumulate seek seconds',passed:true});
    before = after;
    await tap(45); await tap(45);
    check(await page.locator('#seek-feedback').getAttribute('data-side')==='backward','Missing backward seek feedback');
    await page.screenshot({path:options.reportDir+'/'+options.browser+'-seek-backward.png'});
    await page.waitForTimeout(650);
    after = await sample();
    check(!after.paused && Math.abs(after.time-before.time+10)<2, 'Left double tap failed');
    await page.waitForTimeout(2500);
    check(!(await sample()).paused, 'Playback paused after touch seeking');
    results.push({name:'trusted double tap backward and sustained playback',passed:true});
    await tap(); await page.waitForTimeout(400);
    check((await sample()).paused, 'Single tap did not pause');
    before = await sample();
    await tap(335); await tap(335);
    await page.waitForTimeout(600);
    after = await sample();
    check(after.paused && Math.abs(after.time-before.time-10)<1.5,'Double tap lost paused state');
    results.push({name:'single tap pause and paused double tap seek',passed:true});
    await page.evaluate(() => Object.defineProperty(document.querySelector('#video'), 'readyState', {
      configurable:true, get:()=>HTMLMediaElement.HAVE_CURRENT_DATA,
    }));
    await tap();
    await page.waitForFunction(() => !document.querySelector('#video').paused, null, {timeout:5000});
    before = await sample();
    await page.waitForTimeout(500);
    after = await sample();
    check(!after.paused && after.time > before.time && after.phase === 'playing' && after.buffering === 'false',
      'Resume did not continue from current-frame readiness: '+JSON.stringify(after));
    await position(10);
    check((await sample()).buffering === 'false', 'Seek left buffering active with current-frame readiness');
    await page.evaluate(() => delete document.querySelector('#video').readyState);
    results.push({name:'trusted tap resumes with current-frame readiness and continues playback',passed:true});
    for(const fraction of [0.25,0.65,0.15]) {
      const dragged=await dragSeek(fraction);
      check(!dragged.paused,'Playing touch seek paused video');
    }
    results.push({name:'repeated touch seek-bar drags in both directions while playing',passed:true});
    await tap(); await page.waitForTimeout(400);
    for(const fraction of [0.55,0.1,0.45]) {
      const dragged=await dragSeek(fraction);
      check(dragged.paused,'Paused touch seek started playback');
    }
    results.push({name:'repeated touch seek-bar drags preserve pause',passed:true});
    const ownedBar=await page.locator('#seek').evaluate(el=>{
      const r=el.getBoundingClientRect();
      return {x:r.x+6,y:r.y+r.height/2,width:r.width-12,max:Number(el.max)};
    });
    const ownedX=ownedBar.x+ownedBar.width*0.65;
    await touch('down',ownedBar.x+ownedBar.width*0.45,ownedBar.y,'#seek');
    await touch('move',ownedX,ownedBar.y,'#seek');
    if(cdp) {
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[
        {x:ownedX,y:ownedBar.y,id:1},{x:195,y:350,id:2},
      ]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[{x:195,y:350,id:2}]});
    } else await page.locator('#surface').dispatchEvent('pointerup',{
      pointerType:'touch',pointerId:2,isPrimary:false,clientX:195,clientY:350,bubbles:true,
    });
    await page.waitForTimeout(350);
    check(await page.evaluate(()=>window.mobileEvents.findLast(e=>e.type==='pointerup').primary===false),
      'Regression setup released the primary contact');
    const heldValue=await page.locator('#seek').evaluate(el=>Number(el.value));
    check(Math.abs(heldValue-ownedBar.max*0.65)<0.2,'Another contact released the active scrub');
    await touch('up',ownedX,ownedBar.y,'#seek');
    await ready();
    check(Math.abs((await sample()).time-ownedBar.max*0.65)<0.2,'Captured scrub did not commit after another contact');
    results.push({name:'other touch contacts cannot release or overwrite the active seek drag',passed:true});
    const seekBox=await page.locator('#seek').boundingBox();
    before=await sample();
    await touch('down',seekBox.x+seekBox.width/2,seekBox.y+seekBox.height/2,'#seek');
    await touch('move',seekBox.x+seekBox.width*0.9,seekBox.y+seekBox.height/2,'#seek');
    await touch('cancel',0,0,'#seek');
    await page.waitForTimeout(100);
    check(Math.abs((await sample()).time-before.time)<0.2,'Cancelled scrub committed a seek');
    await dragSeek(0.2);
    await tap(); await page.waitForFunction(() => !document.querySelector('#video').paused);
    results.push({name:'cancelled scrub resets ownership and the next drag works',passed:true});
    await position(10);
    await touch('down');
    await page.waitForFunction(() => document.querySelector('#video').playbackRate===2,null,{timeout:350});
    const latency=await page.evaluate(() => {
      const events=window.mobileEvents;
      const down=events.findLast(e=>e.type==='pointerdown'&&e.target==='surface');
      const rate=events.findLast(e=>e.type==='ratechange'&&e.rate===2);
      return rate.wall-down.wall;
    });
    check(latency>=150 && latency<300,'Hold activation lag: '+latency);
    check((await sample()).rate === 2, 'Hold did not play at 2x');
    await page.screenshot({path:options.reportDir+'/'+options.browser+'-hold.png'});
    await touch('up'); await page.waitForTimeout(400);
    check((await sample()).rate === 1 && !(await sample()).paused, 'Release did not restore speed and playback');
    results.push({name:'hold and release '+(cdp?'trusted touch':'WebKit pointer-handler integration'),passed:true,activationMs:latency});
    await touch('down'); await page.waitForTimeout(250); await touch('cancel');
    check((await sample()).rate === 1, 'Cancelled hold stuck at 2x');
    await touch('down'); await page.waitForTimeout(250);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await touch('up');
    check((await sample()).rate === 1, 'Blurred hold stuck at 2x');
    results.push({name:'cancellation and focus loss restore normal speed',passed:true});
    const heldSource=await page.locator('#video').evaluate(el=>el.currentSrc);
    await page.evaluate(()=>{document.querySelector('#video').playbackRate=1.25;});
    await touch('down'); await page.waitForTimeout(250); await touch('up');
    check((await sample()).rate===1.25 && await page.locator('#video').evaluate(el=>el.currentSrc)===heldSource,
      'Hold did not restore the previous speed on the same media source');
    await page.evaluate(()=>{document.querySelector('#video').playbackRate=1;});
    results.push({name:'hold restores the previous speed without changing the media source',passed:true});
    before = await sample();
    const nextScene=findScenes.scenes.find(scene=>scene.id!==before.scene).id;
    await page.evaluate(() => caches.delete('stash-tv-media-v1'));
    await page.request.get(options.baseURL+'/_test/delay/'+nextScene);
    await touch('down',195,450); await touch('move',195,320);
    const drag=await page.evaluate(() => ({phase:document.querySelector('#player').dataset.swipePhase,
      offset:new DOMMatrix(getComputedStyle(document.querySelector('#video')).transform).m42,
      scene:new URL(location.href).searchParams.get('scene')}));
    check(drag.phase==='dragging' && drag.offset===-130 && drag.scene===before.scene,'Swipe did not follow finger: '+JSON.stringify(drag));
    await page.waitForFunction(()=>document.querySelector('#swipe-incoming').width>0);
    await page.screenshot({path:options.reportDir+'/'+options.browser+'-swipe-drag.png'});
    await touch('up',195,320);
    check(await page.evaluate(() => ['loading','settling'].includes(document.querySelector('#player').dataset.swipePhase) && !document.querySelector('#swipe-outgoing').hidden), 'Outgoing decoded frame not retained during handoff');
    await page.waitForFunction(()=>document.querySelector('#swipe-outgoing').getAnimations()
      .some(animation=>animation.transitionProperty==='transform'));
    const slide=await page.evaluate(()=>{
      const outgoing=document.querySelector('#swipe-outgoing'), incoming=document.querySelector('#swipe-incoming');
      const animations=[...outgoing.getAnimations(),...incoming.getAnimations()]
        .filter(animation=>animation.transitionProperty==='transform');
      for(const animation of animations) { animation.pause(); animation.currentTime=40; }
      const pose={
        outgoing:new DOMMatrix(getComputedStyle(outgoing).transform).m42,
        incoming:new DOMMatrix(getComputedStyle(incoming).transform).m42,
        height:document.querySelector('#player').clientHeight,
      };
      for(const animation of animations) animation.play();
      return pose;
    });
    check(slide.outgoing < -130 && slide.outgoing > -slide.height &&
      Math.abs(slide.incoming-slide.outgoing-slide.height)<2,
      'Swipe pages did not interpolate together immediately after release: '+JSON.stringify(slide));
    await page.waitForTimeout(300);
    const handoff=await page.evaluate(()=>({
      phase:document.querySelector('#player').dataset.swipePhase,
      outgoingHidden:document.querySelector('#swipe-outgoing').hidden,
      incomingHidden:document.querySelector('#swipe-incoming')?.hidden,
      offset:new DOMMatrix(getComputedStyle(document.querySelector('#swipe-incoming') || document.querySelector('#video')).transform).m42,
      ready:document.querySelector('#player').dataset.videoReady,
    }));
    check(handoff.phase==='loading' && handoff.outgoingHidden && handoff.incomingHidden===false &&
      handoff.offset===0 && handoff.ready==='false',
      'Swipe waited for the delayed stream before finishing its page transition: '+JSON.stringify(handoff));
    await page.request.get(options.baseURL+'/_test/delay/off');
    await page.waitForFunction(id=>new URL(location.href).searchParams.get('scene')!==id,before.scene);
    await ready();
    await settled();
    after=await sample();
    check(!after.paused && after.rate === 1,'Swipe next failed to play');
    await page.locator('#toggle').click();
    await position(20);
    await page.waitForFunction(()=>document.querySelector('#player').dataset.videoReady==='true');
    await touch('down',195,320); await touch('move',195,450); await touch('up',195,450);
    await page.waitForFunction(id=>new URL(location.href).searchParams.get('scene')===id,before.scene);
    await ready();
    await settled();
    check(await page.locator('video').count()===1 && await page.locator('#swipe-outgoing').isHidden(),'Swipe left a second decoder or stale frame');
    results.push({name:'finger-following swipe and decoded-frame transition in both directions',passed:true});
    await page.evaluate(() => caches.delete('stash-tv-media-v1'));
    await page.request.get(options.baseURL+'/_test/delay/'+nextScene);
    await touch('down',195,450); await touch('move',195,320); await touch('up',195,320);
    await page.waitForFunction(()=>document.querySelector('#player').dataset.swipePhase==='loading' &&
      document.querySelector('#swipe-incoming').width>0);
    const loadingFrame=await page.locator('#swipe-incoming').evaluate(el=>el.toDataURL());
    await touch('down',195,320); await touch('move',195,450);
    await page.waitForFunction(()=>document.querySelector('#swipe-incoming').width>0);
    await touch('up',195,450);
    check(await page.locator('#swipe-outgoing').evaluate(el=>el.toDataURL())===loadingFrame,
      'Reversing a loading video replaced its outgoing frame with the destination');
    await page.request.get(options.baseURL+'/_test/delay/off');
    await page.waitForFunction(id=>new URL(location.href).searchParams.get('scene')===id,before.scene);
    await ready(); await settled();
    check(!(await sample()).paused && await page.locator('#swipe-incoming').isHidden(),
      'Late stream response interrupted the reversed scene');
    results.push({name:'swipe reversal while loading keeps the visible frame and ignores the late stream',passed:true});
    await dragSeek(0.6); await dragSeek(0.2);
    results.push({name:'touch seeking still works after next and previous scene handoffs',passed:true});
    before=await sample();
    await touch('down',195,450); await touch('move',195,405); await touch('cancel');
    await settled();
    check((await sample()).scene===before.scene && await page.evaluate(()=>getComputedStyle(document.querySelector('#video')).transform==='none'),'Cancelled swipe failed to snap back');
    await touch('down',195,450); await touch('move',195,426); await touch('up',195,426);
    const returningPose=await page.evaluate(()=>{
      const video=document.querySelector('#video');
      for(const animation of video.getAnimations()) {animation.pause();animation.currentTime=0;}
      return new DOMMatrix(getComputedStyle(video).transform).m42;
    });
    await touch('down',195,450); await touch('move',195,426);
    const interruptedPose=await page.evaluate(()=>new DOMMatrix(getComputedStyle(document.querySelector('#video')).transform).m42);
    check(Math.abs(interruptedPose-returningPose+24)<1,'Interrupted return jumped to zero instead of continuing from its current position: '+JSON.stringify({returningPose,interruptedPose}));
    await touch('cancel'); await settled();
    check((await sample()).scene===before.scene,'Interrupting a short swipe changed scene');
    results.push({name:'interrupted swipe return continues from its current animated position',passed:true});
    await touch('down',195,320); await touch('move',195,450); await touch('up',195,450);
    await settled();
    check((await sample()).scene===before.scene,'Previous at first scene changed queue');
    results.push({name:'cancelled swipe and queue boundary return without changing video',passed:true});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForFunction(()=>matchMedia('(prefers-reduced-motion: reduce)').matches);
    await tap();
    await page.waitForFunction(()=>document.querySelector('#video').paused);
    await position(10);
    const clip=await page.locator('#video').evaluate(el=>{
      const r=el.getBoundingClientRect();
      const height=r.width*el.videoHeight/el.videoWidth;
      return {x:Math.round(r.x+r.width/4),y:Math.round(r.y+(r.height-height)/2-50),
        width:Math.round(r.width/2),height:30};
    });
    const stationary=await page.screenshot({clip});
    await touch('down',195,450); await touch('move',195,320);
    const reducedDrag=await page.evaluate(()=>({
      phase:document.querySelector('#player').dataset.swipePhase,
      offset:new DOMMatrix(getComputedStyle(document.querySelector('#video')).transform).m42,
    }));
    check(reducedDrag.phase==='dragging' && reducedDrag.offset===-130,
      'Reduced-motion swipe did not follow finger: '+JSON.stringify(reducedDrag));
    const moved=await page.screenshot({clip,path:options.reportDir+'/'+options.browser+'-reduced-motion-drag.png'});
    check(!stationary.equals(moved),'Reduced-motion drag changed styles without moving rendered video pixels');
    const otherScene=findScenes.scenes.find(scene=>scene.id!==before.scene).id;
    await page.evaluate(() => caches.delete('stash-tv-media-v1'));
    await page.request.get(options.baseURL+'/_test/delay/'+otherScene);
    await touch('up',195,320);
    check(await page.evaluate(()=>document.querySelector('#player').dataset.swipePhase==='fading' &&
      !document.querySelector('#swipe-outgoing').hidden), 'Reduced-motion handoff discarded the outgoing frame');
    await page.waitForTimeout(150);
    await page.waitForTimeout(150);
    check(await page.locator('#swipe-incoming').isVisible() && await page.locator('#swipe-outgoing').isHidden(),
      'Reduced-motion fade waited for the delayed incoming stream');
    await page.request.get(options.baseURL+'/_test/delay/off');
    await page.waitForFunction(id=>new URL(location.href).searchParams.get('scene')!==id,before.scene);
    await ready(); await settled();
    check(await page.evaluate(()=>window.mobileEvents.some(e=>e.type==='transitionrun' &&
      e.target==='swipe-outgoing' && e.property==='opacity')),'Reduced-motion handoff did not fade its outgoing frame');
    check(await page.evaluate(()=>getComputedStyle(document.querySelector('#video')).transform==='none'),'Reduced motion still slides video');
    await touch('down',195,320); await touch('move',195,450); await touch('up',195,450);
    await page.waitForFunction(id=>new URL(location.href).searchParams.get('scene')===id,before.scene);
    await ready(); await settled();
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.waitForFunction(()=>!matchMedia('(prefers-reduced-motion: reduce)').matches);
    results.push({name:'reduced motion follows the finger, retains the decoded frame, and fades on release',passed:true});
    before=await sample();
    const transitionCount=()=>page.evaluate(()=>window.mobileEvents.filter(e=>e.type==='transitionrun' &&
      e.target==='swipe-outgoing' && e.property==='transform').length);
    let transitions=await transitionCount();
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(id=>new URL(location.href).searchParams.get('scene')!==id,before.scene);
    await ready(); await settled();
    check(await transitionCount()>transitions,'Up did not start the swipe transition');
    await page.locator('#surface').dispatchEvent('keydown',{key:'ArrowDown',keyCode:40,repeat:true,bubbles:true});
    check((await sample()).scene!==before.scene,'Repeated Down navigated to another video');
    transitions=await transitionCount();
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(id=>new URL(location.href).searchParams.get('scene')===id,before.scene);
    await ready(); await settled();
    check(await transitionCount()>transitions,'Down did not start the swipe transition');
    check(!(await sample()).paused && await page.locator('video').count()===1,'Arrow navigation stopped playback or added another decoder');
    results.push({name:'Up and Down animate next and previous, ignoring repeated keydown',passed:true});
    await page.locator('#zoom').tap();
    check(await page.locator('#zoom').getAttribute('aria-pressed')==='true' &&
      await page.locator('#video').evaluate(el=>getComputedStyle(el).objectFit==='cover'), 'Zoom did not fill the screen');
    await page.keyboard.press('ArrowUp');
    check(await page.locator('#swipe-incoming').evaluate(el=>getComputedStyle(el).objectFit==='cover'),
      'Incoming swipe preview did not preserve fill mode');
    await ready(); await settled();
    check(await page.locator('#video').evaluate(el=>getComputedStyle(el).objectFit==='cover'),'Scene change reset fill mode');
    await page.keyboard.press('ArrowDown');
    await ready(); await settled();
    await page.locator('#zoom').tap();
    check(await page.locator('#zoom').getAttribute('aria-pressed')==='false' &&
      await page.locator('#video').evaluate(el=>getComputedStyle(el).objectFit==='contain'), 'Zoom did not restore the full frame');
    results.push({name:'mobile zoom fills the screen, survives navigation, and restores fit without changing icons',passed:true});
    await page.locator('#toggle').tap();
    await page.waitForFunction(()=>document.querySelector('#video').paused);
    await position(20);
    await page.locator('#zoom').tap();
    const panOrigin=await sample();
    const framing=()=>page.locator('#video').evaluate(el=>({
      position:parseFloat(getComputedStyle(el).objectPosition),
      overflow:el.videoWidth*Math.max(el.clientWidth/el.videoWidth,el.clientHeight/el.videoHeight)-el.clientWidth,
      transform:getComputedStyle(el).transform,
    }));
    const center=await framing();
    check(center.overflow>300 && center.position===50,'Expected a centered, horizontally cropped fixture');
    const centeredImage=await page.screenshot({clip:{x:10,y:100,width:370,height:430}});
    await touch('down',100,350); await touch('move',250,355);
    const panned=await framing();
    check(Math.abs((center.position-panned.position)*center.overflow/100-150)<2 && panned.transform==='none',
      'Fill did not follow the horizontal drag: '+JSON.stringify({center,panned}));
    await touch('move',250,600); await touch('up',250,600);
    const pannedImage=await page.screenshot({clip:{x:10,y:100,width:370,height:430}});
    check(!centeredImage.equals(pannedImage),'Horizontal drag changed state but not the rendered video crop');
    check((await sample()).scene===panOrigin.scene && (await sample()).paused &&
      Math.abs((await sample()).time-panOrigin.time)<0.1,'Pan changed scene, playback, or seek position');
    for(let drag=0;drag<8;drag++) {
      await touch('down',50,350); await touch('move',350,350); await touch('up',350,350);
    }
    check((await framing()).position===0,'Repeated pan did not clamp to the left edge');
    await touch('down',350,350); await touch('move',50,350); await touch('up',50,350);
    check((await framing()).position>0,'Pan could not move away from its clamped edge');
    for(let drag=0;drag<8;drag++) {
      await touch('down',350,350); await touch('move',50,350); await touch('up',50,350);
    }
    check((await framing()).position===100,'Repeated pan did not clamp to the right edge');
    await page.setViewportSize({width:844,height:390});
    check((await framing()).overflow<1,'Expected an uncropped horizontal view in landscape');
    await touch('down',100,220); await touch('move',250,220); await touch('up',250,220);
    check((await framing()).position===100,'Uncropped video still moved horizontally');
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:options.reportDir+'/'+options.browser+'-fill-panned.png'});
    await touch('down',195,450); await touch('move',195,320); await touch('up',195,320);
    check(await page.locator('#swipe-outgoing').evaluate(el=>parseFloat(getComputedStyle(el).objectPosition))===100 &&
      await page.locator('#swipe-incoming').evaluate(el=>parseFloat(getComputedStyle(el).objectPosition))===50,
      'Vertical handoff changed the outgoing crop or inherited it on the new scene');
    await ready(); await settled();
    check((await sample()).scene!==panOrigin.scene && (await framing()).position===50,
      'Vertical swipe failed after panning or new video did not start centered');
    await page.keyboard.press('ArrowDown'); await ready(); await settled();
    await page.locator('#toggle').tap();
    await page.waitForFunction(()=>document.querySelector('#video').paused);
    await touch('down',250,350); await touch('move',100,350); await touch('cancel');
    const cancelledPan=(await framing()).position;
    await page.waitForTimeout(350);
    check(cancelledPan>50 && (await framing()).position===cancelledPan && (await sample()).paused &&
      (await sample()).rate===1,'Cancelled pan reset the view or triggered tap/hold playback');
    await page.locator('#zoom').tap();
    check((await framing()).position===50,'Fit did not recenter the full video');
    results.push({name:'Fill pans with the finger, changes rendered pixels, clamps both edges, and leaves playback alone',passed:true});
    await page.locator('#toggle').tap();
    await page.waitForFunction(() => !document.querySelector('#video').paused);
    await position(10);
    before=await sample();
    await touch('down',100,350); await touch('move',250,355); await touch('up',250,355);
    check((await sample()).scene===before.scene,'Horizontal drag changed scene');
    await page.waitForFunction(() => !document.querySelector('#video').paused && !document.querySelector('#video').seeking && !document.querySelector('#toggle').disabled && document.querySelector('#player').dataset.buffering === 'false');
    await page.evaluate(() => {
      window.controlEvents=[];
      for (const type of ['pointerdown','pointerup','click']) document.querySelector('#toggle').addEventListener(type, e => window.controlEvents.push({type, target:e.target.id, disabled:e.currentTarget.disabled}));
    });
    if (cdp) {
      const box = await page.locator('#toggle').boundingBox();
      await touch('down',box.x+box.width/2,box.y+box.height/2);
      await page.waitForTimeout(80);
      await touch('up',box.x+box.width/2,box.y+box.height/2);
    } else await page.locator('#toggle').tap();
    await page.waitForTimeout(400);
    check((await sample()).paused, 'Control tap did not pause: '+JSON.stringify({sample:await sample(),events:await page.evaluate(()=>window.controlEvents)}));
    results.push({name:'horizontal drag and playback controls do not navigate',passed:true});
    check(await page.locator('#volume-panel').isHidden(), 'Volume panel is not collapsed');
    const muted = await page.evaluate(()=>document.querySelector('#video').muted);
    await page.locator('#mute').tap();
    check(await page.evaluate(()=>document.querySelector('#video').muted)!==muted,'Mobile speaker did not toggle mute');
    check(await page.locator('#volume-panel').isHidden(),'Mobile speaker opened a desktop slider');
    await page.locator('#mute').tap();
    check(await page.evaluate(()=>document.querySelector('#video').muted)===muted,'Mobile unmute did not restore sound');
    results.push({name:'mobile speaker toggles mute without an adjustment popup',passed:true});
    await page.locator('#fullscreen').tap();
    await page.waitForTimeout(500);
    const full = await page.evaluate(()=>!!(document.fullscreenElement||document.webkitFullscreenElement||document.querySelector('#video').webkitDisplayingFullscreen));
    const capability = await page.evaluate(() => ({
      page:document.fullscreenEnabled, prefixed:document.webkitFullscreenEnabled,
      native:typeof document.querySelector('#video').webkitEnterFullscreen,
      notice:document.querySelector('#notice').textContent,
    }));
    if (full) {
      await page.locator('#fullscreen').tap();
      await page.waitForTimeout(300);
      check(!await page.evaluate(()=>!!(document.fullscreenElement||document.webkitFullscreenElement)), 'Fullscreen did not exit');
      results.push({name:'fullscreen enters and exits in '+options.browser,passed:true});
    } else {
      check(options.browser==='webkit' && capability.page!==true && capability.prefixed!==true,
        'Browser fullscreen failed with supported API: '+JSON.stringify(capability));
      results.push({name:'WebKit mobile emulation has no native fullscreen implementation',skipped:true,capability});
    }
    await page.evaluate(() => {
      const player=document.querySelector('#player'), video=document.querySelector('#video');
      player.requestFullscreen=undefined; player.webkitRequestFullscreen=undefined;
      window.nativeFullscreenCalls=0;
      video.webkitEnterFullscreen=()=>{window.nativeFullscreenCalls++;};
    });
    await page.locator('#fullscreen').tap();
    check(await page.evaluate(()=>window.nativeFullscreenCalls===1), 'iPhone native fullscreen fallback missing');
    results.push({name:'native video fullscreen fallback contract when page API is unavailable',passed:true});
    for (const size of [{width:844,height:390},{width:667,height:375}]) {
      await page.setViewportSize(size);
      const overflow=await page.locator('nav button').evaluateAll(elements=>elements.filter(el=>el.getClientRects().length).some(el=>{const r=el.getBoundingClientRect();return r.right>innerWidth||r.left<0||r.bottom>innerHeight;}));
      check(!overflow,'Landscape controls overflow');
      await page.screenshot({path:options.reportDir+'/'+options.browser+'-landscape-'+size.width+'.png'});
    }
    results.push({name:'landscape controls fit',passed:true});
    return { passed:true, browser:options.browser, results };
  } catch(error) {
    await page.screenshot({ path:options.reportDir + '/' + options.browser + '-mobile-failure.png' });
    return { passed:false, browser:options.browser, error:error.message, results, errors,
      events:await page.evaluate(()=>window.mobileEvents),
      state:await page.evaluate(()=>({player:{...document.querySelector('#player').dataset},
        video:{time:document.querySelector('#video').currentTime,paused:document.querySelector('#video').paused},
        canvases:['swipe-incoming','swipe-outgoing'].map(id=>({id,width:document.getElementById(id).width,
          hidden:document.getElementById(id).hidden,data:{...document.getElementById(id).dataset}})),
        buffers:window.bufferEvents})),
      requests:await (await page.request.get(options.baseURL+'/_test/requests')).json() };
  } finally { await context.close(); }
}
