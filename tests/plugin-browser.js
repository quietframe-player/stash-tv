export default async function verifyPlugin(page, options) {
  const results = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const api = async (query, variables = {}) => {
    const response = await page.request.post(options.baseURL + "/graphql", { data: { query, variables } });
    const body = await response.json();
    check(response.ok() && !body.errors, JSON.stringify(body));
    return body.data;
  };
  const config = async (input) => api('mutation($input:ConfigGeneralInput!){configureGeneral(input:$input){username}}', { input });
  const settings = async (enabled) => api('mutation($input:Map!){configurePlugin(plugin_id:"stash-tv",input:$input)}', { input: { enableDelete: enabled } });
  try {
    const library = await api('{findScenes{scenes{id files{path}}}}');
    check(library.findScenes.scenes.length === 1, "Expected disposable test library");
    const scene = library.findScenes.scenes[0];
    check(scene.files[0].path === '/media/sintel.mp4', "Refusing a non-test scene");
    await page.goto(options.baseURL + '/scenes/' + scene.id);
    const closeNotes = page.getByRole("button", { name: "Close", exact: true });
    await closeNotes.click({ timeout: 5000 }).catch(() => {});
    const launcher = page.getByRole('link', { name: 'Open Stash TV' });
    await launcher.waitFor();
    const link = await launcher.evaluate(element => ({ href: element.href, pathname: new URL(element.href).pathname, scene: new URL(element.href).searchParams.get("scene") }));
    check(link.pathname === '/plugin/stash-tv/assets/index.html' && link.scene === scene.id, 'Incorrect launcher link');
    await launcher.click();
    await page.waitForSelector('#video');
    await page.waitForFunction(() => ['ready','paused','playing'].includes(document.getElementById('player').dataset.phase));
    check(await page.locator('#delete').isHidden(), 'Delete is not hidden by default');
    results.push({ name: 'native navigation launcher and deletion default', passed: true });
    await page.locator('#surface').click();
    await page.screenshot({ path: options.reportDir + '/' + options.browser + '-player.png' });
    await settings(true);
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('delete').disabled);
    await page.locator('#more').click();
    check(await page.locator('#delete').isVisible(), 'Delete setting was not applied');
    await page.keyboard.press('Escape');
    results.push({ name: 'server-backed deletion opt-in', passed: true });
    await config({ username: 'integration', password: 'isolated-test-password' });
    await page.context().clearCookies();
    await page.goto(link.href);
    await page.locator('#username').waitFor();
    check(!await page.locator('#video').count(), 'Plugin assets bypassed Stash authentication');
    await page.locator('#username').fill('integration');
    await page.locator('#password').fill('isolated-test-password');
    await page.locator('#login-button').click();
    await page.waitForSelector('#video');
    await page.waitForFunction(() => ['ready','paused','playing'].includes(document.getElementById('player').dataset.phase));
    results.push({ name: 'Stash login protects assets and session authenticates playback', passed: true });
    await config({ username: '', password: '' });
    if (options.destructive) {
      await page.mouse.move(200, 100);
      await page.locator("#more").click(); await page.locator('#delete').click();
      await page.waitForFunction(() => document.getElementById('player').dataset.phase === 'empty');
      const readback = await api('{findScenes{count}}');
      check(readback.findScenes.count === 0, 'Deleted test scene is still in Stash');
      results.push({ name: 'opt-in permanent deletion of disposable scene', passed: true });
    }
    await settings(false);
    return { passed: true, browser: options.browser, results };
  } catch (error) {
    await page.screenshot({ path: options.reportDir + '/' + options.browser + '-failure.png' });
    return { passed: false, browser: options.browser, error: error.message, results };
  }
}
