'use strict';
// =========================================================================
// 1画面に収める ── 描画のたびに、はみ出していたら全体を縮める
//
//   小さいスマホ（375×667）で全37画面を測ったら、タイトルと導入以外は
//   全部はみ出していた。いちばん重い夜の卓で 1528px＝画面の2.3倍。
//   画面ごとに手で詰めても、文章を1行足した瞬間にまた溢れる。
//   なので「入るまで縮める」を1か所で持つ。
//
//   縮める順番は、読みやすさを壊さない順：
//     1. 行間（--lh 1.8 → 1.45）。ここがいちばん効いて、いちばん気づかれない
//     2. 全体の縮小率（--fit 1 → 0.72）。文字・余白・画像の天井に一括で効く
//   それでも入らない画面は、はみ出し量を console に出す（＝直すべき設計の問題）。
//
//   ※ CSS だけでは解けない。文章量が画面ごとに違うので、実測して合わせるしかない。
// =========================================================================

const Fit = (() => {
  const MIN_FIT = 0.72;   // 通常はここまで。これ以上は小さくしない（読めなくなる）
  const TIGHT_FIT = 0.62; // 詰めモードでも入らない画面だけ、もう一段だけ許す
                          // （320×768未満の端末でしか到達しない）
  const MAX_LH  = 1.8;
  const MIN_LH  = 1.45;
  let raf = null;

  function apply(fit, lh) {
    const r = document.documentElement.style;
    r.setProperty('--fit', String(fit));
    r.setProperty('--lh', String(lh));
  }

  // 本文が、与えられた高さに収まっているか。
  // ※ #app を測ってはいけない。高さ固定＋overflow:hidden なので
  //   scrollHeight と clientHeight が常に一致し、はみ出しが永遠に0に見える。
  function overflow() {
    const sc = document.getElementById('screen');
    if (!sc) return 0;
    return sc.scrollHeight - sc.clientHeight;
  }

  // 行間 → 縮小率 の順に詰める。入ったところで打ち切る
  function squeeze(floor) {
    apply(1, MAX_LH);
    if (overflow() <= 0) return true;
    for (let lh = MAX_LH; lh >= MIN_LH; lh -= 0.05) {
      apply(1, lh);
      if (overflow() <= 0) return true;
    }
    for (let f = 0.98; f >= floor; f -= 0.02) {
      apply(f, MIN_LH);
      if (overflow() <= 0) return true;
    }
    return false;
  }

  function run() {
    raf = null;
    document.body.classList.remove('is-tight');
    if (squeeze(MIN_FIT)) return;

    // 限界まで縮めても入らない画面（320×568の昼コマンドなど）は、
    // 二次的な情報を落としてからもう一度やる
    document.body.classList.add('is-tight');
    if (squeeze(TIGHT_FIT)) return;

    const over = overflow();
    if (over > 0) console.warn('[fit] まだ ' + over + 'px はみ出している：' + (window.State && State.screen));
  }

  // render() のたびに呼ばれる。1フレームにまとめる（連続描画で何度も測らない）
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(run);
  }

  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  return { schedule, run };
})();
