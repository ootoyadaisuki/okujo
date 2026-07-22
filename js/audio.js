// =========================================================================
// BGM / SE 再生
//   ゾーン: title / daily / work / rally / ending（切替はgame.js側のcurrentBgmZoneが判定）
//   SE: click（全ボタン共通）／success（場内指名成立）／explosion（客が爆発）
// =========================================================================
const BGM_SRC = {
  title:  'audio/bgm_title.mp3',
  daily:  'audio/bgm_daily.mp3',
  work:   'audio/bgm_work.mp3',
  rally:  'audio/bgm_rally.mp3',
  ending: 'audio/bgm_ending.mp3',
};
const SE_SRC = {
  click:     'audio/se_click.mp3',
  success:   'audio/se_success.mp3',
  explosion: 'audio/se_explosion.mp3',
};

const AudioCtl = (() => {
  const bgm = new Audio();
  bgm.loop = true;
  bgm.volume = 0.45;

  let zone = null;
  let unlocked = false;
  let muted = localStorage.getItem('okujoMuted') === '1';
  bgm.muted = muted;

  function unlock(){
    if (unlocked) return;
    unlocked = true;
    if (zone) bgm.play().catch(() => {});
  }

  function setZone(z){
    if (!BGM_SRC[z] || z === zone) return;
    zone = z;
    bgm.src = BGM_SRC[z];
    if (unlocked) bgm.play().catch(() => {});
  }

  function playSe(name){
    if (muted) return;
    const src = SE_SRC[name];
    if (!src) return;
    const a = new Audio(src);
    a.volume = 0.8;
    a.play().catch(() => {});
  }

  function toggleMute(){
    muted = !muted;
    localStorage.setItem('okujoMuted', muted ? '1' : '0');
    bgm.muted = muted;
    return muted;
  }

  document.addEventListener('click', (e) => {
    unlock();
    if (e.target.closest('button, .shimei-call')) playSe('click');
  }, true);

  return { setZone, playSe, toggleMute, isMuted: () => muted };
})();

window.addEventListener('DOMContentLoaded', () => {
  const btn = document.createElement('button');
  btn.id = 'mute-btn';
  btn.type = 'button';
  btn.textContent = AudioCtl.isMuted() ? '🔇' : '🔊';
  btn.setAttribute('aria-label', 'ミュート切替');
  btn.onclick = () => { btn.textContent = AudioCtl.toggleMute() ? '🔇' : '🔊'; };
  document.body.appendChild(btn);
});
