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
    localStorage: { getItem: () => null, setItem: () => {} },
    Audio: class { play() { return Promise.resolve(); } },
    console, Math, JSON,
  };
  vm.createContext(sandbox);
  for (const f of ['js/config.js', 'js/data.js', 'js/customers.js', 'js/audio.js', 'js/game.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox;
}

// 不合格はここに溜めて、全テストを走らせきってから最後にまとめて投げる。
// 途中で throw すると、その先のチェックが一度も動かなくなるため。
const FAILURES = [];
const CUST_ALL = vm.runInContext('CUSTOMERS', makeContext());   // 定義の参照用

// policy:
//   dayCmd(State) → 昼コマンドid
//   menuPick(cmd, options, State) → メニュー項目index（省略時は買える中からランダム）
//   choose(choices, State, m) → 選択肢index（choices は疲れ選択肢混入後の実効リスト）
//   onedari(State, m) → bool（ねだるかどうか）
//   drinkPick(offer, State, m) → 提示4本のうち何番目をねだるか（省略時 = 通る中で一番高いものを選ぶ完璧な打ち手）
//   useNadameru → bool
// ---- 会話ユニットの整合性チェック（フラグ層）----------------------------
// 「まだ聞いていない話を前提に喋る」「初対面の探りが再演される」を、実プレイ中に検出する。
// once の再演／needs 未達／bindFirst 不整合は、どれか一つでも出たら即失敗。
const CFG = vm.runInContext('CONFIG', makeContext());   // 数値の参照用（プレイスルーごとの文脈とは別物）
const COVERAGE = {};
const REPEAT = { tables: 0, dup: 0, fdup: 0, ftot: 0 };   // 全プレイスルー通算の、会話ユニット到達回数

function checkUnits(name, State, m, log) {
  const cs = State.cust[m.cust.id];
  const u = m.firstUnit;
  const seen = (log.unitSeen = log.unitSeen || {});
  const key = m.cust.id + '/' + u.id;
  if (u.once && seen[key]) throw new Error(`${name}: once指定の探りが再演された（${key}・${seen[key] + 1}回目）`);
  seen[key] = (seen[key] || 0) + 1;
  // needs は、そのユニットを開始する時点で満たされていなければならない。
  // gives は開始時に適用済みなので、自分自身が配る種は除いて判定する
  const known = cs.flags.filter(f => !u.gives.includes(f));
  for (const f of u.needs) {
    if (!known.includes(f)) throw new Error(`${name}: 未知の話を前提にした探り（${key} が要求する "${f}" が未成立）`);
  }
  log.mainTables = (log.mainTables || 0) + 1;
  (log.tables = log.tables || []).push({ cust: m.cust.id, first: u.id, jonai: null });
}

function checkJonaiUnit(name, State, m, log) {
  const cs = State.cust[m.cust.id];
  const j = m.jonaiUnit;
  if (!j) throw new Error(`${name}: 場内に入ったのに会話ユニットが無い（${m.cust.id}）`);
  const key = m.cust.id + '/' + j.id;
  const seen = (log.jonaiSeen = log.jonaiSeen || {});
  if (j.once && seen[key]) throw new Error(`${name}: once指定の場内が再演された（${key}）`);
  seen[key] = (seen[key] || 0) + 1;
  if (j.bindFirst && j.bindFirst !== m.firstUnit.id)
    throw new Error(`${name}: 場内が対になっていない探りと組まれた（first=${m.firstUnit.id} / jonai=${j.id} は ${j.bindFirst} 専用）`);
  const known = cs.flags.filter(f => !j.gives.includes(f));
  for (const f of j.needs) {
    if (!known.includes(f)) throw new Error(`${name}: 未知の話を前提にした場内（${key} が要求する "${f}" が未成立）`);
  }
  log.jonaiTables = (log.jonaiTables || 0) + 1;
  const last = (log.tables || [])[log.tables.length - 1];
  if (last && last.cust === m.cust.id) last.jonai = j.id;
}

// 重複率を二本立てで測る。
//   pair : 「探り＋場内」の組み合わせが既出だった割合
//   first: 探りユニット単体が既出だった割合
// 卓の約半分は場内に入らず、その夜プレイヤーが見るのは探りだけになる。
// だから探りは場内のおよそ倍の速さで消費される。この二つは必ず分けて見ること。
function repeatRate(log) {
  const seenP = new Set(), seenF = new Set();
  let dup = 0, fdup = 0, ftot = 0;
  for (const t of log.tables || []) {
    const fk = `${t.cust}/${t.first}`;
    if (seenF.has(fk)) fdup++; else seenF.add(fk);
    ftot++;
    const key = `${fk}+${t.jonai || '-'}`;
    if (seenP.has(key)) dup++; else seenP.add(key);
  }
  return { tables: (log.tables || []).length, dup, fdup, ftot };
}

function playthrough(name, policy, quiet) {
  const ctx = makeContext();
  const { G, State, CONFIG, DATA } = vm.runInContext('({ G, State, CONFIG, DATA })', ctx);
  G.newGame();
  if (policy.runNo) State.runNo = policy.runNo;   // 2周目以降にしか来ない客を出す
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
      // VIPの電話は出勤の直前に割り込む。プレイヤーは無視できないので、シミュレータも必ず通す
      else if (G.hasMission()) G.toMission();
      else if (policy.nagashi && policy.nagashi(State)) G.toNightNagashi();
      else G.toNight();
    } else if (State.screen === 'skipWork') {
      G.endSkipWork();
    } else if (State.screen === 'sunday') {
      // 日曜（店休）＝街へ。選択肢はランダムに1つ
      if (!State.sunday.picked) {
        log.sunday = (log.sunday || 0) + 1;
        if (State.sunday.kind === 'honshimei') log.sundayMeet = (log.sundayMeet || 0) + 1;
        const n = (State.sunday.kind === 'honshimei'
          ? DATA.sundayHonshimei.choices : State.sunday.ev.choices).length;
        G.sundayChoice(Math.floor(Math.random() * n));
      } else G.endSunday();
    } else if (State.screen === 'shukkin') {
      log.shukkin = (log.shukkin || 0) + 1;
      G.enterFloor();
    } else if (State.screen === 'warukuchi') {
      log.warukuchi = (log.warukuchi || 0) + 1;
      G.endWarukuchi();
    } else if (State.screen === 'nagashiScold') {
      log.nagashiScold = (log.nagashiScold || 0) + 1;
      G.endNagashiScold();
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
    } else if (State.screen === 'mother') {
      const m = State.motherEvent;
      if (m.choice && !State.motherPicked) G.motherChoice(Math.floor(Math.random() * m.choice.length));
      else G.endMother();
    } else if (State.screen === 'soutai') {
      log.soutai++;
      G.endSoutai();
    } else if (State.screen === 'scene') {
      G.sceneNext();   // 一枚絵つきの語りシーン（レイナのねぎらい・フリーデビュー）を送る
    } else if (State.screen === 'nightResult') {
      G.toNextDay();
    } else if (State.screen === 'night') {
      if (State.night.showIntro) { State.night.showIntro = false; continue; }
      if (State.night.tutorialIdx != null) { State.night.tutorialIdx = null; continue; }
      const cur = State.night.current;
      if (cur.kind === 'light') {
        if (cur.weird && cur.phase === 'intro') log.weird++;
        if (cur.phase === 'intro') G.startLightTalk();
        else if (cur.phase === 'pick') G.pickLight(0); else G.lightNext();
      } else {
        const m = cur;
        if (m.stage === 'jonai' && !m._jchecked) { m._jchecked = true; checkJonaiUnit(name, State, m, log); }
        if (m.phase === 'honshimeiCall') { log.shimeiCall = (log.shimeiCall || 0) + 1; G.afterHonshimeiCall(); }
        else if (m.phase === 'mainIntro') { checkUnits(name, State, m, log); G.startMainTalk(); }
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
        else if (m.phase === 'onedari') {
          if (!m.offer || !m.offer.length) throw new Error(`${name}: おねだりの窓が開いたのに銘柄が提示されていない`);
          if (m.offer.length !== CFG.serve.onedari.choices) throw new Error(`${name}: 提示数が${m.offer.length}本（${CFG.serve.onedari.choices}本のはず）`);
          if (new Set(m.offer.map(d => d.name)).size !== m.offer.length) throw new Error(`${name}: 同じ銘柄が二重に提示された`);
          (log.offers = log.offers || []).push({ day: State.day, offer: m.offer.slice(), acc: acceptedIdx(State, m) });
          if (policy.onedari(State, m)) {
            const pick = (policy.drinkPick || smartDrink)(m.offer, State, m);
            log.picked = (log.picked || 0) + 1;
            G.onedariPick(pick);
          } else G.onedariPass();
        }
        else if (m.phase === 'onedariResult') {
          if (m.onedariResult.ok) log.sales++; else log.refused = (log.refused || 0) + 1;
          if (m.onedariResult.nudge) log.nudges = (log.nudges || 0) + 1;
          G.afterOnedari();
        }
        else if (m.phase === 'tableEnd') { G.endTable(); }
        else throw new Error(`${name}: 未知のphase ${m.phase}`);
      }
    } else {
      throw new Error(`${name}: 未知のscreen ${State.screen}`);
    }
  }

  for (const src of [log.unitSeen, log.jonaiSeen])
    for (const k of Object.keys(src || {})) COVERAGE[k] = (COVERAGE[k] || 0) + src[k];
  const rr = repeatRate(log);
  REPEAT.tables += rr.tables; REPEAT.dup += rr.dup;
  REPEAT.fdup += rr.fdup; REPEAT.ftot += rr.ftot;
  const bans = Object.keys(State.cust).filter(id => State.cust[id].banned);
  const fired = State.loseReason === 'fired';
  if (!quiet) console.log(`[${name}] ${State.win ? 'WIN ' : fired ? 'クビ ' : 'LOSE'} 金=${State.money.toLocaleString().padStart(8)} 日=${String(State.day).padStart(2)} 場内=${String(log.jonai).padStart(2)} 売上=${String(log.sales).padStart(2)} 爆発=${log.explosions} 早退=${log.soutai} 欠勤=${log.forcedRests} 病気=${log.sick} 整形=${log.seikei} 容姿=${String(State.stats.looks).padStart(3)} 信頼=${String(State.trust).padStart(3)} 体上限=${State.staminaMax} 出禁=[${bans}]`);
  return { State, log, bans, win: State.win, fired, rr };
}

// 選択肢タイプの優先順で選ぶ（実効リストに正解がない＝メンタル崩壊時はマシな方へフォールバック）
const pickPref = (...types) => cs => {
  for (const t of types) { const i = cs.findIndex(c => c.type === t); if (i >= 0) return i; }
  return 0;
};
const best = pickPref('seikai', 'bonda', 'hazure', 'jirai');
const coastPick = pickPref('bonda', 'hazure', 'seikai', 'jirai');
const aff = (S, m) => S.cust[m.cust.id].affection;

// 容姿いじりが止まる境界（CONFIG.busu.looksCeil と揃える）
const CFG_LOOKS_CEIL = 45;

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
// 容姿を放置すると酔客の一言（メンタル-20）を全期間浴び続けるので、余裕があれば顔に投資する
const smartDay = (S) => {
  const u = uniPlan(S);
  if (u) return u;
  if (S.stamina < 45) return 'rest';
  if (S.mental < 60) return 'shumi';
  if (S.stats.looks < CFG_LOOKS_CEIL && S.money >= 200000) return 'seikei';
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
    // 心が減っているときは無料で一番戻る「推しの配信」。余裕があるときだけ金を払って話題の種を仕込む
    const want = (S.mental < 55 || S.money < 1800) ? 'haishin' : 'sauna';
    return opts.findIndex(o => o.id === want);
  }
  if (cmd === 'kintore') return opts.findIndex(o => o.id === (S.money >= 3000 ? 'gym' : 'run'));
  if (cmd === 'dokusho') return opts.findIndex(o => o.id === 'jiko');
  return 0;
};
// その卓で客が首を縦に振る最上位の階級。おねだりのゲートを、テスト側から独立に再計算する
//（エンジン側の実装をそのまま呼ばずに突き合わせることで、条件式の取り違えも検出できる）
function acceptedIdx(S, m) {
  const CL = ['entry', 'middle', 'high', 'elite'];
  const CAP = { spark: 0, champagne: 1, donperi: 3, roze: 3 };
  const cs = S.cust[m.cust.id];
  const t = CFG.serve.tension;
  const kou = m.tension >= t.kouAt;
  const bond = (cs.jonaiCount || 0) + (cs.missionIdx || 0) * CFG.serve.onedari.bondPerMission;
  let idx = -1;
  CL.forEach((k, i) => {
    const g = CFG.serve.drinkClass[k];
    const hit = m.rallies ? (m.correct || 0) / m.rallies : 0;
    if (cs.affection >= g.aff && bond >= g.bond && (!g.mood || kou) && hit >= (g.hit || 0)) idx = i;
  });
  return Math.min(idx, CAP[m.cust.tierCap] == null ? 3 : CAP[m.cust.tierCap]);
}
const CLASS_IDX = { entry: 0, middle: 1, high: 2, elite: 3 };
// 通る中でいちばん高い1本（無ければ一番安いものに賭ける）
const smartDrink = (offer, S, m) => {
  const ok = offer.map((d, i) => [d, i]).filter(([d]) => CLASS_IDX[d.cls] <= acceptedIdx(S, m));
  if (!ok.length) return 0;
  return ok.sort((a, b) => b[0].price - a[0].price)[0][1];
};
const greedyDrink = (offer) => offer.reduce((bi, d, i, a) => d.price > a[bi].price ? i : bi, 0);
const cheapDrink = () => 0;

const stdOnedari = (S, m) => aff(S, m) >= 85 || (m.turn + 1 === 5 && aff(S, m) >= 72);

// 1) 最適プレイ: 全卓で正解を刺し続ける。
//    なだめるは無料の回復手段なので、完璧な打ち手なら当然使う。
//    ここを使わない設定にしていた頃は「全問正解なのに出禁」が 24回中2回起きていて、
//    好感度の天井を入れてゲームが長くなったら 6回中1回まで増えた。
//    縛りプレイの結果でテストを落としても仕方がないので、最適プレイは最適に打たせ、
//    崩壊ルートは下の「なだめない縛り」で別に踏む。
const bestRun = playthrough('最適プレイ　　', {
  dayCmd: smartDay, menuPick: smartMenu, nagashi: smartNagashi,
  choose: best, onedari: stdOnedari, useNadameru: true,
});
if (bestRun.bans.length) throw new Error('最適プレイで出禁が出た');
if (bestRun.log.jonai === 0) throw new Error('最適プレイで場内指名が一度も付かなかった');
if (bestRun.log.sales === 0) throw new Error('最適プレイでボトルが1本も入らなかった');
if (bestRun.fired) throw new Error('最適プレイでクビになった');
if (bestRun.State.loseReason === 'ryunen') throw new Error('大学に通ったのに留年した');

// 1.2) なだめない縛り: 正解は刺すが、心が折れても回復しない。
//      brokenLine を踏んで選択肢が壊れ、爆発・出禁まで行くルートを毎回踏ませる。
//      ここは出禁が出てよい（出ないほうがおかしい）。クラッシュしないことだけを見る。
const noNadame = playthrough('なだめない縛り', {
  dayCmd: smartDay, menuPick: smartMenu, nagashi: smartNagashi,
  choose: best, onedari: stdOnedari, useNadameru: false,
});
if (noNadame.log.explosions === 0 && noNadame.bans.length === 0) {
  console.log('  ⚠ なだめない縛りで一度も爆発しなかった（メンタル崩壊ルートが踏まれていない）');
}

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

// 2.3) 2周目プレイ：fromRun で2周目からしか来ない客（常連・ハシヅメ）を踏む。
//      この客は場内ユニットを1本も持たない＝場内が発生しないルートも同時に通る。
{
  const r = playthrough('2周目　　　　', {
    dayCmd: smartDay, menuPick: smartMenu, nagashi: smartNagashi,
    choose: (cs) => Math.random() < 0.6 ? best(cs) : coastPick(cs),
    onedari: stdOnedari, useNadameru: true, runNo: 2,
  });
  const g = r.State.cust.gachikoi;
  if (!g || g.visits === 0) throw new Error('2周目なのに、2周目からの客（gachikoi）が一度も来なかった');
  if (g.visits > CUST_ALL.gachikoi.visitCap)
    throw new Error(`visitCap を超えて来店した（${g.visits} > ${CUST_ALL.gachikoi.visitCap}）`);
  console.log(`[2周目　　　　] 常連・ハシヅメ 来店${g.visits}回（上限${CUST_ALL.gachikoi.visitCap}）`);
}
// 1周目には出ないことも確かめる
{
  const r = playthrough('x', {
    dayCmd: smartDay, menuPick: smartMenu, nagashi: smartNagashi,
    choose: best, onedari: stdOnedari, useNadameru: true,
  }, true);
  if (r.State.cust.gachikoi.visits > 0) throw new Error('1周目なのに2周目の客が来た（fromRun が効いていない）');
}

// 2.4) セーブスカム対策：乱数がセーブに乗っているか。
//      Math.random() を直に使っていた頃は、夜の結果を全部見てから再読み込みして
//      「続きから」を押すと、その朝から全部の目が振り直せた
//      （売掛飛び -10万・整形の失敗・遅刻・発熱・陰口・おねだりの提示銘柄）。
//      同じ種・同じ打ち手なら、何度走らせても completely 同じ結果になることを確かめる。
{
  const real = Math.random;
  Math.random = () => 0.42;          // newSeed() を固定する＝同じ種で始める
  const p = { dayCmd: smartDay, menuPick: smartMenu, nagashi: smartNagashi,
    choose: best, onedari: stdOnedari, useNadameru: true };
  const a = playthrough('x', p, true), b = playthrough('x', p, true);
  Math.random = real;
  const key = (r) => `${r.State.day}/${r.State.money}/${r.log.sales}/${r.log.explosions}/${r.log.sick}/${r.log.seikei}/${r.bans.join(',')}`;
  if (key(a) !== key(b)) throw new Error(
    `同じ種から始めたのに結果が違う＝乱数がセーブに乗っていない（セーブスカムし放題）:\n  ${key(a)}\n  ${key(b)}`);
  console.log(`\n[セーブスカム] 同じ種・同じ打ち手で結果が一致（${key(a)}）`);
  // game.js に素の Math.random() が残っていると、そこだけ振り直せてしまう
  const src = fs.readFileSync(path.join(__dirname, '..', 'js/game.js'), 'utf8');
  const bare = (src.match(/Math\.random\(\)/g) || []).length;
  if (bare > 1) throw new Error(
    `js/game.js に素の Math.random() が ${bare} 箇所ある（種を経由する rnd() を使うこと。`
    + `例外は newSeed() の1箇所だけ）`);
}

// 2.5) おねだりの情報漏れ：**本文を見ずに、提示された値段だけを見る打ち手**が、
//      内部状態を全部知っている打ち手にどこまで迫れるか。
//      以前は提示の上限が必ず「通る階級+1」だったので、上から2番目の階級を選ぶだけで
//      成功率100.00%・全知と同着だった＝おねだりが計算問題になっていた。
//      成功率そのものではなく「知っていると何日速いか」で見る。慎重に打てば成功率は上がって当然で、
//      問題はそれが得かどうかなので。
{
  const priceOnly = (offer) => {              // 提示の上から2番目の階級で、いちばん高いもの
    const cls = [...new Set(offer.map(d => d.clsIdx))].sort((a, b) => b - a);
    const target = cls.length >= 2 ? cls[1] : cls[0];
    let bi = offer.findIndex(d => d.clsIdx === target);
    offer.forEach((d, i) => { if (d.clsIdx === target && d.price > offer[bi].price) bi = i; });
    return bi;
  };
  const med = (a) => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  const runN = (drinkPick) => med([...Array(5)].map(() => playthrough('x', {
    dayCmd: smartDay, menuPick: smartMenu, nagashi: smartNagashi,
    choose: best, onedari: stdOnedari, useNadameru: true, drinkPick,
  }, true).State.day));
  const omni = runN(undefined);               // 既定＝通る中で一番高いものを選ぶ全知の打ち手
  const cheap = runN(priceOnly);
  console.log(`\n[おねだりの情報漏れ] 全知 Day${omni} ／ 値段だけを見る打ち手 Day${cheap}`
    + `（差 ${cheap - omni}日・3日以上が要件）`);
  if (cheap - omni < 3) FAILURES.push(
    `おねだりが計算問題になっている: 提示された値段を見るだけの打ち手が、`
    + `内部状態を全部知っている打ち手に ${cheap - omni}日差まで迫っている`
    + `\n  → buildOffer が acceptedClassIdx を材料に使っていないか確認すること。`);
}

// 3) 中級プレイ ×5: 6割正解（本命指標＝クリア日数。Day65〜95が目標帯）
let midWins = 0;
const midDays = [], midRepeat = [];
for (let i = 0; i < 5; i++) {
  const r = playthrough(`中級プレイ${i + 1}　　`, {
    dayCmd: smartDay, menuPick: smartMenu, nagashi: smartNagashi,
    choose: (cs) => Math.random() < 0.6 ? best(cs) : coastPick(cs),
    onedari: stdOnedari, useNadameru: true,
  });
  if (r.win) { midWins++; midDays.push(r.State.day); }
  // 想定プレイでの会話の被りはゼロが要件。
  // シャンパン階級でゲームが延び、VIP1人あたりの卓数が12→24になったぶん在庫が足りず、
  // 一時は26%まで被っていた。探りを各VIP29本以上に増やして0%へ戻した（院長29/御曹司29/芸能社長30）。
  // 客を増やすかクリアDayを延ばすたび、ここは真っ先に破れる。数字が動いたら在庫を足すこと。
  // ──許容値を上げて黙らせない。
  const rate = r.rr.fdup / Math.max(1, r.rr.ftot);
  midRepeat.push(rate);
  if (rate > 0) throw new Error(`中級プレイ${i + 1}で探りが${r.rr.fdup}回被った（探り${r.rr.ftot}卓＝${(rate*100).toFixed(0)}%）。探りの在庫が足りていない`);
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
  State.day = 4;                // 研修明けで、かつ日曜（店休）でない最初の夜＝指名候補が回ってくる
  State.topics.shinbun = true;  // 新聞の話題を仕込んだ状態で夜へ
  State.dayResult = { notes: [], story: '' };
  State.screen = 'dayResult';
  let fired = false, guard = 0;
  while (State.screen !== 'nightResult' && guard++ < 900) {
    const S = State.screen;
    if (S === 'dayResult') G.toNight();
    else if (S === 'shukkin') G.enterFloor();
    else if (S === 'scene') G.sceneNext();
    else if (S === 'night') {
      if (State.night.showIntro) { State.night.showIntro = false; continue; }
      if (State.night.tutorialIdx != null) { State.night.tutorialIdx = null; continue; }
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
        else if (m.phase === 'onedari') G.onedariPass();
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

// 上手いプレイを厚めに回して、第2話まで到達するかを見る
for (let i = 0; i < 12; i++) playthrough(`到達計測${i}`, {
  dayCmd: smartDay, menuPick: smartMenu, nagashi: smartNagashi,
  choose: best, onedari: stdOnedari, useNadameru: true,
}, true);

// 11) 会話ユニットの到達性：書いたのに一度も出ないユニットがあれば設計ミス
{
  const missed = [];
  const CUST = vm.runInContext('CUSTOMERS', makeContext());
  for (const id of Object.keys(CUST)) {
    const c = CUST[id];
    c.episodes.forEach((ep, i) => {
      for (const kind of ['first', 'jonai']) {
        if (!ep[kind] || !ep[kind].length) continue;
        const meta = (kind === 'first' ? ep.firstMeta : ep.jonaiMeta) || {};
        const uid = meta.id || `${id}_${kind}${i + 1}`;
        if (!COVERAGE[`${id}/${uid}`]) missed.push(uid);
      }
    });
  }
  // 全ユニット到達は要求しない。
  // VIPのEP11以降は「通い続けた人へのご褒美（余禄）」と位置づけたので、
  // 在庫のほうが必要数より多いのは設計どおり（SCENARIO_SKELETON.md §2）。
  // 見たいのは「フラグ条件が厳しすぎて構造的に出ない話」なので、割合で見る。
  const total = Object.keys(COVERAGE).length + missed.length;
  const missPct = missed.length / total * 100;
  if (missed.length) console.log(`[未到達ユニット] ${missed.length}/${total}（${missPct.toFixed(1)}%）: ${missed.join(', ')}`);
  if (missPct > 10) throw new Error(
    `到達しない会話ユニットが多すぎる（${missPct.toFixed(1)}%・10%まで）`
    + `。フラグ条件が厳しすぎるか、登場が遅すぎる: ${missed.join(', ')}`);
  console.log(`[会話ユニット ] 全${Object.keys(COVERAGE).length}ユニットに到達`);
  const pct = (REPEAT.dup / REPEAT.tables * 100).toFixed(1);
  const fpct = (REPEAT.fdup / REPEAT.ftot * 100).toFixed(1);
  console.log(`[探りの重複　 ] ${REPEAT.ftot} 卓中 ${REPEAT.fdup} が既出の探り（重複率 ${fpct}%・想定プレイでは0%が要件）`);
  console.log(`[組合せの重複 ] ${REPEAT.tables} 卓中 ${REPEAT.dup} が既出の「探り＋場内」（重複率 ${pct}%）`);
}

// 12) テル検出：本文を読まずに、見た目の1つの特徴だけで正解が当たってしまわないか
//
//     叩き台では503卓中87%で「最長＝正解」だった＝長いのを押すだけで勝てた。
//     それを潰したあと、同じ理由で「……を含む＝正解64%」「……で始まる＝正解100%」が生き残っていた。
//     最長スロットだけを見ていたから素通りしたので、テルの種類を決め打ちするのをやめる。
//
//     考え方：プレイヤーが使える「1変数ルール」を機械的に並べ、それぞれの的中率を測る。
//     4択なので当てずっぽうは25%。どのルールでも45%を超えたら、そのルールは攻略として成立する＝不合格。
//     地雷側も見る。地雷を高精度で指すルールは「それを避ける」攻略になるため同じく不合格。
//     ルールが発火する卓が全体の5%未満なら、攻略として使うには稀すぎるので測らない。
const TELL_MAX = 45;      // 1つのルールが指した先で、どの型も この% 以下であること
const TELL_MINCOV = 5;    // 発火率が この% 未満のルールは母数不足として除外

// 選択肢は全文が「」で括られている。「で始まる／で終わる」を測るために、その外枠だけ外す
const core = t => t.replace(/^[「（]/, '').replace(/[」）]$/, '');

// 選択肢1本を見て真偽を返すもの（その卓でただ1本だけ真なら、ルールが発火する）
const FLAGS = [
  ['「……」を含む',      t => t.includes('……')],
  ['「……」で始まる',    t => core(t).startsWith('……')],
  ['「……」で終わる',    t => /……$/.test(core(t))],
  ['「！」を含む',        t => t.includes('！')],
  ['「？」を含む',        t => t.includes('？')],
  ['「ですか？」で終わる', t => /ですか？$/.test(core(t))],
  ['読点が2つ以上（複文）', t => (t.match(/、/g) || []).length >= 2],
  ['読点がない（単文）',  t => !t.includes('、')],
  ['「私」を含む',        t => t.includes('私')],
  ['中に引用符がある',    t => core(t).includes('「') || core(t).includes('"')],
  ['数字を含む',          t => /[0-9０-９一二三四五六七八九十百千万]/.test(t)],
  ['逆接で始まる',        t => /^(でも|だって|けど|いや|えっ)/.test(core(t))],
  ['「ね」で終わる',      t => /ね[〜ー]?[。！？…]*$/.test(core(t))],
  ['問いかけで終わる',    t => /[？?][」）]?$/.test(t)],
  ['敬語でない（タメ口）', t => !/(です|ます|ません|でした|ましょ)/.test(t)],
  ['句点「。」を含む',    t => t.includes('。')],
  ['「──」を含む',       t => t.includes('──')],
  ['「〜」を含む',        t => t.includes('〜')],
  ['「もん」系の終助詞',  t => /(もんね|ですもん|もん[。！？」]?$)/.test(t)],
  ['相手の未来を語る',    t => /(一生|これから|将来|この先)/.test(t)],
];
// 卓の中で長さがk番目のものを指すもの。
// 「最長＝正解」を潰すと正解が2位へ移るだけ（実測: 1位38%→2位55%）なので、
// 順位は総当たりで測る。ここを1位だけにしていたせいで2位テルを見逃した。
const RANKS = [];
for (const k of [1, 2, 3, 4]) RANKS.push([`長さ${k}位`, k]);
// 順位ではなく最大値を指すもの（同点なら発火しない）
const MAXES = [
  ['読点がいちばん多い', t => (t.match(/、/g) || []).length],
  ['「…」がいちばん多い', t => (t.match(/…/g) || []).length],
  ['句点がいちばん多い',  t => (t.match(/。/g) || []).length],
];

{
  const CUST = vm.runInContext('CUSTOMERS', makeContext());
  const TABLES = [];
  for (const id of Object.keys(CUST)) {
    for (const ep of CUST[id].episodes || []) {
      for (const kind of ['first', 'jonai']) {
        for (const u of ep[kind] || []) {
          if ((u.choices || []).length >= 2) TABLES.push(u.choices);
        }
      }
    }
  }

  // ルールが指した1本の型を数える。指せなかった卓（該当0本・同点複数）は発火せず母数に入らない
  function measure(pick) {
    const c = { seikai: 0, bonda: 0, hazure: 0, jirai: 0 };
    let fired = 0;
    for (const chs of TABLES) {
      const hit = pick(chs);
      if (!hit) continue;
      fired++;
      if (c[hit.type] !== undefined) c[hit.type]++;
    }
    return { c, fired };
  }
  const RULES = [
    ...FLAGS.map(([name, fn]) => [name, chs => {
      const hit = chs.filter(ch => fn(ch.text));
      return hit.length === 1 ? hit[0] : null;
    }]),
    ...RANKS.map(([name, k]) => [name, chs => {
      if (chs.length < k) return null;
      const sorted = [...chs].sort((a, b) => b.text.length - a.text.length);
      // 同じ長さが並んでいたら順位が決まらない＝発火しない
      const t = sorted[k - 1];
      if (chs.filter(c => c.text.length === t.text.length).length > 1) return null;
      return t;
    }]),
    ...MAXES.map(([name, score]) => [name, chs => {
      const vals = chs.map(ch => score(ch.text));
      const best = Math.max(...vals);
      const hit = chs.filter((_, i) => vals[i] === best);
      return hit.length === 1 ? hit[0] : null;
    }]),
  ];

  const rows = [];
  for (const [name, pick] of RULES) {
    const { c, fired } = measure(pick);
    const cov = fired / TABLES.length * 100;
    const worst = ['seikai', 'jirai'].map(t => [t, c[t] / (fired || 1) * 100])
      .sort((a, b) => b[1] - a[1])[0];
    rows.push({ name, cov, fired, c, worstType: worst[0], worstPct: worst[1] });
  }
  rows.sort((a, b) => (b.cov >= TELL_MINCOV ? b.worstPct : -1) - (a.cov >= TELL_MINCOV ? a.worstPct : -1));

  console.log(`\n[テル検出] 全${TABLES.length}卓。1変数ルールの的中率（当てずっぽう=25%／${TELL_MAX}%超で不合格）`);
  const tells = [];
  for (const r of rows) {
    const thin = r.cov < TELL_MINCOV;
    const bad = !thin && r.worstPct > TELL_MAX;
    const dist = ['seikai', 'bonda', 'hazure', 'jirai']
      .map(t => `${t.slice(0, 4)} ${String(Math.round(r.c[t] / (r.fired || 1) * 100)).padStart(3)}%`).join(' ');
    console.log(`  ${bad ? '❌' : thin ? '－' : '✅'} ${r.name.padEnd(22)} 発火${String(Math.round(r.cov)).padStart(3)}%  ${dist}`);
    if (bad) tells.push(`「${r.name}」→${r.worstType} ${r.worstPct.toFixed(0)}%（発火${r.cov.toFixed(0)}%）`);
  }
  // ここで即 throw すると後ろのテストが走らなくなるので、判定は最後にまとめて出す
  if (tells.length) FAILURES.push(
    `本文を読まずに勝てるテルが残っている:\n    ${tells.join('\n    ')}`
    + `\n  → その特徴を、正解だけでなく他の型にも同じくらい配ること。`);
}

// 12a) モブ卓・ヘルプ卓・変な客のテル検出。
//      これらの選択肢は type を持たないため、上のテル検出は一度も見ていなかった。
//      だが研修（Day1-2）はモブ卓しか出ないので、**このゲームの第一印象はここで決まる**。
//      型の代わりに「drinks が最大の選択肢＝その卓の正解」とみなして同じ物差しを当てる。
{
  const D = vm.runInContext('DATA', makeContext());
  const CORPORA = [['モブ卓', D.mobTables], ['ヘルプ卓', D.lightTables], ['変な客', D.weirdTables]];
  const lines = [];
  for (const [label, src] of CORPORA) {
    const TABLES = [];
    for (const t of src || []) for (const u of (t.rallies || t)) {
      if ((u.choices || []).length >= 2) TABLES.push(u.choices);
    }
    if (!TABLES.length) continue;
    const isBest = (chs, ch) => ch.drinks === Math.max(...chs.map(c => c.drinks || 0));
    // 当てずっぽうの基準：ランダムに1本選んだとき最良を引く確率
    const base = TABLES.reduce((a, chs) =>
      a + chs.filter(c => isBest(chs, c)).length / chs.length, 0) / TABLES.length * 100;
    // 減点がまったく無い卓は「読まなくていい卓」。これ自体が設計の穴
    const anyMental = TABLES.some(chs => chs.some(c => c.mental));
    const rows = [];
    for (const [name, k] of RANKS) {
      let fired = 0, hitBest = 0, hitTobi = 0;
      for (const chs of TABLES) {
        if (chs.length < k) continue;
        const sorted = [...chs].sort((a, b) => b.text.length - a.text.length);
        const t = sorted[k - 1];
        if (chs.filter(c => c.text.length === t.text.length).length > 1) continue;
        fired++;
        if (isBest(chs, t)) hitBest++;
        if (t.flag === 'tobi') hitTobi++;
      }
      if (!fired) continue;
      rows.push({ name, cov: fired / TABLES.length * 100, best: hitBest / fired * 100, tobi: hitTobi / fired * 100 });
    }
    const worst = rows.slice().sort((a, b) => b.best - a.best)[0];
    console.log(`\n[テル検出/${label}] ${TABLES.length}卓。当てずっぽうで最良を引く率 ${base.toFixed(0)}%`
      + `（+20pt超で不合格）${anyMental ? '' : '  ⚠ この卓群には減点が一つも無い'}`);
    for (const r of rows) {
      const bad = r.best > base + 20;
      console.log(`  ${bad ? '❌' : '✅'} ${r.name.padEnd(10)} 発火${String(Math.round(r.cov)).padStart(3)}%`
        + `  最良を引く率 ${String(Math.round(r.best)).padStart(3)}%  売掛を踏む率 ${Math.round(r.tobi)}%`);
    }
    if (worst && worst.best > base + 20) lines.push(
      `${label}: 「${worst.name}」を押すだけで最良${worst.best.toFixed(0)}%（当てずっぽう${base.toFixed(0)}%）`);
    if (!anyMental) lines.push(`${label}: 減点のある選択肢が一つも無い＝失敗できない卓になっている`);
  }
  if (lines.length) FAILURES.push(
    `type を持たない卓にもテル／緩みがある:\n    ${lines.join('\n    ')}`
    + `\n  → 研修はモブ卓だけなので、ここが「読まなくていい」とゲームの第一印象が決まる。`);
}

// 12b) 客ごとの偏り：全体で散っていても、特定の客だけ「最長＝正解」だと、その客の卓で読まれる
const REWRITTEN = ['ishi', 'goinkyo', 'kacho', 'shacho', 'shitencho', 'geinin',
  'zeirishi', 'yakyu', 'kaicho', 'sekiyu', 'onzoshi', 'geino'];   // ← 全エピソードを決定稿にした客を足していく
{
  const CUST = vm.runInContext('CUSTOMERS', makeContext());
  const fail = [];
  console.log('');
  for (const id of Object.keys(CUST)) {
    const count = { seikai: 0, bonda: 0, hazure: 0, jirai: 0, tie: 0 };
    let tables = 0;
    for (const ep of CUST[id].episodes || []) {
      for (const kind of ['first', 'jonai']) {
        for (const u of ep[kind] || []) {
          const chs = u.choices || [];
          if (chs.length < 2) continue;
          const max = Math.max(...chs.map(c => c.text.length));
          const longest = chs.filter(c => c.text.length === max);
          tables++;
          // 同率最長が複数あるなら文字数から型は割れない＝tie（セーフ）
          count[longest.length === 1 ? longest[0].type : 'tie']++;
        }
      }
    }
    if (!tables) continue;
    const worst = ['seikai', 'bonda', 'hazure', 'jirai']
      .map(t => [t, count[t] / tables * 100]).sort((a, b) => b[1] - a[1])[0];
    const done = REWRITTEN.includes(id);
    const ok = worst[1] <= 40;
    const mark = done ? (ok ? '✅' : '❌') : (ok ? '  ' : '⚠ ');
    const dist = ['seikai', 'bonda', 'hazure', 'jirai', 'tie']
      .map(t => `${t.slice(0, 4)} ${String(Math.round(count[t] / tables * 100)).padStart(3)}%`).join('  ');
    console.log(`[文字数テル] ${mark} ${id.padEnd(10)} ${String(tables).padStart(3)}卓  最長の型: ${dist}`);
    if (done && !ok) fail.push(`${id}(${worst[0]} ${worst[1].toFixed(0)}%)`);
  }
  if (fail.length) throw new Error(
    `決定稿のはずの客で、最長の選択肢の型が偏っている: ${fail.join(', ')}`
    + ` — 文字数から答えが割れる。どの型も40%以下に散らすこと。`);
}

{
  const avg = midRepeat.reduce((a, b) => a + b, 0) / (midRepeat.length || 1);
  if (avg > 0) console.log(`\n⚠ 中級プレイの探り重複 ${(avg * 100).toFixed(1)}%（要件は0%）`
    + ` — VIPの探りの在庫が、そのクリアDayの卓数に追いついていない。該当VIPに探りを足すこと。`);
}
console.log(`\n中級プレイ: 勝率${midWins}/5・クリア日 [${midDays}]（目標帯: Day65〜95）`);
console.log(`最適プレイのクリア日: Day${bestRun.State.day}（スピードラン枠）`);
if (FAILURES.length) throw new Error('\n\n■ ' + FAILURES.join('\n\n■ ') + '\n');
console.log('✅ 全テスト通過');
