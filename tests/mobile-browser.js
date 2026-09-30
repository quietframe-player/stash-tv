export default async function verifyMobile(page, options) {
  const results = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const context = await page.context().browser().newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  page = await context.newPage();
  const api = async (query, variables = {}) => {
    const response = await page.request.post(options.baseURL + '/graphql', { data: { query, variables } });
    const body = await response.json();
    check(response.ok() && !body.errors, JSON.stringify(body));
    return body.data;
  };
  const ready = () => page.waitForFunction(() => ['ready', 'paused', 'playing'].includes(document.querySelector('#player').dataset.phase) && !document.querySelector('#video').seeking);
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
        return { seek:rect('seek'), buttons:['previous','toggle','next','random','mute','delete','fullscreen'].map(rect), viewport:innerWidth };
      });
      check(layout.seek.width >= width * 0.4, 'Portrait seek bar collapsed: ' + JSON.stringify(layout));
      check(layout.buttons.every(b => b.x >= 0 && b.right <= width && b.bottom <= 844), 'Portrait control overflow: ' + JSON.stringify(layout));
      check(layout.buttons.every((b,i,all) => all.every((c,j) => i === j || b.right <= c.x || c.right <= b.x || b.bottom <= c.y || c.bottom <= b.y)), 'Overlapping controls');
      await page.screenshot({ path: options.reportDir + '/' + options.browser + '-portrait-' + width + '.png' });
      results.push({ name:'portrait layout ' + width, passed:true });
    }
    await page.setViewportSize({ width:390, height:844 });
    const sample = () => page.evaluate(() => {
      const v = document.querySelector('#video');
      return { time:v.currentTime, paused:v.paused, rate:v.playbackRate, scene:new URL(location.href).searchParams.get('scene') };
    });
    const tap = (x=195,y=350) => page.touchscreen.tap(x,y);
    const position = async seconds => {
      await page.locator('#seek').evaluate((el, value) => { el.value=String(value); el.dispatchEvent(new Event('change', {bubbles:true})); }, seconds);
      await ready();
    };
    await tap();
    await page.waitForFunction(() => !document.querySelector('#video').paused);
    await page.waitForTimeout(450);
    await position(20);
    let before = await sample();
    await tap(335); await tap(335);
    await page.waitForTimeout(650);
    let after = await sample();
    check(!after.paused && after.time >= before.time+9 && after.time <= before.time+12, 'Right double tap: '+JSON.stringify({before,after}));
    check(!await page.evaluate(() => !!document.fullscreenElement), 'Touch double tap entered fullscreen');
    results.push({name:'trusted double tap seeks forward without pausing or fullscreen',passed:true});
    before = after;
    await tap(45); await tap(45);
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
    await tap();
    await page.waitForFunction(() => !document.querySelector('#video').paused);
    await position(10);

    const cdp = options.browser === 'chrome' ? await context.newCDPSession(page) : null;
    if (!cdp) await page.evaluate(() => {
      // WebKit's automation interface exposes taps but no held touch sequence.
      window.originalCapture = Element.prototype.setPointerCapture;
      Element.prototype.setPointerCapture = function() {};
    });
    const touch = async (type,x=195,y=350) => {
      if(cdp) await cdp.send('Input.dispatchTouchEvent', {
        type:{down:'touchStart',move:'touchMove',up:'touchEnd',cancel:'touchCancel'}[type],
        touchPoints:['up','cancel'].includes(type)?[]:[{x,y,id:1}],
      });
      else await page.locator('#surface').dispatchEvent('pointer'+type, {
        pointerType:'touch',pointerId:1,isPrimary:true,clientX:x,clientY:y,bubbles:true,cancelable:true,
      });
    };
    await touch('down'); await page.waitForTimeout(600);
    check((await sample()).rate === 2, 'Hold did not play at 2x');
    await page.screenshot({path:options.reportDir+'/'+options.browser+'-hold.png'});
    await touch('up'); await page.waitForTimeout(400);
    check((await sample()).rate === 1 && !(await sample()).paused, 'Release did not restore speed and playback');
    results.push({name:'hold and release '+(cdp?'trusted touch':'WebKit pointer-handler integration'),passed:true});
    await touch('down'); await page.waitForTimeout(600); await touch('cancel');
    check((await sample()).rate === 1, 'Cancelled hold stuck at 2x');
    await touch('down'); await page.waitForTimeout(600);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await touch('up');
    check((await sample()).rate === 1, 'Blurred hold stuck at 2x');
    results.push({name:'cancellation and focus loss restore normal speed',passed:true});
    before = await sample();
    await touch('down',195,450); await touch('move',195,320); await touch('up',195,320);
    await page.waitForFunction(id=>new URL(location.href).searchParams.get('scene')!==id,before.scene);
    await ready();
    after=await sample();
    check(!after.paused && after.rate === 1,'Swipe next failed to play');
    await touch('down',195,320); await touch('move',195,450); await touch('up',195,450);
    await page.waitForFunction(id=>new URL(location.href).searchParams.get('scene')===id,before.scene);
    await ready();
    results.push({name:'swipe up next and swipe down previous through real Stash queue',passed:true});
    await page.waitForFunction(() => !document.querySelector('#video').paused);
    await position(10);
    before=await sample();
    await touch('down',100,350); await touch('move',250,355); await touch('up',250,355);
    check((await sample()).scene===before.scene,'Horizontal drag changed scene');
    await page.waitForFunction(() => !document.querySelector('#video').paused && !document.querySelector('#video').seeking);
    await page.locator('#toggle').tap(); await page.waitForTimeout(400);
    check((await sample()).paused, 'Control tap fired video gesture');
    results.push({name:'horizontal drag and playback controls do not navigate',passed:true});
    check(await page.locator('#volume-panel').isHidden(), 'Volume panel is not collapsed');
    await page.locator('#mute').tap();
    check(await page.locator('#volume-panel').isVisible(), 'Volume button did not open panel');
    await page.locator('#volume').evaluate(el=>{el.value='35';el.dispatchEvent(new Event('input',{bubbles:true}));});
    check(await page.evaluate(()=>Math.abs(document.querySelector('#video').volume-0.35)<0.01),'Volume slider failed');
    await page.locator('#volume-mute').tap();
    check(await page.evaluate(()=>document.querySelector('#video').muted),'Mute action failed');
    await page.locator('#mute').tap();
    check(await page.locator('#volume-panel').isHidden(),'Volume button did not close panel');
    results.push({name:'volume button opens adjustment and mute controls',passed:true});
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
    return { passed:false, browser:options.browser, error:error.message, results };
  } finally { await context.close(); }
}
