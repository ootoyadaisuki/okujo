'use strict';
// ゲームロジックの自動プレイテスト。DOMをスタブして全ルートを回す。
// 実行: node tools/smoke_test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeContext() {
  const el = () => ({ innerHTML: '', style: {} });
  const els = { screen: el(), 'status-bar': el() };
  const sandbox = {
    document: { getElementById: id => els[id], addEventListener: () => {} },
    window: { addEventListener: () => {} },
    console, Math, JSON,
  };
  vm.createContext(sandbox);
  for (const f of ['js/config.js', 'js/data.js', 'js/customers.js', 'js/game.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox;
}

// policy:
//   dayCmd(State) → 昼コマンドid
//   menuPick(cmd, options, State) → メニュー項目index（省略時は買える中からランダム）
//   choose(choices, State, m) → 選択肢index（choices は疲れ選択肢混入後の実効リスト）
//   onedari(State, m) → bool
//   useNadameru → bool
function playthrough(name, policy, quiet) {
  const ctx = makeContext();
  const { G, State, CONFIG, DATA } = vm.runInContext('({ G, State, CONFIG, DATA })', ctx);
  G.newGame();
  // イントロスキップ→初日は昼なしで即出勤（本編と同じ流れ）
  State.dayResult = { notes: [], story: '' };
  State.screen = 'dayResult';

  let guard = 0;
  const log = { explosions: 0, sales: 0, nadameru: 0, forcedRests: 0, jonai: 0, chenji: 0, soutai: 0, sick: 0, weird: 0, seikei: 0, uniEvents: 0 };

  while (State.screen !== 'ending') {
    if (++guard > 60000) throw new Error(`${name}: 無限ループ検出 screen=${State.screen}`);

    if (State.screen === 'day') {
      G.pickDay(policy.dayCmd(State));
    } else if (State.screen === 'seikeiPart') {
      const parts = CONFIG.parts.order;
      G.pickSeikeiPart(parts[Math.floor(Math.random() * parts.length)]);
    } else if (State.screen === 'seikeiClinic') {
      let pick = 0;
      for (let i = CONFIG.seikei.clinics.length - 1; i >= 0; i--) {
        if (State.money >= CONFIG.seikei.clinics[i].cost) { pick = i; break; }
      }
      log.seikei++;
      G.pickSeikeiClinic(pick);
    } else if (State.screen === 'menu') {
      const opts = CONFIG[State.menuCmd].options;
      let idx;
      if (policy.menuPick) idx = policy.menuPick(State.menuCmd, opts, State);
      if (idx == null || idx < 0) {
        const aff = opts.map((o, i) => [o, i]).filter(([o]) => !(o.cost) || State.money >= o.cost);
        idx = aff[Math.floor(Math.random() * aff.length)][1];
      }
      G.pickMenu(idx);
    } else if (State.screen === 'dayResult') {
      if (State.trust < CONFIG.trust.apologizeLine && State.trust > CONFIG.trust.firedLine) G.apologize();
      else if (policy.nagashi && policy.nagashi(State)) G.toNightNagashi();
      else G.toNight();
    } else if (State.screen === 'skipWork') {
      G.endSkipWork();
    } else if (State.screen === 'scold') {
      log.scold = (log.scold || 0) + 1;
      G.endScold();
    } else if (State.screen === 'apologize') {
      G.endApologize();
    } else if (State.screen === 'forcedRest') {
      log.forcedRests++;
      G.endForcedRest();
    } else if (State.screen === 'sick') {
      log.sick++;
      G.endSick();
    } else if (State.screen === 'fired') {
      G.endFired();
    } else if (State.screen === 'uniEvent') {
      log.uniEvents++;
      G.endUniEvent();
    } else if (State.screen === 'living') {
      log.living = (log.living || 0) + 1;
      G.endLiving();
    } else if (State.screen === 'biyou') {
      log.biyou = (log.biyou || 0) + 1;
      G.endBiyou();
    } else if (State.screen === 'binge') {
      log.binge = (log.binge || 0) + 1;
      G.endBinge();
    } else if (State.screen === 'tobi') {
      log.tobi = (log.tobi || 0) + 1;
      G.endTobi();
    } else if (State.screen === 'puchi') {
      log.puchi = (log.puchi || 0) + 1;
      G.endPuchi();
    } else if (State.screen === 'after') {
      if (!State.afterResult) { log.after = (log.after || 0) + 1; G.afterChoice(Math.floor(Math.random() * 4)); }
      else G.endAfter();
    } else if (State.screen === 'mission') {
      if (State.missionPhase === 'offer') {
        log.missions = (log.missions || 0) + 1;
        if (policy.declineMission) G.missionDecline(); else G.missionAccept();
      }
      else if (State.missionPhase === 'scene') G.missionChoice(0);
      else if (State.missionPhase === 'result') G.endMission();
      else G.endMissionDecline();
    } else if (State.screen === 'oshiEvent') {
      // 余裕があれば買う・なければ我慢（平均的なプレイヤー像）
      if (!State.oshiResult) G.oshiChoice(State.money >= State.oshiEvent.cost * 3 ? 0 : 1);
      else G.endOshi();
    } else if (State.screen === 'holiday') {
      const h = DATA.holidays[State.day];
      if (h.choice && !State.holidayPicked) G.holidayChoice(Math.floor(Math.random() * h.choice.length));
      else G.endHoliday();
    } else if (State.screen === 'soutai') {
      log.soutai++;
      G.endSoutai();
    } else if (State.screen === 'nightResult') {
      G.toNextDay();
    } else if (State.screen === 'night') {
      if (State.night.showIntro) { State.night.showIntro = false; continue; }
      const cur = State.night.current;
      if (cur.kind === 'light') {
        if (cur.weird && cur.phase === 'intro') log.weird++;
        if (cur.phase === 'intro') G.startLightTalk();
        else if (cur.phase === 'pick') G.pickLight(0); else G.lightNext();
      } else {
        const m = cur;
        if (m.phase === 'mainIntro') { G.startMainTalk(); }
        else if (m.phase === 'turn') {
          if (m.nadameruWindow && policy.useNadameru) { log.nadameru++; G.nadameru(); }
          else {
            const wantIdx = policy.choose(m.effChoices, State, m);
            if (wantIdx < 0 || wantIdx >= m.effChoices.length) throw new Error(`${name}: 選択肢index不正 ${wantIdx}`);
            G.pickChoice(m.choiceOrder.indexOf(wantIdx));
          }
        }
        else if (m.phase === 'react') {
          if (m.result.type === 'explosion') log.explosions++;
          G.afterReact();
        }
        else if (m.phase === 'topicEvent') { log.topics = (log.topics || 0) + 1; G.afterTopic(); }
        else if (m.phase === 'buzzEvent') { log.buzz = (log.buzz || 0) + 1; G.afterBuzz(); }
        else if (m.phase === 'jonaiGet') { log.jonai++; G.startJonai(); }
        else if (m.phase === 'chenji') { log.chenji++; G.endTable(); }
        else if (m.phase === 'onedari') { G.onedari(policy.onedari(State, m)); }
        else if (m.phase === 'onedariResult') { if (m.onedariResult.ok) log.sales++; G.afterOnedari(); }
        else if (m.phase === 'tableEnd') { G.endTable(); }
        else throw new Error(`${name}: 未知のphase ${m.phase}`);
      }
    } else {
      throw new Error(`${name}: 未知のscreen ${State.screen}`);
    }
  }

  const bans = Object.keys(State.cust).filter(id => State.cust[id].banned);
  const fired = State.loseReason === 'fired';
  if (!quiet) console.log(`[${name}] ${State.win ? 'WIN ' : fired ? 'クビ ' : 'LOSE'} 金=${State.money.toLocaleString().padStart(8)} 日=${String(State.day).padStart(2)} 場内=${String(log.jonai).padStart(2)} 売上=${String(log.sales).padStart(2)} 爆発=${log.explosions} 早退=${log.soutai} 欠勤=${log.forcedRests} 病気=${log.sick} 整形=${log.seikei} 容姿=${String(State.stats.looks).padStart(3)} 信頼=${String(State.trust).padStart(3)} 体上限=${State.staminaMax} 出禁=[${bans}]`);
  return { State, log, bans, win: State.win, fired };
}

// 選択肢タイプの優先順で選ぶ（実効リストに正解がない＝メンタル崩壊時はマシな方へフォールバック）
const pickPref = (...types) => cs => {
  for (const t of types) { const i = cs.findIndex(c => c.type === t); if (i >= 0) return i; }
  return 0;
};
const best = pickPref('seikai', 'bonda', 'hazure', 'jirai');
const coastPick = pickPref('bonda', 'hazure', 'seikai', 'jirai');
const aff = (S, m) => S.cust[m.cust.id].affection;

// 大学の出席計画（土日・冬休みを避け、締切が近づいたら最優先）
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
// 体力・メンタルを管理する標準的な昼コマンドとメニュー選択
const smartDay = (S) => {
  const u = uniPlan(S);
  if (u) return u;
  if (S.stamina < 45) return 'rest';
  if (S.mental < 60) return 'shumi';
  return S.day % 3 === 0 || S.money < 2000 ? 'shumi' : 'dokusho';
};
// メンタルが危ない夜は流しで客を守る（落差ルール下の人間の立ち回り）
const smartNagashi = (S) => S.mental < 50;
// 大学をサボる版（留年テスト用）
const noUniDay = (S) => {
  if (S.stamina < 45) return 'rest';
  if (S.mental < 50) return 'shumi';
  return S.day % 3 === 0 || S.money < 2000 ? 'shumi' : 'dokusho';
};
const smartMenu = (cmd, opts, S) => {
  if (cmd === 'shumi') {
    const want = (S.money >= 15000 && S.mental < 55) ? 'genba' : 'haishin';
    return opts.findIndex(o => o.id === want);
  }
  if (cmd === 'kintore') return opts.findIndex(o => o.id === (S.money >= 3000 ? 'gym' : 'run'));
  if (cmd === 'dokusho') return opts.findIndex(o => o.id === 'jiko');
  return 0;
};
const stdOnedari = (S, m) => aff(S, m) >= 85 || (m.turn + 1 === 5 && aff(S, m) >= 72);

// 1) 最適プレイ: 全卓で正解を刺し続ける
const bestRun = playthrough('最適プレイ　　', {
  dayCmd: smartDay, menuPick: smartMenu, nagashi: smartNagashi,
  choose: best, onedari: stdOnedari, useNadameru: false,
});
if (bestRun.bans.length) throw new Error('最適プレイで出禁が出た');
if (bestRun.log.jonai === 0) throw new Error('最適プレイで場内指名が一度も付かなかった');
if (bestRun.log.sales === 0) throw new Error('最適プレイでボトルが1本も入らなかった');
if (bestRun.fired) throw new Error('最適プレイでクビになった');
if (bestRun.State.loseReason === 'ryunen') throw new Error('大学に通ったのに留年した');

// 1.5) 大学サボりプレイ（中級の腕）: 警告2回→3/1に留年確定・学費-100万を背負って続行→届かないはず
const saboru = playthrough('大学サボり　　', {
  dayCmd: noUniDay, menuPick: smartMenu, nagashi: smartNagashi,
  choose: (cs) => Math.random() < 0.6 ? best(cs) : coastPick(cs),
  onedari: stdOnedari, useNadameru: true,
});
if (!saboru.State.uniWarned.ryunen) throw new Error('大学をサボり切ったのに留年判定が出なかった');
if (saboru.log.uniEvents < 3) throw new Error(`警告の階段が踏まれていない（イベント${saboru.log.uniEvents}回）`);

// 2) トリアージプレイ: ご隠居・課長は凡打で流し、院長だけに張る
playthrough('トリアージ　　', {
  dayCmd: smartDay, menuPick: smartMenu, nagashi: smartNagashi,
  choose: (cs, S, m) => m.cust.id === 'ishi' ? best(cs) : coastPick(cs),
  onedari: stdOnedari, useNadameru: true,
});

// 3) 中級プレイ ×5: 6割正解（本命指標＝クリア日数。Day65〜95が目標帯）
let midWins = 0;
const midDays = [];
for (let i = 0; i < 5; i++) {
  const r = playthrough(`中級プレイ${i + 1}　　`, {
    dayCmd: smartDay, menuPick: smartMenu, nagashi: smartNagashi,
    choose: (cs) => Math.random() < 0.6 ? best(cs) : coastPick(cs),
    onedari: stdOnedari, useNadameru: true,
  });
  if (r.win) { midWins++; midDays.push(r.State.day); }
}

// 4) 自己投資プレイ: 稼いだら整形・筋トレに突っ込む → 容姿と体力上限が育つはず
const invest = playthrough('自己投資プレイ', {
  dayCmd: (S) => S.parts.taikei < 36 ? 'kintore'
    : S.stamina < 45 ? 'rest'
    : S.mental < 45 ? 'shumi'
    : (S.stats.looks < 60 && S.money >= 90000) ? 'seikei'
    : S.money >= 2000 ? 'dokusho' : 'shumi',
  menuPick: smartMenu,
  choose: best, onedari: stdOnedari, useNadameru: true,
});
if (invest.State.stats.looks <= 20) throw new Error('自己投資したのに容姿が育っていない');
if (invest.State.parts.taikei <= 20) throw new Error('筋トレしたのに体型が育っていない');
if (invest.State.staminaMax <= 100) throw new Error('筋トレしたのに体力上限が伸びていない');

// 5) 凡打だけプレイ: 場内は一度も付かないはず
const coast = playthrough('凡打オンリー　', {
  dayCmd: (S) => S.stamina < 45 ? 'rest' : 'shumi', menuPick: smartMenu,
  choose: coastPick, onedari: () => false, useNadameru: false,
});
if (coast.log.jonai !== 0) throw new Error('凡打だけで場内指名が付いた');
if (coast.win) throw new Error('凡打だけで勝ててしまった');

// 6) 地雷踏み抜きプレイ: 爆発→出禁→信頼喪失→クビまで落ちるはず
const bomb = playthrough('地雷プレイ　　', {
  dayCmd: (S) => S.stamina < 45 ? 'rest' : 'shumi', menuPick: smartMenu,
  choose: pickPref('jirai', 'hazure', 'bonda', 'seikai'),
  onedari: () => false, useNadameru: false,
});
if (bomb.log.explosions === 0) throw new Error('地雷を踏み続けたのに一度も爆発しなかった');
if (bomb.win) throw new Error('地雷プレイで勝ててしまった');

// 7) なだめプレイ: T2で地雷 → 次ターンに〈なだめる〉が出るはず
const calm = playthrough('なだめプレイ　', {
  dayCmd: smartDay, menuPick: smartMenu,
  choose: (cs, S, m) => {
    const j = cs.findIndex(c => c.type === 'jirai');
    return ((m.turn === 0 || m.turn === 1) && m.stage === 'first' && j >= 0) ? j : best(cs);
  },
  onedari: () => false, useNadameru: true,
});
if (calm.log.nadameru === 0) throw new Error('なだめるが一度も発動しなかった');

// 8) 体力無視プレイ: 休まない → 欠勤/病気/早退が出るはず
const burnout = playthrough('体力無視　　　', {
  dayCmd: () => 'kintore',
  choose: best, onedari: () => false, useNadameru: false,
});
if (burnout.log.soutai + burnout.log.forcedRests + burnout.log.sick === 0) throw new Error('体力を回復しないのに早退も欠勤も病気も出なかった');
if (burnout.win) throw new Error('体力無視で勝ててしまった');

// 8.7) 流しオンリー: 毎晩流し出勤だけ → 心身は保つが目標には届かないはず
const nagashiOnly = playthrough('流しオンリー　', {
  dayCmd: (S) => uniPlan(S) || (S.mental < 40 ? 'shumi' : 'rest'),
  menuPick: smartMenu,
  choose: best, onedari: () => false, useNadameru: false,
  nagashi: () => true,
});
if (nagashiOnly.win) throw new Error('流し出勤だけで勝ててしまった（本気営業の意味がなくなる）');

// 9) 一発やらかしプレイ: ご隠居だけ爆発させて信頼を中途半端に落とす → 変な客が回されるはず
const oops = playthrough('一発やらかし　', {
  dayCmd: smartDay, menuPick: smartMenu,
  choose: (cs, S, m) => {
    if (m.cust.id === 'goinkyo' && !S.cust.goinkyo.banned) {
      const j = cs.findIndex(c => c.type === 'jirai');
      const h = cs.findIndex(c => c.type === 'hazure');
      return j >= 0 ? j : (h >= 0 ? h : 0);
    }
    return best(cs);
  },
  onedari: () => false, useNadameru: false,
});
if (oops.log.weird === 0) throw new Error('信頼が下がったのに変な客が一度も回されなかった');

// 9.5) 話題の種: 新聞を読んでおくと院長（1巡目の指名候補）の卓で発火するはず
{
  const ctx = makeContext();
  const { G, State } = require('vm').runInContext('({ G, State })', ctx);
  G.newGame();
  State.topics.shinbun = true;  // 新聞の話題を仕込んだ状態で初夜へ
  State.dayResult = { notes: [], story: '' };
  State.screen = 'dayResult';
  let fired = false, guard = 0;
  while (State.screen !== 'nightResult' && guard++ < 900) {
    const S = State.screen;
    if (S === 'dayResult') G.toNight();
    else if (S === 'night') {
      if (State.night.showIntro) { State.night.showIntro = false; continue; }
      if (State.night.eventLabel && !State.night.eventShown) { State.night.eventShown = true; continue; }
      const cur = State.night.current;
      if (cur.kind === 'light') { if (cur.phase === 'intro') G.startLightTalk(); else if (cur.phase === 'pick') G.pickLight(0); else G.lightNext(); }
      else {
        const m = cur;
        if (m.phase === 'mainIntro') G.startMainTalk();
        else if (m.phase === 'turn') G.pickChoice(0);
        else if (m.phase === 'react') G.afterReact();
        else if (m.phase === 'topicEvent') { fired = true; G.afterTopic(); }
        else if (m.phase === 'buzzEvent') G.afterBuzz();
        else if (m.phase === 'jonaiGet') G.startJonai();
        else if (m.phase === 'chenji') G.endTable();
        else if (m.phase === 'onedari') G.onedari(false);
        else if (m.phase === 'onedariResult') G.afterOnedari();
        else if (m.phase === 'tableEnd') G.endTable();
      }
    } else break;
  }
  if (!fired) throw new Error('新聞の話題を仕込んだのに院長の卓で発火しなかった');
  if (State.topics.shinbun) throw new Error('話題の種が消費されていない');
  console.log('[話題の種　　　] 院長の卓で発火・消費を確認');
}

// 10) ランダムプレイ ×20（クラッシュしないこと）
for (let i = 0; i < 20; i++) {
  playthrough(`ランダム${String(i + 1).padStart(2)}　　　`, {
    dayCmd: () => ['seikei','kintore','dokusho','rest','shumi','uni'][Math.floor(Math.random()*6)],
    choose: (cs) => Math.floor(Math.random() * cs.length),
    onedari: () => Math.random() < 0.5,
    useNadameru: Math.random() < 0.5,
  }, true);
}
console.log('[ランダム×20 ] クラッシュなし');

console.log(`\n中級プレイ: 勝率${midWins}/5・クリア日 [${midDays}]（目標帯: Day65〜95）`);
console.log(`最適プレイのクリア日: Day${bestRun.State.day}（スピードラン枠）`);
console.log('✅ 全テスト通過');
