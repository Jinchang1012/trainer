/* family-engine.js — 英文「詞族／同義換字」練習的純邏輯（無 DOM）
 * 掛 window.FamilyEngine（瀏覽器）或 module.exports（node 測試）。
 * 資料格式見 modules/en/data/SPEC-families.md。
 */
(function (root) {
  'use strict';

  var BLANK = '___';

  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }

  /* 正規化使用者輸入／詞：去頭尾空白、連續空白併成一格、彎引號轉直引號、小寫 */
  function norm(s) {
    return String(s == null ? '' : s).replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /* 整字（片語整串）比對：前後不得緊鄰字母／數字／底線／連字號，
     例如 word=form 不會命中 information、forms、platform；片語中的空白可對應任意空白。 */
  function wordRegex(word, flags) {
    var body = String(word).trim().split(/\s+/).map(escRe).join('\\s+');
    return new RegExp('(?<![\\p{L}\\p{N}_-])' + body + '(?![\\p{L}\\p{N}_-])', flags || 'giu');
  }

  /* 把例句中的 word 換成 ___（所有出現處、不分大小寫）。ok=false 代表句中找不到該詞形。 */
  function blankSentence(ex, word) {
    var text = String(ex == null ? '' : ex);
    if (!word || !String(word).trim()) return { text: text, ok: false, count: 0 };
    var re = wordRegex(word, 'giu'), n = 0;
    var out = text.replace(re, function () { n++; return BLANK; });
    return { text: out, ok: n > 0, count: n };
  }

  /* 把例句切成 [{t, hit}]，hit=true 的是 word 出現處（顯示時加粗用） */
  function segments(text, word) {
    text = String(text == null ? '' : text);
    var segs = [], last = 0, m;
    if (!word || !String(word).trim()) return [{ t: text, hit: false }];
    var re = wordRegex(word, 'giu');
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (m.index > last) segs.push({ t: text.slice(last, m.index), hit: false });
      segs.push({ t: m[0], hit: true });
      last = m.index + m[0].length;
    }
    if (last < text.length) segs.push({ t: text.slice(last), hit: false });
    return segs.length ? segs : [{ t: text, hit: false }];
  }

  /* 詞性挖空判題：trim、不分大小寫、空白正規化後完全相同 */
  function checkForm(input, word) {
    var a = norm(input);
    return a !== '' && a === norm(word);
  }

  /* 把 tpl 的 ___ 換成 word；___ 在句首（或句號後）時首字母大寫 */
  function renderTpl(tpl, word) {
    var t = String(tpl == null ? '' : tpl);
    var w = String(word == null ? '' : word);
    return t.replace(/_{3,}/, function (m, off, whole) {
      var before = whole.slice(0, off);
      var atStart = /^\s*$/.test(before) || /[.!?]["')\]]*\s+$/.test(before);
      return atStart && w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
    });
  }

  /* 同義換字判題。frame={ok:[...], best}；exclude=已顯示的成員（換個說法題型，答它不算）。
     回傳 {ok, word(對應 ok 內的標準寫法), best(是否為 best), reason:''|'empty'|'excluded'|'notok'} */
  function checkFrame(input, frame, exclude) {
    var a = norm(input);
    if (!a) return { ok: false, word: null, best: false, reason: 'empty' };
    var list = (frame && frame.ok) || [];
    var hit = null;
    for (var i = 0; i < list.length; i++) if (norm(list[i]) === a) { hit = list[i]; break; }
    if (hit === null) return { ok: false, word: null, best: false, reason: 'notok' };
    if (exclude != null && exclude !== '' && norm(exclude) === a) return { ok: false, word: hit, best: false, reason: 'excluded' };
    return { ok: true, word: hit, best: norm(frame.best) === a, reason: '' };
  }

  /* 加權抽題：答錯過（ng>0）的題權重 2，其餘 1。
     items 每項要有 id；stats[id]={ok,ng,last}；rnd 預設 Math.random；avoidId 盡量不重複上一題。 */
  function weightOf(st) { return (st && st.ng > 0) ? 2 : 1; }
  function pickWeighted(items, stats, rnd, avoidId) {
    if (!items || !items.length) return null;
    rnd = rnd || Math.random;
    stats = stats || {};
    var pool = items;
    if (avoidId != null && items.length > 1) {
      var f = items.filter(function (x) { return x.id !== avoidId; });
      if (f.length) pool = f;
    }
    var total = 0, i;
    for (i = 0; i < pool.length; i++) total += weightOf(stats[pool[i].id]);
    var r = rnd() * total;
    for (i = 0; i < pool.length; i++) {
      r -= weightOf(stats[pool[i].id]);
      if (r < 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  /* 更新單題統計（回傳新物件，不改原物件）。day = 當天的 epoch day */
  function updateStat(st, ok, day) {
    var o = (st && typeof st === 'object') ? st : {};
    return { ok: (o.ok || 0) + (ok ? 1 : 0), ng: (o.ng || 0) + (ok ? 0 : 1), last: day || 0 };
  }

  /* 統計彙總 → {n, ok, ng, acc(0-100 整數或 null)} */
  function summarize(stats) {
    var ok = 0, ng = 0;
    for (var id in (stats || {})) { var s = stats[id]; if (s) { ok += s.ok || 0; ng += s.ng || 0; } }
    var n = ok + ng;
    return { n: n, ok: ok, ng: ng, acc: n ? Math.round(ok / n * 100) : null };
  }

  var api = {
    BLANK: BLANK, norm: norm, wordRegex: wordRegex, blankSentence: blankSentence, segments: segments,
    checkForm: checkForm, renderTpl: renderTpl, checkFrame: checkFrame,
    pickWeighted: pickWeighted, updateStat: updateStat, summarize: summarize
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FamilyEngine = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
