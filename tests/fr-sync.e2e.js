/* 法文模組：帳號隔離＋雲端同步的瀏覽器檢查（Playwright／Chromium）。
 *   node tests/fr-sync.e2e.js
 * 需要執行環境裝有 playwright（require('playwright')）。腳本自己起一個本機靜態伺服器。
 *
 * 這裡「沒有」連真正的 Google：
 *   - 登入：直接把首頁殼層會寫的 session（localStorage.langhub_gd_session = {accessToken, expiresAt, email}）寫進去，
 *     沒有走 Google Identity Services／Android bridge 的實際登入、也沒有測 token 過期後的靜默重取。
 *   - Drive：www.googleapis.com 的請求全部由下面的假 Drive（記憶體）回應，驗的是模組送出的請求與流程
 *     （先 pull 合併才 push、只同步自己帳號的紀錄、debounce、hidden 時立即送出），不是 Google 端的真實行為。 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const ALICE = 'alice@example.com', BOB = 'bob@example.com';
const K = 'francais_v1', KA = K+'::'+ALICE, KB = K+'::'+BOB;
const FILE_NAME = 'langhub_fr_state.json';

function serve(){
  const types = {'.html':'text/html; charset=utf-8', '.js':'text/javascript', '.json':'application/json', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2'};
  const srv = http.createServer((req, res)=>{
    let p = decodeURIComponent(req.url.split('?')[0]);
    if(p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if(!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()){ res.writeHead(404); res.end(); return; }
    res.writeHead(200, {'content-type': types[path.extname(f)]||'application/octet-stream'});
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r=>srv.listen(0, '127.0.0.1', ()=>r(srv)));
}

/* 假的 Drive appDataFolder：每個帳號（token＝tok-<email>）一個空間 */
function makeDrive(){
  const d = {files:{}, log:[], failReads:false, seq:0};
  const cors = {'access-control-allow-origin':'*', 'access-control-allow-headers':'*', 'access-control-allow-methods':'*'};
  const json = (route, status, body)=>route.fulfill({status, headers:Object.assign({'content-type':'application/json'}, cors), body:JSON.stringify(body)});
  d.handle = async route=>{
    const req = route.request(), url = new URL(req.url()), method = req.method();
    if(method==='OPTIONS') return route.fulfill({status:204, headers:cors});
    const auth = req.headers()['authorization']||'';
    if(!/^Bearer tok-/.test(auth)) return json(route, 401, {error:'unauthorized'});
    const email = auth.replace(/^Bearer tok-/, '').toLowerCase();
    const f = d.files[email];
    d.log.push({method, path:url.pathname, email});
    if(url.pathname==='/oauth2/v3/userinfo') return json(route, 200, {email});
    if(method==='GET' && url.pathname==='/drive/v3/files'){
      assert.strictEqual(url.searchParams.get('spaces'), 'appDataFolder');
      assert.strictEqual(url.searchParams.get('q'), "name='"+FILE_NAME+"'");
      return json(route, 200, {files: f ? [{id:f.id}] : []});
    }
    let m = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if(method==='GET' && m){
      if(d.failReads) return json(route, 500, {error:'boom'});
      if(!f || f.id!==m[1]) return json(route, 404, {});
      return json(route, 200, f.body);
    }
    if(method==='POST' && url.pathname==='/upload/drive/v3/files'){
      const parts = req.postData().split(/\r\n--gd_boundary_[^\r]*/).map(p=>p.split('\r\n\r\n').slice(1).join('\r\n\r\n'));
      const meta = JSON.parse(parts[0]), body = JSON.parse(parts[1]);
      d.files[email] = {id:'file'+(++d.seq), name:meta.name, parents:meta.parents, body, writes:1};
      return json(route, 200, {id:d.files[email].id});
    }
    m = url.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if(method==='PATCH' && m){
      if(!f || f.id!==m[1]) return json(route, 404, {});
      f.body = JSON.parse(req.postData()); f.writes++;
      return json(route, 200, {id:f.id});
    }
    return json(route, 400, {error:'unexpected '+method+' '+url.pathname});
  };
  d.writesBy = email=>d.log.filter(x=>x.email===email && (x.method==='POST'||x.method==='PATCH')).length;
  return d;
}

const sess = email=>({accessToken:'tok-'+email, expiresAt:Math.floor(Date.now()/1000)+3600, email});
const sleep = ms=>new Promise(r=>setTimeout(r, ms));
let passed = 0;
const notes = [];
function ok(v, msg){ assert(v, msg); passed++; }
function eq(a, b, msg){ assert.deepStrictEqual(a, b, msg); passed++; }

(async()=>{
  const srv = await serve();
  const BASE = 'http://127.0.0.1:'+srv.address().port;
  const HUB = BASE+'/index.html', FR = BASE+'/modules/fr/index.html';
  const browser = await chromium.launch();
  const drive = makeDrive();

  async function newCtx(){
    const ctx = await browser.newContext();
    await ctx.route('https://www.googleapis.com/**', drive.handle);
    await ctx.route('https://accounts.google.com/**', r=>r.abort());
    return ctx;
  }
  /* 開一頁並收集 JS 錯誤與對話框 */
  async function open(ctx, url, dialogAnswer){
    const page = await ctx.newPage();
    page.errors = []; page.dialogs = []; page.warns = [];
    page.on('pageerror', e=>page.errors.push(String(e)));
    page.on('console', m=>{ if(m.type()==='error') page.errors.push('console: '+m.text()); if(m.type()==='warning') page.warns.push(m.text()); });
    page.on('dialog', async dlg=>{ page.dialogs.push(dlg.message()); if(dialogAnswer) await dlg.accept(); else await dlg.dismiss(); });
    await page.goto(url);
    return page;
  }
  const ls = (page, k)=>page.evaluate(k=>{ const r=localStorage.getItem(k); return r===null ? null : JSON.parse(r); }, k);
  const setSession = (page, email)=>page.evaluate(s=>{ if(s) localStorage.setItem('langhub_gd_session', JSON.stringify(s)); else localStorage.removeItem('langhub_gd_session'); }, email ? sess(email) : null);
  /* 換帳號一律照使用者的走法：先離開法文頁，再由首頁寫入 session（法文頁關閉時的 push 不會和它搶寫 session） */
  async function hubSet(ctx, email){ const p = await open(ctx, HUB); await setSession(p, email); await p.close(); }
  const synced = page=>page.waitForFunction(()=>!GD.syncing && GD.lastSyncStatus==='ok', null, {timeout:8000});
  const chip = page=>page.locator('#cs-chip-slot .cs-chip-tx').innerText();
  const owner = page=>page.evaluate(()=>storeOwner);
  /* 到單字卡分頁複習一張（答「記得」），回傳該卡 id */
  async function practise(page){
    await page.click('#tabs [data-tab="vocab"]');
    const id = await page.evaluate(()=>ui.vocab.queue.length ? ui.vocab.queue[ui.vocab.idx] : null);
    if(id===null){ await page.waitForFunction(()=>ui.vocab.queue.length>0); }
    const cid = await page.evaluate(()=>ui.vocab.queue[ui.vocab.idx]);
    await page.click('.btn.primary[data-act="vFlip"]');
    await page.click('[data-act="vGrade"][data-g="2"]');
    await page.click('#tabs [data-tab="home"]');
    return cid;
  }
  const seenIds = s=>Object.keys((s&&s.vsrs)||{}).filter(id=>s.vsrs[id].seen>0).sort();
  const frStat = async page=>(await page.locator('.mod[data-id="fr"] .mod-stat').innerText()).trim();

  /* ── 1. 未登入、HTTP ── */
  {
    const ctx = await newCtx();
    const page = await open(ctx, FR);
    await page.waitForSelector('#view .statgrid');
    eq(await chip(page), '未登入', '未登入時 chip 顯示未登入');
    ok((await page.locator('#gd-section-slot').innerText()).includes('使用 Google 登入'), '未登入時雲端同步小節有登入按鈕');
    eq(await owner(page), null, '未登入 → storeOwner 為 null');
    const id = await practise(page);
    eq(seenIds(await ls(page, K)), [id], '未登入的紀錄寫在 francais_v1');
    eq(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.indexOf('francais_v1::')===0)), [], '未登入不會產生帳號 key');
    await sleep(4500);
    eq(drive.log.length, 0, '未登入不會對 Google 發任何請求');
    eq(page.errors, [], 'HTTP 未登入載入與操作沒有 JS 錯誤');
    await ctx.close();
  }

  /* ── 2. 未登入、file:// ── */
  {
    const ctx = await newCtx();
    const page = await open(ctx, 'file://'+path.join(ROOT, 'modules', 'fr', 'index.html'));
    await page.waitForSelector('#view .statgrid');
    eq(await chip(page), '未登入', 'file:// chip 顯示未登入');
    ok((await page.locator('#gd-section-slot').innerText()).includes('以檔案方式開啟'), 'file:// 的雲端同步小節說明無法登入');
    const id = await practise(page);
    eq(seenIds(await ls(page, K)), [id], 'file:// 紀錄寫在 francais_v1');
    for(const t of ['quiz','fav','bank','home']) await page.click('#tabs [data-tab="'+t+'"]');
    eq(page.errors, [], 'file:// 未登入載入與切換分頁沒有 JS 錯誤');
    await ctx.close();
  }

  /* ── 3～6. 同一台裝置：舊紀錄遷移、首次上傳、帳號隔離、訪客併入 ── */
  const ctx1 = await newCtx();
  const legacy = {vsrs:{'f-v1':{box:3,due:99999,seen:3,star:true}, 'f-v2':{box:0,due:1,seen:0,star:false}}, custom:{vocab:[],seq:1}, qstats:{'f-v1':{a:2,c:1,lw:true}}, history:{20000:true}};
  {
    /* 3. 舊版紀錄（francais_v1）＋已在首頁登入 alice → 搬到 alice 的 key，並首次上傳 */
    let page = await open(ctx1, HUB);
    await page.evaluate(([k, v])=>localStorage.setItem(k, JSON.stringify(v)), [K, legacy]);
    await page.evaluate(s=>localStorage.setItem('langhub_gd_session', JSON.stringify(s)), sess('Alice@Example.com'));   // 大小寫混用：key 要用小寫
    await page.close();
    page = await open(ctx1, FR);
    await synced(page);
    eq(await owner(page), ALICE, '登入 alice → storeOwner 為小寫 email');
    eq(seenIds(await ls(page, KA)), ['f-v1'], '舊紀錄搬進第一個登入的帳號');
    eq(await ls(page, K), null, '搬移後舊 key 清空');
    eq(page.dialogs, [], '遷移不需要詢問');
    ok(drive.files[ALICE], '雲端沒有檔案、本機有紀錄 → 建檔');
    eq([drive.files[ALICE].name, drive.files[ALICE].parents], [FILE_NAME, ['appDataFolder']], '同步檔名與位置');
    eq(drive.files[ALICE].body.store.vsrs['f-v1'].seen, 3, '上傳的是 alice 的紀錄');
    ok((await chip(page)).indexOf('已同步')===0, '同步後 chip 顯示已同步');
    ok((await page.locator('#gd-section-slot').innerText()).includes('已登入 Alice@Example.com'), '雲端同步小節顯示登入帳號');
    eq(page.errors, [], '登入狀態載入沒有 JS 錯誤');
    await page.close();

    /* 首頁統計讀的是該帳號的 key */
    page = await open(ctx1, HUB);
    eq(await frStat(page), '練習紀錄 1 筆・單字卡 2 張', '首頁（已登入 alice）顯示 alice 的法文統計');
    await setSession(page, null);
    await page.reload();
    eq(await frStat(page), '尚未開始', '首頁（登出）顯示訪客的法文統計');
    await page.close();
  }
  let guestCard, bobCard;
  {
    /* 4. 登出 → 訪客紀錄（空的）；訪客練一張 */
    let page = await open(ctx1, FR);
    eq(await owner(page), null, '登出後是訪客');
    eq(await page.evaluate(()=>Object.keys(store.vsrs).filter(id=>store.vsrs[id].seen>0)), [], '登出後看不到 alice 的紀錄');
    guestCard = await practise(page);
    eq(seenIds(await ls(page, K)), [guestCard], '訪客紀錄寫在 francais_v1');
    eq(seenIds(await ls(page, KA)), ['f-v1'], 'alice 的紀錄沒被訪客動到');
    /* 換 bob 登入：詢問是否併入訪客紀錄 → 取消 */
    await page.close();
    await hubSet(ctx1, BOB);
    page = await open(ctx1, FR, false);
    await synced(page);
    eq(page.dialogs.length, 1, '訪客有紀錄 → 詢問一次是否併入');
    ok(page.dialogs[0].includes(BOB), '詢問訊息指明帳號');
    eq(await owner(page), BOB, '切到 bob');
    eq(await page.evaluate(()=>Object.keys(store.vsrs).filter(id=>store.vsrs[id].seen>0)), [], 'bob 看不到 alice 或訪客的紀錄');
    eq(seenIds(await ls(page, K)), [guestCard], '取消併入 → 訪客紀錄保留');
    ok(!drive.files[BOB], 'bob 本機沒有紀錄 → 不建檔');
    bobCard = await practise(page);
    eq(seenIds(await ls(page, KB)), [bobCard], 'bob 的練習寫在 bob 的 key');
    const w0 = drive.writesBy(BOB);
    await sleep(1500);
    eq(drive.writesBy(BOB), w0, 'debounce：存檔後不會立刻 push');
    await page.waitForFunction(()=>!GD.syncing && GD.lastSyncStatus==='ok');
    await sleep(3500);
    eq(drive.writesBy(BOB), w0+1, 'debounce 約 4 秒後 push 一次');
    eq(seenIds(drive.files[BOB].body.store), [bobCard], 'bob 的雲端檔只有 bob 的紀錄');
    await page.close();
    page = await open(ctx1, FR, false);
    await synced(page);
    eq(page.dialogs, [], '訪客紀錄沒有新變動 → 不重複詢問');
    /* 換回 alice */
    await page.close();
    await hubSet(ctx1, ALICE);
    page = await open(ctx1, FR, false);
    await synced(page);
    eq(page.dialogs.length, 1, 'alice 還沒被問過 → 問一次');
    eq(await page.evaluate(()=>Object.keys(store.vsrs).filter(id=>store.vsrs[id].seen>0)), ['f-v1'], '換回 alice 看到 alice 的紀錄');
    eq(seenIds(await ls(page, KB)), [bobCard], 'bob 的紀錄不受影響');
    eq(seenIds(drive.files[ALICE].body.store), ['f-v1'], 'alice 的雲端檔沒有混進別人的紀錄');
    eq(seenIds(drive.files[BOB].body.store), [bobCard], 'bob 的雲端檔沒有混進別人的紀錄');
    eq(page.errors, [], '換帳號過程沒有 JS 錯誤');
    await page.close();

    /* 5. 訪客併入：以 bob 登入並同意 */
    await hubSet(ctx1, BOB);
    page = await open(ctx1, FR, false);
    await synced(page);
    eq(page.dialogs, [], 'bob 問過了、訪客紀錄沒變 → 不再詢問');
    await page.close(); await hubSet(ctx1, null);
    page = await open(ctx1, FR);
    const guestCard2 = await practise(page);            // 訪客紀錄有新變動
    await page.close(); await hubSet(ctx1, BOB);
    page = await open(ctx1, FR, true);                  // 這次同意併入
    await synced(page);
    eq(page.dialogs.length, 1, '訪客紀錄有新變動 → 再問一次');
    eq(seenIds(await ls(page, KB)), [bobCard, guestCard, guestCard2].sort(), '同意 → 訪客紀錄併入 bob');
    eq(await ls(page, K), null, '併入後清空訪客紀錄');
    eq(seenIds(drive.files[BOB].body.store), [bobCard, guestCard, guestCard2].sort(), '併入結果已推上 bob 的雲端檔');
    eq(seenIds(await ls(page, KA)), ['f-v1'], 'alice 的紀錄仍不受影響');
    eq(page.errors, [], '訪客併入沒有 JS 錯誤');
    await page.close();
  }

  /* ── 6. 第二台裝置登入 alice：先拉回雲端紀錄；debounce push；hidden 立即 push ── */
  const ctx2 = await newCtx();
  let dev2Card, dev2Card2;
  {
    await hubSet(ctx2, ALICE);
    let page;
    const logStart = drive.log.length;
    page = await open(ctx2, FR);
    await synced(page);
    eq(page.dialogs, [], '新裝置沒有訪客紀錄 → 不詢問');
    eq(seenIds(await ls(page, KA)), ['f-v1'], '新裝置拉回 alice 的雲端紀錄');
    eq((await ls(page, KA)).vsrs['f-v1'].star, true, '收藏也同步回來');
    const firstWrite = drive.log.slice(logStart).findIndex(x=>x.method==='PATCH'||x.method==='POST');
    const firstRead = drive.log.slice(logStart).findIndex(x=>x.method==='GET' && /^\/drive\/v3\/files\/./.test(x.path));
    ok(firstRead>=0 && firstRead<firstWrite, '第一次 push 之前先 pull');
    /* 同步完成的整頁重繪不會清掉正在輸入的文字 */
    await page.click('#tabs [data-tab="bank"]');
    await page.fill('#imp-ta', '[{"word":"brouillon"');
    await page.click('#tabs [data-tab="home"]');
    await page.click('#tabs [data-tab="bank"]');
    await page.fill('#imp-ta', '[{"word":"brouillon"');
    await page.evaluate(()=>gdPullAndMerge());
    await synced(page);
    eq(await page.inputValue('#imp-ta'), '[{"word":"brouillon"', '同步重繪保住輸入中的匯入文字');
    await page.click('#tabs [data-tab="home"]');

    dev2Card = await practise(page);
    let w0 = drive.files[ALICE].writes;
    await sleep(5000);
    eq(drive.files[ALICE].writes, w0+1, '練習後 debounce push 一次');
    eq(seenIds(drive.files[ALICE].body.store), ['f-v1', dev2Card].sort(), '雲端有第二台的新進度');
    /* hidden → 立即 push（不等 4 秒） */
    dev2Card2 = await practise(page);
    w0 = drive.files[ALICE].writes;
    await page.evaluate(()=>{ Object.defineProperty(document, 'visibilityState', {value:'hidden', configurable:true}); document.dispatchEvent(new Event('visibilitychange')); });
    await sleep(1200);
    eq(drive.files[ALICE].writes, w0+1, '頁面轉 hidden 時立即 push');
    ok(seenIds(drive.files[ALICE].body.store).includes(dev2Card2), 'hidden push 內容包含最新進度');
    await sleep(4000);
    eq(drive.files[ALICE].writes, w0+1, 'hidden push 後 debounce 計時器已取消，不重複送');
    eq(page.errors, [], '第二台裝置同步沒有 JS 錯誤');
    await page.close();

    /* 第一台回來：拉回第二台的進度 */
    await hubSet(ctx1, ALICE);
    page = await open(ctx1, FR);
    await synced(page);
    eq(seenIds(await ls(page, KA)), ['f-v1', dev2Card, dev2Card2].sort(), '第一台拉回第二台的進度');
    await page.close();
  }

  /* ── 7. pull 失敗時不 push（避免用本機舊資料蓋掉雲端）；恢復後「立即同步」會合併兩邊 ── */
  {
    const ctx = await newCtx();
    await hubSet(ctx, ALICE);
    let page;
    drive.failReads = true;
    page = await open(ctx, FR);
    await page.waitForFunction(()=>!GD.syncing && GD.lastSyncStatus==='fail');
    eq(await chip(page), '同步失敗', 'pull 失敗 → chip 顯示同步失敗');
    const before = JSON.stringify(drive.files[ALICE].body), w0 = drive.files[ALICE].writes;
    const localCard = await practise(page);
    await sleep(5000);
    await page.evaluate(()=>{ Object.defineProperty(document, 'visibilityState', {value:'hidden', configurable:true}); document.dispatchEvent(new Event('visibilitychange')); });
    await sleep(800);
    eq([drive.files[ALICE].writes, JSON.stringify(drive.files[ALICE].body)], [w0, before], 'pull 沒成功過 → debounce 與 hidden 都不 push，雲端原封不動');
    ok(page.warns.some(w=>w.includes('push blocked')), 'push 被閘門擋下');
    eq(seenIds(await ls(page, KA)), [localCard], '本機練習仍存在本機');
    drive.failReads = false;
    await page.click('[data-act="gdSyncNow"]');
    await synced(page);
    eq(seenIds(drive.files[ALICE].body.store), ['f-v1', dev2Card, dev2Card2, localCard].sort(), '恢復後合併：雲端舊進度與本機新進度都在');
    eq(seenIds(await ls(page, KA)), ['f-v1', dev2Card, dev2Card2, localCard].sort(), '本機也有完整紀錄');

    /* 8. 本機紀錄的擁有者 ≠ 登入帳號 → 不 push */
    const wA = drive.writesBy(ALICE), wB = drive.writesBy(BOB), bobBody = JSON.stringify(drive.files[BOB].body);
    await page.evaluate(async()=>{ const e=GD.email, t=GD.session; GD.email='bob@example.com'; GD.session={accessToken:'tok-bob@example.com', expiresAt:t.expiresAt}; await gdPush(false); GD.email=e; GD.session=t; });
    eq([drive.writesBy(ALICE), drive.writesBy(BOB), JSON.stringify(drive.files[BOB].body)], [wA, wB, bobBody], 'storeOwner 與登入 email 不同 → 不 push，bob 的雲端檔不會被 alice 的紀錄蓋掉');
    ok(page.warns.some(w=>w.includes('不屬於目前登入的帳號')), 'owner 檢查擋下 push');

    /* 9. 另一個分頁（首頁）換帳號／登出 → 本頁跟著換 */
    const hub = await open(ctx, HUB);
    await setSession(hub, BOB);
    await page.waitForFunction(()=>storeOwner==='bob@example.com' && !GD.syncing && GD.lastSyncStatus==='ok');
    eq(seenIds(await page.evaluate(()=>store)), seenIds(drive.files[BOB].body.store), '首頁換成 bob → 本頁換成 bob 的紀錄（從雲端拉回）');
    eq(seenIds(await ls(page, KA)), ['f-v1', dev2Card, dev2Card2, localCard].sort(), 'alice 的本機紀錄原封不動');
    await setSession(hub, null);
    await page.waitForFunction(()=>storeOwner===null);
    eq(await chip(page), '未登入', '首頁登出 → 本頁變未登入');
    eq(await page.evaluate(()=>Object.keys(store.vsrs).length), 0, '登出後是空的訪客紀錄');

    /* 從 bfcache 復原（收不到 storage 事件）：以 pageshow 補做帳號核對 */
    await hub.close();
    await page.evaluate(s=>{ localStorage.setItem('langhub_gd_session', JSON.stringify(s)); window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true})); }, sess(BOB));
    await page.waitForFunction(()=>storeOwner==='bob@example.com' && !GD.syncing && GD.lastSyncStatus==='ok');
    ok(true, 'pageshow(persisted) 會重新核對登入帳號');
    const hub2 = await open(ctx, HUB);

    /* 10. 模組內的登出按鈕 */
    await setSession(hub2, ALICE);
    await page.waitForFunction(()=>storeOwner==='alice@example.com' && !GD.syncing && GD.lastSyncStatus==='ok');
    await page.click('#tabs [data-tab="home"]');
    await page.click('[data-act="gdLogout"]');
    eq([await owner(page), await ls(page, 'langhub_gd_session')], [null, null], '登出按鈕清掉共用 session、切回訪客');
    const wEnd = drive.writesBy(ALICE);
    await sleep(4500);
    eq(drive.writesBy(ALICE), wEnd, '登出後不再 push');
    eq(page.errors.filter(e=>!/500/.test(e)), [], '同步失敗／換帳號流程沒有 JS 錯誤（故意製造的 HTTP 500 除外）');
    await ctx.close();
  }

  await browser.close();
  srv.close();
  console.log('fr sync e2e OK：'+passed+' 項檢查通過（登入與 Drive 皆為模擬，未連線真正的 Google）');
})().catch(e=>{ console.error(e); process.exit(1); });
