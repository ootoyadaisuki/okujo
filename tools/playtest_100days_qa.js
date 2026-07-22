'use strict';
// 100日間・クリアなしプレイの専用QA。
// smoke_test.js のロジック不変条件チェックに加えて、実際に render() が書き出す
// innerHTML 本文まで丸ごと記録し、undefined/NaN/画像欠落/表記ゆれ等を機械的に検出する。
// 実行: node tools/playtest_100days_qa.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const IMG_DIR = path.join(ROOT, 'images');
const imgFiles = new Set(fs.readdirSync(IMG_DIR));

function makeContext(rec) {
  const screens = []; // { day, tag, html }
  function trackedEl(id) {
    let _html = '';
    return {
      get innerHTML() { return _html; },
      set innerHTML(v) {
        _html = v;
        if (id === 'screen') screens.push({ day: rec.day, screen: rec.screen, html: v });
      },
      style: {},
    };
  }
  const els = { screen: trackedEl('screen'), 'status-bar': trackedEl('status-bar') };
  const sandbox = {
    document: { getElementById: id => els[id], addEventListener: () => {} },
    window: { addEventListener: () => {} },
    localStorage: { getItem: () => null, setItem: () => {} },
    Audio: class { play() { return Promise.resolve(); } },
    console, Math, JSON,
  };
  vm.createContext(sandbox);
  for (const f of ['js/config.js', 'js/data.js', 'js/customers.js', 'js/audio.js', 'js/game.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  }
  sandbox.__screens = screens;
  return sandbox;
}

const pickPref = (...types) => cs => {
  for (const t of types) { const i = cs.findIndex(c => c.type === t); if (i >= 0) return i; }
  return 0;
};
const best = pickPref('seikai', 'bonda', 'hazure', 'jirai');
const coastPick = pickPref('bonda', 'hazure', 'seikai', 'jirai');

// クリアさせない現実的な「平均プレイヤー」像:
// - 体力・メンタルはそれなりに管理する(smartDayと同じ)が、正答率は低め(35%)
// - おねだりは受けるが常に一番安い銘柄を選ぶ → 売上が伸びず目標100万に届かない
const isWknd = d => ['土', '日'].includes(['金','土','日','月','火','水','木'][(d - 1) % 7]);
const inBreak = d => d >= 7 && d <= 18;
const canUni = d => d <= 43 && !isWknd(d) && !inBreak(d);
const uniPlan = (S) => {
  if (S.uniAttended >= 10 || !canUni(S.day)) return null;
  let left = 0;
  for (let d = S.day; d <= 43; d++) if (canUni(d)) left++;
  const needLeft = 10 - S.uniAttended;
  if (left <= needLeft + 4) return 'uni';
  if (S.day % 3 === 0 && S.stamina >= 40) return 'uni';
  return null;
};
const CFG_LOOKS_CEIL = 45;
const avgDay = (S) => {
  const u = uniPlan(S);
  if (u) return u;
  if (S.stamina < 45) return 'rest';
  if (S.mental < 60) return 'shumi';
  return S.day % 3 === 0 || S.money < 2000 ? 'shumi' : 'dokusho';
};
const smartMenu = (cmd, opts, S) => {
  if (cmd === 'shumi') {
    const want = (S.mental < 55 || S.money < 1800) ? 'haishin' : 'sauna';
    return opts.findIndex(o => o.id === want);
  }
  if (cmd === 'kintore') return opts.findIndex(o => o.id === (S.money >= 3000 ? 'gym' : 'run'));
  if (cmd === 'dokusho') return opts.findIndex(o => o.id === 'jiko');
  return 0;
};
const cheapDrink = () => 0;

function playthrough100(name) {
  const rec = { day: 1, screen: 'title' };
  const ctx = makeContext(rec);
  const { G, State, CONFIG, DATA } = vm.runInContext('({ G, State, CONFIG, DATA })', ctx);
  G.newGame();
  State.dayResult = { notes: [], story: '' };
  State.screen = 'dayResult';

  let guard = 0;
  const log = { explosions: 0, sales: 0 };
  const seed = () => Math.random();

  while (State.screen !== 'ending') {
    rec.day = State.day; rec.screen = State.screen;
    if (++guard > 80000) throw new Error(`${name}: 無限ループ検出 screen=${State.screen}`);

    if (State.screen === 'day') {
      G.pickDay(avgDay(State));
    } else if (State.screen === 'seikeiPart') {
      const parts = CONFIG.parts.order;
      G.pickSeikeiPart(parts[Math.floor(seed() * parts.length)]);
    } else if (State.screen === 'seikeiClinic') {
      G.pickSeikeiClinic(0);
    } else if (State.screen === 'menu') {
      const opts = CONFIG[State.menuCmd].options;
      let idx = smartMenu(State.menuCmd, opts, State);
      if (idx == null || idx < 0) {
        const aff = opts.map((o, i) => [o, i]).filter(([o]) => !(o.cost) || State.money >= o.cost);
        idx = aff.length ? aff[Math.floor(seed() * aff.length)][1] : 0;
      }
      G.pickMenu(idx);
    } else if (State.screen === 'dayResult') {
      if (State.trust < CONFIG.trust.apologizeLine && State.trust > CONFIG.trust.firedLine) G.apologize();
      else if (G.hasMission()) G.toMission();
      else G.toNight();
    } else if (State.screen === 'skipWork') {
      G.endSkipWork();
    } else if (State.screen === 'sunday') {
      if (!State.sunday.picked) {
        const n = (State.sunday.kind === 'honshimei'
          ? DATA.sundayHonshimei.choices : State.sunday.ev.choices).length;
        G.sundayChoice(Math.floor(seed() * n));
      } else G.endSunday();
    } else if (State.screen === 'shukkin') {
      G.enterFloor();
    } else if (State.screen === 'warukuchi') {
      G.endWarukuchi();
    } else if (State.screen === 'nagashiScold') {
      G.endNagashiScold();
    } else if (State.screen === 'scold') {
      G.endScold();
    } else if (State.screen === 'apologize') {
      G.endApologize();
    } else if (State.screen === 'forcedRest') {
      G.endForcedRest();
    } else if (State.screen === 'sick') {
      G.endSick();
    } else if (State.screen === 'fired') {
      G.endFired();
    } else if (State.screen === 'uniEvent') {
      G.endUniEvent();
    } else if (State.screen === 'living') {
      G.endLiving();
    } else if (State.screen === 'biyou') {
      G.endBiyou();
    } else if (State.screen === 'binge') {
      G.endBinge();
    } else if (State.screen === 'tobi') {
      G.endTobi();
    } else if (State.screen === 'puchi') {
      G.endPuchi();
    } else if (State.screen === 'after') {
      if (!State.afterResult) G.afterChoice(Math.floor(seed() * 4));
      else G.endAfter();
    } else if (State.screen === 'mission') {
      if (State.missionPhase === 'offer') G.missionAccept();
      else if (State.missionPhase === 'scene') G.missionChoice(0);
      else if (State.missionPhase === 'result') G.endMission();
      else G.endMissionDecline();
    } else if (State.screen === 'oshiEvent') {
      if (!State.oshiResult) G.oshiChoice(State.money >= State.oshiEvent.cost * 3 ? 0 : 1);
      else G.endOshi();
    } else if (State.screen === 'holiday') {
      const h = DATA.holidays[State.day];
      if (h.choice && !State.holidayPicked) G.holidayChoice(Math.floor(seed() * h.choice.length));
      else G.endHoliday();
    } else if (State.screen === 'mother') {
      const m = State.motherEvent;
      if (m.choice && !State.motherPicked) G.motherChoice(Math.floor(seed() * m.choice.length));
      else G.endMother();
    } else if (State.screen === 'soutai') {
      G.endSoutai();
    } else if (State.screen === 'scene') {
      G.sceneNext();
    } else if (State.screen === 'nightResult') {
      G.toNextDay();
    } else if (State.screen === 'night') {
      if (State.night.showIntro) { State.night.showIntro = false; continue; }
      if (State.night.tutorialIdx != null) { State.night.tutorialIdx = null; continue; }
      const cur = State.night.current;
      if (cur.kind === 'light') {
        if (cur.phase === 'intro') G.startLightTalk();
        else if (cur.phase === 'pick') G.pickLight(0); else G.lightNext();
      } else {
        const m = cur;
        if (m.phase === 'honshimeiCall') G.afterHonshimeiCall();
        else if (m.phase === 'mainIntro') G.startMainTalk();
        else if (m.phase === 'turn') {
          if (m.nadameruWindow) { G.nadameru(); }
          else {
            const useCoast = seed() > 0.35;
            const cs = m.effChoices;
            const wantIdx = (useCoast ? coastPick : best)(cs);
            G.pickChoice(m.choiceOrder.indexOf(wantIdx));
          }
        }
        else if (m.phase === 'react') {
          if (m.result.type === 'explosion') log.explosions++;
          G.afterReact();
        }
        else if (m.phase === 'topicEvent') G.afterTopic();
        else if (m.phase === 'buzzEvent') G.afterBuzz();
        else if (m.phase === 'jonaiGet') G.startJonai();
        else if (m.phase === 'chenji') G.endTable();
        else if (m.phase === 'onedari') {
          if (seed() < 0.5) { log.sales++; G.onedariPick(cheapDrink(m.offer)); }
          else G.onedariPass();
        }
        else if (m.phase === 'onedariResult') { G.afterOnedari(); }
        else if (m.phase === 'tableEnd') { G.endTable(); }
        else throw new Error(`${name}: 未知のphase ${m.phase}`);
      }
    } else {
      throw new Error(`${name}: 未知のscreen ${State.screen}`);
    }
  }
  rec.day = State.day; rec.screen = 'ending';
  return { State, log, screens: ctx.__screens };
}

// ---- 実行 ----
const run = playthrough100('100日クリアなし');
const S = run.State;
console.log(`結果: ${S.win ? 'WIN(想定外)' : 'クリアなしで終了'} 日=${S.day} 金=${S.money.toLocaleString()} loseReason=${S.loseReason || '(期限切れ)'} 画面遷移数=${run.screens.length}`);

// ---- 異常検出パス ----
const issues = [];
const seenExactText = new Map(); // 完全一致本文の連続回数チェック用（コピペ事故検出）
let prevHtml = null, prevRepeat = 0;

for (const s of run.screens) {
  const html = s.html;
  if (html == null) continue;

  // 1) JSのundefined/NaNがテキストに漏れていないか
  if (/undefined/.test(html)) issues.push({ day: s.day, screen: s.screen, kind: 'undefined漏れ', excerpt: excerpt(html, 'undefined') });
  if (/\bNaN\b/.test(html)) issues.push({ day: s.day, screen: s.screen, kind: 'NaN漏れ', excerpt: excerpt(html, 'NaN') });
  if (/¥NaN|¥undefined/.test(html)) issues.push({ day: s.day, screen: s.screen, kind: '金額フォーマット破損', excerpt: excerpt(html, '¥') });

  // 2) テンプレートリテラルの取りこぼし（${...}がそのまま残る）
  if (/\$\{[^}]*\}/.test(html)) issues.push({ day: s.day, screen: s.screen, kind: 'テンプレート未展開', excerpt: excerpt(html, '${') });

  // 3) 空のstory-box（本文が空なのにボックスだけ出る）
  const emptyStory = html.match(/<div class="story-box">\s*<\/div>/);
  if (emptyStory) issues.push({ day: s.day, screen: s.screen, kind: '本文が空のstory-box', excerpt: '(空)' });

  // 4) 画像src参照の欠落チェック
  const imgSrcs = [...html.matchAll(/src="images\/([^"]+)"/g)].map(m => m[1]);
  for (const f of imgSrcs) {
    if (!imgFiles.has(f)) issues.push({ day: s.day, screen: s.screen, kind: '画像ファイル欠落', excerpt: f });
  }

  // 5) マイナス金額の表記（¥-123,456 のように¥の後に-が来る見た目のねじれ）
  const yenMinus = html.match(/¥-[\d,]+/);
  if (yenMinus) issues.push({ day: s.day, screen: s.screen, kind: '金額表記(¥-…の順序)', excerpt: yenMinus[0] });

  // 6) 全く同じ本文HTMLが3回以上連続（コピペ/分岐ミスで同一テキストが繰り返し出る事故）
  if (html === prevHtml) prevRepeat++; else { prevRepeat = 0; prevHtml = html; }
  if (prevRepeat === 2) issues.push({ day: s.day, screen: s.screen, kind: '同一画面が3連続', excerpt: excerpt(html, null) });

  // 7) ボタンのonclickが壊れていないか（onclick="" や G. を含まない主要ボタン）
  const badBtn = html.match(/<button[^>]*onclick=""[^>]*>/);
  if (badBtn) issues.push({ day: s.day, screen: s.screen, kind: '空のonclick', excerpt: badBtn[0] });
}

function excerpt(html, marker) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!marker) return text.slice(0, 80);
  const i = text.indexOf(marker);
  return i < 0 ? text.slice(0, 80) : text.slice(Math.max(0, i - 30), i + 50);
}

console.log(`\n検出された異常候補: ${issues.length}件`);
for (const it of issues.slice(0, 200)) {
  console.log(`  [Day${it.day} / ${it.screen}] ${it.kind}: ${it.excerpt}`);
}
if (issues.length > 200) console.log(`  ...ほか${issues.length - 200}件`);

console.log(`\n爆発回数=${run.log.explosions} 売上本数=${run.log.sales}`);
process.exit(issues.length ? 1 : 0);
