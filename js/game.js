'use strict';
// =====================================================================
// ゲームエンジン本体（構造・数値・分岐）。テキストは data.js / customers.js、数値は config.js。
//
// 夜の構造：フリー客3組（ご隠居→課長→院長）。
//   各卓 = 探り3ラリー → 正答率60%以上で場内指名 → さらに5ラリー（おねだり解禁）
//
// 3つのバロメータ：
//   体力＝働ける量。卓に着くたび減る。尽きると出勤不可・即退勤・病気（数日休み）
//   メンタル＝接客の質。40未満で「疲れた心の一言」が選択肢に混入、10以下で最悪の選択肢しか浮かばない
//   店長の信頼＝卓の質。40未満で院長卓が変な客に、25未満で課長卓も。5以下でクビ（ゲームオーバー）
// =====================================================================

const $screen = () => document.getElementById('screen');
const $status = () => document.getElementById('status-bar');
const yen = n => '¥' + n.toLocaleString('ja-JP');
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const para = s => esc(s).split('\n').map(l => l===''?'<br>':`<p>${l}</p>`).join('');

// 暦：Day1 = 12月20日 → Day100 = 3月29日（翌3/30がツアー初日）
function dateLabel(day){
  if (day <= 12) return `12/${19 + day}`;
  if (day <= 43) return `1/${day - 12}`;
  if (day <= 71) return `2/${day - 43}`;
  return `3/${day - 71}`;
}
function inWinterBreak(day){
  const [a, b] = CONFIG.uni.winterBreak;
  return day >= a && day <= b;
}
function weekdayName(day){ return CONFIG.weekdays[(day - 1) % 7]; }
function isWeekend(day){ const w = weekdayName(day); return w === '土' || w === '日'; }
// 日曜は店休。出勤という選択肢そのものが無い日
function isSunday(day){ return weekdayName(day) === '日'; }
// 明日以降（fromDay以降）、1月末までに大学に出席できる回数（土日・冬休みを除く）
function uniChancesLeft(fromDay){
  let n = 0;
  for (let d = fromDay; d <= CONFIG.uni.lastDay; d++) {
    if (!isWeekend(d) && !inWinterBreak(d)) n++;
  }
  return n;
}

const MOOD_LABEL = { kou:'機嫌が良さそうだ', fu:'機嫌は普通みたいだ', ken:'……今日はもう、機嫌が悪そうだ' };

// テンション（-4〜+4）から機嫌を導出
function moodOf(m){
  const t = CONFIG.serve.tension;
  if (m.tension >= t.kouAt) return 'kou';
  if (m.tension <= t.kenAt) return 'ken';
  return 'fu';
}
// テンションから表情画像のサフィックスを決める（p4〜p1 / fu / m1〜m4）
// faceCap付きの客（スポット客＝画像8枚体制）は表示だけ±capに丸める。内部のテンションは丸めない。
function faceOf(m){
  const cap = (m.cust && m.cust.faceCap) || 4;
  if (m.exploded) return 'm' + cap;
  const t = Math.max(-cap, Math.min(cap, m.tension));
  if (t === 0) return 'fu';
  return (t > 0 ? 'p' : 'm') + Math.abs(t);
}

const State = {};
const G = {}; // onclick用の窓口

// ---------------------------------------------------------------------
// セーブ（毎朝オートセーブ。localStorage・file://でも動く）
// ---------------------------------------------------------------------
const SAVE_KEY = 'okujo_save_v1';

function saveGame(){
  try {
    // 夜の進行中データは保存しない（復帰は常に「その日の朝」から）
    localStorage.setItem(SAVE_KEY, JSON.stringify({ ...State, night: null, screen: null }));
  } catch (e) { /* localStorageが使えない環境では黙ってスキップ */ }
}

function loadSaved(){
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s.day !== 'number' || !s.cust || typeof s.money !== 'number') return null;
    return s;
  } catch (e) { return null; }
}

function clearSave(){
  try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
}

G.continueGame = function(){
  const s = loadSaved();
  if (!s) { State.screen = 'title'; render(); return; }
  Object.assign(State, s);
  // 後方互換：セーブ後に追加されたフィールドを補完
  if (State.biyouPaid == null) State.biyouPaid = 0;
  if (State.lastBinge == null) State.lastBinge = -99;
  if (State.lastMission == null) State.lastMission = -99;
  if (!State.oshiDone) State.oshiDone = {};
  if (State.uniRumor == null) State.uniRumor = 0;
  if (State.seikeiBuzz === undefined) State.seikeiBuzz = null;
  if (State.kintoreBuzz == null) State.kintoreBuzz = false;
  if (State.tobiDay === undefined) State.tobiDay = null;
  if (State.afterReturn === undefined) State.afterReturn = null;
  if (State.lastPuchi == null) State.lastPuchi = 0;
  if (State.puchiIdx == null) State.puchiIdx = 0;
  if (!State.puchiUsed) State.puchiUsed = {};
  if (State.skipStreak == null) { State.skipStreak = 0; State.lastSkipDay = -9; }
  if (State.benchNext == null) State.benchNext = false;
  if (State.uniBuzz == null) State.uniBuzz = false;
  if (State.workedToday == null) State.workedToday = false;
  if (State.workedYesterday == null) State.workedYesterday = true;
  if (State.nagashiStreak == null) State.nagashiStreak = 0;
  if (State.lastNagashiDay == null) State.lastNagashiDay = -9;
  if (State.seikeiCount == null) State.seikeiCount = 0;
  if (State.busuSeen == null) State.busuSeen = false;
  if (State.sundayIdx == null) State.sundayIdx = 0;
  if (State.sunday === undefined) State.sunday = null;
  for (const id of Object.keys(CUSTOMERS)) {
    if (!State.cust[id]) {
      State.cust[id] = { affection: CONFIG.serve.affectionStart, banned: false, met: false, epIdx: 0, lastVisit: 0, visits: 0, lastSuccess: false, missionIdx: 0, donperiCount: 0, flags: [], usedFirst: [], usedJonai: [], usedPairs: [], jonaiCount: 0 };
    } else {
      const c = State.cust[id];
      if (c.visits == null) c.visits = 0;
      if (c.lastSuccess == null) c.lastSuccess = false;
      if (c.missionIdx == null) c.missionIdx = 0;
      if (c.donperiCount == null) c.donperiCount = 0;
      if (!Array.isArray(c.flags)) c.flags = [];
      if (!Array.isArray(c.usedFirst)) c.usedFirst = [];
      if (!Array.isArray(c.usedJonai)) c.usedJonai = [];
      if (!Array.isArray(c.usedPairs)) c.usedPairs = [];
      if (c.jonaiCount == null) c.jonaiCount = 0;
    }
  }
  State.night = null;
  enterDay();   // 朝から再開（未処理の引き落とし・イベントはそのまま流れる）
};

// ---------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------
G.newGame = function(){
  const cust = {};
  for (const id of Object.keys(CUSTOMERS)) {
    cust[id] = { affection: CONFIG.serve.affectionStart, banned: false, met: false, epIdx: 0, lastVisit: 0, visits: 0, lastSuccess: false, missionIdx: 0, donperiCount: 0, flags: [], usedFirst: [], usedJonai: [], usedPairs: [], jonaiCount: 0 };
  }
  Object.assign(State, {
    screen: 'intro', introIdx: 0,
    day: 1,
    money: CONFIG.start.money,
    stats: { looks: CONFIG.start.looks, intel: CONFIG.start.intel, talk: CONFIG.start.talk },
    parts: Object.fromEntries(CONFIG.parts.order.map(k => [k, CONFIG.parts.start])),
    seikeiPart: null,
    mental: CONFIG.start.mental,
    stamina: CONFIG.start.stamina,
    staminaMax: CONFIG.start.stamina,
    trust: CONFIG.start.trust,
    topics: {},
    haishinIdx: 0,
    uniAttended: 0,
    uniWarned: {},
    uniIdx: 0,
    uniRumor: 0,   // 噂の進行段階（0=平穏〜バレ→親友の一言まで）
    livingPaid: 0,
    biyouPaid: 0,
    lastBinge: -99,
    lastMission: -99,
    seikeiBuzz: null,
    tobiDay: null,
    afterReturn: null, afterGuest: null, afterResult: null,
    lastPuchi: 0, puchiIdx: 0, puchiUsed: {},
    skipStreak: 0, lastSkipDay: -9,
    workedToday: false, workedYesterday: true,   // 朝のイベントの出し分け（昨夜、店に出たか）
    nagashiStreak: 0, lastNagashiDay: -9,        // 流しの連投を店長が見ている
    seikeiCount: 0, busuSeen: false,             // 12/27の初ダメ出し判定
    sundayIdx: 0, sunday: null,                  // 日曜（店休）の街歩き
    benchNext: false,
    kintoreBuzz: false,
    uniBuzz: false,
    mission: null, missionPhase: null, missionPicked: null,
    oshiDone: {},
    holidayDone: {},
    holidayPicked: null,
    loseReason: null,
    cust,
    night: null,
    scene: null, day1EndSeen: false, day3StartSeen: false,   // 一枚絵つきの語りシーン（各1回だけ）
    lightDeck: null, lightPos: 0, weirdDeck: null, weirdPos: 0,  // 永続デッキ（引き切るまで重複なし）
  });
  recalcLooks();
  render();
};

function clampStat(v){ return Math.max(0, Math.min(CONFIG.statMax, v)); }
function clampMental(v){ return Math.max(0, Math.min(CONFIG.mentalMax, v)); }
function clampStamina(v){ return Math.max(0, Math.min(State.staminaMax, v)); }
function clampAff(v){ return Math.max(0, Math.min(100, v)); }

function addTrust(v, label){
  State.trust = Math.max(0, Math.min(CONFIG.trust.max, State.trust + v));
  if (State.night && label) State.night.trustNotes.push(`${label} ${v > 0 ? '+' + v : v}`);
}

// 容姿＝6パーツの平均
function recalcLooks(){
  const ids = CONFIG.parts.order;
  State.stats.looks = clampStat(Math.round(ids.reduce((s, k) => s + State.parts[k], 0) / ids.length));
}

// 重み付き抽選（[[値, 確率], ...]）
function weightedRoll(table){
  const r = Math.random();
  let acc = 0;
  for (const [v, p] of table) { acc += p; if (r < acc) return v; }
  return table[table.length - 1][0];
}

// ---------------------------------------------------------------------
// 昼パート
// ---------------------------------------------------------------------
// メニュー選択式の昼コマンド
const MENU_CMDS = {
  kintore: { icon: '💪', title: '筋トレ' },
  dokusho: { icon: '📖', title: '読書' },
  shumi:   { icon: '🎧', title: '趣味' },
};

// [min, max] の配列なら範囲ランダム、数値ならそのまま
const rangeVal = v => Array.isArray(v) ? Math.floor(v[0] + Math.random() * (v[1] - v[0] + 1)) : v;

// 昼コマンド・メニュー項目の効果を適用して notes に記録する
function applyEffects(o, notes){
  if (o.intel)   { State.stats.intel = clampStat(State.stats.intel + o.intel); notes.push(`知性 +${o.intel}`); }
  if (o.talk)    { State.stats.talk  = clampStat(State.stats.talk  + o.talk);  notes.push(`トーク力 +${o.talk}`); }
  if (o.mental)  { const v = rangeVal(o.mental);  State.mental  = clampMental(State.mental + v);   notes.push(`メンタル ${v > 0 ? '+' + v : v}`); }
  if (o.stamina) { const v = rangeVal(o.stamina); State.stamina = clampStamina(State.stamina + v); notes.push(`体力 ${v > 0 ? '+' + v : v}`); }
  if (o.taikei) {
    const before = State.parts.taikei;
    State.parts.taikei = Math.min(CONFIG.parts.max, before + o.taikei);
    recalcLooks();
    notes.push(`体型 ${before} → ${State.parts.taikei}（容姿 いま ${State.stats.looks}）`);
    // 一段締まった夜は、卓で気づかれる
    if (o.taikei > 0 && Math.floor(before / 15) !== Math.floor(State.parts.taikei / 15)) State.kintoreBuzz = true;
  }
  // 体力の「上限」だけを押し上げる。いまの体力は回復しない（鍛えた分は、削れた体には戻らない）
  if (o.roll && State.staminaMax < CONFIG.staminaMaxCap) {
    const gain = weightedRoll(o.roll);
    if (gain > 0) {
      State.staminaMax = Math.min(CONFIG.staminaMaxCap, State.staminaMax + gain);
      notes.push(`体力の上限 +${gain}（いま ${State.staminaMax}）${gain >= 3 ? '　💪 大当たり！' : ''}`);
    } else {
      notes.push('体力の上限は、今日は動かなかった');
    }
  }
  if (o.topic) {
    if (!State.topics[o.topic]) {
      State.topics[o.topic] = true;
      notes.push(`話題の種を仕込んだ：${DATA.topicNames[o.topic]}（好みが合う客の卓で光る）`);
    } else {
      notes.push(`（${DATA.topicNames[o.topic]}の話題は、もう仕込んである）`);
    }
  }
}

// 大学イベントの効果適用（体型はパーツ連動なので専用処理）
function applyUniEvent(ev, notes){
  if (ev.mental)  { State.mental  = clampMental(State.mental + ev.mental);    notes.push(`メンタル ${ev.mental > 0 ? '+' + ev.mental : ev.mental}`); }
  if (ev.stamina) { State.stamina = clampStamina(State.stamina + ev.stamina); notes.push(`体力 ${ev.stamina > 0 ? '+' + ev.stamina : ev.stamina}`); }
  if (ev.intel)   { State.stats.intel = Math.min(CONFIG.statMax, State.stats.intel + ev.intel); notes.push(`知性 +${ev.intel}`); }
  if (ev.taikei)  { State.parts.taikei = Math.max(1, State.parts.taikei + ev.taikei); recalcLooks(); notes.push(`体型 ${ev.taikei}`); }
}

G.pickDay = function(id){
  // メニュー選択式コマンド（日を消費するのは中で確定したときだけ）
  if (id === 'seikei') {
    if (State.money < CONFIG.seikei.clinics[0].cost) return;
    State.screen = 'seikeiPart';
    render();
    return;
  }
  if (MENU_CMDS[id]) {
    const minCost = Math.min(...CONFIG[id].options.map(o => o.cost || 0));
    if (minCost > 0 && State.money < minCost) return;  // 無料項目があれば残高マイナスでも開ける
    State.menuCmd = id;
    State.screen = 'menu';
    render();
    return;
  }

  // 通常コマンド（大学・休む・接客ノート）
  if (id === 'uni' && (State.day > CONFIG.uni.lastDay || inWinterBreak(State.day) || isWeekend(State.day))) return;  // 土日・冬休み・2月以降は休講
  const c = CONFIG.day[id];
  const notes = [];
  if (c.cost) {
    if (State.money < c.cost) return;
    State.money -= c.cost;
    notes.push(`${yen(c.cost)} 使った`);
  }
  applyEffects(c, notes);

  let story = '';
  if (id === 'uni') {
    State.uniAttended++;
    notes.push(`出席 ${State.uniAttended}/${CONFIG.uni.need}${State.uniAttended >= CONFIG.uni.need ? '　🎓 進級ライン到達！' : ''}`);
    story = DATA.uniScenes[State.uniIdx % DATA.uniScenes.length];
    State.uniIdx++;
    if (Math.random() < CONFIG.uni.buzz.chance) State.uniBuzz = true;  // 講義ネタは夜の卓で光ることがある
    // キャンパスの出来事（噂は階段式に進む。ある日、学校中に知れ渡る）
    const uev = CONFIG.uni.event;
    if (State.uniRumor < DATA.uniRumorEvents.length && Math.random() < uev.rumorChance) {
      const ev = DATA.uniRumorEvents[State.uniRumor++];
      story += '\n\n' + ev.text;
      applyUniEvent(ev, notes);
    } else if (Math.random() < uev.chance) {
      const ev = DATA.uniRandomEvents[Math.floor(Math.random() * DATA.uniRandomEvents.length)];
      story += '\n\n' + ev.text;
      applyUniEvent(ev, notes);
    }
  }

  // 「休む」は昼のまま。画像も昼の部屋のまま（一日ずっとこの部屋にいた、という絵）
  State.dayResult = { notes, story, scene: id === 'uni' ? 'uni_class' : (id === 'rest' ? 'room' : null) };
  State.screen = 'dayResult';
  render();
};

// 昼メニュー項目→シーン画像の対応
const MENU_ITEM_SCENE = {
  run: 'kintore_run', gym: 'kintore_gym', personal: 'kintore_gym',
  manga: 'dokusho', jiko: 'dokusho', shosetsu: 'dokusho', shinbun: 'dokusho',
  karaoke: 'karaoke', eiga: 'eiga', cafe: 'cafe', sauna: null,
};

// メニュー項目の確定
G.pickMenu = function(i){
  const cmd = State.menuCmd;
  const o = CONFIG[cmd].options[i];
  if ((o.cost || 0) > 0 && State.money < o.cost) return;
  if (o.cost) State.money -= o.cost;
  const notes = o.cost ? [`${yen(o.cost)} 使った`] : [];
  applyEffects(o, notes);

  let story = '';
  if (o.id === 'haishin') { story = DATA.haishinScenes[State.haishinIdx % DATA.haishinScenes.length]; State.haishinIdx++; }
  else                    { story = (DATA[cmd + 'Scenes'] || {})[o.id] || ''; }

  State.dayResult = { notes, story, scene: MENU_ITEM_SCENE[o.id] || null };
  State.screen = 'dayResult';
  render();
};

// ---- プチ整形（パーツ→クリニックの2段選択）----
G.cancelSub = function(){ State.screen = 'day'; render(); };

G.pickSeikeiPart = function(pid){
  State.seikeiPart = pid;
  State.screen = 'seikeiClinic';
  render();
};

G.backToParts = function(){ State.screen = 'seikeiPart'; render(); };

G.pickSeikeiClinic = function(i){
  const c = CONFIG.seikei.clinics[i];
  if (State.money < c.cost) return;
  State.money -= c.cost;
  const pid = State.seikeiPart;
  const info = DATA.parts[pid];
  const notes = [`${yen(c.cost)} 使った（${c.name}）`];
  State.seikeiCount = (State.seikeiCount || 0) + 1;   // 一度でも手を入れたか（12/27の初ダメ出し判定に使う）
  let story;
  if (Math.random() < c.rate) {
    const before = State.parts[pid];
    State.parts[pid] = Math.min(CONFIG.parts.max, before + c.gain);
    recalcLooks();
    notes.push(`${info.label}（${info.menu}）成功 ${before} → ${State.parts[pid]}`);
    notes.push(`容姿 いま ${State.stats.looks}`);
    State.seikeiBuzz = { ok: true, label: info.label };   // 今夜の卓で気づかれる
    story = `${c.name}。${info.menu}、成功。\n\n帰り道、ショーウィンドウに映る自分と目が合って、少しだけ長く見てしまった。\n……悪くない。全然、悪くない。`;
  } else {
    State.stamina = clampStamina(State.stamina + CONFIG.seikei.failStamina);
    notes.push(`施術失敗……効果なし／体力 ${CONFIG.seikei.failStamina}（ダウンタイム）`);
    State.seikeiBuzz = { ok: false, label: info.label };  // 腫れは、卓からも見える
    story = `${c.name}。${info.menu}──腫れが、引かない。\n\n「個人差がありますので」と受付は言った。返金の話は、しなかった。\n鏡は、しばらく見たくない。`;
  }
  State.dayResult = { notes, story, scene: 'seikei' };
  State.screen = 'dayResult';
  render();
};

// 出勤前の関門（店休日／クビ／強制欠勤／発熱）。true = 出勤できず画面遷移済み
function nightGates(){
  // 日曜は店が閉まっている。どの入口から来ても出勤にはならない
  if (isSunday(State.day)) {
    G.toSunday();
    return true;
  }
  if (State.trust <= CONFIG.trust.firedLine) {
    State.screen = 'fired';
    render();
    return true;
  }
  if (State.stamina < CONFIG.stamina.noWorkLine) {
    State.stamina = clampStamina(State.stamina + CONFIG.forcedRest.stamina);
    State.mental = clampMental(State.mental + CONFIG.forcedRest.mental);
    addTrust(CONFIG.trust.absent);
    State.screen = 'forcedRest';
    render();
    return true;
  }
  if (State.stamina < CONFIG.stamina.sickLine && Math.random() < CONFIG.stamina.sickChance) {
    State.screen = 'sick';
    render();
    return true;
  }
  return false;
}

G.toNight = function(){
  if (nightGates()) return;
  startNight();
};

// 流し出勤：夜を自動処理で流す（早上がり日給＋少しのドリンク。指名関係は進まない）
G.toNightNagashi = function(){
  if (nightGates()) return;
  const ng = CONFIG.nagashi;
  const nev = CONFIG.nightEvents[State.day];
  const drinks = Math.floor(ng.drinks[0] + Math.random() * (ng.drinks[1] - ng.drinks[0] + 1));
  const earned = ng.wage - CONFIG.pay.hairSet + drinks * CONFIG.pay.drinkBack * (nev ? nev.drinkMult : 1);
  State.mental = clampMental(State.mental + ng.mental);
  State.stamina = clampStamina(State.stamina + ng.stamina);
  addTrust(CONFIG.trust.perNight);
  State.workedToday = true;
  State.night = {
    breakdown: [
      `日給（流し・早上がり） ${yen(ng.wage)}`,
      `ヘアセット代 -${yen(CONFIG.pay.hairSet)}`,
      `ドリンクバック${drinks}杯 ${yen(drinks * CONFIG.pay.drinkBack * (nev ? nev.drinkMult : 1))}`,
    ],
    trustNotes: [`皆勤 +${CONFIG.trust.perNight}`],
  };
  // 流しの連投は店長に見えている。3回続けたところで、閉店後に呼び止められる
  State.nagashiStreak = (State.lastNagashiDay === State.day - 1) ? State.nagashiStreak + 1 : 1;
  State.lastNagashiDay = State.day;
  if (State.nagashiStreak >= ng.scoldStreak) {
    State.nagashiStreak = 0;   // 一度言われたら、そこから数え直し
    addTrust(ng.scoldTrust, '流しの連投を見抜かれた');
    State.mental = clampMental(State.mental + ng.scoldMental);
    State.nagashiEarned = earned;
    State.screen = 'nagashiScold';
    render();
    return;
  }
  endDay(earned);
};

G.endNagashiScold = function(){ endDay(State.nagashiEarned || 0); };

G.endForcedRest = function(){ endDay(0); };

// 希望休：回復は大きいが、連続で取るほど店長の信頼が削れる
G.skipWork = function(){
  if (isSunday(State.day)) { G.toSunday(); return; }   // 休む対象の夜が、そもそも無い
  const sw = CONFIG.skipWork;
  State.skipStreak = (State.lastSkipDay === State.day - 1) ? State.skipStreak + 1 : 1;
  State.lastSkipDay = State.day;
  const tier = Math.min(State.skipStreak, 3) - 1;
  const dTrust = sw.trust[tier];
  addTrust(dTrust, `希望休${State.skipStreak >= 2 ? `（${State.skipStreak}連続）` : ''}`);
  const st = sw.stamina[0] + Math.floor(Math.random() * (sw.stamina[1] - sw.stamina[0] + 1));
  const me = sw.mental[0] + Math.floor(Math.random() * (sw.mental[1] - sw.mental[0] + 1));
  State.stamina = clampStamina(State.stamina + st);
  State.mental = clampMental(State.mental + me);
  State.skipResult = { scene: DATA.skipScenes[tier], st, me, dTrust };
  State.screen = 'skipWork';
  render();
};
G.endSkipWork = function(){ endDay(0); };

G.endSick = function(){
  State.stamina = clampStamina(State.stamina + CONFIG.stamina.sickHeal.stamina);
  State.mental = clampMental(State.mental + CONFIG.stamina.sickHeal.mental);
  addTrust(CONFIG.trust.sick);
  for (let i = 0; i < CONFIG.stamina.sickDays; i++) {
    if (State.day >= CONFIG.totalDays) {
      State.win = State.money >= CONFIG.goalMoney;
      State.screen = 'ending';
      render();
      return;
    }
    State.day++;
  }
  enterDay();
};

G.endFired = function(){
  State.win = false;
  State.loseReason = 'fired';
  State.screen = 'ending';
  render();
};

// ---------------------------------------------------------------------
// 夜パート
// ---------------------------------------------------------------------

// 今夜の指名候補を選ぶ：未消化エピソードのある客を、来店が古い順に。信頼が低いと店長が回してくれない
// スポット客の卒業判定：成功（場内指名成立）なら2回目まで来る。3回目はない。初回失敗ならそれっきり。
function spotGraduated(id){
  if (CUSTOMERS[id].tier !== 'spot') return false;
  const cs = State.cust[id];
  if (cs.visits >= 2) return true;
  return cs.visits >= 1 && !cs.lastSuccess;
}

// 来店資格：出禁でない／登場日（fromDay）を迎えている／スポット卒業していない
function custActive(id){
  const cs = State.cust[id];
  return !cs.banned && State.day >= (CUSTOMERS[id].fromDay || 1) && !spotGraduated(id);
}

// 研修期間：最初の2日は先輩のヘルプ。モブ卓だけを回され、場内指名も起きない
function inTutorial(){ return State.day <= CONFIG.tutorial.helpDays; }

// ---- 会話ユニットの選択（フラグ層）------------------------------------
// episodes[] の first / jonai は、それぞれ独立した「会話ユニット」として扱う。
//   needs: このユニットを出す前に、客が知っていなければならない話の種
//   gives: このユニットを演じ切ると立つ種
//   once : 一度きり（初対面の探りなど、二度と再生してはいけないもの）
//   bindFirst: その夜の探りユニットと対になっているとき、相手の id を書く（例：企画書を見せた夜の場内）
// これで「まだ聞いていない話を前提に喋る」事故と、
// 「15回通った客が"君、新しい子？"と言い出す」再演事故の両方を防ぐ。
function unitsOf(cust, kind){
  cust._units = cust._units || {};
  if (cust._units[kind]) return cust._units[kind];
  const list = [];
  cust.episodes.forEach((ep, i) => {
    const rallies = ep[kind];
    if (!rallies || !rallies.length) return;
    const meta = (kind === 'first' ? ep.firstMeta : ep.jonaiMeta) || {};
    list.push({
      id: meta.id || `${cust.id}_${kind}${i + 1}`,
      needs: meta.needs || [], gives: meta.gives || [], once: !!meta.once,
      bindFirst: meta.bindFirst || null, desc: ep.desc, rallies,
    });
  });
  cust._units[kind] = list;
  return list;
}

function unitEligible(u, cs, used, firstId){
  if (u.once && used.includes(u.id)) return false;
  if (u.bindFirst && u.bindFirst !== firstId) return false;
  return u.needs.every(f => cs.flags.includes(f));
}

const pairKey = (fid, jid) => fid + '+' + jid;

// その探りユニットに、まだ演じていない「探り＋場内」の組み合わせが残っているか。
// 探りと場内をそれぞれ独立に一巡させると、両者が足並みを揃えて回ってしまい、
// 7本×7本あっても7通りの夜しか出てこない。組み合わせで数えるのはそれを避けるため。
function hasFreshPair(cust, cs, f){
  return unitsOf(cust, 'jonai').some(j =>
    unitEligible(j, cs, cs.usedJonai, f.id) && !cs.usedPairs.includes(pairKey(f.id, j.id)));
}

// 未見のものを物語順に優先。全部見たら、まだ出していない組み合わせを作れるものを優先し、
// それも尽きたら、再演可能なものの中でいちばん昔に見たものを回す
function pickUnit(cust, kind, cs, firstId){
  const used = kind === 'first' ? cs.usedFirst : cs.usedJonai;
  const ok = unitsOf(cust, kind).filter(u => unitEligible(u, cs, used, firstId));
  if (!ok.length) return null;
  const bound = ok.filter(u => u.bindFirst);   // 今夜の探りと対になっている話が最優先
  if (bound.length) return bound[0];
  const fresh = ok.filter(u => !used.includes(u.id));
  if (fresh.length) return fresh[0];
  const lru = ok.slice().sort((a, b) => used.indexOf(a.id) - used.indexOf(b.id));
  const novel = kind === 'jonai'
    ? lru.filter(j => !cs.usedPairs.includes(pairKey(firstId, j.id)))
    : lru.filter(f => hasFreshPair(cust, cs, f));
  return (novel.length ? novel : lru)[0];
}

// ユニットを実際に演じたときに呼ぶ：使用済みに記録し、話の種を立てる
function consumeUnit(cust, kind, cs, u, firstId){
  if (!u) return;
  const used = kind === 'first' ? cs.usedFirst : cs.usedJonai;
  const at = used.indexOf(u.id);
  if (at >= 0) used.splice(at, 1);   // 再演したら最後尾へ（＝次はいちばん昔のものが回る）
  used.push(u.id);
  if (kind === 'jonai' && firstId) {
    const key = pairKey(firstId, u.id);
    const pat = cs.usedPairs.indexOf(key);
    if (pat >= 0) cs.usedPairs.splice(pat, 1);
    cs.usedPairs.push(key);
  }
  u.gives.forEach(f => { if (!cs.flags.includes(f)) cs.flags.push(f); });
}

// まだ一度も見ていない探りユニットが残っているか（＝新しい話ができる客か）
function hasFreshTalk(id){
  const cs = State.cust[id];
  return unitsOf(CUSTOMERS[id], 'first')
    .some(u => !cs.usedFirst.includes(u.id) && u.needs.every(f => cs.flags.includes(f)));
}

function pickMains(){
  if (inTutorial()) return { mains: [], weird: 0 };   // 上級客は回ってこない＝場内指名も発生しない
  if (State.trust < CONFIG.trust.weirdLine2) return { mains: [], weird: 2 };
  if (State.trust < CONFIG.trust.weirdLine)  return { mains: [], weird: 1 };
  let cands = Object.keys(CUSTOMERS).filter(id => custActive(id) && hasFreshTalk(id));
  // 新しい話が尽きたら、来店が古い客から再登場（再演可能なユニットだけが回る）
  if (cands.length === 0) cands = Object.keys(CUSTOMERS).filter(id =>
    custActive(id) && pickUnit(CUSTOMERS[id], 'first', State.cust[id]));
  cands.sort((a, b) => (State.cust[a].lastVisit || 0) - (State.cust[b].lastVisit || 0));
  return { mains: cands.slice(0, CONFIG.mainsPerNight), weird: 0 };
}

function startNight(){
  const { mains, weird } = pickMains();
  const plan = [];
  for (let i = 0; i < weird; i++) plan.push('weird');
  while (plan.length + mains.length < 3) plan.push('light');
  mains.forEach(id => plan.push('main:' + id));  // 本命は夜の最後（クライマックス）
  const nev = CONFIG.nightEvents[State.day];
  State.night = {
    plan,
    step: 0,
    earned: CONFIG.pay.dayWage - CONFIG.pay.hairSet,
    breakdown: [`日給保証 ${yen(CONFIG.pay.dayWage)}`, `ヘアセット代 -${yen(CONFIG.pay.hairSet)}`],
    weirdNoticeShown: false,
    trustNotes: [],
    current: null,
    drinkMult: nev ? nev.drinkMult : 1,
    eventLabel: nev ? nev.label : null,
    eventShown: false,
  };
  // 昨夜のお叱りの翌日は、フリーの卓を1つ外される
  if (State.benchNext) {
    State.benchNext = false;
    const li = State.night.plan.indexOf('light');
    if (li >= 0 && State.night.plan.length > 1) {
      State.night.plan.splice(li, 1);
      State.night.breakdown.push('（昨夜のお叱りで、フリーの卓を1つ外された）');
    }
  }
  // アフターで縁を作った客が、本指名で顔を出す夜
  if (State.afterReturn && State.day >= State.afterReturn.day) {
    const ar = State.afterReturn;
    State.afterReturn = null;
    State.night.earned += CONFIG.afterInvite.returnAmount;
    State.night.breakdown.push(`本指名で再来（${ar.name}さん・アフターの縁） ${yen(CONFIG.afterInvite.returnAmount)}`);
  }
  State.screen = 'night';
  if (State.day === 1) { State.night.showIntro = true; State.night.tutorialIdx = 0; }
  nextTable();
  // 研修明けの初日は、接客に入る前にレイナが背中を押してくれる
  if (State.day >= CONFIG.tutorial.helpDays + 1 && !State.day3StartSeen && State.screen === 'night') {
    State.day3StartSeen = true;
    playScene('day3Start', () => { State.screen = 'night'; render(); });
  }
}

// 一見/モブ卓・変な客卓は「引き切るまで重複なし」の永続デッキから配る（尽きたら再シャッフル）
// 研修中（最初の2日）は、顔と空気を覚えるだけの期間なのでモブ卓しか回ってこない
function drawTable(weird){
  const tut = !weird && inTutorial();
  const dk = weird ? 'weirdDeck' : (tut ? 'mobDeck' : 'lightDeck');
  const pk = weird ? 'weirdPos' : (tut ? 'mobPos' : 'lightPos');
  if (!State[dk] || State[pk] >= State[dk].length) {
    const pool = weird ? DATA.weirdTables
      : tut ? (DATA.mobTables || [])
      : [...DATA.lightTables, ...(DATA.mobTables || [])];
    State[dk] = pool.slice().sort(() => Math.random() - 0.5);
    State[pk] = 0;
  }
  // 女性客（偵察・同伴）は店が育ってから。序盤は飛ばして次を引く
  while (State[pk] < State[dk].length
         && State[dk][State[pk]].img === 'josei' && State.day < CONFIG.joseiFromDay) {
    State[pk]++;
  }
  if (State[pk] >= State[dk].length) { State[dk] = null; return drawTable(weird); }
  return State[dk][State[pk]++];
}

function nextTable(){
  const n = State.night;
  if (n.step >= n.plan.length) { endNight(); return; }

  // 卓に着く肉体コスト。体力が尽きたら即退勤
  State.stamina = clampStamina(State.stamina + CONFIG.stamina.perTable);
  if (State.stamina <= 0) {
    addTrust(CONFIG.trust.soutai, '早退');
    State.screen = 'soutai';
    render();
    return;
  }

  const kind = n.plan[n.step];
  n.step++;
  if (kind === 'light' || kind === 'weird') {
    const weird = kind === 'weird';
    const table = drawTable(weird);
    n.current = {
      kind: 'light',
      weird,
      table,
      rally: 0,             // 一客最低3ラリーの原則は一見さんにも適用
      phase: 'intro',       // まず状況説明→「接客スタート」→会話
      picked: null,
      totalDrinks: 0,
      totalBack: 0,
      order: [...Array(table.rallies[0].choices.length).keys()].sort(() => Math.random() - 0.5),
      notice: weird && !n.weirdNoticeShown,
      mobAff: CONFIG.mobAff.start,
    };
    if (weird) n.weirdNoticeShown = true;
    if (!weird && table.img) (n.mobsSeen = n.mobsSeen || []).push({ job: table.job, name: table.name });
    // 容姿が低いうちは、酔客の無神経が顔に飛んでくる（容姿を磨くほど減る）。言うのは男性客だけ
    const bs = CONFIG.busu;
    const maleMob = !weird && table.img && table.img !== 'josei';
    // 12/27以降、まだ一度もプチ整形していないなら、最初に当たった男性客が必ず言ってくる
    // （その日に休む・流すこともあるので「12/27ちょうど」ではなく「12/27以降の初回」で確定させる）
    const firstStrike = maleMob && State.day >= bs.firstDay && !State.busuSeen && !State.seikeiCount;
    if (maleMob && State.day >= bs.fromDay && State.stats.looks < bs.looksCeil
        && (firstStrike || Math.random() < (bs.looksCeil - State.stats.looks) * bs.ratePerPoint)) {
      State.busuSeen = true;
      n.current.insult = DATA.busuLines[Math.floor(Math.random() * DATA.busuLines.length)];
      State.mental = clampMental(State.mental + bs.mental);
    }
  } else {
    const cust = CUSTOMERS[kind.split(':')[1]];
    const cs = State.cust[cust.id];
    const firstUnit = pickUnit(cust, 'first', cs);
    consumeUnit(cust, 'first', cs, firstUnit);
    cs.epIdx++;
    cs.lastVisit = State.day;
    cs.visits = (cs.visits || 0) + 1;
    cs.lastSuccess = false;   // この来店の成否（場内指名成立で立つ）
    // 前回来店からの間で関係は少し戻る（来店ごとに1段減衰＝太客化はゆっくり）
    if (cs.visits > 1) {
      const base = CONFIG.serve.affectionStart;
      cs.affection = clampAff(Math.round(base + (cs.affection - base) * CONFIG.serve.carryOver));
    }
    // 場内ユニットは「場内に入った瞬間」に選ぶ。探りで立った話の種を、その場で条件に使えるように
    n.current = { kind: 'main', cust, firstUnit, jonaiUnit: null,
      honshimei: cs.visits >= 2,   // 2回目以降の来店＝本指名（あなたに会いに来ている）
      stage: 'first',   // 'first'=探り（フリー接客）→ 'jonai'=場内指名後
      turn: 0, correct: 0, rallies: 0, drinksSettled: false,
      tension: 0,
      sold: null, exploded: false,
      nadameruWindow: false,
      // 本指名なら、まず「本指名が入りました！」の一枚を叩きつけてから状況説明へ
      phase: cs.visits >= 2 ? 'honshimeiCall' : 'mainIntro',
      firstMeet: !cs.met,
      showSenpai: !cs.met && State.stats.intel >= CONFIG.intel.senpaiLine,
      effChoices: null, choiceOrder: null, result: null, mindState: 'ok',
    };
    cs.met = true;
    if (n.current.honshimei) {
      State.night.earned += CONFIG.pay.honshimeiBack;
      State.night.breakdown.push(`本指名バック（${cust.name}） ${yen(CONFIG.pay.honshimeiBack)}`);
    }
    shuffleChoices();
  }
  render();
}

// ---- 軽い卓（一見さん／変な客・3ラリー制）----
G.pickLight = function(orderIdx){
  const cur = State.night.current;
  const ch = cur.table.rallies[cur.rally].choices[cur.order[orderIdx]];
  cur.picked = ch;
  if (ch.flag === 'tobi') State.tobiDay = State.day + CONFIG.tobi.delayDays;  // 売掛を通してしまった
  const amount = ch.drinks * CONFIG.pay.drinkBack * (State.night.drinkMult || 1);
  cur.amount = amount;
  cur.totalDrinks += ch.drinks;
  cur.totalBack += amount;
  if (amount > 0) State.night.earned += amount;
  State.mental = clampMental(State.mental + ch.mental);
  cur.affDelta = ch.drinks * CONFIG.mobAff.perDrink;
  cur.mobAff = clampAff(cur.mobAff + cur.affDelta);
  // モブ卓の気まぐれ注文（最終ラリーまで盛り上げた卓なら、たまに追加注文が入る）
  cur.bonus = null;
  const mo = CONFIG.pay.mobOrder;
  const lastRally = cur.rally + 1 >= cur.table.rallies.length;
  if (lastRally && State.day >= mo.fromDay && cur.table.img && cur.totalDrinks >= mo.minDrinks && Math.random() < mo.chance) {
    const it = mo.items[Math.floor(Math.random() * mo.items.length)];
    const bonusBack = Math.round(it.price * CONFIG.pay.bottleBackRate);
    State.night.earned += bonusBack;
    State.night.breakdown.push(`${it.label}（${cur.table.name}） ${yen(bonusBack)}`);
    cur.bonus = { label: it.label, price: it.price, back: bonusBack };
  }
  cur.phase = 'react';
  render();
};

G.afterHonshimeiCall = function(){
  State.night.current.phase = 'mainIntro';
  render();
};

G.startMainTalk = function(){
  State.night.current.phase = 'turn';
  render();
};

G.startLightTalk = function(){
  State.night.current.phase = 'pick';
  render();
};

G.lightNext = function(){
  const cur = State.night.current;
  if (cur.rally + 1 < cur.table.rallies.length) {
    cur.rally++;
    cur.picked = null;
    cur.phase = 'pick';
    cur.order = [...Array(cur.table.rallies[cur.rally].choices.length).keys()].sort(() => Math.random() - 0.5);
    render();
    return;
  }
  // 卓じまい：ドリンクバックを明細へ
  if (cur.totalDrinks > 0) {
    State.night.breakdown.push(`ドリンクバック${cur.totalDrinks}杯（${cur.weird ? '変な客' : '一見さん'}） ${yen(cur.totalBack)}`);
  }
  nextTable();
};

G.nextTable = function(){ nextTable(); };

// ---- 意味のある卓 ----
function turnData(m){
  const u = m.stage === 'first' ? m.firstUnit : m.jonaiUnit;
  return u.rallies[m.turn];
}
function rallyNo(m){
  return m.stage === 'first' ? m.turn + 1 : CONFIG.serve.firstRallies + m.turn + 1;
}
function custState(m){ return State.cust[m.cust.id]; }

// メンタルの状態で「その卓で浮かぶ選択肢」が変わる
function buildChoices(m){
  const turn = turnData(m);
  const mc = CONFIG.mentalChoice;
  if (State.mental <= mc.brokenLine) {
    // 最悪の選択肢しか浮かばない
    const bad = turn.choices.filter(c => c.type === 'hazure' || c.type === 'jirai');
    m.effChoices = [...bad, DATA.worstChoice];
    m.mindState = 'broken';
  } else if (State.mental <= mc.tiredLine) {
    // 頭が回らない：ベストの一言だけが浮かばず、代わりに疲れた心の一言が混ざる（計4択のまま）
    const extra = DATA.tsukareChoices[Math.floor(Math.random() * DATA.tsukareChoices.length)];
    const rest = turn.choices.filter(c => c.type !== 'seikai');
    m.effChoices = [...rest, extra];
    m.mindState = 'tired';
  } else {
    m.effChoices = [...turn.choices];
    m.mindState = 'ok';
  }
}

function shuffleChoices(){
  const m = State.night.current;
  buildChoices(m);
  m.choiceOrder = [...Array(m.effChoices.length).keys()].sort(() => Math.random() - 0.5);
}

function affGain(type, rally){
  const s = CONFIG.serve, st = State.stats;
  let v;
  if (type === 'seikai')      v = s.seikaiBase + Math.floor(st.talk / 15);
  else if (type === 'bonda')  v = (rally === 1 ? s.bondaT1 : rally <= 3 ? s.bondaMid : s.bondaLate) + Math.floor(st.talk / 40);
  else if (type === 'hazure') v = Math.min(s.hazureFloor, s.hazureBase + Math.floor(st.looks / 15));
  else                        v = Math.min(s.jiraiFloor,  s.jiraiBase  + Math.floor(st.looks / 12));
  return v;
}

function mentalCost(type){
  const s = CONFIG.serve;
  const base = { seikai: s.mentalSeikai, bonda: s.mentalBonda, hazure: s.mentalHazure, jirai: s.mentalJirai }[type];
  return base - State.night.current.cust.mentalTax;
}

// テンションの増減（落差ルール込み）
function tensionUp(m, n){
  m.tension = Math.min(CONFIG.serve.tension.max, m.tension + (n || 1));
}
function tensionDrop(m, type){
  const t = CONFIG.serve.tension;
  if (m.tension > 0) { m.tension = -1; return; }  // プラス圏から失敗＝一気に-1（テンションの落差）
  const drop = type === 'jirai' ? t.jiraiDrop : t.hazureDrop;
  m.tension = Math.max(t.min, m.tension - drop);
}

G.pickChoice = function(orderIdx){
  const m = State.night.current;
  const ch = m.effChoices[m.choiceOrder[orderIdx]];

  // 機嫌〈険〉でさらに地雷 or ハズレ → 爆発
  if (moodOf(m) === 'ken' && (ch.type === 'jirai' || ch.type === 'hazure')) {
    explode();
    return;
  }

  const dAff = affGain(ch.type, rallyNo(m));
  const dMental = mentalCost(ch.type);
  custState(m).affection = clampAff(custState(m).affection + dAff);
  State.mental = clampMental(State.mental + dMental);
  m.rallies++;

  m.nadameruWindow = false;
  const beforeMood = moodOf(m);
  // ボトルが入ったあとの連続正解＝2本目の窓（途切れたらリセット）
  m.streakSinceSale = ch.type === 'seikai' ? (m.streakSinceSale || 0) + 1 : 0;
  if (ch.type === 'seikai') {
    m.correct++;
    tensionUp(m, 1);            // 正解のたびに表情が一段明るくなる
  } else if (ch.type === 'hazure' || ch.type === 'jirai') {
    tensionDrop(m, ch.type);    // プラス圏からの失敗は一気に-1（落差）
    if (moodOf(m) === 'ken' && beforeMood !== 'ken') m.nadameruWindow = true; // 回避の窓
  }

  m.result = { text: ch.react, dAff, dMental, type: ch.type };
  if (ch.type === 'jirai') State.night.jiraiCount = (State.night.jiraiCount || 0) + 1;
  m.phase = 'react';
  render();
};

G.nadameru = function(){
  const m = State.night.current;
  const c = CONFIG.serve.nadameru;
  custState(m).affection = clampAff(custState(m).affection + c.affection);
  State.mental = clampMental(State.mental + c.mental);
  m.tension = 0;               // なだめて機嫌〈普〉＝テンション0へ
  m.nadameruWindow = false;
  m.rallies++;
  m.result = { text: m.cust.nadameruText, dAff: c.affection, dMental: c.mental, type: 'nadameru' };
  m.phase = 'react';
  render();
};

function explode(){
  const m = State.night.current;
  m.exploded = true;
  custState(m).banned = true;
  addTrust(CONFIG.trust.explosion, `${m.cust.name}を出禁に`);
  m.result = { text: m.cust.explosion, dAff: 0, dMental: -20, type: 'explosion' };
  State.mental = clampMental(State.mental - 20);
  m.phase = 'react';
  render();
}

// 卓じまい：客が入れてくれたドリンクのバックを精算（ラリー数＝卓の長さに比例）
function settleDrinks(m){
  if (m.drinksSettled) return;
  m.drinksSettled = true;
  const drinks = Math.floor(m.rallies / CONFIG.pay.ralliesPerDrink);
  const amount = drinks * CONFIG.pay.drinkBack * (State.night.drinkMult || 1);
  if (drinks > 0) {
    State.night.earned += amount;
    State.night.breakdown.push(`ドリンクバック${drinks}杯（${m.cust.name}） ${yen(amount)}`);
  }
  m.drinkInfo = { drinks, amount };
}

G.afterReact = function(){
  const m = State.night.current;
  if (m.exploded) { settleDrinks(m); m.phase = 'tableEnd'; render(); return; }
  // 話題の種：T1の直後、好みが合う話題を仕込んでいたら会話が芽吹く（使うと消費）
  const aff = m.cust.topicAffinity;
  if (m.stage === 'first' && m.turn === 0 && !m.topicDone && aff && State.topics[aff]) {
    m.topicDone = true;
    delete State.topics[aff];
    m.topicId = aff;
    custState(m).affection = clampAff(custState(m).affection + CONFIG.topic.affection);
    if (CONFIG.topic.moodUp) tensionUp(m, 1);
    m.phase = 'topicEvent';
    render();
    return;
  }
  // 昼の行動へのフィードバック（整形＞筋トレ＞大学の優先で、1卓に1つだけ）
  // 「見た目が変わった」に気づけるのは、前の姿を知っている客だけ。初対面の客に比較対象はない
  // （大学ネタは見た目の話ではないので、初対面でも出る）
  const knowsYou = !m.firstMeet;
  const lookBuzz = knowsYou && (State.seikeiBuzz || State.kintoreBuzz);
  if (m.stage === 'first' && m.turn === 0 && !m.buzzDone && (lookBuzz || State.uniBuzz)) {
    m.buzzDone = true;
    if (lookBuzz && State.seikeiBuzz) {
      const b = State.seikeiBuzz;
      State.seikeiBuzz = null;
      const bz = CONFIG.seikei.buzz;
      if (b.ok) {
        State.night.earned += bz.drink;
        State.night.breakdown.push(`ご祝儀ドリンク（${m.cust.name}） ${yen(bz.drink)}`);
        custState(m).affection = clampAff(custState(m).affection + bz.affection);
        tensionUp(m, 1);
      } else {
        State.mental = clampMental(State.mental + bz.failMental);
      }
      m.buzzResult = { kind: 'seikei', ok: b.ok };
    } else if (lookBuzz && State.kintoreBuzz) {
      State.kintoreBuzz = false;
      const bz = CONFIG.kintore.buzz;
      State.night.earned += bz.drink;
      State.night.breakdown.push(`おかわりドリンク（${m.cust.name}） ${yen(bz.drink)}`);
      custState(m).affection = clampAff(custState(m).affection + bz.affection);
      tensionUp(m, 1);
      m.buzzResult = { kind: 'kintore' };
    } else {
      State.uniBuzz = false;
      custState(m).affection = clampAff(custState(m).affection + CONFIG.uni.buzz.affection);
      tensionUp(m, 1);
      m.buzzResult = { kind: 'uni' };
    }
    m.phase = 'buzzEvent';
    render();
    return;
  }
  const od = CONFIG.serve.onedari;
  // 1本目＝まだ入っていないとき。2本目＝入れてもらったあと、正解を続けて機嫌を保てたときだけ
  const canOnedari = !m.sold
    || ((m.soldCount || 0) < od.maxPerTable && (m.streakSinceSale || 0) >= od.encoreStreak);
  if (m.stage === 'jonai' && (m.turn + 1) >= od.fromJonaiTurn && canOnedari) {
    m.encore = !!m.sold;
    m.offer = buildOffer(m);
    m.phase = 'onedari';
  } else {
    advanceTurn();
  }
  render();
};

G.afterBuzz = function(){
  advanceTurn();
  render();
};

G.afterTopic = function(){
  advanceTurn();
  render();
};

// 場内に入る：この時点で場内ユニットを選ぶ（探りで立った種を条件に使える）
function enterJonai(m){
  const cs = custState(m);
  let u = pickUnit(m.cust, 'jonai', cs, m.firstUnit.id);
  if (!u) {   // once を配り切った保険：条件を満たす無印のものを頭から、それも無ければ先頭
    const all = unitsOf(m.cust, 'jonai');
    u = all.find(x => !x.bindFirst && x.needs.every(f => cs.flags.includes(f))) || all[0];
  }
  m.jonaiUnit = u;
  cs.jonaiCount = (cs.jonaiCount || 0) + 1;
  consumeUnit(m.cust, 'jonai', cs, u, m.firstUnit.id);
  m.stage = 'jonai';
  m.turn = 0;
  m.streak = 0;
  shuffleChoices();
  m.phase = 'turn';
}

function advanceTurn(){
  const m = State.night.current;
  const s = CONFIG.serve;
  if (m.stage === 'first') {
    if (m.turn + 1 >= s.firstRallies) {
      // 場内指名判定：正答率60%以上
      if (m.correct / s.firstRallies >= s.jonaiRate) {
        custState(m).lastSuccess = true;
        if (m.honshimei) {
          // 本指名客に場内指名は発生しない。会話はそのまま深い段へ滑り込む
          addTrust(CONFIG.trust.jonai, `本指名の満足（${m.cust.name}）`);
          enterJonai(m);
        } else {
          State.night.earned += CONFIG.pay.jonaiBack;
          State.night.breakdown.push(`場内指名バック（${m.cust.name}） ${yen(CONFIG.pay.jonaiBack)}`);
          addTrust(CONFIG.trust.jonai, `場内指名（${m.cust.name}）`);
          m.phase = 'jonaiGet';
        }
      } else {
        settleDrinks(m);
        State.night.chenjiCount = (State.night.chenjiCount || 0) + 1;
        m.phase = 'chenji';
      }
    } else {
      m.turn++; shuffleChoices(); m.phase = 'turn';
    }
  } else {
    if (m.turn + 1 >= s.jonaiRallies) { settleDrinks(m); m.phase = 'tableEnd'; }
    else { m.turn++; shuffleChoices(); m.phase = 'turn'; }
  }
}

G.startJonai = function(){
  const m = State.night.current;
  enterJonai(m);
  render();
};

// ---- おねだり ----
// 4本の中から自分で選ぶ。上の階級ほど客が首を縦に振らなくなる。
// 好感度＝今夜の温度、関係値＝積み上げてきたもの。ハイクラス以上は両方ないと開かない。
const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];
const CLASS_ORDER = ['entry', 'middle', 'high', 'elite'];
// 旧データ（tierCap/tierFloor）の語彙を、階級の語彙に読み替える
const CAP_TO_CLASS = { spark: 'entry', champagne: 'middle', donperi: 'elite', roze: 'elite' };
const FLOOR_TO_CLASS = { spark: 'entry', champagne: 'middle', donperi: 'high', roze: 'elite' };

function capClassIdx(cust){
  const c = CAP_TO_CLASS[cust.tierCap] || 'elite';
  return CLASS_ORDER.indexOf(c);
}
// 桁の違う客の下限（石油王など）。この人が入れると決めたら、安いものは出てこない
function floorClassIdx(cust){
  if (!cust.tierFloor) return 0;
  return CLASS_ORDER.indexOf(FLOOR_TO_CLASS[cust.tierFloor] || 'entry');
}

// 関係値：その客から場内指名を取った回数＋雑用を引き受けた回数×2。
// 来店回数を使うと「長く粘っただけの人」が最上級に届いてしまう。
// 場内は正答率がjonaiRate以上でしか付かないので、これは通った回数ではなく"当てた回数"になる。
function bondOf(cs){
  return (cs.jonaiCount || 0) + (cs.missionIdx || 0) * CONFIG.serve.onedari.bondPerMission;
}

// 今この瞬間、客が首を縦に振る最上位の階級（-1 = 何を頼んでも断られる）
function acceptedClassIdx(m){
  const cs = custState(m);
  const a = cs.affection, bond = bondOf(cs), kou = moodOf(m) === 'kou';
  const hit = m.rallies ? (m.correct || 0) / m.rallies : 0;   // 今この卓の正答率
  let idx = -1;
  CLASS_ORDER.forEach((k, i) => {
    const g = CONFIG.serve.drinkClass[k];
    if (a >= g.aff && bond >= g.bond && (!g.mood || kou) && hit >= (g.hit || 0)) idx = i;
  });
  return Math.min(idx, capClassIdx(m.cust));   // 予算の天井
}

function drinksOf(classIdx){ return CONFIG.pay.drinks[CLASS_ORDER[classIdx]] || []; }

function mixWeights(day){
  let w = CONFIG.pay.drinkMix[0].w;
  for (const row of CONFIG.pay.drinkMix) if (day >= row.fromDay) w = row.w;
  return w;
}

// 提示する4本を組む。
//   ・通る階級から最低1本（アンパイ）
//   ・その1つ上から最低1本（届きそうで届かないかもしれない誘惑）
//   ・残りは日付重みでランダム。後半ほど上の階級が増える
function buildOffer(m){
  const n = CONFIG.serve.onedari.choices;
  const capIdx = capClassIdx(m.cust);
  let loIdx = floorClassIdx(m.cust);
  const accIdx = acceptedClassIdx(m);
  let topIdx = Math.min(capIdx, Math.max(accIdx + 1, loIdx));
  // 階級の幅が狭いと4本揃わない（ハイクラスは3銘柄しかない）。
  // まず上へ、それでも足りなければ下へ広げる。下限持ちの客でも、まず上を試すのが筋。
  const stock = () => { let c = 0; for (let i = loIdx; i <= topIdx; i++) c += drinksOf(i).length; return c; };
  while (stock() < n && topIdx < capIdx) topIdx++;
  while (stock() < n && loIdx > 0) loIdx--;
  const w = mixWeights(State.day);

  const picked = [], usedNames = new Set();
  const takeFrom = (ci) => {
    if (ci < loIdx || ci > topIdx) return false;
    const pool = drinksOf(ci).filter(d => !usedNames.has(d.name));
    if (!pool.length) return false;
    const d = pool[Math.floor(Math.random() * pool.length)];
    usedNames.add(d.name);
    picked.push({ name: d.name, price: d.price, cls: CLASS_ORDER[ci], clsIdx: ci });
    return true;
  };

  if (accIdx >= loIdx) takeFrom(accIdx);          // 確実に通る1本
  if (topIdx > accIdx) takeFrom(topIdx);          // 背伸びの1本
  let guard = 0;
  while (picked.length < n && guard++ < 200) {
    let tot = 0;
    for (let i = loIdx; i <= topIdx; i++) tot += w[i] || 0;
    let r = Math.random() * (tot || 1), ci = loIdx;
    for (let i = loIdx; i <= topIdx; i++) { r -= (w[i] || 0); if (r <= 0) { ci = i; break; } }
    if (!takeFrom(ci)) { for (let i = topIdx; i >= loIdx; i--) if (takeFrom(i)) break; }
  }
  picked.sort((a, b) => a.price - b.price);
  return picked;
}

// 見送る
G.onedariPass = function(){
  const m = State.night.current;
  m.offer = null;
  advanceTurn(); render();
};

// 提示された4本のうち、idx番目をねだる
G.onedariPick = function(idx){
  const m = State.night.current;
  const o = CONFIG.serve.onedari;
  const pick = (m.offer || [])[idx];
  if (!pick) return;
  const accIdx = acceptedClassIdx(m);
  const cs = custState(m);

  // 身の程を超えた1本＝断られる。どれだけうわずったかで冷え方が変わる
  if (pick.clsIdx > accIdx) {
    const over = pick.clsIdx - accIdx;
    const drop = over >= 2 ? o.failAffectionFar : o.failAffection;
    cs.affection = clampAff(cs.affection + drop);
    if (moodOf(m) === 'ken') { explode(); return; }
    tensionDrop(m, over >= 2 ? 'jirai' : 'hazure');
    m.offer = null;
    m.onedariResult = { ok: false, text: over >= 2
      ? `「あの……${pick.name}、どうですか？」\n\n「──……本気で言ってる？」\n彼はグラスを置いた。目が、笑っていない。\n「君さ。俺のこと、いくらの財布だと思ってんの」\n\n卓の温度が、一段で落ちた。（好感度 ${drop}・機嫌が悪化した）`
      : `「ね、今日……${pick.name}、開けちゃいません？」\n\n「……${pick.name}か。──いや、今日はやめとくわ」\n\n惜しかった。あと一歩、何かが足りなかった。（好感度 ${drop}・機嫌が悪化した）` };
    m.phase = 'onedariResult';
    render();
    return;
  }

  // 通った
  const price = pick.price;
  const back = Math.round(price * CONFIG.pay.bottleBackRate);
  const rate = Math.round(CONFIG.pay.bottleBackRate * 100);
  State.night.earned += back;
  State.night.breakdown.push(`${pick.name}バック${rate}%（${m.cust.name}） ${yen(back)}`);
  addTrust(CONFIG.trust.bottle[pick.cls], `ボトルを入れた（${pick.name}）`);
  m.sold = pick.cls;
  m.soldName = pick.name;
  m.soldCount = (m.soldCount || 0) + 1;
  m.streakSinceSale = 0;
  if (pick.clsIdx === CLASS_ORDER.indexOf('elite')) cs.donperiCount = (cs.donperiCount || 0) + 1;
  cs.affection = clampAff(cs.affection + o.cashInDrop[pick.cls]);

  // ヒント：もっと上を頼めたのに、ずいぶん下で手を打った夜。
  // 断りはしない。ただ、この人たちは自分の価値を安く見積もる女を、放っておかない。
  const best = (m.offer || []).filter(d => d.clsIdx <= accIdx).sort((a, b) => b.price - a.price)[0];
  const gap = best ? best.price - price : 0;
  const nudge = gap >= o.hintGap ? pickOne(DATA.onedariNudge) : null;

  const head = m.encore
    ? `「……ねえ。この空気のまま、終わらせちゃうんですか？」\n\n「──はは、言うようになったな」\n彼はボーイさんに指を上げた。\n\n${pick.name}（${yen(price)}）、本日2本目！`
    : pick.clsIdx >= CLASS_ORDER.indexOf('elite')
      ? `「……${pick.name}、って。言ってみてもいいですか」\n\n彼は数秒こちらを見て、それから短く笑った。\n「──いいよ。持ってきて」\n\n${pick.name}（${yen(price)}）が卓に入った！　店内が、少しざわついた。`
      : `「ね、今日……${pick.name}、開けちゃいません？」\n\n「……しょうがないなあ」\n\n${pick.name}（${yen(price)}）が卓に入った！`;

  m.offer = null;
  m.onedariResult = { ok: true, nudge,
    text: `${head}（バック${rate}% ＝ +${yen(back)}）${nudge ? `\n\n${nudge}` : ''}` };
  m.phase = 'onedariResult';
  render();
};

G.afterOnedari = function(){
  advanceTurn();
  render();
};

G.endTable = function(){ nextTable(); };

G.endSoutai = function(){ endNight(); };

// ---------------------------------------------------------------------
// 夜の終わり・日送り
// ---------------------------------------------------------------------
function endNight(){
  // 閉店後、下手な夜はたまに店長に呼び出される（翌夜は卓を減らされる）
  const sc = CONFIG.scold;
  const nn = State.night;
  if (!nn.scolded && State.screen !== 'soutai'
      && ((nn.chenjiCount || 0) >= 1 || (nn.jiraiCount || 0) >= sc.jiraiLine)
      && Math.random() < sc.chance) {
    nn.scolded = true;
    State.mental = clampMental(State.mental + sc.mental);
    State.stamina = clampStamina(State.stamina + sc.stamina);
    State.benchNext = true;
    State.screen = 'scold';
    render();
    return;
  }
  // 閉店後、まれにモブ客からアフターの誘い
  const ai = CONFIG.afterInvite;
  const seen = State.night.mobsSeen || [];
  if (State.day >= ai.fromDay && !State.night.afterDone && State.screen !== 'soutai' && !State.afterReturn && seen.length && Math.random() < ai.chance) {
    State.night.afterDone = true;
    State.night.wasFull = true;   // 皆勤ぶんの信頼はアフター後に付ける
    State.afterGuest = seen[Math.floor(Math.random() * seen.length)];
    State.afterResult = null;
    State.screen = 'after';
    render();
    return;
  }
  finishNight(State.screen !== 'soutai');
}

function finishNight(full){
  State.stats.talk = clampStat(State.stats.talk + CONFIG.talkGrowthPerNight);
  if (full) addTrust(CONFIG.trust.perNight, '皆勤');
  State.workedToday = true;
  State.nagashiStreak = 0;   // 本気で出た夜は、流しの連投カウントを切る
  endDay(State.night.earned);
}

// アフターの選択：0=参加／1=丁寧に断る／2=店のルールを盾に断る／3=軽くあしらう
G.afterChoice = function(i){
  const ai = CONFIG.afterInvite;
  const g = State.afterGuest;
  if (i === 0) {
    const fun = Math.random() < ai.funRate;
    const eff = fun ? ai.fun : ai.bore;
    State.stamina = clampStamina(State.stamina + eff.stamina);
    State.mental = clampMental(State.mental + eff.mental);
    if (fun) {
      const d = ai.returnDelay;
      State.afterReturn = { day: State.day + d[0] + Math.floor(Math.random() * (d[1] - d[0] + 1)), name: g.name };
      State.afterResult = { text: DATA.afterScenes.fun, note: `体力 +${eff.stamina}／メンタル +${eff.mental}／……${g.name}さん、また来てくれるかも` };
    } else {
      State.afterResult = { text: DATA.afterScenes.bore, note: `体力 ${eff.stamina}／メンタル ${eff.mental}／再来の気配は、ない` };
    }
  } else if (i === 1) {
    State.afterResult = { text: DATA.afterScenes.declineSoft, note: '今夜はしっかり休める' };
  } else if (i === 2) {
    State.afterResult = { text: DATA.afterScenes.declineRule, note: '今夜はしっかり休める' };
  } else {
    State.mental = clampMental(State.mental + ai.angryMental);
    State.afterResult = { text: DATA.afterScenes.declineAngry, note: `メンタル ${ai.angryMental}` };
  }
  render();
};
G.endAfter = function(){ finishNight(!!State.night.wasFull); };
G.endScold = function(){ finishNight(false); };   // お叱りの夜に、皆勤の褒めはない

// 出席がもう間に合わない＝留年不可避か（明日以降 lastDay までの残り回数で判定）
// 早期クリアの条件＝留年リスクが清算済みであること（出席を満たしたか、判定で学費-100万を背負ったか）。
// 出席が足りないまま1月に勝ち逃げして「留年をなかったことにする」穴を塞ぐ。
function ryunenUnsettled(){
  return State.uniAttended < CONFIG.uni.need && !State.uniWarned.ryunen;
}

function endDay(earned){
  State.money += earned;
  State.lastEarned = earned;
  // 翌朝のイベント出し分け用（昨夜、店に出たか＝店・客・帰り道の話をしていいか）
  State.workedYesterday = !!State.workedToday;
  State.workedToday = false;

  // 早期クリアは留年が回避可能なときだけ（3月に留年が確定する人間に勝ち逃げはない）
  if (State.money >= CONFIG.goalMoney && !ryunenUnsettled()) { State.screen = 'ending'; State.win = true; render(); return; }
  if (State.day >= CONFIG.totalDays)   { State.screen = 'ending'; State.win = false; render(); return; }
  State.day++;
  State.screen = 'nightResult';
  render();
}

G.toNextDay = function(){
  // 朝の自然回復（寝れば少しは戻る）
  State.stamina = clampStamina(State.stamina + CONFIG.stamina.morning);
  State.mental = clampMental(State.mental + CONFIG.stamina.mentalMorning);
  State.night = null;
  // 初日の閉店後だけ、レイナのねぎらい＋昼パートの説明を挟む（endDayで日付は+1済み＝いまDay2）
  if (State.day === 2 && !State.day1EndSeen) {
    State.day1EndSeen = true;
    playScene('day1End', enterDay);
    return;
  }
  enterDay();
};

// 朝、昼画面に入る前に大学イベント（警告・留年判定）をチェック
function pendingUniEvent(){
  const u = CONFIG.uni;
  if (State.day >= u.ryunenDay && State.uniAttended < u.need && !State.uniWarned.ryunen) return 'ryunen';
  for (const c of u.checks) {
    if (State.day >= c.day && State.uniAttended < c.min && !State.uniWarned[c.type]) return c.type;
  }
  return null;
}

function biyouSchedule(){
  const list = [];
  for (const it of CONFIG.biyou.items) for (const d of it.days) list.push({ day: d, label: it.label, cost: it.cost });
  return list.sort((a, b) => a.day - b.day);
}

function enterDay(){
  saveGame();   // 毎朝オートセーブ（中断してもこの日の朝から再開できる）
  const ev = pendingUniEvent();
  if (ev) {
    State.uniEvent = ev;
    State.uniWarned[ev] = true;
    if (ev !== 'ryunen') {
      const p = CONFIG.uni.penalties[ev];
      if (p.mental)  State.mental = clampMental(State.mental + p.mental);
      if (p.stamina) State.stamina = clampStamina(State.stamina + p.stamina);
    }
    State.screen = 'uniEvent';
    render();
    return;
  }
  // 月初の家賃・生活費の引き落とし
  const dueLiving = CONFIG.living.days.filter(d => State.day >= d).length;
  if (State.livingPaid < dueLiving) {
    State.livingPaid++;
    State.money -= CONFIG.living.cost;
    State.screen = 'living';
    render();
    return;
  }
  // 美容維持費（ネイル・まつエク等が1件ずつ財布に来る）
  const biyouSched = biyouSchedule();
  const dueBiyou = biyouSched.filter(b => State.day >= b.day).length;
  if (State.biyouPaid < dueBiyou) {
    const item = biyouSched[State.biyouPaid];
    State.biyouPaid++;
    State.money -= item.cost;
    State.biyouItem = item;
    State.screen = 'biyou';
    render();
    return;
  }
  // 売掛飛びの発覚（ATM以外で通した客は、ある朝ツケごと消える）
  if (State.tobiDay && State.day >= State.tobiDay) {
    State.tobiDay = null;
    State.money -= CONFIG.tobi.amount;
    State.mental = clampMental(State.mental + CONFIG.tobi.mental);
    State.screen = 'tobi';
    render();
    return;
  }
  // 暴飲暴食（メンタルが低い朝、ストレスが財布を開けることがある）
  const bg = CONFIG.binge;
  if (State.mental < bg.line
      && State.day - (State.lastBinge || -99) >= bg.cooldownDays
      && Math.random() < bg.chance) {
    State.lastBinge = State.day;
    State.money -= bg.cost;
    State.mental = clampMental(State.mental + bg.mental);
    State.bingeScene = DATA.bingeScenes[Math.floor(Math.random() * DATA.bingeScenes.length)];
    State.screen = 'binge';
    render();
    return;
  }
  // 推し活の臨時出費イベント（買うか、我慢か）
  const oe = (DATA.oshiEvents || []).find(e => e.day === State.day && !State.oshiDone[e.day]);
  if (oe) {
    State.oshiDone[oe.day] = true;
    State.oshiEvent = oe;
    State.oshiResult = null;
    State.screen = 'oshiEvent';
    render();
    return;
  }
  // 店休日（大晦日・元日・初詣）＝スクリプトイベントで1日が過ぎる
  if (CONFIG.holidays.includes(State.day) && !State.holidayDone[State.day]) {
    State.holidayPicked = null;
    State.holidayNotes = [];
    const h = DATA.holidays[State.day];
    if (h.effects) applyEffects(h.effects, State.holidayNotes);
    State.screen = 'holiday';
    render();
    return;
  }
  // プチイベント（10日に1回くらいの小さな日常）
  // 昨夜の過ごし方に合うものだけを、上から順に消化する
  //   出勤した朝＝店・客・帰り道の話／休んだ朝＝部屋にいた人間の話（通販・投げ銭など）
  const pz = CONFIG.puchi;
  if (State.day - (State.lastPuchi || 0) >= pz.minGap && Math.random() < pz.chance) {
    const mode = State.workedYesterday ? 'work' : 'off';
    const idx = DATA.puchiEvents.findIndex((e, i) =>
      !State.puchiUsed[i] && (!e.when || e.when === mode));
    if (idx >= 0) {
      State.puchiUsed[idx] = true;
      State.lastPuchi = State.day;
      const ev = DATA.puchiEvents[idx];
      if (ev.mental)  State.mental  = clampMental(State.mental + ev.mental);
      if (ev.stamina) State.stamina = clampStamina(State.stamina + ev.stamina);
      if (ev.money)   State.money  += ev.money;
      State.puchiEvent = ev;
      State.screen = 'puchi';
      render();
      return;
    }
  }
  // VIP雑用ミッション（重要人物からの頼まれごと。朝の電話で打診される）
  const mi = pendingMission();
  if (mi) {
    State.mission = mi;
    State.missionPhase = 'offer';
    State.missionPicked = null;
    State.screen = 'mission';
    render();
    return;
  }
  State.screen = 'day';
  render();
}

// 次に打診すべきミッション（VIPのみ・来店回数が条件・間隔を空ける）
function pendingMission(){
  if (isSunday(State.day)) return null;   // 「今日は店に出られない」が意味を持たない日には打診されない
  if (State.day - (State.lastMission || -99) < CONFIG.mission.gapDays) return null;
  for (const id of Object.keys(CUSTOMERS)) {
    if (CUSTOMERS[id].tier !== 'vip') continue;
    const cs = State.cust[id];
    if (cs.banned) continue;
    const list = DATA.missions[id] || [];
    const idx = cs.missionIdx || 0;
    if (idx >= list.length) continue;
    if (cs.visits >= list[idx].afterVisits) return { custId: id, data: list[idx] };
  }
  return null;
}

G.missionAccept = function(){
  const cs = State.cust[State.mission.custId];
  cs.missionIdx = (cs.missionIdx || 0) + 1;
  State.lastMission = State.day;
  State.missionPhase = 'scene';
  render();
};

G.missionDecline = function(){
  const cs = State.cust[State.mission.custId];
  cs.missionIdx = (cs.missionIdx || 0) + 1;
  State.lastMission = State.day;
  cs.affection = clampAff(cs.affection + CONFIG.mission.declineAff);
  State.missionPhase = 'declined';
  render();
};

G.missionChoice = function(i){
  const ch = State.mission.data.choices[i];
  const cs = State.cust[State.mission.custId];
  cs.affection = clampAff(cs.affection + (ch.aff || 0));
  if (ch.mental)  State.mental = clampMental(State.mental + ch.mental);
  if (ch.stamina) State.stamina = clampStamina(State.stamina + ch.stamina);
  State.missionPicked = ch;
  State.missionPhase = 'result';
  render();
};

G.endMission = function(){ endDay(0); };          // 1日が消える（夜給ゼロ）
G.endMissionDecline = function(){ State.screen = 'day'; render(); };  // 断った日は普通に動ける

G.holidayChoice = function(i){
  const h = DATA.holidays[State.day];
  const c = h.choice[i];
  State.holidayPicked = c;
  if (c.effects) applyEffects(c.effects, State.holidayNotes);
  if (c.flag) State[c.flag] = true;
  render();
};

G.endHoliday = function(){
  State.holidayDone[State.day] = true;
  State.holidayPicked = null;
  State.workedYesterday = false;   // 店休日。夜の話は起きていない
  State.workedToday = false;
  if (State.money >= CONFIG.goalMoney && !ryunenUnsettled()) { State.win = true; State.screen = 'ending'; render(); return; }
  if (State.day >= CONFIG.totalDays) { State.win = State.money >= CONFIG.goalMoney; State.screen = 'ending'; render(); return; }
  State.day++;
  State.stamina = clampStamina(State.stamina + CONFIG.stamina.morning);
  State.mental = clampMental(State.mental + CONFIG.stamina.mentalMorning);
  enterDay();
};

G.endLiving = function(){ enterDay(); };
G.endBiyou = function(){ enterDay(); };
G.endBinge = function(){ enterDay(); };
G.endTobi = function(){ enterDay(); };
G.endPuchi = function(){ enterDay(); };

// 推し活の臨時出費：0=買う / 1=我慢
G.oshiChoice = function(i){
  const e = State.oshiEvent;
  if (i === 0) {
    State.money -= e.cost;
    State.mental = clampMental(State.mental + e.buyMental);
    State.oshiResult = { text: e.buyText, note: `-${yen(e.cost)}／メンタル +${e.buyMental}` };
  } else {
    State.mental = clampMental(State.mental + e.gamanMental);
    State.oshiResult = { text: e.gamanText, note: `メンタル ${e.gamanMental}` };
  }
  render();
};
G.endOshi = function(){ enterDay(); };

G.endUniEvent = function(){
  if (State.uniEvent === 'ryunen') {
    State.money += CONFIG.uni.ryunenMoney;  // 学費100万。マイナスもありうる。ゲームは続く（地獄の敗者復活戦）
  }
  enterDay();  // 同じ朝に複数のイベントが重なることもある
};

// ---------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------
function bar(v, max, cls){
  const pct = Math.round(v / max * 100);
  return `<div class="bar ${cls}"><div class="bar-fill" style="width:${pct}%"></div><span>${v}</span></div>`;
}

function renderStatus(){
  if (['title','intro'].includes(State.screen)) { $status().innerHTML = ''; $status().style.display = 'none'; return; }
  $status().style.display = '';
  const daysLeft = CONFIG.totalDays - State.day + 1;
  const staminaCls = State.stamina < CONFIG.stamina.sickLine ? 'bar-danger' : 'bar-stamina';
  const mentalCls = State.mental <= CONFIG.mentalChoice.tiredLine ? 'bar-danger' : 'bar-mental';
  const trustCls = State.trust < CONFIG.trust.weirdLine ? 'bar-danger' : 'bar-trust';
  $status().innerHTML = `
    <div class="st-row">
      <span class="st-day">${dateLabel(State.day)} ${weekdayName(State.day)}<small>・残り${daysLeft}日</small></span>
      <span class="st-money">所持金 ${yen(State.money)}<small> / 目標 ${yen(CONFIG.goalMoney)}</small></span>
    </div>
    <div class="st-row st-bars">
      <span class="st-meter">容姿 ${bar(State.stats.looks, CONFIG.statMax, 'bar-looks')}</span>
      <span class="st-meter">知性 ${bar(State.stats.intel, CONFIG.statMax, 'bar-intel')}</span>
      <span class="st-meter">トーク ${bar(State.stats.talk, CONFIG.statMax, 'bar-talk')}</span>
    </div>
    <div class="st-row st-bars">
      <span class="st-meter">体力 ${bar(State.stamina, State.staminaMax, staminaCls)}</span>
      <span class="st-meter">メンタル ${bar(State.mental, CONFIG.mentalMax, mentalCls)}</span>
      <span class="st-meter">店長の信頼 ${bar(State.trust, CONFIG.trust.max, trustCls)}</span>
    </div>`;
}

function render(){
  renderStatus();
  const S = State.screen;
  if (S === 'title') return renderTitle();
  if (S === 'intro') return renderIntro();
  if (S === 'scene') return renderScene();
  if (S === 'day') return renderDay();
  if (S === 'seikeiPart') return renderSeikeiPart();
  if (S === 'seikeiClinic') return renderSeikeiClinic();
  if (S === 'menu') return renderMenu();
  if (S === 'dayResult') return renderDayResult();
  if (S === 'forcedRest') return renderForcedRest();
  if (S === 'sick') return renderSick();
  if (S === 'fired') return renderFired();
  if (S === 'uniEvent') return renderUniEvent();
  if (S === 'living') return renderLiving();
  if (S === 'biyou') return renderBiyou();
  if (S === 'binge') return renderBinge();
  if (S === 'tobi') return renderTobi();
  if (S === 'after') return renderAfter();
  if (S === 'puchi') return renderPuchi();
  if (S === 'skipWork') return renderSkipWork();
  if (S === 'sunday') return renderSunday();
  if (S === 'nagashiScold') return renderNagashiScold();
  if (S === 'scold') return renderScold();
  if (S === 'apologize') return renderApologize();
  if (S === 'mission') return renderMission();
  if (S === 'oshiEvent') return renderOshiEvent();
  if (S === 'holiday') return renderHoliday();
  if (S === 'night') return renderNight();
  if (S === 'soutai') return renderSoutai();
  if (S === 'nightResult') return renderNightResult();
  if (S === 'ending') { clearSave(); return renderEnding(); }
}

function renderTitle(){
  const sv = loadSaved();
  const buttons = sv
    ? `<button class="btn btn-primary" onclick="G.continueGame()">つづきから（${dateLabel(sv.day)}・${yen(sv.money)}）</button>
       <button class="btn btn-ghost" onclick="G.newGame()">はじめから</button>`
    : `<button class="btn btn-primary" onclick="G.newGame()">はじめる</button>`;
  $screen().innerHTML = `
    <div class="title-screen">
      <p class="title-sub">キャバ嬢育成シミュレーション</p>
      <h1>億女を目指せ！</h1>
      <p class="title-copy">武器は色気じゃない。トークと、機転と、心。</p>
      ${buttons}
      <p class="title-note">v0.4 プロトタイプ／毎朝オートセーブ</p>
    </div>`;
}

function renderIntro(){
  const last = State.introIdx >= DATA.intro.length - 1;
  // 初日は昼パートなし＝決意したその夜に初出勤。昼メニューはDay2の朝から
  $screen().innerHTML = `
    ${sceneBanner('intro_oshi')}
    <div class="story-box">${para(DATA.intro[State.introIdx])}</div>
    <button class="btn btn-primary" onclick="${last ? 'G.toNight()' : 'State.introIdx++;render()'}">${last ? '🌙 初出勤へ' : '▼'}</button>`;
}

function dayWarnings(){
  const w = [];
  if (State.uniAttended < CONFIG.uni.need && !State.uniWarned.ryunen) {
    const u = CONFIG.uni;
    const left = uniChancesLeft(State.day);
    if (left < (u.need - State.uniAttended)) {
      w.push('……もう、出席が間に合わない。3月1日に留年が確定する（学費¥1,000,000が自腹に）');
    } else if (inWinterBreak(State.day)) {
      w.push(`大学は冬休み（1/7に再開）。出席 ${State.uniAttended}/${u.need}`);
    } else if (isWeekend(State.day)) {
      w.push(`今日は${weekdayName(State.day)}曜・大学は休講。出席 ${State.uniAttended}/${u.need}（残りチャンス${left}日）`);
    } else {
      w.push(`大学の出席 ${State.uniAttended}/${u.need}（1月末までに${u.need}回で進級・残りチャンス${left}日。留年＝学費¥1,000,000が自腹）`);
    }
  }
  if (isSunday(State.day)) w.push('今日は日曜。お店は休みで、出勤できない（夜は、街へ出る日）');
  const nextLiving = CONFIG.living.days.find(d => d > State.day);
  if (nextLiving && nextLiving - State.day <= 5) w.push(`${dateLabel(nextLiving)} に家賃・生活費 ¥${CONFIG.living.cost.toLocaleString()} の引き落としがある`);
  if (State.trust <= CONFIG.trust.firedLine) w.push('店長の信頼が底をついている。……今夜、呼び出されるかもしれない。');
  if (State.stamina < CONFIG.stamina.noWorkLine) w.push('体が動かない。今夜は出勤できそうにない（強制欠勤＝信頼も下がる）');
  else if (State.stamina < CONFIG.stamina.sickLine) w.push('顔色が悪い。このまま出勤すると熱が出るかもしれない（発熱リスク）');
  if (State.mental <= CONFIG.mentalChoice.brokenLine) w.push('心が限界。今夜卓に着いても、最悪の言葉しか浮かばない');
  else if (State.mental <= CONFIG.mentalChoice.tiredLine) w.push('心が疲れている。接客中、変な一言が口をつきそうだ');
  if (State.trust < CONFIG.trust.weirdLine2) w.push('店長の信頼が低い。いい卓はほとんど回してもらえない');
  else if (State.trust < CONFIG.trust.weirdLine) w.push('店長の信頼が低い。一番いい卓は回してもらえない');
  return w.map(t => `<p class="warn">${esc(t)}</p>`).join('');
}

function renderDay(){
  const cmds = DATA.dayCommands.map(c => {
    const conf = CONFIG.day[c.id];
    let disabled = false;
    if (c.id === 'seikei') disabled = State.money < CONFIG.seikei.clinics[0].cost;
    else if (c.id === 'uni') disabled = State.day > CONFIG.uni.lastDay || inWinterBreak(State.day) || isWeekend(State.day);
    else if (MENU_CMDS[c.id]) { const mc = Math.min(...CONFIG[c.id].options.map(o => o.cost || 0)); disabled = mc > 0 && State.money < mc; }
    else if (conf && conf.cost) disabled = State.money < conf.cost;
    return `<button class="cmd" ${disabled ? 'disabled' : ''} onclick="G.pickDay('${c.id}')">
      <b>${c.label}</b><small>${c.desc}</small></button>`;
  }).join('');
  const topicList = Object.keys(State.topics).map(t => DATA.topicNames[t]);
  const topicLine = topicList.length ? `<p class="mood-read">🌱 仕込んである話題の種：${topicList.join('・')}</p>` : '';
  $screen().innerHTML = `
    <h2>☀️ 昼</h2>
    ${sceneBanner('room')}
    <p>今日、なにをする？</p>${topicLine}${dayWarnings()}
    <div class="cmd-grid">${cmds}</div>`;
}

function renderSeikeiPart(){
  const rows = CONFIG.parts.order.map(pid => {
    const info = DATA.parts[pid];
    const v = State.parts[pid];
    const maxed = v >= CONFIG.parts.max;
    return `<button class="cmd" ${maxed ? 'disabled' : ''} onclick="G.pickSeikeiPart('${pid}')">
      <b>${info.label}　${v}</b><small>${info.menu}${maxed ? '（もう完璧）' : ''}</small></button>`;
  }).join('');
  $screen().innerHTML = `
    <h2>💉 プチ整形</h2>
    ${sceneBanner('seikei')}
    <p>どこをプチ整形しますか？<small>（容姿＝6パーツの平均。いま ${State.stats.looks}）</small></p>
    <div class="cmd-grid">${rows}</div>
    <button class="btn btn-ghost" onclick="G.cancelSub()">やっぱりやめる</button>`;
}

function renderSeikeiClinic(){
  const info = DATA.parts[State.seikeiPart];
  const rows = CONFIG.seikei.clinics.map((c, i) => {
    const disabled = State.money < c.cost;
    return `<button class="cmd cmd-wide" ${disabled ? 'disabled' : ''} onclick="G.pickSeikeiClinic(${i})">
      <b>${esc(c.name)}</b><small>${esc(c.tag)}／${yen(c.cost)}／${info.label} +${c.gain}／成功率 ${Math.round(c.rate * 100)}%</small></button>`;
  }).join('');
  $screen().innerHTML = `
    <h2>💉 ${info.label}（${info.menu}）</h2>
    ${sceneBanner('seikei')}
    <p>どのクリニックに行きますか？</p>
    <p class="onedari-note">（失敗すると効果なし・体力${CONFIG.seikei.failStamina}のダウンタイム。お金は返ってこない）</p>
    <div class="cmd-grid cmd-grid-1">${rows}</div>
    <button class="btn btn-ghost" onclick="G.backToParts()">パーツを選び直す</button>`;
}

function menuOptionDesc(o){
  const p = [o.cost ? yen(o.cost) : '無料'];
  if (o.taikei) p.push(`体型 +${o.taikei}`);
  if (o.roll) p.push(`体力上限 ${o.roll.map(([g, pr]) => `+${g}=${Math.round(pr * 100)}%`).join('/')}`);
  if (o.intel) p.push(`知性 +${o.intel}`);
  if (o.talk) p.push(`トーク +${o.talk}`);
  if (o.mental) p.push(`メンタル ${o.mental > 0 ? '+' : ''}${o.mental}`);
  if (o.stamina) p.push(`体力 ${o.stamina > 0 ? '+' : ''}${o.stamina}`);
  if (o.topic) p.push(`話題の種：${DATA.topicNames[o.topic]}`);
  return p.join('／');
}

function renderMenu(){
  const cmd = State.menuCmd;
  const meta = MENU_CMDS[cmd];
  const subs = {
    kintore: `体型 ${State.parts.taikei}／体力上限 ${State.staminaMax}`,
    dokusho: `知性 ${State.stats.intel}`,
    shumi:   `メンタル ${State.mental}`,
  };
  const rows = CONFIG[cmd].options.map((o, i) => {
    const disabled = (o.cost || 0) > 0 && State.money < o.cost;
    return `<button class="cmd cmd-wide" ${disabled ? 'disabled' : ''} onclick="G.pickMenu(${i})">
      <b>${esc(o.label)}</b><small>${menuOptionDesc(o)}</small></button>`;
  }).join('');
  const menuScene = { kintore: 'kintore_gym', dokusho: 'dokusho' }[cmd];
  $screen().innerHTML = `
    <h2>${meta.icon} ${meta.title}</h2>
    ${sceneBanner(menuScene)}
    <p>どれにする？<small>（${subs[cmd]}）</small></p>
    <div class="cmd-grid cmd-grid-1">${rows}</div>
    <button class="btn btn-ghost" onclick="G.cancelSub()">やっぱりやめる</button>`;
}

// 出勤ボタン群（店長の信頼が低いと、出勤の代わりに謝罪しかできない）
function workButtons(){
  // 日曜は店が閉まっている。稼げないかわりに、街へ出る夜がある
  if (isSunday(State.day)) {
    return `<div class="hint-box">日曜日。お店はお休み。……夜が、まるまる空いている。</div>
      <button class="btn btn-primary" onclick="G.toSunday()">🚶 ひとりで街へ出かける</button>`;
  }
  if (State.trust <= CONFIG.trust.firedLine) {
    return `<div class="hint-box">店からのシフト連絡が、来ていない。……嫌な予感がする。</div>
      <button class="btn btn-primary" onclick="G.toNight()">……店に向かう</button>`;
  }
  if (State.trust < CONFIG.trust.apologizeLine) {
    return `<div class="hint-box">店長から「今日は入らなくていい」と連絡が来た。……卓に付かせてもらえない。まずは、信頼からだ。</div>
      <button class="btn btn-primary" onclick="G.apologize()">🙇 店長に謝りに行く（今夜は働けない／信頼を取り戻す）</button>`;
  }
  return `<button class="btn btn-primary" onclick="G.toNight()">🌙 本気で出勤する</button>
    <button class="btn btn-ghost" onclick="G.toNightNagashi()">流しで出勤する（自動処理・日給${yen(CONFIG.nagashi.wage)}＋α／消耗が軽い／指名関係は進まない）</button>
    <button class="btn btn-ghost" onclick="G.skipWork()">🛏 今日は出勤しない（体力・メンタル大回復／店長の信頼が下がる${State.lastSkipDay === State.day - 1 ? '・連続はさらに冷える' : ''}）</button>`;
}

// ---- 日曜（店休）：ひとりで街へ ----
// たまに本指名客と鉢合わせる。店の外で会う客は、店の中の客とは別人だ
G.toSunday = function(){
  const honshimeiIds = Object.keys(CUSTOMERS).filter(id => {
    const cs = State.cust[id];
    return cs && cs.visits >= 2 && !cs.banned;
  });
  if (honshimeiIds.length && Math.random() < CONFIG.sunday.honshimeiChance) {
    const custId = honshimeiIds[Math.floor(Math.random() * honshimeiIds.length)];
    State.sunday = { kind: 'honshimei', custId, picked: null };
  } else {
    const list = DATA.sundayEvents;
    State.sunday = { kind: 'town', ev: list[State.sundayIdx % list.length], picked: null };
    State.sundayIdx++;
  }
  State.screen = 'sunday';
  render();
};

G.sundayChoice = function(i){
  const s = State.sunday;
  const notes = [];
  const c = s.kind === 'honshimei'
    ? DATA.sundayHonshimei.choices[i]
    : s.ev.choices[i];
  if (c.money)   { State.money += c.money; notes.push(`${yen(c.money)}`); }
  if (c.mental)  { State.mental  = clampMental(State.mental + c.mental);   notes.push(`メンタル ${c.mental > 0 ? '+' + c.mental : c.mental}`); }
  if (c.stamina) { State.stamina = clampStamina(State.stamina + c.stamina); notes.push(`体力 ${c.stamina > 0 ? '+' + c.stamina : c.stamina}`); }
  if (c.aff && s.kind === 'honshimei') {
    const cs = State.cust[s.custId];
    cs.affection = clampAff(cs.affection + c.aff);
    notes.push(`${CUSTOMERS[s.custId].name}の好感度 ${c.aff > 0 ? '+' + c.aff : c.aff}`);
  }
  if (c.topic && !State.topics[c.topic]) {
    State.topics[c.topic] = true;
    notes.push(`話題の種を仕込んだ：${DATA.topicNames[c.topic]}`);
  }
  s.picked = c;
  s.notes = notes;
  render();
};

G.endSunday = function(){ State.sunday = null; endDay(0); };

G.apologize = function(){
  const ap = CONFIG.apologize;
  const gain = ap.trust[0] + Math.floor(Math.random() * (ap.trust[1] - ap.trust[0] + 1));
  addTrust(gain, '頭を下げた');
  State.mental = clampMental(State.mental + ap.mental);
  State.apologizeResult = { gain };
  State.screen = 'apologize';
  render();
};
G.endApologize = function(){ endDay(0); };

function renderDayResult(){
  const r = State.dayResult;
  $screen().innerHTML = `
    ${sceneBanner(r.scene)}
    ${r.story ? `<div class="story-box">${para(r.story)}</div>` : ''}
    <div class="note-box">${r.notes.map(n => `<p>・${esc(n)}</p>`).join('')}</div>
    ${dayWarnings()}
    ${workButtons()}`;
}

function renderForcedRest(){
  $screen().innerHTML = `
    ${sceneBanner('rest')}
    <div class="story-box"><p>着替えようとして、腕が上がらなかった。</p><p>店に「体調不良」とだけ送って、ベッドに沈む。今日の売上はゼロ。……店長からの返信は、スタンプ1個だった。</p></div>
    <div class="note-box"><p>・体力 +${CONFIG.forcedRest.stamina}／メンタル +${CONFIG.forcedRest.mental}</p><p>・店長の信頼 ${CONFIG.trust.absent}（欠勤）</p></div>
    <button class="btn btn-primary" onclick="G.endForcedRest()">目を閉じる</button>`;
}

function renderSick(){
  $screen().innerHTML = `
    <h2>🤒 発熱</h2>
    ${sceneBanner('sick')}
    <div class="story-box">${para(DATA.sickScene)}</div>
    <div class="note-box"><p>・${CONFIG.stamina.sickDays}日間、出勤できない</p><p>・店長の信頼 ${CONFIG.trust.sick}（病欠）</p></div>
    <button class="btn btn-primary" onclick="G.endSick()">布団に沈む</button>`;
}

function renderUniEvent(){
  const ev = State.uniEvent;
  const titles = { school: '📞 大学から着信', parent: '📞 親から電話', ryunen: '🎓 進級判定' };
  const p = CONFIG.uni.penalties[ev];
  const notes = ev === 'ryunen'
    ? `<div class="note-box"><p>・留年確定──学費 ${yen(CONFIG.uni.ryunenMoney)}</p></div>`
    : `<div class="note-box"><p>・メンタル ${p.mental}${p.stamina ? `／体力 ${p.stamina}` : ''}</p><p>・大学の出席 ${State.uniAttended}/${CONFIG.uni.need}（1月末まで＝残り${Math.max(0, CONFIG.uni.lastDay - State.day)}日）</p></div>`;
  $screen().innerHTML = `
    <h2>${titles[ev]}</h2>
    <div class="story-box bad">${para(DATA.uniCalls[ev])}</div>
    ${notes}
    <button class="btn btn-primary" onclick="G.endUniEvent()">${ev === 'ryunen' ? '……それでも、夜は来る' : '通話を切る'}</button>`;
}

const HOLIDAY_SCENE = { 12: 'omisoka', 13: 'jikka', 14: 'hatsumode' };

function renderHoliday(){
  const h = DATA.holidays[State.day];
  const banner = sceneBanner(HOLIDAY_SCENE[State.day]);
  const notes = State.holidayNotes.length
    ? `<div class="note-box">${State.holidayNotes.map(n => `<p>・${esc(n)}</p>`).join('')}</div>` : '';
  if (h.choice && !State.holidayPicked) {
    $screen().innerHTML = `
      <h2>${esc(h.title)}</h2>
      ${banner}
      <div class="story-box">${para(h.scene)}</div>
      <div class="choices">${h.choice.map((c, i) =>
        `<button class="choice" onclick="G.holidayChoice(${i})">${esc(c.label)}</button>`).join('')}</div>`;
    return;
  }
  const picked = State.holidayPicked;
  $screen().innerHTML = `
    <h2>${esc(h.title)}</h2>
    ${banner}
    <div class="story-box">${para(picked ? picked.scene : h.scene)}</div>
    ${notes}
    <button class="btn btn-primary" onclick="G.endHoliday()">${esc(h.next || '眠る')}</button>`;
}

function renderLiving(){
  $screen().innerHTML = `
    <h2>🧾 引き落とし日</h2>
    <div class="story-box">${para(DATA.livingScene)}</div>
    <div class="note-box"><p>・家賃・生活費 -${yen(CONFIG.living.cost)}</p><p>・残高 ${yen(State.money)}</p></div>
    <button class="btn btn-primary" onclick="G.endLiving()">通帳を閉じる</button>`;
}

function renderBiyou(){
  const it = State.biyouItem;
  $screen().innerHTML = `
    <h2>💅 ${esc(it.label)}</h2>
    <div class="story-box">${para(DATA.biyouScenes[it.label] || '')}</div>
    <div class="note-box"><p>・${esc(it.label)} -${yen(it.cost)}</p><p>・残高 ${yen(State.money)}</p></div>
    <button class="btn btn-primary" onclick="G.endBiyou()">続ける</button>`;
}

function renderMission(){
  const mi = State.mission;
  const cust = CUSTOMERS[mi.custId];
  const d = mi.data;
  const head = `<h2>📞 ${esc(d.title)}</h2><p class="cust-intro">${esc(cust.name)}からの頼まれごと</p>`;
  if (State.missionPhase === 'offer') {
    $screen().innerHTML = `${head}
      <div class="story-box">${para(d.call)}</div>
      <div class="choices">
        <button class="choice" onclick="G.missionAccept()">引き受ける（今日は出勤できない）</button>
        <button class="choice" onclick="G.missionDecline()">断る（好感度 ${CONFIG.mission.declineAff}）</button>
      </div>`;
  } else if (State.missionPhase === 'scene') {
    $screen().innerHTML = `${head}
      <div class="story-box">${para(d.scene)}</div>
      <div class="choices">${d.choices.map((c, i) =>
        `<button class="choice" onclick="G.missionChoice(${i})">${esc(c.text)}</button>`).join('')}</div>`;
  } else if (State.missionPhase === 'result') {
    const ch = State.missionPicked;
    $screen().innerHTML = `${head}
      <div class="story-box ok">${para(ch.react)}</div>
      <div class="note-box"><p>・${esc(cust.name)}の好感度 +${ch.aff}${ch.mental ? `／メンタル ${ch.mental > 0 ? '+' + ch.mental : ch.mental}` : ''}${ch.stamina ? `／体力 ${ch.stamina > 0 ? '+' + ch.stamina : ch.stamina}` : ''}</p><p>・今日は店を休んだ（夜の給料はなし）</p></div>
      <button class="btn btn-primary" onclick="G.endMission()">今日はこれで、おしまい</button>`;
  } else {
    $screen().innerHTML = `${head}
      <div class="story-box bad">${para(d.declineText)}</div>
      <button class="btn btn-primary" onclick="G.endMissionDecline()">……仕事に戻ろう</button>`;
  }
}

function renderScold(){
  $screen().innerHTML = `
    <h2>😤 閉店後の呼び出し</h2>
    <div class="story-box bad">${para(DATA.scoldScene)}</div>
    <div class="note-box"><p>・メンタル ${CONFIG.scold.mental}／体力 ${CONFIG.scold.stamina}</p><p>・明日はフリーの卓を1つ外される</p></div>
    <button class="btn btn-primary" onclick="G.endScold()">……頭、冷やします</button>`;
}

function renderApologize(){
  $screen().innerHTML = `
    <h2>🙇 開店前の店</h2>
    <div class="story-box">${para(DATA.apologizeScene)}</div>
    <div class="note-box"><p>・店長の信頼 +${State.apologizeResult.gain}（いま ${State.trust}）／メンタル ${CONFIG.apologize.mental}</p><p>・今夜の収入はなし</p></div>
    <button class="btn btn-primary" onclick="G.endApologize()">明日から、やり直す</button>`;
}

function renderSunday(){
  const s = State.sunday;
  const honshimei = s.kind === 'honshimei';
  const ev = honshimei ? DATA.sundayHonshimei : s.ev;
  const name = honshimei ? CUSTOMERS[s.custId].name : '';
  const title = honshimei ? `😳 ${ev.title}` : `🚶 ${ev.title}`;
  const banner = sceneBanner(honshimei ? null : 'room');
  const body = honshimei ? ev.text.replace(/\{name\}/g, name) : ev.text;

  if (!s.picked) {
    $screen().innerHTML = `
      <h2>${title}</h2>
      ${banner}
      <div class="story-box">${para(honshimei ? body : DATA.sundayIntro + '\n\n' + body)}</div>
      <div class="choices">${ev.choices.map((c, i) =>
        `<button class="choice" onclick="G.sundayChoice(${i})">${esc(c.label)}</button>`).join('')}</div>`;
    return;
  }
  const notes = s.notes.length
    ? `<div class="note-box"><p>・${s.notes.join('／')}</p><p>・残高 ${yen(State.money)}</p></div>` : '';
  $screen().innerHTML = `
    <h2>${title}</h2>
    ${banner}
    <div class="story-box ${honshimei && s.picked.aff < 0 ? 'bad' : ''}">${para(s.picked.react)}</div>
    ${notes}
    <button class="btn btn-primary" onclick="G.endSunday()">日曜が、終わる</button>`;
}

function renderNagashiScold(){
  const ng = CONFIG.nagashi;
  $screen().innerHTML = `
    <h2>😤 閉店後の呼び出し</h2>
    <div class="story-box bad">${para(DATA.nagashiScoldScene)}</div>
    <div class="note-box"><p>・店長の信頼 ${ng.scoldTrust}（いま ${State.trust}）／メンタル ${ng.scoldMental}</p></div>
    <button class="btn btn-primary" onclick="G.endNagashiScold()">……すみません</button>`;
}

function renderSkipWork(){
  const r = State.skipResult;
  $screen().innerHTML = `
    <h2>🛏 希望休</h2>
    ${sceneBanner('rest')}
    <div class="story-box">${para(r.scene)}</div>
    <div class="note-box"><p>・体力 +${r.st}／メンタル +${r.me}</p><p>・店長の信頼 ${r.dTrust}（いま ${State.trust}）</p></div>
    <button class="btn btn-primary" onclick="G.endSkipWork()">布団に、沈む</button>`;
}

function renderPuchi(){
  const ev = State.puchiEvent;
  const eff = [];
  if (ev.mental)  eff.push(`メンタル ${ev.mental > 0 ? '+' + ev.mental : ev.mental}`);
  if (ev.stamina) eff.push(`体力 ${ev.stamina > 0 ? '+' + ev.stamina : ev.stamina}`);
  if (ev.money)   eff.push(`${yen(ev.money)}`);
  $screen().innerHTML = `
    <h2>🍃 ${esc(ev.title)}</h2>
    <div class="story-box">${para(ev.text)}</div>
    ${eff.length ? `<div class="note-box"><p>・${eff.join('／')}</p></div>` : ''}
    <button class="btn btn-primary" onclick="G.endPuchi()">今日も始まる</button>`;
}

function renderAfter(){
  const g = State.afterGuest;
  if (State.afterResult) {
    $screen().innerHTML = `
      <h2>🌃 閉店後</h2>
      ${sceneBanner('after')}
      <div class="story-box">${para(State.afterResult.text)}</div>
      <div class="note-box"><p>・${esc(State.afterResult.note)}</p></div>
      <button class="btn btn-primary" onclick="G.endAfter()">帰って、寝る</button>`;
    return;
  }
  $screen().innerHTML = `
    <h2>🌃 アフターのお誘い</h2>
    ${sceneBanner('after')}
    <div class="story-box">${para(`閉店後、着替えて裏口を出ると、今夜の卓の${g.job}・${g.name}さんが待っていた。\n\n「お疲れさま。……このあと、ラーメンでもどう？」`)}</div>
    <div class="choices">
      <button class="choice" onclick="G.afterChoice(0)">「行きます。ラーメン、付き合っちゃいます」（体力・メンタルを消耗）</button>
      <button class="choice" onclick="G.afterChoice(1)">「明日も早いので……ごめんなさい」と丁寧に断る</button>
      <button class="choice" onclick="G.afterChoice(2)">「アフターはお店のルールで禁止なんです」と店のせいにする</button>
      <button class="choice" onclick="G.afterChoice(3)">「え〜、また今度で〜」と軽くあしらう</button>
    </div>`;
}

function renderTobi(){
  $screen().innerHTML = `
    <h2>💸 売掛、飛ぶ</h2>
    <div class="story-box bad">${para(DATA.tobiScene)}</div>
    <div class="note-box"><p>・立て替え -${yen(CONFIG.tobi.amount)}／メンタル ${CONFIG.tobi.mental}</p><p>・残高 ${yen(State.money)}</p></div>
    <button class="btn btn-primary" onclick="G.endTobi()">……勉強代、高すぎる</button>`;
}

function renderBinge(){
  $screen().innerHTML = `
    <h2>🍜 ストレスの請求書</h2>
    <div class="story-box">${para(State.bingeScene)}</div>
    <div class="note-box"><p>・暴飲暴食 -${yen(CONFIG.binge.cost)}／メンタル +${CONFIG.binge.mental}</p><p>・残高 ${yen(State.money)}</p></div>
    <button class="btn btn-primary" onclick="G.endBinge()">……明日から本気出す</button>`;
}

function renderOshiEvent(){
  const e = State.oshiEvent;
  if (State.oshiResult) {
    $screen().innerHTML = `
      <h2>💖 ${esc(e.title)}</h2>
      <div class="story-box">${para(State.oshiResult.text)}</div>
      <div class="note-box"><p>・${esc(State.oshiResult.note)}</p><p>・残高 ${yen(State.money)}</p></div>
      <button class="btn btn-primary" onclick="G.endOshi()">今日も生きていく</button>`;
    return;
  }
  $screen().innerHTML = `
    <h2>💖 ${esc(e.title)}</h2>
    <div class="story-box">${para(e.desc)}</div>
    <div class="choices">
      <button class="choice" onclick="G.oshiChoice(0)">${esc(e.buyLabel)}（-${yen(e.cost)}）</button>
      <button class="choice" onclick="G.oshiChoice(1)">${esc(e.gamanLabel)}</button>
    </div>`;
}

function renderFired(){
  $screen().innerHTML = `
    <h2>💔 呼び出し</h2>
    <div class="story-box">${para(DATA.firedScene)}</div>
    <button class="btn btn-primary" onclick="G.endFired()">……</button>`;
}

function renderSoutai(){
  $screen().innerHTML = `
    <h2>🌙 早退</h2>
    <div class="story-box"><p>次の卓に向かおうとして、脚が止まった。ヒールの中の足が、もう言うことを聞かない。</p><p>店長が小さくため息をついて、裏へ下がるよう顎で示した。……今夜はここまでだ。</p></div>
    <div class="note-box"><p>・店長の信頼 ${CONFIG.trust.soutai}（早退）</p></div>
    <button class="btn btn-primary" onclick="G.endSoutai()">裏へ下がる</button>`;
}

// ---- 夜の描画 ----
function renderNight(){
  const n = State.night;
  if (n.showIntro) {
    n.showIntro = false;
    $screen().innerHTML = `
      <h2>🌙 初出勤</h2>
      ${sceneBanner('mensetsu')}
      <div class="story-box">${para(DATA.firstNightIntro)}</div>
      <button class="btn btn-primary" onclick="render()">フロアへ</button>`;
    return;
  }
  if (n.tutorialIdx != null) return renderTutorial();
  if (n.eventLabel && !n.eventShown) {
    n.eventShown = true;
    $screen().innerHTML = `
      <h2>🎄 ${esc(n.eventLabel)}</h2>
      ${sceneBanner('club')}
      <div class="story-box">${para(DATA.nightEventScenes[State.day] || '')}</div>
      <div class="note-box"><p>・今夜はドリンクバック×${n.drinkMult}</p></div>
      <button class="btn btn-primary" onclick="render()">フロアへ</button>`;
    return;
  }
  if (n.current.kind === 'light') return renderLight();
  return renderMain();
}

// ---- 一枚絵つきの語りシーン（DATA.scenes を1ページずつ送る）----
// 終わったら State.scene.after に積んだ続き先へ渡す
function playScene(id, after){
  State.scene = { id, idx: 0, after };
  State.screen = 'scene';
  render();
}

function renderScene(){
  const sc = DATA.scenes[State.scene.id];
  const i = State.scene.idx;
  const pg = sc.pages[i];
  const last = i >= sc.pages.length - 1;
  const visual = pg.who === 'senpai'
    ? `<div class="cust-head">
         <span class="cust-name">💄 ${esc(DATA.senpai.title)}</span>
       </div>
       <div class="cust-visual">
         <img src="images/${DATA.senpai.id}.webp" alt="" onerror="this.parentElement.classList.add('noimg')">
         <span class="visual-fallback">（${esc(DATA.senpai.name)} の画像）</span>
       </div>`
    : '';
  $screen().innerHTML = `
    <h2>${esc(sc.title)}</h2>
    ${visual}
    <p class="turn-no">${i + 1} / ${sc.pages.length}</p>
    <div class="story-box ${pg.who ? 'cust-line' : 'monologue'}">${para(pg.text)}</div>
    <button class="btn btn-primary" onclick="G.sceneNext()">${last ? '▶' : '▼'}</button>`;
}

G.sceneNext = function(){
  const sc = DATA.scenes[State.scene.id];
  if (State.scene.idx < sc.pages.length - 1) { State.scene.idx++; render(); return; }
  const after = State.scene.after;
  State.scene = null;
  after();
};

// 初出勤の夜、先輩キャバ嬢が遊び方を教えてくれる（1ページずつ送る）
function renderTutorial(){
  const sp = DATA.senpai;
  const i = State.night.tutorialIdx;
  const last = i >= sp.pages.length - 1;
  $screen().innerHTML = `
    <div class="cust-head">
      <span class="cust-name">💄 ${esc(sp.title)}</span>
      <span class="cust-badge badge-senpai">研修</span>
    </div>
    <div class="cust-visual">
      <img src="images/${sp.id}.webp" alt="" onerror="this.parentElement.classList.add('noimg')">
      <span class="visual-fallback">（ここに ${esc(sp.name)} の画像<br><small>images/${sp.id}.webp を置くと表示</small>）</span>
    </div>
    <p class="turn-no">${i + 1} / ${sp.pages.length}</p>
    <div class="story-box cust-line">${para(sp.pages[i])}</div>
    <button class="btn btn-primary" onclick="G.tutorialNext()">${last ? 'フロアへ' : '▼'}</button>`;
}

G.tutorialNext = function(){
  const n = State.night;
  if (n.tutorialIdx < DATA.senpai.pages.length - 1) n.tutorialIdx++;
  else n.tutorialIdx = null;
  render();
};

function nightHeader(title, badge, aff){
  return `<div class="cust-head"><span class="cust-name">${title}</span>${aff || ''}${badge || ''}</div>
    <p class="cust-intro">${State.night.step}卓目</p>`;
}

function renderLight(){
  const cur = State.night.current;
  const t = cur.table;
  const who = t.job ? `${esc(t.job)}・${esc(t.name)}` : (cur.weird ? '回された卓' : 'フリーの一見さん');
  const title = `${cur.weird ? '🌀' : '🥂'} ${who}`;
  const notice = cur.notice ? `<p class="warn">${esc(DATA.weirdNotice)}</p>` : '';
  const helpNote = inTutorial() ? `<p class="help-note">${esc(DATA.helpNotice)}</p>` : '';
  const affMeter = `<span class="cust-aff">好感度 ${bar(cur.mobAff, 100, 'bar-aff')}</span>`;
  const r = cur.table.rallies[cur.rally];
  const isLast = cur.rally + 1 >= cur.table.rallies.length;
  // モブ卓は1枚絵（水割り・普通）を表示。imgが無い既存卓は従来どおり画像なし
  const mobImg = cur.table.img
    ? `<div class="cust-visual"><img src="images/mob_${cur.table.img}.webp" alt="" onerror="this.parentElement.classList.add('noimg')"><span class="visual-fallback">（モブ画像 images/mob_${cur.table.img}.webp）</span></div>`
    : '';
  if (cur.phase === 'intro') {
    const insult = cur.insult
      ? `<div class="story-box bad">${para(cur.insult)}</div>
         <div class="note-box"><p>・メンタル ${CONFIG.busu.mental}</p><p>・（……容姿を磨けば、こういう夜は減っていく）</p></div>` : '';
    $screen().innerHTML = `${nightHeader(title, stageBadge(cur), affMeter)}${notice}${helpNote}
      ${mobImg}
      <div class="story-box">${para(cur.table.desc)}</div>
      ${insult}
      <button class="btn btn-primary" onclick="G.startLightTalk()">${cur.insult ? '……笑顔で、接客スタート' : '接客スタート'}</button>`;
    return;
  }
  if (cur.phase === 'pick') {
    $screen().innerHTML = `${nightHeader(title, stageBadge(cur), affMeter)}
      ${mobImg}
      <div class="story-box cust-line">${para(r.line)}</div>
      <div class="choices">${cur.order.map((idx, oi) =>
        `<button class="choice" onclick="G.pickLight(${oi})">${esc(r.choices[idx].text)}</button>`).join('')}</div>`;
  } else {
    const bonusBox = cur.bonus
      ? `<div class="story-box ok"><p>「──あ、あと${esc(cur.bonus.label)}ひとつ」\n思わぬ追加注文だ。（${yen(cur.bonus.price)}・バック +${yen(cur.bonus.back)}）</p></div>` : '';
    $screen().innerHTML = `${nightHeader(title, stageBadge(cur), affMeter)}
      ${mobImg}
      <div class="story-box">${para(cur.picked.react)}</div>
      ${bonusBox}
      <div class="note-box"><p>・ドリンク${cur.picked.drinks}杯 バック +${yen(cur.amount)}／好感度 +${cur.affDelta}／メンタル ${cur.picked.mental}</p></div>
      <button class="btn btn-primary" onclick="G.lightNext()">${isLast ? '次の卓へ' : '次へ'}</button>`;
  }
}

function stageLabel(m){
  return m.stage === 'first'
    ? `フリー接客 ${m.turn + 1}/${CONFIG.serve.firstRallies}`
    : `場内指名 ${m.turn + 1}/${CONFIG.serve.jonaiRallies}`;
}

// 客の関係バッジ：ヘルプ（灰枠）／フリー（青枠）／場内指名（オレンジ枠）／本指名（ピンク枠）
function stageBadge(m){
  if (m.kind === 'main') {
    if (m.honshimei) return '<span class="cust-badge badge-honshimei">本指名</span>';
    if (m.stage === 'jonai') return '<span class="cust-badge badge-jonai">場内指名</span>';
    return '<span class="cust-badge badge-free">フリー</span>';   // first＝探り＝フリー接客中
  }
  if (inTutorial()) return '<span class="cust-badge badge-help">ヘルプ</span>';  // 研修中は先輩の卓に付くだけ
  return '<span class="cust-badge badge-free">フリー</span>';       // 一見・変な客は常にフリー
}

// 場面の背景画像：images/scene_{id}.webp（主人公の姿は出さない背景美術）
// 画像が無ければ枠ごと非表示になる
function sceneBanner(id){
  if (!id) return '';
  return `<div class="scene-visual"><img src="images/scene_${id}.webp" alt="" onerror="this.parentElement.style.display='none'"></div>`;
}

// 客の画像ファイル名：images/{客id}_{表情}.webp（fu=普/kou=好/ken=険/explosion=爆発）
// 画像を置くだけで自動表示される。無ければ仮枠を出す
function custImage(m){
  const face = faceOf(m);
  // 画像の出し分け：
  // ・マイナス表情(m1〜m4)＝グラスなしの1種類（{id}_{face}.webp）
  // ・プラス/ニュートラル(fu,p1〜p4)＝ボトルが入る前は水割り(_mizu)、入った後はシャンパン(プレーン)
  const isNeg = face[0] === 'm';
  const src = isNeg
    ? `images/${m.cust.id}_${face}.webp`
    : (m.sold ? `images/${m.cust.id}_${face}.webp` : `images/${m.cust.id}_${face}_mizu.webp`);
  const label = face === 'fu' ? '普通' : `テンション${m.tension > 0 ? '+' + m.tension : m.tension}`;
  // 水割り画像が無ければシャンパン(プレーン)へ、それも無ければ枠表示へフォールバック
  return `<div class="cust-visual">
    <img src="${src}" alt="" onerror="if (this.src.includes('_mizu.webp')) { this.src = this.src.replace('_mizu.webp', '.webp'); } else { this.parentElement.classList.add('noimg'); }">
    <span class="visual-fallback">（ここに ${esc(m.cust.name)} の画像／表情：${label}<br><small>images/${m.cust.id}_${face}.webp を置くと表示</small>）</span>
  </div>`;
}

function renderMain(){
  const m = State.night.current;
  const cust = m.cust;
  const aff = custState(m).affection;
  const tableNo = State.night.step;
  const header = `
    <div class="cust-head">
      <span class="cust-name">🥂 ${tableNo}卓目 — ${esc(cust.name)}</span>
      <span class="cust-aff">好感度 ${bar(aff, 100, 'bar-aff')}</span>
      ${stageBadge(m)}
    </div>
    ${custImage(m)}`;

  // 本指名の入電。逆転裁判の「異議あり！」枠（images/honshimei.webp があればそれを、無ければ文字で）
  if (m.phase === 'honshimeiCall') {
    $screen().innerHTML = `
      <div class="shimei-call" onclick="G.afterHonshimeiCall()">
        <img class="shimei-img" src="images/honshimei.webp" alt=""
             onerror="this.parentElement.classList.add('noimg')">
        <div class="shimei-text"><span>本指名が</span><span>入りました！</span></div>
        <p class="shimei-who">${esc(cust.name)}　様</p>
      </div>
      <button class="btn btn-primary" onclick="G.afterHonshimeiCall()">フロアへ出る</button>`;
    return;
  }

  if (m.phase === 'mainIntro') {
    $screen().innerHTML = `${header}
      ${m.firstMeet ? `<p class="cust-intro">${esc(cust.intro)}</p>` : ''}
      ${m.firstUnit.desc ? `<div class="story-box">${para(m.firstUnit.desc)}</div>` : ''}
      ${m.showSenpai ? `<div class="hint-box">${para(cust.senpaiHint)}</div>` : ''}
      <button class="btn btn-primary" onclick="G.startMainTalk()">接客スタート</button>`;
    return;
  }

  if (m.phase === 'turn') {
    const moodRead = State.stats.intel >= CONFIG.intel.moodReadLine
      ? `<p class="mood-read">（${MOOD_LABEL[moodOf(m)]}）</p>` : '';
    const kenCue = moodOf(m) === 'ken' && State.stats.intel < CONFIG.intel.moodReadLine
      ? `<p class="mood-cue">グラスを回す音だけが、やけに大きく聞こえる。</p>` : '';
    const typeHint = m.stage === 'first' && m.turn === 0 && State.stats.intel >= CONFIG.intel.moodReadLine
      ? `<p class="mood-read">${esc(cust.typeHint)}</p>` : '';
    const mindHint = m.mindState === 'broken'
      ? `<p class="mind-hint">${esc(DATA.brokenMindHint)}</p>`
      : m.mindState === 'tired'
        ? `<p class="mind-hint">${esc(DATA.tiredMindHint)}</p>` : '';
    const mark = i => State.stats.intel >= CONFIG.intel.jiraiMarkLine && m.effChoices[i].type === 'jirai' ? ' <span class="jirai-mark">⚠</span>' : '';
    const choices = m.choiceOrder.map((idx, oi) =>
      `<button class="choice" onclick="G.pickChoice(${oi})">${esc(m.effChoices[idx].text)}${mark(idx)}</button>`).join('');
    const nadameru = m.nadameruWindow
      ? `<button class="choice choice-nadameru" onclick="G.nadameru()">〈必死になだめる〉（好感度${CONFIG.serve.nadameru.affection}・メンタル${CONFIG.serve.nadameru.mental}）</button>` : '';
    $screen().innerHTML = `${header}
      ${typeHint}
      <div class="story-box cust-line">${para(turnData(m).line)}</div>
      ${moodRead}${kenCue}${mindHint}
      <div class="choices">${nadameru}${choices}</div>`;
    return;
  }

  if (m.phase === 'react') {
    const r = m.result;
    const cls = { seikai:'ok', bonda:'', hazure:'bad', jirai:'bad', nadameru:'', explosion:'bad' }[r.type] || '';
    const delta = r.type === 'explosion' ? '' :
      `<div class="note-box"><p>・好感度 ${r.dAff >= 0 ? '+' + r.dAff : r.dAff}／メンタル ${r.dMental}</p></div>`;
    $screen().innerHTML = `${header}
      <div class="story-box ${cls}">${para(r.text)}</div>
      ${delta}
      <button class="btn btn-primary" onclick="G.afterReact()">${m.exploded ? '……' : '次へ'}</button>`;
    return;
  }

  if (m.phase === 'topicEvent') {
    $screen().innerHTML = `${header}
      <div class="story-box ok">${para(DATA.topicEvents[m.topicId])}</div>
      <div class="note-box"><p>・話題の種「${esc(DATA.topicNames[m.topicId])}」が刺さった！　好感度 +${CONFIG.topic.affection}／機嫌が良くなった</p><p>・（この話題の種は使い切った。また仕込める）</p></div>
      <button class="btn btn-primary" onclick="G.afterTopic()">会話に戻る</button>`;
    return;
  }
  if (m.phase === 'buzzEvent') {
    const b = m.buzzResult;
    let scene, note, btn = '……ふふ。', bad = false;
    if (b.kind === 'seikei') {
      const bz = CONFIG.seikei.buzz;
      scene = b.ok ? DATA.seikeiReact.ok : DATA.seikeiReact.fail;
      note = b.ok
        ? `・ご祝儀ドリンク +${yen(bz.drink)}／好感度 +${bz.affection}／機嫌が一段上がった`
        : `・メンタル ${bz.failMental}`;
      if (!b.ok) { bad = true; btn = '……笑顔、笑顔。'; }
    } else if (b.kind === 'kintore') {
      const bz = CONFIG.kintore.buzz;
      scene = DATA.kintoreReact;
      note = `・おかわりドリンク +${yen(bz.drink)}／好感度 +${bz.affection}／機嫌が一段上がった`;
    } else {
      scene = DATA.uniReact;
      note = `・好感度 +${CONFIG.uni.buzz.affection}／機嫌が一段上がった`;
      btn = '（大学、行っといてよかった）';
    }
    $screen().innerHTML = `${header}
      <div class="story-box ${bad ? 'bad' : 'ok'}">${para(scene)}</div>
      <div class="note-box"><p>${note}</p></div>
      <button class="btn btn-primary" onclick="G.afterBuzz()">${btn}</button>`;
    return;
  }

  if (m.phase === 'jonaiGet') {
    $screen().innerHTML = `${header}
      <div class="story-box ok">${para(cust.jonaiText)}</div>
      <div class="note-box"><p>・${CONFIG.serve.firstRallies}回中 ${m.correct}回、欲しい言葉を刺せた → 場内指名成立</p>
      <p>・場内指名バック +${yen(CONFIG.pay.jonaiBack)}／店長の信頼 +${CONFIG.trust.jonai}／ここからおねだり可能</p></div>
      <button class="btn btn-primary" onclick="G.startJonai()">卓を続ける</button>`;
    return;
  }

  if (m.phase === 'chenji') {
    $screen().innerHTML = `${header}
      <div class="story-box bad">${para(cust.chenjiText)}</div>
      <div class="note-box"><p>・${CONFIG.serve.firstRallies}回中 ${m.correct}回しか刺さらなかった → チェンジ</p>
      <p>・ドリンクバック${m.drinkInfo.drinks}杯のみ +${yen(m.drinkInfo.amount)}</p></div>
      <button class="btn btn-primary" onclick="G.endTable()">次の卓へ</button>`;
    return;
  }

  if (m.phase === 'onedari') {
    const body = m.encore
      ? `<p>1本目が、まだ半分残っている。……でも、この人の機嫌はまだ上を向いている。</p>
         <p class="onedari-note">（正解を続けて開いた"2本目の窓"。欲を出すか、きれいに終わるか）</p>`
      : `<p>……今、いける気がする？　それとも、まだ？</p>
         <p class="onedari-note">（高いものほど、首を縦に振ってもらえない。場内は${CONFIG.serve.jonaiRallies}ラリーで終了・待ちすぎたら今夜はゼロ）</p>`;
    $screen().innerHTML = `${header}
      <p class="turn-no">${stageLabel(m)} 終わり</p>
      <div class="story-box">${body}</div>
      <div class="choices">
        ${(m.offer || []).map((d, i) => `
          <button class="choice onedari-drink" onclick="G.onedariPick(${i})">
            <span class="drink-name">${d.name}</span>
            <span class="drink-price">${yen(d.price)}</span>
          </button>`).join('')}
        <button class="choice" onclick="G.onedariPass()">${m.encore ? 'これ以上は言わない' : 'まだ待つ'}</button>
      </div>`;
    return;
  }

  if (m.phase === 'onedariResult') {
    const r = m.onedariResult;
    $screen().innerHTML = `${header}
      <div class="story-box ${r.ok ? 'ok' : 'bad'}">${para(r.text)}</div>
      <button class="btn btn-primary" onclick="G.afterOnedari()">次へ</button>`;
    return;
  }

  if (m.phase === 'tableEnd') {
    const summary = m.exploded
      ? '<p>卓は、最悪の形で終わった。</p>'
      : (m.soldCount || 0) >= 2
        ? '<p>ボトルが2本。……こんな夜が、月に何度かあればいいのに。</p>'
        : m.sold
          ? '<p>ボトルの入った、いい卓だった。</p>'
          : '<p>ボトルは入らなかった。今日はこんなもんか。</p>';
    $screen().innerHTML = `${header}
      <div class="story-box">${summary}</div>
      <button class="btn btn-primary" onclick="G.endTable()">次の卓へ</button>`;
    return;
  }
}

function renderNightResult(){
  const n = State.night;
  const rows = n ? n.breakdown.map(b => `<p>・${esc(b)}</p>`).join('') : '';
  const trustRows = n && n.trustNotes.length
    ? `<div class="note-box"><p>店長の信頼（いま ${State.trust}）</p>${n.trustNotes.map(t => `<p>・${esc(t)}</p>`).join('')}</div>` : '';
  $screen().innerHTML = `
    <h2>🌃 閉店</h2>
    <div class="note-box">${rows}<p class="total">今夜の収入：${yen(State.lastEarned)}</p></div>
    ${trustRows}
    <p>貯金：${yen(State.money)} ／ 目標まであと ${yen(Math.max(0, CONFIG.goalMoney - State.money))}</p>
    <button class="btn btn-primary" onclick="G.toNextDay()">眠る</button>`;
}

function renderEnding(){
  const text = State.win ? DATA.ending.win
    : State.loseReason === 'fired' ? DATA.ending.fired
    : State.loseReason === 'ryunen' ? DATA.ending.ryunen
    : DATA.ending.lose;
  const label = State.win ? '🌸 CLEAR'
    : State.loseReason === 'fired' ? '💔 GAME OVER — 解雇'
    : State.loseReason === 'ryunen' ? '🎓 GAME OVER — 留年'
    : '🌧 GAME OVER';
  $screen().innerHTML = `
    <h2>${label}</h2>
    <div class="story-box">${para(text)}</div>
    <div class="note-box"><p>・最終貯金：${yen(State.money)}（目標 ${yen(CONFIG.goalMoney)}）</p></div>
    <button class="btn btn-primary" onclick="State.screen='title';render()">タイトルへ</button>`;
}

// 起動
window.addEventListener('DOMContentLoaded', () => {
  State.screen = 'title';
  render();
});
