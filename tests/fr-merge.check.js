/* 法文模組 mergeStore() 檢查（不需安裝任何套件）：
 *   node tests/fr-merge.check.js
 * 直接從 modules/fr/index.html 取出 MERGESTORE_BEGIN/END 區塊來跑，測的就是上線的那份程式。
 * 檢查：冪等（同一份併兩次不變）、不丟進度（每張卡／每題保留練習較多的一方）、
 * 兩個方向合併結果等價、自建單字 id 撞號不會蓋掉或混淆、刪除標記、不改動傳入的 incoming。 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'modules', 'fr', 'index.html'), 'utf8');
const m = html.match(/\/\* === MERGESTORE_BEGIN ===[\s\S]*?\/\* === MERGESTORE_END === \*\//);
assert(m, '找不到 MERGESTORE 區塊');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(m[0] + '\n;this.api={mergeStore,normStore,defaults,customKey};', ctx);
const { mergeStore, normStore, defaults, customKey } = ctx.api;

const clone = x => JSON.parse(JSON.stringify(x));
const isCustomId = id => /^f-c\d+$/.test(id);
let checks = 0;
function eq(a, b, msg){ checks++; assert.deepStrictEqual(clone(a), clone(b), msg); }
function ok(v, msg){ checks++; assert(v, msg); }

/* 與 id 編號無關的「內容」表示法：自建單字以內容為鍵、附上它的進度 */
function canon(s){
  s = normStore(clone(s));
  const out = {v:{}, q:{}, h:Object.keys(s.history).filter(d=>s.history[d]).sort(), c:{}, del:s.custom.del};
  Object.keys(s.vsrs).forEach(id=>{ if(!isCustomId(id)) out.v[id]=s.vsrs[id]; });
  Object.keys(s.qstats).forEach(id=>{ if(!isCustomId(id)) out.q[id]=s.qstats[id]; });
  s.custom.vocab.forEach(w=>{
    const k = customKey(w);
    ok(!(k in out.c), '同一份紀錄內不應有內容重複的自建單字');
    out.c[k] = {at:w.at||0, v:s.vsrs[w.id]||null, q:s.qstats[w.id]||null};
  });
  return out;
}
function sortObj(o){ if(Array.isArray(o)) return o.map(sortObj); if(o && typeof o==='object'){ const r={}; Object.keys(o).sort().forEach(k=>r[k]=sortObj(o[k])); return r; } return o; }
const core = r => r ? {box:r.box, due:r.due, seen:r.seen||0} : null;

/* 一組 (A,B) 的全部性質 */
function checkPair(A, B, label){
  const A0 = clone(A), B0 = clone(B);
  const M = clone(A);
  mergeStore(M, B);
  eq(B, B0, label+'：incoming 不可被改動');

  /* 冪等 */
  const M2 = clone(M);
  const n2 = mergeStore(M2, B);
  eq(M2, M, label+'：同一份併入第二次不可有變動');
  eq(n2, {vsrs:0, qstats:0, hist:0, custom:0}, label+'：第二次併入的變動計數應為 0');
  const M3 = clone(M);
  mergeStore(M3, A0);
  eq(M3, M, label+'：把原本的本機紀錄再併回來不可有變動');
  const S = clone(A);
  mergeStore(S, A0);
  eq(S, normStore(clone(A0)), label+'：自己併自己不可有變動');

  /* 兩個方向等價（自建單字的 id 編號可以不同，內容與進度要相同） */
  const R = clone(B);
  mergeStore(R, A0);
  eq(sortObj(canon(M)), sortObj(canon(R)), label+'：A←B 與 B←A 結果應等價');

  /* 不丟進度 */
  const cA = canon(A0), cB = canon(B0), cM = canon(M);
  new Set(Object.keys(cA.v).concat(Object.keys(cB.v))).forEach(id=>{
    const a=cA.v[id], b=cB.v[id], r=cM.v[id];
    ok(r, label+'：vsrs '+id+' 不見了');
    ok((r.seen||0) === Math.max(a?a.seen||0:0, b?b.seen||0:0), label+'：vsrs '+id+' 應保留複習次數較多的一方');
    ok([a,b].some(x=>x && JSON.stringify(core(x))===JSON.stringify(core(r))), label+'：vsrs '+id+' 必須是其中一方的紀錄');
    const st = Math.max(a?a.st||0:0, b?b.st||0:0);
    const want = [a,b].filter(x=>x && (x.st||0)===st);
    ok(!!r.star === want.some(x=>x.star), label+'：vsrs '+id+' 收藏狀態應以較晚改動的一方為準（同時則聯集）');
  });
  new Set(Object.keys(cA.q).concat(Object.keys(cB.q))).forEach(id=>{
    const a=cA.q[id], b=cB.q[id], r=cM.q[id];
    ok(r, label+'：qstats '+id+' 不見了');
    ok(r.a === Math.max(a?a.a:0, b?b.a:0), label+'：qstats '+id+' 應保留作答次數較多的一方');
    ok([a,b].some(x=>x && x.a===r.a && x.c===r.c), label+'：qstats '+id+' 必須是其中一方的紀錄');
  });
  cA.h.concat(cB.h).forEach(d=>ok(cM.h.indexOf(d)>=0, label+'：history '+d+' 不見了'));

  /* 自建單字：沒被刪除的都要在，進度沒有被別的字混進來 */
  const del = {};
  [cA.del, cB.del].forEach(dm=>Object.keys(dm).forEach(k=>{ del[k]=Math.max(del[k]||0, dm[k]); }));
  new Set(Object.keys(cA.c).concat(Object.keys(cB.c))).forEach(k=>{
    const a=cA.c[k], b=cB.c[k], r=cM.c[k];
    const at = Math.max(a?a.at:0, b?b.at:0);
    const deleted = (del[k]||0)>0 && del[k]>=at;
    if(deleted){ ok(!r, label+'：已刪除的自建單字不應被加回來'); return; }
    ok(r, label+'：自建單字不見了：'+k.split('\u0001')[0]);
    const seen = Math.max(a&&a.v?a.v.seen||0:0, b&&b.v?b.v.seen||0:0);
    ok((r.v?r.v.seen||0:0) === seen, label+'：自建單字的複習進度應等於兩邊較多的一方');
    if(r.v) ok([a,b].some(x=>x && x.v && JSON.stringify(core(x.v))===JSON.stringify(core(r.v))), label+'：自建單字的進度必須來自同一個字');
    const qa = Math.max(a&&a.q?a.q.a:0, b&&b.q?b.q.a:0);
    ok((r.q?r.q.a:0) === qa, label+'：自建單字的測驗統計應等於兩邊較多的一方');
  });
  Object.keys(cM.c).forEach(k=>ok(cA.c[k]||cB.c[k], label+'：合併後多出不存在的自建單字'));
  const ids = normStore(clone(M)).custom.vocab.map(w=>w.id);
  ok(new Set(ids).size===ids.length, label+'：自建單字 id 不可重複');
  ok(ids.every(id=>+id.slice(3) < M.custom.seq), label+'：custom.seq 必須大於所有已用編號');
  return M;
}

/* ── 固定案例：兩台裝置各自練習後分歧 ── */
const word = (id, w, extra) => Object.assign({id, theme:'quotidien', themeName:'日常生活與作息', word:w, pos:'n.', meaning:w+'的意思', example:'', exampleZh:'', collocations:[], freq:'中頻', tip:'', stars:3}, extra||{});
const A = {
  vsrs:{
    'f-v1':{box:3,due:20410,seen:6,star:true},            // A 練得多
    'f-v2':{box:1,due:20401,seen:2,star:false},           // B 練得多
    'f-v3':{box:2,due:20405,seen:3,star:false},           // 次數相同，A 盒數高
    'f-v4':{box:0,due:20400,seen:0,star:true,st:1000},    // A 先收藏，B 之後取消
    'f-c1':{box:2,due:20404,seen:4,star:false},           // A 的 f-c1 = chat
  },
  qstats:{'f-v1':{a:5,c:4,lw:false}, 'f-v2':{a:1,c:0,lw:true}, 'f-c1':{a:2,c:2,lw:false}},
  history:{20398:true, 20399:true},
  custom:{vocab:[word('f-c1','chat'), word('f-c2','lait')], seq:3},
};
const B = {
  vsrs:{
    'f-v1':{box:1,due:20402,seen:2,star:false},
    'f-v2':{box:4,due:20420,seen:7,star:false},
    'f-v3':{box:1,due:20409,seen:3,star:false},
    'f-v4':{box:0,due:20400,seen:0,star:false,st:2000},
    'f-v5':{box:1,due:20401,seen:1,star:false},           // 只有 B 有
    'f-c1':{box:4,due:20430,seen:9,star:true},            // B 的 f-c1 = chien（與 A 撞號、不同字）
    'f-c2':{box:1,due:20401,seen:1,star:false},           // B 的 f-c2 = chat（與 A 的 f-c1 同一個字）
  },
  qstats:{'f-v1':{a:2,c:2,lw:false}, 'f-v2':{a:4,c:3,lw:false}, 'f-c1':{a:6,c:5,lw:false}},
  history:{20399:true, 20400:true},
  custom:{vocab:[word('f-c1','chien'), word('f-c2','chat')], seq:3},
};
const M = checkPair(A, B, '固定案例 A←B');
checkPair(B, A, '固定案例 B←A');
eq(M.vsrs['f-v1'], {box:3,due:20410,seen:6,star:true}, 'f-v1 應保留 A（練習較多）');
eq(M.vsrs['f-v2'], {box:4,due:20420,seen:7,star:false}, 'f-v2 應保留 B（練習較多）');
eq(M.vsrs['f-v3'].box, 2, 'f-v3 次數相同取盒數高的');
eq(M.vsrs['f-v4'].star, false, 'f-v4 較晚的取消收藏要生效');
eq(M.qstats['f-v1'], {a:5,c:4,lw:false}, 'qstats f-v1 取 A');
eq(M.qstats['f-v2'], {a:4,c:3,lw:false}, 'qstats f-v2 取 B');
eq(Object.keys(M.history).sort(), ['20398','20399','20400'], 'history 取聯集');
eq(M.custom.vocab.map(w=>w.word).sort(), ['chat','chien','lait'], '三個自建單字都要在');
const idOf = w => M.custom.vocab.find(x=>x.word===w).id;
eq(idOf('chat'), 'f-c1', '本機的 chat 維持原 id');
ok(idOf('chien')!=='f-c1' && idOf('chien')!=='f-c2', 'chien 撞號，要換新 id');
eq(M.vsrs[idOf('chat')].seen, 4, 'chat 的進度：A 4 次 vs B 1 次 → 4，不可被 chien 的 9 次蓋掉');
eq(M.vsrs[idOf('chien')].seen, 9, 'chien 的進度跟著它的新 id');
eq(M.qstats[idOf('chien')].a, 6, 'chien 的測驗統計跟著它的新 id');
eq(M.qstats[idOf('chat')].a, 2, 'chat 的測驗統計不可被 chien 的蓋掉');

/* ── 固定案例：刪除標記、空白與壞資料 ── */
(function(){
  const kChat = customKey(word('x','chat'));
  const L = {vsrs:{}, qstats:{}, history:{}, custom:{vocab:[word('f-c1','chat')], seq:2}};
  const D = {vsrs:{}, qstats:{}, history:{}, custom:{vocab:[], seq:2, del:{[kChat]:5000}}};
  const r = checkPair(L, D, '刪除標記');
  eq(r.custom.vocab.length, 0, '別台刪掉的字，本機也要刪掉');
  const Re = {vsrs:{}, qstats:{}, history:{}, custom:{vocab:[word('f-c1','chat',{at:6000})], seq:2}};
  const r2 = checkPair(D, Re, '刪除後重新匯入');
  eq(r2.custom.vocab.map(w=>w.word), ['chat'], '刪除之後才重新加入的字要保留');

  const E = defaults();
  eq(mergeStore(clone(E), undefined), {vsrs:0,qstats:0,hist:0,custom:0}, '併入 undefined 不出錯');
  const bad = {vsrs:{'f-v1':null,'f-v2':'x','f-v3':{box:1}}, qstats:{'f-v1':7}, history:[1,2], custom:{vocab:[null,{word:'x'},7], seq:'a'}};
  const E2 = clone(E);
  mergeStore(E2, bad);
  eq(E2, normStore(clone(E)), '壞資料一律不收');
  const old = {vsrs:{'f-v1':{box:1,due:5,seen:1,star:false}}, custom:{vocab:[word('f-c1','chat')], seq:2}};   // 舊版紀錄：沒有 qstats/history/del
  checkPair(old, B, '舊版紀錄');
  /* 本機殘留進度（單字已刪、進度還在）的 id 不可被別台的新單字沿用 */
  const O = {vsrs:{'f-c1':{box:4,due:9,seen:9,star:false}}, qstats:{}, history:{}, custom:{vocab:[], seq:2}};
  const N = {vsrs:{'f-c1':{box:1,due:3,seen:1,star:false}}, qstats:{}, history:{}, custom:{vocab:[word('f-c1','lune')], seq:2}};
  const r3 = clone(O); mergeStore(r3, N);
  const lune = r3.custom.vocab[0];
  ok(lune.id!=='f-c1' && r3.vsrs[lune.id].seen===1, '殘留進度不可套到別台的新單字上');
})();

/* ── 隨機案例 ── */
let seed = 20261116;
function rnd(n){ seed = (seed*1103515245 + 12345) >>> 0; return Math.floor(seed/4294967296*n); }
const POOL = ['chat','chien','lait','pain','lune','mer','ciel'];
function randStore(){
  const s = {vsrs:{}, qstats:{}, history:{}, custom:{vocab:[], seq:1, del:{}}};
  for(let i=1;i<=10;i++){
    if(rnd(3)){ const r={box:rnd(5), due:20390+rnd(30), seen:rnd(6), star:!rnd(3)}; if(!rnd(2)) r.st=1000+rnd(5); s.vsrs['f-v'+i]=r; }
    if(rnd(2)){ const a=rnd(6); s.qstats['f-v'+i]={a, c:rnd(a+1), lw:!rnd(2)}; }
  }
  for(let d=0;d<8;d++) if(rnd(2)) s.history[20390+d]=true;
  const words = POOL.slice().sort(()=>rnd(3)-1).slice(0, rnd(POOL.length+1));
  words.forEach(w=>{
    s.custom.seq += rnd(2);                      // 偶爾跳號（模擬刪過字）
    const id = 'f-c'+(s.custom.seq++);
    const it = word(id, w);
    if(rnd(2)) it.at = 100+rnd(6);
    s.custom.vocab.push(it);
    if(rnd(2)) s.vsrs[id] = {box:rnd(5), due:20390+rnd(30), seen:rnd(6), star:!rnd(3)};
    if(rnd(2)){ const a=rnd(6); s.qstats[id]={a, c:rnd(a+1), lw:!rnd(2)}; }
  });
  POOL.forEach(w=>{ if(!rnd(5)) s.custom.del[customKey(word('x',w))] = 100+rnd(6); });
  /* 自己的刪除標記對自己已經生效（上線的程式刪字時就會移除） */
  s.custom.vocab = s.custom.vocab.filter(w=>{ const t=s.custom.del[customKey(w)]||0; const gone=t>0 && t>=(w.at||0); if(gone){ delete s.vsrs[w.id]; delete s.qstats[w.id]; } return !gone; });
  return s;
}
const N_RANDOM = 400;
for(let i=0;i<N_RANDOM;i++){
  const a = randStore(), b = randStore();
  checkPair(a, b, '隨機#'+i);
}

/* ── 三台裝置輪流「拉取→合併→推回」：兩輪後內容一致；再一輪讓編號計數器（custom.seq）取齊後，就完全不再變動 ── */
for(let i=0;i<60;i++){
  const dev = [randStore(), randStore(), randStore()];
  let cloud = null;
  const sync = d => { if(cloud) mergeStore(d, cloud); cloud = clone(d); };
  for(let round=0; round<2; round++) dev.forEach(sync);
  const c0 = sortObj(canon(dev[0]));
  dev.forEach((d,k)=>eq(sortObj(canon(d)), c0, '三裝置#'+i+'：裝置 '+k+' 與其他裝置內容不一致'));
  dev.forEach(sync);
  dev.forEach((d,k)=>eq(sortObj(canon(d)), c0, '三裝置#'+i+'：第三輪不應改變內容（裝置 '+k+'）'));
  const snap = dev.map(clone);
  dev.forEach(sync);
  dev.forEach((d,k)=>eq(d, snap[k], '三裝置#'+i+'：收斂後再同步不應有任何變動'));
}

console.log('fr mergeStore OK：'+checks+' 項檢查通過（固定案例 + '+N_RANDOM+' 組隨機紀錄 + 60 組三裝置輪流同步）');
