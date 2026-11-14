/* FSRS-6 排程核心（純函式、無相依）：全域 FSRS6。
 * 公式與預設參數依 open-spaced-repetition 的 FSRS-6（對照 ts-fsrs 5.4.2 驗證，數值誤差 < 1e-6）。
 * 記憶狀態：s＝穩定度（天；回想率從 100% 掉到 90% 所需的天數）、d＝難度（1~10）。
 * 評分 g：1 忘了（Again）、2 勉強（Hard）、3 記得（Good）、4 很熟（Easy）。
 * 用法：
 *   var m = FSRS6.next(null, 0, 3);                 // 新卡第一次作答
 *   m = FSRS6.next(m, elapsedDays, g);              // 之後每次複習（elapsedDays＝距上次複習幾天，0＝同一天）
 *   var days = FSRS6.interval(m.s, 0.9, 365);       // 目標保留率 90% 時，幾天後再複習
 *   var r = FSRS6.retrievability(elapsedDays, m.s); // 現在還記得的機率
 */
(function (root) {
  'use strict';
  var W = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
           1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];
  var S_MIN = 0.001, S_MAX = 36500;
  var DECAY = -W[20];
  var FACTOR = Math.exp(Math.log(0.9) / DECAY) - 1;

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
  function retrievability(t, s) { return Math.pow(1 + FACTOR * t / s, DECAY); }
  function initS(g) { return Math.max(W[g - 1], 0.1); }
  function initDRaw(g) { return W[4] - Math.exp((g - 1) * W[5]) + 1; }
  function initD(g) { return clamp(initDRaw(g), 1, 10); }
  function nextD(d, g) {
    var delta = -W[6] * (g - 3);
    var nd = d + delta * (10 - d) / 9;                       // linear damping
    return clamp(W[7] * initDRaw(4) + (1 - W[7]) * nd, 1, 10); // mean reversion toward D0(Easy)
  }
  function recallS(d, s, r, g) {
    var hard = g === 2 ? W[15] : 1, easy = g === 4 ? W[16] : 1;
    return clamp(s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - r) * W[10]) - 1) * hard * easy), S_MIN, S_MAX);
  }
  function forgetS(d, s, r) {
    return clamp(W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]), S_MIN, S_MAX);
  }
  function shortTermS(s, g) {
    var sinc = Math.pow(s, -W[19]) * Math.exp(W[17] * (g - 3 + W[18]));
    if (g >= 2) sinc = Math.max(sinc, 1);
    return clamp(s * sinc, S_MIN, S_MAX);
  }
  /* state：null（新卡）或 {s,d}；t：距上次複習的天數（>=0）；g：1~4。回傳新的 {s,d}。 */
  function next(state, t, g) {
    if (!state || !(state.s > 0) || !(state.d >= 1)) return { s: initS(g), d: initD(g) };
    var s = state.s, d = state.d, ns;
    t = Math.max(0, t || 0);
    if (t === 0) ns = shortTermS(s, g);
    else if (g === 1) ns = clamp(s / Math.exp(W[17] * W[18]), S_MIN, forgetS(d, s, retrievability(t, s)));
    else ns = recallS(d, s, retrievability(t, s), g);
    return { s: ns, d: nextD(d, g) };
  }
  /* 依目標保留率（0.7~0.99）把穩定度換成複習間隔（天，至少 1） */
  function interval(s, retention, maxDays) {
    var r = clamp(retention || 0.9, 0.7, 0.99);
    var mod = (Math.pow(r, 1 / DECAY) - 1) / FACTOR;
    return Math.min(Math.max(1, Math.round(s * mod)), maxDays || 36500);
  }
  var api = { W: W, next: next, interval: interval, retrievability: retrievability, initS: initS, initD: initD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FSRS6 = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
