'use strict';
// =========================================================================
// BGM / SE ── 音のファイルは1つも持たない。全部その場で合成する。
//
//   狙いは「夜のラウンジ」。八王子の雑居ビル5階の、ちょっと安い高級感。
//   ピアノバーの生演奏を、安い音源で真似している感じ。
//
//   夜に聞こえるかどうかは、次の4つでほぼ決まる：
//     1. 短調（全曲Cm）。長調で書くと、何をどう飾ってもポップスになる
//     2. 和音が 9th / m7♭5 / 7♭9。7thだけだと"おしゃれ"止まりで、♭9で夜になる
//     3. スウィング（8分音符の裏を後ろにずらす）。イーブンだと行進曲になる
//     4. ベースが歩く（ルートに留まらず、次のコードへ半音・全音で近づく）
//   メロディは4オクターブ台。跳ねさせず、伸ばす音で置く。
//   笑いはBGMに入れない。しくじった瞬間の効果音（ズコー）だけに集中させる。
//
//   ゾーン: title / daily / work / rally / ending（切替は game.js の currentBgmZone）
//   SE: click（全ボタン共通）／success（場内指名成立）／explosion（客が爆発）
//
//   譜面の書き方は SONGS のコメントを見ること。曲を直すのに、この上の実装は触らなくていい。
// =========================================================================

// ---- 音名 → 周波数 -------------------------------------------------------
const NOTE_STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function noteFreq(n) {
  let i = 1, acc = 0;
  if (n[1] === '#') { acc = 1; i = 2; } else if (n[1] === 'b') { acc = -1; i = 2; }
  const oct = +n.slice(i);
  return 440 * Math.pow(2, ((NOTE_STEP[n[0]] + acc + (oct + 1) * 12) - 69) / 12);
}

// 譜面の1トラックを「どのマスで、どの高さを、何マスぶん鳴らすか」に開く。
// 1マス = 8分音符。`C5`=鳴らす／`-`=前の音をのばす／`.`=休み／`E4+G4+B4`=和音。
function parseNotes(src) {
  const tk = src.trim().split(/\s+/);
  const out = new Array(tk.length).fill(null);
  for (let i = 0; i < tk.length; i++) {
    if (tk[i] === '-' || tk[i] === '.') continue;
    let len = 1;
    while (i + len < tk.length && tk[i + len] === '-') len++;
    out[i] = { f: tk[i].split('+').map(noteFreq), len };
  }
  return out;
}

const AudioCtl = (() => {
  let ctx = null;
  let master = null;
  let cur = null;                                   // 再生中の曲
  let zone = null;
  let unlocked = false;
  let muted = localStorage.getItem('okujoMuted') === '1';
  const last = {};                                  // SEの連打よけ

  function ready() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // ---- 音の部品 ----------------------------------------------------------
  // 減衰する1音。lp を渡すと角を丸める（安い音源のやわらかさが出る）
  function note(type, freq, t0, dur, vol, lp, out) {
    const dest = out || master; if (!ctx || !dest) return;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t0);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    if (lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; g.connect(f); f.connect(dest); }
    else g.connect(dest);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  // ブラシのシャッ（ジャズドラムの刷毛）。ハイハットのチッより柔らかく、ラウンジ感の要
  function brush(t0, vol, out) {
    const dest = out || master; if (!ctx || !dest) return;
    const n = Math.floor(ctx.sampleRate * 0.09);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 1.4);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 5200; bp.Q.value = 0.7;
    const g = ctx.createGain(); g.gain.value = vol;
    src.connect(bp); bp.connect(g); g.connect(dest);
    src.start(t0);
  }

  // ウッドベースの胴鳴りに寄せたキック
  function kick(t0, out) {
    const dest = out || master; if (!ctx || !dest) return;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(120, t0); o.frequency.exponentialRampToValueAtTime(48, t0 + 0.11);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.055, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
    o.connect(g); g.connect(dest); o.start(t0); o.stop(t0 + 0.18);
  }

  // ---- BGM ---------------------------------------------------------------
  function setZone(z) {
    if (!SONGS[z] || z === zone) return;
    zone = z;
    if (!unlocked || muted) return;               // 解錠前は「かけたい曲」を覚えるだけ
    start(z);
  }

  function start(name) {
    const song = SONGS[name]; if (!song) return;
    if (cur && cur.name === name) return;
    if (!ready()) return;
    stop();
    if (!song.parsed) {
      song.parsed = {};
      for (const part of ['mel', 'chord', 'bass']) song.parsed[part] = parseNotes(song[part] || '.');
      song.steps = song.mel.trim().split(/\s+/).length;
    }
    const g = ctx.createGain(); g.gain.value = 1; g.connect(master);
    cur = { name, song, out: g, step: 0, at: ctx.currentTime + 0.12 };
    cur.timer = setInterval(pump, 30);
    pump();
  }

  function stop() {
    const b = cur; if (!b) return;
    cur = null;
    clearInterval(b.timer);
    const t = ctx.currentTime;
    b.out.gain.setValueAtTime(b.out.gain.value, t);
    b.out.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    setTimeout(() => { try { b.out.disconnect(); } catch (e) {} }, 700);
  }

  // 0.2秒先までの音符を予約し続ける。描画が詰まってもリズムはよれない
  function pump() {
    const b = cur; if (!b || !ctx) return;
    const s = b.song, stepDur = 30 / s.bpm;
    const sw = s.swing ?? 0.34;                   // 裏拍を後ろへずらす量（0=イーブン、0.33前後でスウィング）
    if (b.at < ctx.currentTime) b.at = ctx.currentTime + 0.05;
    while (b.at < ctx.currentTime + 0.2) {
      const i = b.step % s.steps;
      const v = s.vol ?? 1;
      // 裏拍（奇数マス）を後ろにずらす＝ジャズのハネ。ここを0にすると一気に行進曲になる
      const t = b.at + (i % 2 ? stepDur * sw : 0);

      const mel = s.parsed.mel[i];
      if (mel) for (const f of mel.f) note(s.wave || 'sine', f, t, Math.max(mel.len * stepDur * 0.95, 0.14), 0.042 * v, 2200);

      // 和音は短く切る（コンピング＝合いの手）。伸ばすとメロディを濁す
      const ch = s.parsed.chord[i];
      if (ch) for (const f of ch.f) note('sine', f, t, Math.max(ch.len * stepDur * 0.7, 0.18), 0.030 * v, 1500);

      const bass = s.parsed.bass[i];
      if (bass) for (const f of bass.f) note('triangle', f, t, Math.max(bass.len * stepDur * 0.85, 0.14), 0.05 * v, 420);

      const d = (s.drum || '........')[i % (s.drum || '........').length];
      if (d === 'k') kick(t, b.out);
      else if (d === 'b') brush(t, 0.02, b.out);
      else if (d === 'B') brush(t, 0.035, b.out);

      b.at += stepDur; b.step++;
    }
  }

  // ---- SE ----------------------------------------------------------------
  function playSe(kind) {
    if (muted) return;
    if (!ready()) return;
    const now = ctx.currentTime;
    const gap = { click: 0.04, success: 0.3, explosion: 0.4 }[kind] || 0.05;

    if (last[kind] && now - last[kind] < gap) return;
    last[kind] = now;

    if (kind === 'click') {
      // 丸いポッ。矩形波のピッだとファミコンになるので、正弦波を短く
      note('sine', 880, now, 0.055, 0.05, 2600);
      note('sine', 1760, now, 0.03, 0.018, 3000);
    } else if (kind === 'success') {
      // グラスが触れ合う「チン」＋ maj7 の上昇。場内指名が取れた音
      note('triangle', 1046.5, now, 0.16, 0.055, 6000);
      note('triangle', 1318.5, now + 0.07, 0.16, 0.05, 6000);
      note('triangle', 1568.0, now + 0.14, 0.2, 0.05, 6000);
      note('sine', 1975.5, now + 0.21, 0.5, 0.045, 8000);
      brush(now + 0.21, 0.02);
    // ---- 回答音（接客中、選択肢を押した瞬間に鳴る4種）------------------
    // 4つで1つの家族。楽器を変えず、音程の動きだけで結果を伝える。
    // 別々の効果音を4つ置くと卓がうるさくなるし、場内指名の「チン」の格も下がる。
    // 音はどれも Cm の構成音（Eb / G / Bb）。曲の上で鳴っても濁らない。
    } else if (kind === 'seikai') {
      // 上がる2音＝小さいチン。場内指名の success より短く・軽く（山場を食わないため）
      note('triangle', 1244.5, now, 0.10, 0.040, 6000);        // Eb6
      note('triangle', 1864.7, now + 0.055, 0.20, 0.034, 7000); // Bb6
    } else if (kind === 'bonda') {
      // 同じ高さの単音＝ボッ。上がりも下がりもしない＝可もなく不可もない
      note('sine', 466.2, now, 0.10, 0.045, 1100);             // Bb4
    } else if (kind === 'hazure') {
      // 下がる2音＝ボ、ト。落ちたことだけが分かる
      note('sine', 466.2, now, 0.08, 0.042, 1000);             // Bb4
      note('sine', 349.2, now + 0.07, 0.16, 0.040, 900);       // F4
    } else if (kind === 'jirai') {
      // 半音のぶつかり＋低音＝ズッ。ズコー（爆発）の短縮版で、続きがある感じを残す
      note('sawtooth', 155.6, now, 0.22, 0.045, 700);          // Eb3
      note('sawtooth', 164.8, now, 0.22, 0.040, 700);          // E3 ← 半音でぶつける
      note('triangle', 77.8, now, 0.28, 0.040, 300);           // 1オクターブ下で沈める
    } else if (kind === 'explosion') {
      // 「ズコー」。トロンボーンが半音ずつ落ちる、あの音。地雷を踏んだときだけ鳴る
      note('sawtooth', 233.1, now, 0.20, 0.05, 900);           // Bb3
      note('sawtooth', 220.0, now + 0.18, 0.20, 0.05, 850);    // A3
      note('sawtooth', 207.7, now + 0.36, 0.45, 0.055, 800);   // Ab3
      note('sawtooth', 103.8, now + 0.36, 0.5, 0.035, 500);    // 1オクターブ下で厚みを出す
    }
  }

  // ---- 解錠・ミュート ------------------------------------------------------
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    ready();
    if (zone && !muted) start(zone);
  }

  function toggleMute() {
    muted = !muted;
    localStorage.setItem('okujoMuted', muted ? '1' : '0');
    if (master) master.gain.value = muted ? 0 : 1;
    if (muted) stop();
    else if (unlocked && zone) start(zone);
    return muted;
  }

  document.addEventListener('click', (e) => {
    unlock();
    // 卓の選択肢（.choice-answer）だけは、ここでは鳴らさない。
    // 押した結果に応じた回答音を game.js 側が鳴らすので、二重になる。
    // 祝日・母・ミッション・日曜・アフターの選択肢は .choice だが回答音を持たないので、
    // ここを .choice で切ると全部無音になる。印は .choice-answer の側に付けること
    if (e.target.closest('.choice-answer')) return;
    if (e.target.closest('button, .shimei-call')) playSe('click');
  }, true);

  return { setZone, playSe, toggleMute, isMuted: () => muted };
})();

// =========================================================================
// 譜面
//   1マス = 8分音符。`C5`=鳴らす／`-`=のばす／`.`=休み／`E4+G4+B4`=和音。
//   行のあたまが1小節（8マス）。譜面を書き換えれば曲が変わる。上の実装は触らなくていい。
//   drum: 1小節ぶんを繰り返す。k=キック／b=ブラシ（弱）／B=ブラシ（強）／.=無音
//   swing: 裏拍を後ろへずらす量。0.34前後がジャズ、0だとイーブン（行進曲になる）
// =========================================================================
const SONGS = {

  /* 全曲 Cm（ハ短調）で統一。明るい長調をやめたのが、いちばん大きい変更。
     使う和音は 9th / m7♭5 / 7♭9。7thだけだと"おしゃれ"止まりで、
     ♭9 が入って初めて夜になる（Cm9 → Fm9 → Dm7♭5 → G7♭9）。
     メロディは4オクターブ台に下げ、跳ねる動きを消して、伸ばす音で置いている。 */

  /* タイトル「借り物のドレス」──まだ何も始まっていない、5階の廊下の音。 */
  title: {
    bpm: 82, wave: 'sine', drum: 'k..b..b.',
    mel: `
      .  .  Eb5 -  D5 -  C5 -
      Bb4 -  -  -  G4 -  -  -
      Ab4 -  C5 -  Eb5 -  -  -
      D5 -  -  -  -  -  .  .
      .  .  Eb5 -  F5 -  Eb5 -
      D5 -  -  -  Bb4 -  -  -
      C5 -  Eb5 -  D5 -  C5 -
      Bb4 -  -  -  -  -  .  .`,
    chord: `
      Eb4+G4+Bb4+D5 -  -  -  .  .  .  .
      C4+Eb4+G4 -  -  -  .  .  .  .
      Ab3+C4+Eb4+G4 -  -  -  .  .  .  .
      B3+F4+Ab4 -  -  -  .  .  .  .
      Eb4+G4+Bb4+D5 -  -  -  .  .  .  .
      G3+Bb3+D4+F4 -  -  -  .  .  .  .
      F4+Ab4+C5 -  -  -  .  .  .  .
      B3+F4+Ab4 -  -  -  .  .  .  .`,
    bass: `
      C2 -  Eb2 -  G2 -  Ab2 -
      Ab2 -  C3 -  Eb3 -  D3 -
      F2 -  Ab2 -  C3 -  Eb3 -
      G2 -  F2 -  Eb2 -  D2 -
      C2 -  Eb2 -  G2 -  Bb2 -
      Eb2 -  G2 -  Bb2 -  C3 -
      D2 -  F2 -  Ab2 -  C3 -
      G2 -  -  -  G2 -  -  -`,
  },

  /* 昼パート「一日にできることは、ひとつだけ」──ここだけ E♭メジャー（Cmの並行調）。
     昼なので少し明るいが、9thでけだるくしてある。跳ねるアルペジオは全部やめた。 */
  daily: {
    bpm: 88, wave: 'sine', swing: 0.22, drum: 'b.b.b.bb',
    mel: `
      .  .  G4 -  Bb4 -  -  -
      C5 -  Bb4 -  G4 -  -  -
      F4 -  G4 -  Bb4 -  C5 -
      Bb4 -  -  -  -  -  .  .
      .  .  D5 -  C5 -  Bb4 -
      G4 -  -  -  F4 -  -  -
      G4 -  Bb4 -  C5 -  D5 -
      Eb5 -  -  -  -  -  .  .`,
    chord: `
      G3+Bb3+D4+F4 -  -  -  .  .  .  .
      Eb4+G4+Bb4 -  -  -  .  .  .  .
      Ab3+C4+Eb4+G4 -  -  -  .  .  .  .
      D4+F4+Ab4 -  -  -  .  .  .  .
      G3+Bb3+D4+F4 -  -  -  .  .  .  .
      C4+Eb4+G4 -  -  -  .  .  .  .
      Bb3+D4+F4 -  -  -  .  .  .  .
      Ab3+C4+Eb4 -  -  -  D4+F4+Ab4 -  -  -`,
    bass: `
      Eb2 -  G2 -  Bb2 -  C3 -
      C3 -  Eb3 -  G3 -  F3 -
      F2 -  Ab2 -  C3 -  Eb3 -
      Bb2 -  Ab2 -  G2 -  F2 -
      Eb2 -  G2 -  Bb2 -  D3 -
      Ab2 -  C3 -  Eb3 -  D3 -
      G2 -  Bb2 -  D3 -  F3 -
      F2 -  -  -  Bb2 -  -  -`,
  },

  /* 出勤・フロア「5階のピアノバー」──店の地の音。ベースが歩く。
     ここがいちばん長く鳴る帯なので、メロディは間を多めに取ってある。 */
  work: {
    bpm: 78, wave: 'sine', vol: 0.95, drum: 'k..b..b.',
    mel: `
      .  .  G4 -  Bb4 -  -  -
      C5 -  -  -  Ab4 -  -  -
      .  .  Ab4 -  C5 -  -  -
      Bb4 -  -  -  -  -  .  .
      G4 -  Bb4 -  D5 -  -  -
      C5 -  -  -  Eb5 -  -  -
      D5 -  C5 -  Ab4 -  -  -
      G4 -  -  -  -  -  .  .`,
    chord: `
      Eb4+G4+Bb4+D5 -  -  -  .  .  .  .
      Ab3+C4+Eb4+G4 -  -  -  .  .  .  .
      F4+Ab4+C5 -  -  -  .  .  .  .
      B3+F4+Ab4 -  -  -  .  .  .  .
      G3+Bb3+D4+F4 -  -  -  .  .  .  .
      C4+Eb4+G4 -  -  -  .  .  .  .
      F4+Ab4+C5 -  -  -  .  .  .  .
      B3+F4+Ab4 -  -  -  .  .  .  .`,
    bass: `
      C2 -  Eb2 -  G2 -  Ab2 -
      F2 -  Ab2 -  C3 -  Eb3 -
      D2 -  F2 -  Ab2 -  B2 -
      G2 -  F2 -  Eb2 -  D2 -
      Eb2 -  G2 -  Bb2 -  C3 -
      Ab2 -  C3 -  Eb3 -  D3 -
      D2 -  F2 -  Ab2 -  C3 -
      G2 -  B2 -  D3 -  F3 -`,
  },

  /* 卓の会話中「探り」──いちばん長く聞く曲。ここで喋っているのは客であって、曲ではない。
     太鼓はブラシが1小節に1回だけ。ベースは全音符。和音は2小節にひとつ。 */
  rally: {
    bpm: 70, wave: 'sine', vol: 0.62, drum: '....b...',
    mel: `
      .  .  .  .  G4 -  Bb4 -
      C5 -  -  -  -  -  .  .
      .  .  .  .  Ab4 -  G4 -
      F4 -  -  -  -  -  .  .
      .  .  .  .  Bb4 -  C5 -
      Eb5 -  -  -  -  -  .  .
      .  .  .  .  D5 -  C5 -
      Bb4 -  -  -  -  -  .  .`,
    chord: `
      Eb4+G4+Bb4 -  -  -  -  -  -  -
      Eb4+G4+Bb4 -  -  -  -  -  -  -
      Ab3+C4+Eb4 -  -  -  -  -  -  -
      Ab3+C4+Eb4 -  -  -  -  -  -  -
      C4+Eb4+G4 -  -  -  -  -  -  -
      G3+Bb3+D4 -  -  -  -  -  -  -
      F4+Ab4+C5 -  -  -  -  -  -  -
      B3+F4+Ab4 -  -  -  -  -  -  -`,
    bass: `
      C2 -  -  -  -  -  -  -
      C2 -  -  -  Bb2 -  -  -
      Ab2 -  -  -  -  -  -  -
      F2 -  -  -  -  -  -  -
      Ab2 -  -  -  -  -  -  -
      Eb2 -  -  -  -  -  -  -
      D2 -  -  -  -  -  -  -
      G2 -  -  -  -  -  -  -`,
  },

  /* エンディング「100日」──いちばん遅い。太鼓なし。
     タイトルと同じ和音の並びを、速さと編成だけ落として置き直している。 */
  ending: {
    bpm: 58, wave: 'sine', vol: 0.9, swing: 0.15, drum: '........',
    mel: `
      G4 -  -  -  Bb4 -  -  -
      C5 -  -  -  -  -  -  -
      Ab4 -  -  -  G4 -  -  -
      F4 -  -  -  -  -  -  -
      Bb4 -  -  -  C5 -  -  -
      Eb5 -  -  -  -  -  -  -
      D5 -  -  -  C5 -  -  -
      C5 -  -  -  -  -  -  -`,
    chord: `
      Eb4+G4+Bb4+D5 -  -  -  -  -  -  -
      Eb4+G4+Bb4+D5 -  -  -  -  -  -  -
      Ab3+C4+Eb4+G4 -  -  -  -  -  -  -
      Ab3+C4+Eb4+G4 -  -  -  -  -  -  -
      C4+Eb4+G4+Bb4 -  -  -  -  -  -  -
      G3+Bb3+D4+F4 -  -  -  -  -  -  -
      B3+F4+Ab4 -  -  -  -  -  -  -
      Eb4+G4+Bb4+D5 -  -  -  -  -  -  -`,
    bass: `
      C2 -  -  -  -  -  -  -
      C2 -  -  -  -  -  -  -
      F2 -  -  -  -  -  -  -
      F2 -  -  -  -  -  -  -
      Ab2 -  -  -  -  -  -  -
      Eb2 -  -  -  -  -  -  -
      G2 -  -  -  -  -  -  -
      C2 -  -  -  -  -  -  -`,
  },
};

window.addEventListener('DOMContentLoaded', () => {
  const btn = document.createElement('button');
  btn.id = 'mute-btn';
  btn.type = 'button';
  btn.textContent = AudioCtl.isMuted() ? '🔇' : '🔊';
  btn.setAttribute('aria-label', 'ミュート切替');
  btn.onclick = () => { btn.textContent = AudioCtl.toggleMute() ? '🔇' : '🔊'; };
  document.body.appendChild(btn);
});
