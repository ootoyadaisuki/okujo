'use strict';
// モブ卓「2回目の来店」の機械チェック。
// 実行: node tools/check_mob2.js [チェックしたい配列を持つファイル...]
// 引数なしなら js/data.js の mobTables2 を見る。
//
// 見るのは「本文を読まずに正解が分かってしまう手がかり（テル）」と、書式の事故。
// このゲームは過去に「正解だけが長い」「正解だけが二文構造」で攻略されているので、
// 人間の目より先に、まずここで落とす。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function loadTables(args) {
  if (!args.length) {
    const s = { console, Math, JSON };
    vm.createContext(s);
    for (const f of ['js/config.js', 'js/data.js']) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), s, { filename: f });
    }
    return vm.runInContext('DATA.mobTables2 || []', s);
  }
  // 断片ファイル（配列リテラルの並び）を読む
  const src = args.map(f => fs.readFileSync(f, 'utf8')).join('\n');
  const s = { console, Math, JSON };
  vm.createContext(s);
  return vm.runInContext('[' + src + ']', s).map(([img, job, name, desc, rs]) => ({
    img, job, name, desc,
    rallies: rs.map(([line, ...cs]) => ({
      line, choices: cs.map(([text, drinks, react]) => ({ text, drinks, react })),
    })),
  }));
}

const args = process.argv.slice(2);
const T = loadTables(args);
const errors = [];
const warns = [];
const err = m => errors.push(m);
const warn = m => warns.push(m);

// ---- 書式 ----
const seen = new Set();
for (const t of T) {
  const who = `${t.name}(${t.img})`;
  if (seen.has(t.img + '/' + t.name)) err(`${who}: 同じ人が2回出てくる`);
  seen.add(t.img + '/' + t.name);
  if (!t.desc || t.desc.length > 44) err(`${who}: desc が無いか長すぎる（${(t.desc || '').length}字）`);
  if (t.rallies.length !== 2) err(`${who}: ラリーが${t.rallies.length}本（2本であること）`);
  for (const [ri, r] of t.rallies.entries()) {
    const tag = `${who} ラリー${ri + 1}`;
    if (r.choices.length !== 4) { err(`${tag}: 選択肢が${r.choices.length}個`); continue; }
    const ds = r.choices.map(c => c.drinks).slice().sort().join('');
    if (ds !== '0112') err(`${tag}: ドリンク配分が ${ds}（0/1/1/2 であること）`);
    for (const c of r.choices) {
      if (!c.text || !c.react) err(`${tag}: 選択肢かリアクションが空`);
    }
  }
}

// ---- 表記 ----
const HANKAKU = /[!?]/;
const ASCII_WORD = /[A-Za-z]{2,}/;
for (const t of T) {
  const strs = [t.desc, ...t.rallies.flatMap(r => [r.line, ...r.choices.flatMap(c => [c.text, c.react])])];
  for (const s of strs) {
    if (HANKAKU.test(s)) err(`${t.name}: 半角の ! か ? が入っている → 「${s.slice(0, 30)}」`);
    if (ASCII_WORD.test(s)) warn(`${t.name}: 英字が入っている → 「${s.slice(0, 30)}」`);
  }
}

// ---- テル（1変数で正解が当たるか）----
// 各ラリーで「その特徴を持つ選択肢」を押したときの的中率。25%が当てずっぽう。
const rallies = T.flatMap(t => t.rallies);
function tell(name, pick) {
  let fired = 0, hit = 0;
  for (const r of rallies) {
    const cs = r.choices.map((c, i) => ({ ...c, i }));
    const target = pick(cs);
    if (target == null) continue;
    fired++;
    if (target.drinks === 2) hit++;
  }
  if (!fired) return;
  const rate = hit / fired;
  const line = `  ${name.padEnd(22)} 発火 ${String(Math.round(fired / rallies.length * 100)).padStart(3)}%  的中 ${(rate * 100).toFixed(0).padStart(3)}%`;
  // 高すぎるのはもちろんテルだが、低すぎるのも同じくらいテルになる。
  // 「正解は絶対に最長ではない」と分かれば、それは4択を3択に減らす情報なので。
  // 発火率が十分ある特徴だけ、下側も見る（たまにしか発火しない特徴は0%でも判断材料にならない）
  const bad = rate > 0.45 || (fired >= rallies.length * 0.6 && rate < 0.10);
  if (rate > 0.45) err(`テル「${name}」の的中率 ${(rate * 100).toFixed(0)}%（45%まで）`);
  else if (bad) err(`逆テル「${name}」の的中率 ${(rate * 100).toFixed(0)}%（低すぎ。この特徴を持つ札は正解ではない、と読める）`);
  console.log((bad ? '  ❌' : '  ✅') + line.slice(2));
}

const len = c => c.text.length;
const byLen = cs => cs.slice().sort((a, b) => len(b) - len(a));
const kuten = c => (c.text.match(/。/g) || []).length;
const touten = c => (c.text.match(/、/g) || []).length;

console.log(`\n[テル検出] ${T.length}人・${rallies.length}ラリー。1変数ルールの的中率（当てずっぽう=25%／45%超で不合格）`);
tell('長さ1位', cs => byLen(cs)[0]);
tell('長さ2位', cs => byLen(cs)[1]);
tell('長さ最下位', cs => byLen(cs)[3]);
tell('句点がいちばん多い', cs => {
  const s = cs.slice().sort((a, b) => kuten(b) - kuten(a));
  return kuten(s[0]) > kuten(s[1]) ? s[0] : null;
});
tell('読点がいちばん多い', cs => {
  const s = cs.slice().sort((a, b) => touten(b) - touten(a));
  return touten(s[0]) > touten(s[1]) ? s[0] : null;
});
tell('数字を含む唯一の1本', cs => {
  const h = cs.filter(c => /[0-9０-９一二三四五六七八九十]/.test(c.text));
  return h.length === 1 ? h[0] : null;
});
tell('「──」を含む唯一の1本', cs => {
  const h = cs.filter(c => c.text.includes('──'));
  return h.length === 1 ? h[0] : null;
});
tell('鉤括弧の外に地の文', cs => {
  const h = cs.filter(c => !/^「.*」$/.test(c.text));
  return h.length === 1 ? h[0] : null;
});

// ---- 長さの散らばり ----
let wide = 0;
for (const r of rallies) {
  const ls = r.choices.map(len);
  if (Math.max(...ls) - Math.min(...ls) > 12) wide++;
}
const widePct = wide / rallies.length * 100;
console.log(`\n[長さの散らばり] 最長と最短の差が12字を超えるラリー ${wide}/${rallies.length}（${widePct.toFixed(0)}%）`);
if (widePct > 25) err(`選択肢の長さがばらつきすぎ（${widePct.toFixed(0)}%・25%まで）`);

// 正解が最長になっている割合
const topIsSeikai = rallies.filter(r => byLen(r.choices)[0].drinks === 2).length;
const topPct = topIsSeikai / rallies.length * 100;
console.log(`[正解が最長] ${topIsSeikai}/${rallies.length}（${topPct.toFixed(0)}%・25%が理想、40%超で不合格）`);
if (topPct > 40) err(`正解がいちばん長い割合が高すぎる（${topPct.toFixed(0)}%）`);

// ---- 結果 ----
console.log('');
if (warns.length) {
  console.log(`[注意] ${warns.length}件`);
  warns.slice(0, 20).forEach(w => console.log('  ・' + w));
}
if (errors.length) {
  console.log(`\n[不合格] ${errors.length}件`);
  errors.slice(0, 40).forEach(e => console.log('  ・' + e));
  process.exit(1);
}
console.log(`[合格] ${T.length}人ぶん、書式もテルも基準内`);
