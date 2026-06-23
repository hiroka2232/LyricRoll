// 歌詞をピアノロール風に流して表示するアプリ本体．
// 流れは，曲を選ぶ → TextAlive SDK が歌詞と拍を返す（onVideoReady）→ 歌詞を1文字ずつの
// 「ノート」にして拍へ吸着 → 各ノートを横6本の「段」に割り当て（commitRows）→ render() が
// 毎フレーム Canvas に描く．描画は CSS px(viewW/viewH)基準で，実体は dpr 倍に拡大している．

import './style.css';
import { Player } from 'textalive-app-api';
import { LAYOUT, COLORS, ROW_COLORS, PITCH, CONTROL, ROW_TRANSITION } from './config.js';
import { SONGS } from './songs.js';

// 段（歌詞が流れる横の行）の数．色テーブルと1対1なので長さから求める
const ROW_COUNT = ROW_COLORS.length;

// style.css の読み込み後，FOUC 防止で隠していた中身を表示に切り替える
document.documentElement.classList.remove('app-loading');

// 無害な AbortError だけコンソールから抑制する
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason && e.reason.name === 'AbortError') {
    e.preventDefault();
  }
});

// DOM
const playBtn    = document.querySelector('#play');
const pauseBtn   = document.querySelector('#pause');
const stopBtn    = document.querySelector('#stop');
const timeEl     = document.querySelector('#time');
const titleEl    = document.querySelector('#song-title');
const artistEl   = document.querySelector('#song-artist');
const bpmEl      = document.querySelector('#bpm-value');
const chordEl    = document.querySelector('#chord-value');
const canvas     = document.querySelector('#piano-roll');
const overlay    = document.querySelector('#loading-overlay');

// 再生バー
const seekBar    = document.querySelector('#seek-bar');  // バー本体（クリックで時間ジャンプ）
const seekFill   = document.querySelector('#seek-fill');
const seekTimeEl = document.querySelector('#seek-time'); // 現在位置 mm:ss
const seekDurEl  = document.querySelector('#seek-dur');  // 曲全体の長さ mm:ss

// スタート画面（曲選択）
const startScreen   = document.querySelector('#start-screen');
const startSongList = document.querySelector('#start-song-list');
const ctx        = canvas.getContext('2d');

// 描画に使うキャンバスの幅・高さ（CSSピクセル単位）．
// 実解像度は dpr 倍に拡大するが描画座標はこの viewW/viewH を使う．
let viewW = 0;
let viewH = 0;
let dpr   = 1;   // devicePixelRatio（画面の画素密度．スマホは 2〜3）

// スクロール速度（横スケール）：
//   実効速度 baseTimeScale = 曲の scroll_spd × speedMultiplier
//   LAYOUT.PX_PER_MS は baseTimeScale にさらに画面幅の掛け率をかけた値
let   speedMultiplier      = 1.0;   // スライダー倍率（0.5〜2.0）．曲をまたいで保持
let   baseTimeScale = SONGS[0].scroll_spd * speedMultiplier; // 実効 px/ms（画面幅の掛け率の前）

// 再生ボタンは「読み込み中（回転）」と「再生（▶）」で切り替わるため JS 側で持つ
const ICON_PLAY = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
const ICON_LOADING = `<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;

// ── 状態 ─────────────────────────────────────────────────
const state = {
  noteItems:           [],        // [{start, end, rowIdx, lyric}] start 順ソート済み
  beats:               [],        // [{time, pos, bar}]
  curTime:             0,         // 画面に表示している再生位置 (ms)．補間で滑らかに進める
  duration:            0,         // 曲全体の長さ (ms)
  syncTime:            0,         // 最後の onTimeUpdate で受け取ったプレイヤー時刻 (ms)
  syncWallClock:       0,         // 上を受け取った瞬間の performance.now() (ms．壁時計)
  overshootGuardUntil: 0,         // この時刻(performance.now)まで再開直後の先走り報告を弾く
  isPlaying:           false,
  isSongEnded:         false,
  activeRowSet:        new Set(), // 今まさに鳴っている段(rowIdx)の集合
  rowH:                60,        // 1段の高さ (px)．画面サイズに応じて recalcLayout が更新
  pitchScale:          1,         // ピッチ線・ボールの縮小係数（PC=1，スマホ<1）
  isReadyToPlay:       false,     // 曲の読み込みが完了し，ノートを表示できる状態か

  // 段（行）割り当て（commitRows が逐次確定していく）
  commitIdx:           0,         // 次に段を確定するノートの添字
  walkRow:             2,         // 直近に確定した段（ランダムウォークの現在位置）
  walkSeed:            0,         // ランダムウォークのタネ（曲ごとに onVideoReady で更新）
  userRow:             null,      // ユーザがタップで指定した段（null = 指定なし）
  userRowUntil:        0,         // この曲中時刻(ms)までユーザ指定を有効化
  isAutoMode:          false,

  // VUメーター用：この曲の最大声量（声量を 0〜1 に正規化するときの分母）
  maxVocalAmplitude:   0,
};

// ── Player ───────────────────────────────────────────────
const player = new Player({
  app: { token: 'piNyzZr3BgAHDkoh' },
  vocalAmplitudeEnabled: true, // 声量データ（VUメーター用）を取得できるようにする
});
let currentSongIdx = 0;

let isAppReady = false;          // onAppReady が呼ばれたら true
let isSongChosen = false;        // スタート画面で曲が選ばれたら true
let isSongLoading = false;       // createFromSongUrl 実行中（並列呼び出し防止）
let pendingNextSongIdx = null;   // 読み込み中に来た切り替え要求の保持（null=なし）

// ── 読み込みリトライ（一時的失敗・歌詞欠落への対策）──────────
// サーバーが一時的に遅いと読み込みが失敗したり歌詞が空で返るので，少し待って自動でやり直す
let loadAttempt = 0;               // 現在の曲で試した回数（loadSong でリセット）
const MAX_LOAD_RETRIES = 2;        // 自動リトライの上限回数
const RETRY_DELAY_MS   = 1500;     // リトライ前に待つ時間(ms)
const loadingText = overlay.querySelector('.loading-text');
const LOADING_MSG = '楽曲データ読み込み中...';

// 読み込み失敗／歌詞が空のときに呼ぶ．残り回数があれば自動リトライ，尽きたら失敗表示
function retryOrFailLoad(reason) {
  if (loadAttempt < MAX_LOAD_RETRIES) {
    loadAttempt++;
    console.warn(`曲データを再取得します (${loadAttempt}/${MAX_LOAD_RETRIES})。理由: ${reason}`);
    if (loadingText) loadingText.textContent = `読み込み再試行中… (${loadAttempt}/${MAX_LOAD_RETRIES})`;
    overlay.style.display = 'flex';
    setTimeout(() => {
      try { player.requestStop(); } catch (_) {} // 念のため前回の読み込み状態を片付ける
      startSongLoad(currentSongIdx);
    }, RETRY_DELAY_MS);
  } else {
    console.error(`曲データの取得に失敗しました。理由: ${reason}`);
    if (loadingText) loadingText.textContent =
      '読み込みに失敗しました。通信状況を確認し、「← 戻る」から曲を選び直してください。';
    overlay.style.display = 'flex';
    // 曲データが無いので再生ボタンは押せないままにする（誤操作防止）
    playBtn.disabled  = true;
    playBtn.innerHTML = ICON_PLAY;
  }
}

// createFromSongUrl を安全に呼ぶ唯一の窓口（並列呼び出しを防ぐ）
function startSongLoad(idx) {
  if (isSongLoading) {
    // 前の読み込み中なら完了後に切り替えるよう予約する
    pendingNextSongIdx = idx;
    return;
  }
  isSongLoading        = true;
  pendingNextSongIdx = null;

  // catch しないと，読み込み失敗時に isSongLoading が true のまま固まり
  // 以降の曲が一切読めなくなる
  player.createFromSongUrl(SONGS[idx].url).catch((err) => {
    console.error('曲の読み込みに失敗しました:', err);
    isSongLoading = false;

    // 待機中の切り替えがあればそちらを優先
    if (pendingNextSongIdx !== null) {
      const next = pendingNextSongIdx;
      pendingNextSongIdx = null;
      loadSong(next);
      return;
    }

    // 一時的な失敗の可能性 → 自動リトライ，尽きたら失敗表示
    retryOrFailLoad(err && err.message ? err.message : '読み込み失敗');
  });
}

function loadSong(idx) {
  // onAppReady・startSongLoad からも参照するので先に更新しておく
  currentSongIdx = idx;

  state.isReadyToPlay = false;
  state.noteItems     = [];
  state.beats         = [];
  state.curTime       = 0;
  state.duration      = 0;
  state.isSongEnded   = false;  // 「再生し終えた」状態を解除
  state.activeRowSet  = new Set();
  // 補間の基準も初期化（前の曲の時刻が一瞬表示されるのを防ぐため）
  state.syncTime      = 0;
  state.syncWallClock = 0;

  // 新しい曲なのでリトライ回数と読み込みメッセージを初期化
  loadAttempt = 0;
  if (loadingText) loadingText.textContent = LOADING_MSG;

  overlay.style.display = 'flex';
  playBtn.disabled      = true;
  playBtn.innerHTML     = ICON_LOADING;

  // 計器表示・シークバーをリセット
  bpmEl.textContent   = '—';
  lastBpmShown        = null;  // 次の曲が同じ BPM 値でも必ず表示を書き直すため
  timeEl.textContent  = '001 : 1';
  chordEl.textContent = '-';
  updateSeekUI(0, 0);

  // モードは曲を読み込むたびに「タッチ」へ戻す
  state.isAutoMode   = false;
  state.userRow      = null;  // 前の曲の段指定を持ち越さない
  state.userRowUntil = 0;
  autoToggle.classList.remove('active');
  autoToggle.textContent = 'モード：タッチ';

  // スタート画面のカードの選択ハイライトを更新
  document.querySelectorAll('.start-song-card').forEach((card, i) =>
    card.classList.toggle('active', i === idx));

  const song = SONGS[idx];
  // 曲名＋作者を1行で表示（作者が空のときは区切り「 / 」も出さない）
  titleEl.textContent  = song.title;
  artistEl.textContent = song.artist ? ` / ${song.artist}` : '';

  // 曲の基準スクロール速度を反映（スライダー倍率 speedMultiplier は曲をまたいで保持）
  applyScrollSpeed();

  try { player.requestStop(); } catch (_) {}

  // createFromSongUrl は isAppReady 後にしか呼べない．
  // 初回はまだ準備前なので onAppReady の中で startSongLoad() が呼ばれる．
  if (isAppReady) {
    startSongLoad(idx);
  }
}

// ── BPM 表示 ─────────────────────────────────────────────
// BPM は曲ごとの固定値（songs.js の bpm）．bpmChanges のある曲は，再生位置 t が区間内のとき
// その区間の BPM を返す．
let lastBpmShown = null; // 直前に表示した BPM（同じ値の DOM 書き込みを避けるため保持）

// 再生位置 t(ms) における BPM を返す（テンポ変更区間内ならその値，それ以外は曲の基準 bpm）
function bpmAtTime(t) {
  const song = SONGS[currentSongIdx];
  for (const change of song.bpmChanges ?? []) {
    if (t >= change.from && t < change.to) return change.bpm;
  }
  return song.bpm;
}

// 現在位置の BPM を計器表示へ反映する（値が変わったときだけ DOM を書き換える）
function updateBpmDisplay(t) {
  const bpm = bpmAtTime(t);
  if (bpm !== lastBpmShown) {
    bpmEl.textContent = bpm ?? '—';
    lastBpmShown = bpm;
  }
}

player.addListener({
  // ── SDK 初期化完了 ──────────────────────────────────────
  // createFromSongUrl はこのタイミング以降でないと "parallel calls" エラーになる
  onAppReady: (_app) => {
    if (isAppReady) return; // CORS 等で二重に呼ばれることがある
    isAppReady = true;
    if (isSongChosen) startSongLoad(currentSongIdx); // 曲が選ばれていれば読み込む
  },

  onVideoReady: (video) => {
    isSongLoading = false;

    // 待機中の曲切り替えがあれば今すぐ処理し，古い曲の残り処理は打ち切る
    if (pendingNextSongIdx !== null) {
      loadSong(pendingNextSongIdx);
      return;
    }

    // ── 文字ブロック収集 ────────────────────────────────
    const items = [];

    // この曲で非表示にするフレーズ（別歌唱と同時に鳴り，API が時刻を正しく付けられない行）
    const hiddenPhrases = SONGS[currentSongIdx].hiddenPhrases ?? [];

    // 時刻を手修正するフレーズ（フレーズ全文 → 単語ごと・文字ごとの正しい [開始ms, 終了ms]）．
    // API の時刻が大きくずれるフレーズを，曲データ側で測り直した値に差し替えるために使う．
    const correctedPhrases = SONGS[currentSongIdx].correctedPhrases ?? {};

    // フレーズ全体を前後へずらす量（フレーズ全文 → ミリ秒，負で前へ）．フレーズ内のリズムは
    // そのままに，開始位置だけを揃えたいとき（前のフレーズの直後に詰めたい等）に使う．
    const phraseShifts = SONGS[currentSongIdx].phraseShifts ?? {};

    try {
      let phrase = player.video.firstPhrase;
      while (phrase) {
        // phrase.children はこのフレーズ内に閉じた配列．word.next で辿ると後続フレーズの
        // 単語まで重複収集してしまうため children を使う．
        const words = phrase.children ?? [];
        if (words.length === 0) { phrase = phrase.next; continue; }

        // 非表示指定フレーズ（別歌唱と同時のコーラス等）はテキスト一致で丸ごと飛ばす．
        // そのまま流すと API の不正確な時刻のせいで歌より先に流れて見えるため．
        const phraseText = words.map(word => word.text ?? '').join('');
        if (hiddenPhrases.some(text => phraseText.includes(text))) { phrase = phrase.next; continue; }

        // このフレーズの手修正タイミング（無ければ undefined）．単語ごとの配列が入っている．
        const correctedWords = correctedPhrases[phraseText];

        // このフレーズ全体をずらす量（ミリ秒．指定が無ければ 0）
        const shift = phraseShifts[phraseText] ?? 0;

        // 単語ごとに個別タイミングがあるか
        const hasWordTiming = words.some(word => word.startTime !== words[0].startTime);

        if (correctedWords || hasWordTiming) {
          // 単語ごとの個別タイミングあり → 単語の時間幅で文字を均等割り（正確な同期）．
          // 手修正タイミングがあるフレーズは，均等割りの代わりに測り直した値を1文字ずつ使う．
          for (let wi = 0; wi < words.length; wi++) {
            const word = words[wi];
            const chars = [...(word.text ?? '')];
            if (!chars.length) continue;
            const wordDur = word.endTime - word.startTime;
            const charDur = wordDur > 0 ? wordDur / chars.length : 80;
            const correctedChars = correctedWords ? correctedWords[wi] : null;
            chars.forEach((ch, i) => {
              // 手修正値があればそれを，無ければ単語の時間幅から均等割りした時刻を使う
              const fix = correctedChars ? correctedChars[i] : null;
              items.push({
                start:       (fix ? fix[0] : word.startTime + i * charDur) + shift,
                end:         (fix ? fix[1] : word.startTime + (i + 1) * charDur) + shift,
                lyric:       ch,
                phraseStart: wi === 0 && i === 0,
                wordStart:   i === 0,
              });
            });
          }
        } else {
          // 全単語が同タイミング → フレーズの時間幅で全文字を均等割り（単語境界は保持）
          const allChars = [];
          words.forEach(word => {
            const wChars = [...(word.text ?? '')];
            wChars.forEach((ch, i) => allChars.push({ ch, wordStart: i === 0 }));
          });
          if (!allChars.length) { phrase = phrase.next; continue; }
          const phraseDur = phrase.endTime - phrase.startTime;
          const charDur   = phraseDur > 0 ? phraseDur / allChars.length : 100;
          allChars.forEach((item, i) => {
            items.push({
              start:       phrase.startTime + i * charDur + shift,
              end:         phrase.startTime + (i + 1) * charDur + shift,
              lyric:       item.ch,
              phraseStart: i === 0,
              wordStart:   item.wordStart,
            });
          });
        }

        phrase = phrase.next;
      }
    } catch (_) {}

    // startTime でソート
    items.sort((a, b) => a.start - b.start);

    // 歌詞解析データが届かないと items が空になる．この曲たちは必ず歌詞があるので
    // 空＝一時的な取得失敗とみなして自動リトライする
    if (items.length === 0) {
      retryOrFailLoad('歌詞データが空（504 等の可能性）');
      return;
    }
    loadAttempt = 0; // 歌詞を取得できたのでリトライ回数をリセット

    // ── ビート収集 ──────────────────────────────────────
    // ビートは歌詞と違い player.getBeats() で配列として取得する（video.firstBeat は無い）
    state.beats = [];
    try {
      const beats = player.getBeats() ?? [];
      let barNum = 1;
      for (let i = 0; i < beats.length; i++) {
        const b = beats[i];
        if (b.position === 1 && i > 0) barNum++; // position=1 で新しい小節
        state.beats.push({ time: b.startTime, pos: b.position, bar: barNum });
      }
    } catch (e) {
      console.warn('ビート取得に失敗:', e);
    }

    // ノート始点をビートグリッドへ吸着（クオンタイズ）
    quantizeItems(items, state.beats);

    // ── 段割り当ての準備 ─────────────────────────────
    // 段はここでは決めず，ノートが画面右端に入る直前に commitRows() が1つずつ確定する
    // （ユーザのタップ指定とランダムウォークを切り替えるため）
    state.commitIdx    = 0;
    state.walkRow      = Math.floor((ROW_COUNT - 1) / 2); // ミク段（段2）から開始
    state.userRow      = null;
    state.userRowUntil = 0;
    // ランダムウォークのタネ．曲ごとに変えて同じ曲でも実行のたびに違うウォークにする
    state.walkSeed     = Math.random() * 100000;

    // ── スロット幅と描画幅を事前計算 ──────────────────────────
    for (let i = 0; i < items.length; i++) {
      const nextStart = i + 1 < items.length ? items[i + 1].start : items[i].end + 200;

      // slotDur：次ノートが始まるまでの枠幅
      items[i].slotDur = Math.max(nextStart - items[i].start, 1 / LAYOUT.PX_PER_MS);

      // renderDur：実際に描くブロック幅．次ノートとの隙間が狭ければ slotDur まで伸ばして
      // くっつけ，十分あれば歌唱終了(n.end)で切る
      const gapPx = (nextStart - items[i].end) * LAYOUT.PX_PER_MS;
      items[i].renderDur = gapPx < LAYOUT.NOTE_SNAP_GAP_PX
        ? items[i].slotDur                                               // スナップ：隣とくっつける
        : Math.max(items[i].end - items[i].start, 1 / LAYOUT.PX_PER_MS); // 通常：歌唱時間で切る
    }

    // 二分探索用「ここまでの最大ブロック終端」．renderDur は単調でないため，単調増加に
    // なる cumMaxEnd を探索キーにして左端を過ぎたノートを正しくスキップできるようにする
    let maxEnd = -Infinity;
    for (const n of items) {
      maxEnd = Math.max(maxEnd, n.start + n.renderDur);
      n.cumMaxEnd = maxEnd;
    }

    // ピッチ軌跡カリング用「ここまでの最大カーブ終端」．繋がるノートのカーブは次ノート開始
    // まで伸びるため cumMaxEnd では過小評価になる．カーブ用に別途 cumMaxPitchEnd を持つ
    let maxPitchEnd = -Infinity;
    for (let i = 0; i < items.length; i++) {
      const next   = i + 1 < items.length ? items[i + 1] : null;
      const segEnd = pitchConnected(items[i], next) ? next.start : items[i].end;
      maxPitchEnd  = Math.max(maxPitchEnd, segEnd);
      items[i].cumMaxPitchEnd = maxPitchEnd;
    }

    state.noteItems = items;

    recalcLayout();

    if (video?.title)        titleEl.textContent  = video.title;
    if (video?.artist?.name) artistEl.textContent = video.artist.name;

    // BPM 表示を曲先頭（0ms）の値で初期化する（再生中は onTimeUpdate が更新する）
    updateBpmDisplay(0);

    // 曲全体の長さ（シークバー用）
    state.duration = video?.duration ?? player.video?.duration ?? 0;
    updateSeekUI(0, state.duration);

    // データは揃った（音源 Timer はまだ準備中なので再生ボタンの有効化は onTimerReady で）．
    // isReadyToPlay=true にすると音が鳴る前でもノートが画面に静止表示される．
    state.isReadyToPlay = true;

    // VUメーター用：この曲の最大声量（正規化の分母．0 なら無効扱い）
    state.maxVocalAmplitude = player.getMaxVocalAmplitude();
  },

  // ── 音源（Timer）の準備完了 ──────────────────────────────
  // requestPlay() が機能するのはこのイベント以降．ここで再生ボタンを有効化し
  // 読み込みオーバーレイを消して「押せる＝本当に音が鳴る」状態に揃える．
  onTimerReady: (_timer) => {
    playBtn.innerHTML     = ICON_PLAY;
    playBtn.disabled      = false;
    overlay.style.display = 'none';
  },

  onTimeUpdate: (t) => {
    // 再開直後，プレイヤーは数回ぶん「先の時刻（約0.6秒オーバーシュート）」を報告してから
    // 正しい位置に戻る．検証ウィンドウ中は予測 curTime から大きく外れた t を採用せず，
    // 妥当な値が来たらウィンドウを閉じて以降は t を信用する．
    if (performance.now() < state.overshootGuardUntil) {
      if (Math.abs(t - state.curTime) > 300) {
        return; // オーバーシュート値を捨て補間で滑らかに進める
      }
      state.overshootGuardUntil = 0; // 妥当な値が来た→検証終了
    }

    // 補間の基準点を記録する．描画時刻 curTime は render() がこの基準へ少しずつ近づける．
    // ここで curTime を直接上書きすると報告時刻がブレるたびに表示が振動するため上書きしない．
    state.syncTime = t;
    state.syncWallClock = performance.now();

    // 一時停止・停止中は render() の補間が働かないので報告時刻に即座に合わせる
    if (!state.isPlaying) {
      state.curTime = t;
    }

    // アクティブな段を事前計算（描画ループ内の重い検索を回避）
    const activeSet = new Set();
    const startI = lowerBound(state.noteItems, t);
    for (let i = startI; i < state.noteItems.length; i++) {
      const n = state.noteItems[i];
      if (n.start > t) break;
      if (n.end < t) continue; // cumMaxEnd 探索なので終了済みが混ざる
      activeSet.add(n.rowIdx);
    }
    state.activeRowSet = activeSet;

    // タイムコード表示：ビートデータがあれば「小節 : 拍」，なければ「分:秒」
    if (state.beats.length) {
      const beat = lastBeatAtOrBefore(t);
      if (beat) {
        const bar = String(beat.bar).padStart(3, '0'); // 3桁ゼロ埋め
        timeEl.textContent = `${bar} : ${beat.pos}`;
      } else {
        timeEl.textContent = '001 : 1';
      }
    } else {
      timeEl.textContent = formatTime(t);
    }

    // BPM 表示（テンポ変更区間に入ると値が切り替わる）
    updateBpmDisplay(t);

    // コード表示．findChord は現在時刻に重なるコードを1つ返す．
    // コードなし区間は name が "N"（No Chord）なので「-」扱いにする．
    const chord = player.findChord(t);
    chordEl.textContent = (chord && chord.name && chord.name !== 'N') ? chord.name : '-';

    // 曲を最後まで再生し終えたら終了ポップアップを出す（isSongEnded フラグで1回だけ）．
    // 最後の onTimeUpdate が duration ぴったりに来ないことがあるので 250ms 手前で拾う．
    if (!state.isSongEnded && state.isPlaying && state.duration > 0
        && t >= state.duration - 250) {
      state.isSongEnded = true;
      showEndScreen();
    }
  },

  // 再生開始．syncTime/syncWallClock を今の表示位置に合わせて補間を始める．
  // 再開直後のオーバーシュート報告は overshootGuardUntil の検証ウィンドウで弾く．
  onPlay:  () => {
    state.isPlaying  = true;
    state.syncTime = state.curTime;
    state.syncWallClock = performance.now();
    state.overshootGuardUntil = performance.now() + 700;
    playBtn.classList.add('playing');
  },
  // 一時停止．syncWallClock=0 にしないと再開時に古い syncWallClock が残って
  // 再生位置が一瞬 0.2 秒先に飛んでから戻る．
  onPause: () => { state.isPlaying = false; state.syncWallClock = 0; playBtn.classList.remove('playing'); },
  // 停止は曲を先頭(0)へ戻す．curTime/syncTime も 0 にしないと
  // 再生時に停止位置のノートが一瞬表示されてから 0 へ飛ぶ．
  onStop:  () => {
    state.isPlaying     = false;
    state.syncWallClock = 0;
    state.syncTime      = 0;
    state.curTime       = 0;
    state.activeRowSet  = new Set(); // 停止位置のハイライトを残さない
    playBtn.classList.remove('playing');
  },
});

// 曲が未読み込み（player.video が空）のときに操作すると内部でクラッシュするので
// player.video の有無を確認してから操作する
playBtn.addEventListener('click',  () => { if (player.video) player.requestPlay();  });
pauseBtn.addEventListener('click', () => { if (player.video) player.requestPause(); });
stopBtn.addEventListener('click',  () => { if (player.video) player.requestStop(); });

// 再生中なら一時停止，止まっているなら再生（スペースキーのトグル用）
function togglePlayPause() {
  if (!player.video) return;
  if (state.isPlaying) player.requestPause();
  else               player.requestPlay();
}

// ── キーボードショートカット ──────────────────────────────
// スペース＝再生/一時停止，M＝モード切替（AUTO/タッチ）
document.addEventListener('keydown', (e) => {
  // 入力欄にフォーカス中はキー操作を奪わない
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  // スタート画面表示中はショートカットを効かせない
  if (!startScreen.classList.contains('hidden')) return;

  if (e.code === 'Space') {
    e.preventDefault();          // ページスクロールを防ぐ
    togglePlayPause();
  } else if (e.key === 'm' || e.key === 'M') {
    setAutoMode(!state.isAutoMode);
  }
});

// ── スタート画面（曲選択）─────────────────────────────────
// カードを押すとその曲を読み込んでメイン画面へ進む
SONGS.forEach((song, i) => {
  const card = document.createElement('button');
  card.className = 'start-song-card';
  card.innerHTML = `
    <span class="card-title">${song.title}</span>
    <span class="card-artist">${song.artist}</span>
  `;
  card.addEventListener('click', () => chooseSong(i));
  startSongList.appendChild(card);
});

// 曲を選んだとき：スタート画面を閉じてその曲を読み込む
function chooseSong(idx) {
  isSongChosen = true;
  startScreen.classList.add('hidden');
  loadSong(idx); // isAppReady 済みなら即読み込み，未済なら onAppReady が読む
}

// スタート画面へ戻る共通処理（ヘッダーと終了ポップアップの両方の「戻る」から呼ぶ）
function returnToStartScreen() {
  try { player.requestPause(); } catch (_) {}

  // 前回選んだカードの選択ハイライトを全て外す
  document.querySelectorAll('.start-song-card').forEach((card) =>
    card.classList.remove('active'));

  startScreen.classList.remove('hidden');
}

const backToSongs = document.querySelector('#back-to-songs');
backToSongs.addEventListener('click', returnToStartScreen);

// ── 曲を最後まで再生し終えたときのポップアップ（#end-screen）──
const endScreen   = document.querySelector('#end-screen');
const endBackBtn  = document.querySelector('#end-back');
const endReplayBtn = document.querySelector('#end-replay');

function showEndScreen() { endScreen.classList.remove('hidden'); }
function hideEndScreen() { endScreen.classList.add('hidden'); }

// 「プロジェクト選択に戻る」：ポップアップを閉じてスタート画面へ戻る
endBackBtn.addEventListener('click', () => {
  hideEndScreen();
  returnToStartScreen();
});

// 「もう一度再生する」：同じ曲を最初の読み込みからやり直す
endReplayBtn.addEventListener('click', () => {
  hideEndScreen();
  loadSong(currentSongIdx);
});

// ── 操作方法ポップアップ（ヘルプモーダル）────────────────────
const helpButton   = document.querySelector('#help-button');
const helpModal    = document.querySelector('#help-modal');
const helpClose    = document.querySelector('#help-close');
const helpBackdrop = document.querySelector('#help-backdrop');

function openHelp()  { helpModal.classList.remove('hidden'); }
function closeHelp() { helpModal.classList.add('hidden'); }

helpButton.addEventListener('click',   openHelp);
helpClose.addEventListener('click',    closeHelp);
helpBackdrop.addEventListener('click', closeHelp);   // 背景の暗い部分クリックで閉じる

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeHelp();
});

// 初回アクセス時だけ自動で開く（localStorage に「一度見た」印を保存して判定する）
const HELP_SEEN_KEY = 'lyricroll-help-seen';
if (!localStorage.getItem(HELP_SEEN_KEY)) {
  openHelp();
  localStorage.setItem(HELP_SEEN_KEY, 'true');
}

// ── 再生バー（シークバー）────────────────────────────────
// ミリ秒を mm:ss 形式の文字列にする
function formatTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// シークバーの塗り幅と時間表示を更新する（毎フレーム呼ばれる）．
// DOM 書き込みは値が変わったときだけ行い毎フレームのスタイル再計算を抑える．
let lastFillPct = -1;
function updateSeekUI(cur, dur) {
  const ratio = dur > 0 ? Math.min(cur / dur, 1) : 0;
  const pct   = Math.round(ratio * 1000) / 10; // 0.1% 刻み
  if (pct !== lastFillPct) {
    seekFill.style.width = `${pct}%`;
    lastFillPct = pct;
  }

  const curText = formatTime(cur);
  if (seekTimeEl.textContent !== curText) seekTimeEl.textContent = curText;
  const durText = formatTime(dur);
  if (seekDurEl.textContent !== durText) seekDurEl.textContent = durText;
}

// ── シークバーのクリック/ドラッグで時間ジャンプ（デバッグ用）──
// バー上の位置の割合から再生位置を求め，その時刻へ移動する．
let seekDragging = false;

function seekToPointer(e) {
  if (!player.video || state.duration <= 0) return;
  const rect  = seekBar.getBoundingClientRect();
  const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
  const time  = ratio * state.duration;
  player.requestMediaSeek(time); // プレイヤー本体の再生位置を移動

  // onTimeUpdate が来るまでのちらつき防止に，表示と補間の基準も即座に移動先へ合わせる
  state.curTime       = time;
  state.syncTime      = time;
  state.syncWallClock = performance.now();
  updateSeekUI(time, state.duration);
}

seekBar.addEventListener('pointerdown', (e) => {
  seekDragging = true;
  seekBar.setPointerCapture(e.pointerId); // バー外へドラッグしても追従させる
  seekToPointer(e);
});
seekBar.addEventListener('pointermove', (e) => { if (seekDragging) seekToPointer(e); });
seekBar.addEventListener('pointerup',   (e) => {
  seekDragging = false;
  seekBar.releasePointerCapture(e.pointerId);
});

// ── 段指定（ピアノロール右部のタップ/クリック/ドラッグ）──
// pointer イベントはマウスとタッチの両方で発火する
let pointerActive = false;
let lastTouch     = null; // {x, y, color} タッチ中の現在位置
const touchTrail  = [];   // [{x, y, t, color}] 彗星の尾用の位置履歴

function pickRow(e) {
  if (state.isAutoMode) return; // AUTO 中はタッチ不可

  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const phX = playheadX();
  if (x <= phX || y <= LAYOUT.RULER_H) return; // 再生ラインより右だけ有効

  const row = Math.floor((y - LAYOUT.RULER_H) / state.rowH);
  if (row < 0 || row >= ROW_COUNT) return;

  state.userRow      = row;
  state.userRowUntil = Infinity; // AUTO が ON になるまで手動

  // 確定済みでも，まだ再生ラインの右にあるノートは指定段へ振り直す
  // （冒頭は1画面分が先に確定済みのため，これがないと反応が数秒遅れる）
  const items   = state.noteItems;
  const minTime = state.curTime + CONTROL.LEAD_MS;
  let i = lowerBound(items, minTime);
  // 次の単語の先頭まで進める（再生中の単語が途中で段替わりしないように）
  while (i < state.commitIdx && !(items[i].wordStart && items[i].start > minTime)) i++;
  for (; i < state.commitIdx; i++) items[i].rowIdx = row;
  state.walkRow = row; // 以降のランダムウォークもこの段から続ける

  // タッチ演出用に位置を記録（色は指定段のキャラカラー）
  const color = ROW_COLORS[row % ROW_COLORS.length];
  lastTouch = { x, y, color };
  touchTrail.push({ x, y, t: performance.now(), color });
}

canvas.addEventListener('pointerdown', (e) => { pointerActive = true; pickRow(e); });
canvas.addEventListener('pointermove', (e) => { if (pointerActive) pickRow(e); });
window.addEventListener('pointerup',   ()  => { pointerActive = false; lastTouch = null; });

// ── VUメーター（ツールバーのミニLED表示．装飾）─────────────
// 取得できるのは歌声の音量1値だけなので，それを複数バンドに振り分け，各バンドに
// 違う揺らぎを与えてスペクトラムアナライザ風に見せている（実際の周波数解析ではない）
const vuCanvas = document.querySelector('#vu-meter');
const vuCtx    = vuCanvas.getContext('2d');

const VU_W     = 64;   // 表示サイズ（CSS と一致させる）
const VU_H     = 24;
const VU_BANDS = 7;    // 横に並べるバンド（列）の数
const VU_SEGS  = 6;    // 1バンドあたりの LED の段数

// dpr を掛けた実ピクセルを確保してくっきり描く（scale 後は VU_W×VU_H 座標系で描ける）
const vuDpr = window.devicePixelRatio || 1;
vuCanvas.width  = VU_W * vuDpr;
vuCanvas.height = VU_H * vuDpr;
vuCtx.scale(vuDpr, vuDpr);

// 各バンドの現在レベル(0〜1)と，ピークホールド位置（段数．ゆっくり落ちる）
const vuBands = new Array(VU_BANDS).fill(0);
const vuPeaks = new Array(VU_BANDS).fill(0);

function updateVU() {
  // 全体の音量レベル(0〜1)．再生中だけ実データを読み，停止中は 0．
  let level = 0;
  if (state.isPlaying && state.maxVocalAmplitude > 0) {
    const raw = player.getVocalAmplitude(state.curTime);
    level = raw / state.maxVocalAmplitude;
    if (level > 1) level = 1;
  }

  const tSec = performance.now() / 1000; // 揺らぎ用の時刻[秒]

  for (let band = 0; band < VU_BANDS; band++) {
    // バンドごとに位相と速さを変えた揺らぎでスペクトルらしさを出す
    const wobble = 0.75 + 0.25 * Math.sin(tSec * (2 + band * 0.7) + band * 1.7);
    let target = level * wobble;
    if (target > 1) target = 1;

    // 上がるとき速く・下がるときゆっくり（VUメーターらしい動き）
    const speed = target > vuBands[band] ? 0.6 : 0.12;
    vuBands[band] += (target - vuBands[band]) * speed;

    // ピークホールド：今の高さを超えたら更新，そうでなければ少しずつ落とす
    const curSeg = vuBands[band] * VU_SEGS;
    if (curSeg >= vuPeaks[band]) vuPeaks[band] = curSeg;
    else                         vuPeaks[band] = Math.max(0, vuPeaks[band] - 0.08);
  }

  drawVU();
}

function drawVU() {
  vuCtx.clearRect(0, 0, VU_W, VU_H);

  const gap   = 1; // バンド間・段間の隙間[px]
  const cellW = (VU_W - gap * (VU_BANDS + 1)) / VU_BANDS;
  const cellH = (VU_H - gap * (VU_SEGS + 1)) / VU_SEGS;

  for (let band = 0; band < VU_BANDS; band++) {
    const x       = gap + band * (cellW + gap);
    const litCnt  = Math.round(vuBands[band] * VU_SEGS); // 点灯する段数
    const peakSeg = Math.round(vuPeaks[band]);           // ピーク位置

    for (let seg = 0; seg < VU_SEGS; seg++) {
      const isRed = seg >= VU_SEGS - 2;                        // 上2段を赤に
      const y     = VU_H - gap - (seg + 1) * cellH - seg * gap; // 下から積み上げる

      if (seg < litCnt) {
        vuCtx.fillStyle = isRed ? '#ff2f2f' : '#1ee03c';    // 点灯
      } else if (seg + 1 === peakSeg) {
        vuCtx.fillStyle = isRed ? '#5a0d0d' : '#0d5a18';    // ピーク跡（暗い）
      } else {
        continue;                                           // 消灯は描かない
      }
      vuCtx.fillRect(x, y, cellW, cellH);
    }
  }
}

// ── 音量コントロール ─────────────────────────────────────
const volumeControl = document.querySelector('#volume-control');
const volumeToggle  = document.querySelector('#volume-toggle');
const volumePopup   = document.querySelector('#volume-popup');
const volumeSlider  = document.querySelector('#volume-slider');
const volumeValue   = document.querySelector('#volume-value');

// ボタンを押すたびに縦スライダーの表示/非表示を切り替える
volumeToggle.addEventListener('click', (e) => {
  e.stopPropagation(); // 「外側クリックで閉じる」処理に拾われないようにする
  const hidden = volumePopup.classList.toggle('hidden');
  volumeToggle.classList.toggle('active', !hidden);
});

// スライダーを動かすたびにプレイヤーの音量（0〜100）へ反映する
volumeSlider.addEventListener('input', () => {
  const volume = Number(volumeSlider.value);
  player.volume = volume;
  volumeValue.textContent = volume;
});

// ポップアップの外側をクリックしたら閉じる
document.addEventListener('click', (e) => {
  if (!volumeControl.contains(e.target)) {
    volumePopup.classList.add('hidden');
    volumeToggle.classList.remove('active');
  }
});

// ── スクロール速度コントロール（音量コントロールと同じ作り）──────
const speedControl = document.querySelector('#speed-control');
const speedToggle  = document.querySelector('#speed-toggle');
const speedPopup   = document.querySelector('#speed-popup');
const speedSlider  = document.querySelector('#speed-slider');
const speedValue   = document.querySelector('#speed-value');

// 速度スライダー最小値での倍率（スライダー値＝倍率×100 なので min/100．例 min=50 → ×0.5）
const SPEED_MIN_MULTIPLIER = Number(speedSlider.min) / 100;

// 歌詞フォントの縮小率（流れる歌詞・強調歌詞で共用）．スライダー倍率が小さい（遅い）ほど
// ブロックが詰まって潰れやすいので縮小する．×1.0 以上=1.0倍，最小倍率=0.5倍，その間を線形補間．
function lyricFontScale() {
  if (speedMultiplier >= 1) return 1;
  // 最小倍率〜×1.0 の範囲で speedMultiplier がどこにいるか（0〜1）
  const progress = (speedMultiplier - SPEED_MIN_MULTIPLIER) / (1 - SPEED_MIN_MULTIPLIER);
  return 0.5 + Math.min(1, Math.max(0, progress)) * 0.5;
}

// ボタンを押すたびに縦スライダーの表示/非表示を切り替える
speedToggle.addEventListener('click', (e) => {
  e.stopPropagation(); // 「外側クリックで閉じる」処理に拾われないようにする
  const hidden = speedPopup.classList.toggle('hidden');
  speedToggle.classList.toggle('active', !hidden);
});

// スライダー（50〜200）を 100 で割って ×0.5〜×2.0 の倍率にし，スクロール速度へ反映する
speedSlider.addEventListener('input', () => {
  speedMultiplier = Number(speedSlider.value) / 100;
  applyScrollSpeed();
  speedValue.textContent = '×' + speedMultiplier.toFixed(1);
});

// ポップアップの外側をクリックしたら閉じる
document.addEventListener('click', (e) => {
  if (!speedControl.contains(e.target)) {
    speedPopup.classList.add('hidden');
    speedToggle.classList.remove('active');
  }
});

const autoToggle = document.querySelector('#auto-toggle');

// モード（AUTO / タッチ）を設定する共通処理（ボタンと M キーの両方から呼ぶ）
function setAutoMode(on) {
  state.isAutoMode = on;
  autoToggle.classList.toggle('active', state.isAutoMode);
  autoToggle.textContent = state.isAutoMode ? 'モード：AUTO' : 'モード：タッチ';
  if (state.isAutoMode) {
    state.userRow = null; // AUTO に戻したらタッチ指定→ランダムへ
  }
}

autoToggle.addEventListener('click', () => setAutoMode(!state.isAutoMode));

// ── スマホでは 再生バー・BPM/小節 を上部ヘッダーへ移動する ──
// CSS だけでは親要素を変えられないので JS で要素そのものを移し替える．
// 判定条件は CSS のスマホ用レイアウトと同じ（タッチ端末かつ小画面．iPad は対象外）．
const headerEl       = document.querySelector('#header');
const seekEl         = document.querySelector('#seek');
const readoutEl      = document.querySelector('#transport-readout');
const toolbarLeftEl   = document.querySelector('.toolbar-left');
const toolbarRightEl  = document.querySelector('.toolbar-right');
const toolbarCenterEl = document.querySelector('.toolbar-center'); // 再生ボタン群
// VUメーター(vuCanvas)・速度コントロール(speedControl)は上で取得済みのものを使い回す

// スマホかどうか（CSS の @media と同じ条件）
const phoneMediaQuery = window.matchMedia(
  '(pointer: coarse) and (max-width: 600px), (pointer: coarse) and (max-height: 500px)'
);

function applyResponsiveLayout(isPhone) {
  if (isPhone) {
    // スマホ：ヘッダーの曲情報の右側に「再生バー → BPM/小節」，VUメーターは再生ボタン群の直後へ
    headerEl.appendChild(seekEl);
    headerEl.appendChild(readoutEl);
    toolbarCenterEl.appendChild(vuCanvas);
  } else {
    // PC / タブレット：元の下部バーの位置に戻す．
    // insertBefore は基準ノードが親の子である必要があるので先に VUメーターを戻す．
    toolbarLeftEl.insertBefore(seekEl, autoToggle);
    toolbarRightEl.insertBefore(vuCanvas, speedControl);
    toolbarRightEl.insertBefore(readoutEl, vuCanvas);
  }
}

applyResponsiveLayout(phoneMediaQuery.matches);                       // 起動時に一度適用
phoneMediaQuery.addEventListener('change', (e) => applyResponsiveLayout(e.matches)); // 端末/向きの変化に追従

// ── ヘルパー ─────────────────────────────────────────────

// 決定論的な疑似乱数（seed → 0〜1 の値）
function pseudoRandom(seed) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// '#rrggbb' 形式の色を透明度付きの rgba() 文字列に変換する
function hexToRgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// "#rrggbb" を [r, g, b] の数値配列に変換する
function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// 二分探索：arr[i].cumMaxEnd >= target となる最小 i を返す．
// cumMaxEnd は単調増加なので，これ以降に「まだ終わっていない可能性のあるノート」が全て含まれる．
function lowerBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    arr[mid].cumMaxEnd < target ? (lo = mid + 1) : (hi = mid);
  }
  return lo;
}

// lowerBound のピッチ軌跡版：カーブの実際の右端(cumMaxPitchEnd)で探索する．
// 繋がるノートのカーブが画面に残っている間はカリングされないようにする．
function lowerBoundPitch(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    arr[mid].cumMaxPitchEnd < target ? (lo = mid + 1) : (hi = mid);
  }
  return lo;
}

// 段の移動確率テーブルを累積分布(CDF)へ前計算する（抽選を速くするため）．
// 例 [0.1, 0.5, 0.2, …] → [0.1, 0.6, 0.8, …]．「r を初めて超える段」を選べる．
const ROW_CDF = ROW_TRANSITION.map((row) => {
  const cdf = [];
  let sum = 0;
  for (let i = 0; i < row.length; i++) { sum += row[i]; cdf.push(sum); }
  return cdf;
});

// ランダムウォークの1ステップ：今いる段 prev から確率表に従って次の段を抽選する
function walkStep(prev, n) {
  // タネに walkSeed（曲ごとの乱数）を足して実行ごとに結果を変える
  const r = pseudoRandom(n.start + state.walkSeed);

  const cdf = ROW_CDF[prev] ?? ROW_CDF[0];
  for (let dest = 0; dest < cdf.length; dest++) {
    if (r < cdf[dest]) return dest;
  }
  // 丸めで合計が僅かに 1 未満でも最後の段に落として必ず値を返す
  return cdf.length - 1;
}

// ホールド（タップ指定）が直前のフレームで有効だったか
// （有効→無効に切り替わった瞬間を検出してランダムへ振り直すため）
let userHoldWasActive = false;

// 画面右端に入る直前のノートまで段を順次確定する（毎フレーム呼ばれる）．
// ユーザ指定（タップ）が有効ならその段，なければランダムウォーク．
function commitRows() {
  const items = state.noteItems;
  if (!items.length) return;

  const { tRight } = visibleTimeRange();

  // ── ホールド切れの検出 ───────────────────────────────────
  // タップ指定が切れた瞬間，画面右端より外（未表示）の先行確定ノートだけをランダムへ
  // 振り直す．画面内のノートは触らない（触ると指定段が突然別の段へ瞬間移動して見える）．
  const holdActiveNow = state.userRow !== null && state.curTime <= state.userRowUntil;
  if (userHoldWasActive && !holdActiveNow) {
    const edgeTime = tRight; // 画面右端より外だけ振り直す
    let i = lowerBound(items, edgeTime);
    // 単語の途中で段が変わらないよう先の単語の先頭まで進める
    while (i < state.commitIdx && !(items[i].wordStart && items[i].start > edgeTime)) i++;
    if (i < state.commitIdx) {
      // i 以降を未確定に戻す → 下の while ループが walkStep で確定し直す
      state.walkRow   = i > 0 ? items[i - 1].rowIdx : state.walkRow;
      state.commitIdx = i;
    }
    state.userRow = null; // 指定を完全に解除
  }
  userHoldWasActive = holdActiveNow;

  if (state.commitIdx >= items.length) return;

  const horizon = tRight + 500; // 画面に入る 500ms 前に確定しておく

  while (state.commitIdx < items.length && items[state.commitIdx].start <= horizon) {
    const n = items[state.commitIdx];
    // 段が変わるのは単語の先頭だけ（単語内の文字は同じ段を引き継ぐ）
    if (n.wordStart && state.commitIdx > 0) {
      const userActive = state.userRow !== null && state.curTime <= state.userRowUntil;
      // 直前のノートとほぼ同時（ブロック最低幅より近い）に始まる単語は段を変えない．
      // 別の段に分かれると縦に重なって見え，ピッチカーブも段間を一瞬で往復してしまうため．
      const prevStart  = items[state.commitIdx - 1].start;
      const minGapMs   = LAYOUT.NOTE_MIN_W_PX / LAYOUT.PX_PER_MS;
      const tooClose   = (n.start - prevStart) < minGapMs;
      if (userActive)     state.walkRow = state.userRow;
      else if (!tooClose) state.walkRow = walkStep(state.walkRow, n);
    }
    n.rowIdx = state.walkRow;
    state.commitIdx++;
  }
}

// time で二分探索：beats[i].time >= target となる最小 i を返す
function beatLowerBound(beats, target) {
  let lo = 0, hi = beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    beats[mid].time < target ? (lo = mid + 1) : (hi = mid);
  }
  return lo;
}

// ノート始点をビートグリッド（隣接ビート間を QUANTIZE_DIV 分割）へ吸着させる．
// QUANTIZE_MAX_SHIFT_MS を超えて動く吸着，並び順が崩れる吸着は行わない．
function quantizeItems(items, beats) {
  if (!beats.length) return;
  const div      = LAYOUT.QUANTIZE_DIV;
  const maxShift = LAYOUT.QUANTIZE_MAX_SHIFT_MS;

  let bi = 0;              // beats の走査位置（items がソート済みなので戻らない）
  let lastStart = -Infinity;

  for (const n of items) {
    // n.start を挟む隣接ビート対 [bi, bi+1] まで進める
    while (bi + 1 < beats.length && beats[bi + 1].time <= n.start) bi++;

    if (n.start >= beats[bi].time && bi + 1 < beats.length) {
      const beatStart = beats[bi].time;                         // 左側のビート時刻 (ms)
      const step      = (beats[bi + 1].time - beatStart) / div; // グリッド1マスの幅 (ms)
      if (step > 0) {
        // n.start を最寄りのグリッド線へ丸めた時刻
        const quantizedStart = beatStart + Math.round((n.start - beatStart) / step) * step;
        const shift          = quantizedStart - n.start;        // 動かす量 (ms)
        // ズレ許容内 かつ 前のノートを追い越さない場合のみ移動（end も平行移動）
        if (Math.abs(shift) <= maxShift && quantizedStart > lastStart) {
          n.start += shift;
          n.end   += shift;
        }
      }
    }
    lastStart = n.start;
  }
}

// ── レイアウト ────────────────────────────────────────────

// 画面幅に応じて横スケール(LAYOUT.PX_PER_MS)を決める．
// 基準幅(REF_ROLL_W)より狭い画面では掛け率を下げ画面に見える拍数を一定に保つ．
function applyTimeScale() {
  const rollW  = Math.max(viewW - LAYOUT.LEFT_W, 1);
  const factor = Math.min(1, rollW / LAYOUT.REF_ROLL_W);
  LAYOUT.PX_PER_MS = baseTimeScale * factor;
}

// 曲の基準速度 × スライダー倍率 → baseTimeScale を決め直し PX_PER_MS へ反映する．
// 曲を読み込んだとき・速度スライダーを動かしたときに呼ぶ．
function applyScrollSpeed() {
  baseTimeScale = SONGS[currentSongIdx].scroll_spd * speedMultiplier;
  applyTimeScale();
}

// 毎フレーム作ると重い「未来カーブのグラデーション」と「ボール光彩の基準半径」を
// 1回だけ作り置きする（画面サイズ・行高さに依存するので recalcLayout から呼ぶ）
let futureTrailGrad = null; // 未来ピッチカーブ用の横グラデーション
let pitchGlowR      = 0;    // ボール光彩の基準半径（行高さに合わせて縮めた値）

function rebuildPitchSprites() {
  const phX = playheadX();

  // 未来カーブ用グラデーション（再生ラインのすぐ右が濃く右端へ向かって薄くなる）
  futureTrailGrad = ctx.createLinearGradient(phX, 0, viewW, 0);
  futureTrailGrad.addColorStop(0,    'rgba(255, 255, 255, 1.00)');
  futureTrailGrad.addColorStop(0.30, 'rgba(255, 255, 255, 0.80)');
  futureTrailGrad.addColorStop(1,    'rgba(255, 255, 255, 0.18)');

  // 光彩は声量で色が変わるため作り置きできない（drawPitchBall で毎フレーム作る）．
  // ここでは基準半径だけ計算しておく．
  pitchGlowR = PITCH.GLOW_R * state.pitchScale;
}

function recalcLayout() {
  applyTimeScale();
  state.rowH = Math.floor((viewH - LAYOUT.RULER_H) / ROW_COUNT);
  // ピッチ線・ボールを行高さに合わせて縮める係数（PC=1，スマホ<1）．固定px だと
  // スマホで相対的に太く見えるのを防ぐ．設定欠落時でも NaN にしないよう既定値．
  const refRowH = (PITCH.REF_ROW_H > 0) ? PITCH.REF_ROW_H : 100;
  state.pitchScale = Math.min(state.rowH / refRowH, 1);

  rebuildPitchSprites();
}

function resize() {
  // CSS 上の表示サイズ
  viewW = canvas.offsetWidth;
  viewH = canvas.offsetHeight;

  // 画面の画素密度（高精細スマホでは 2〜3）
  dpr = window.devicePixelRatio || 1;

  // キャンバスの実解像度を dpr 倍にして実画素ぴったりに描く（文字や黒縁のボヤけ防止）．
  // 描画は viewW/viewH 基準のままで，毎フレーム冒頭で ctx を dpr 倍にスケールして合わせる．
  canvas.width  = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);

  recalcLayout();
}
window.addEventListener('resize', resize);
resize();

// アドレスバー開閉による 100dvh の変動や画面回転を確実に捕捉し，実解像度を表示サイズへ
// 即座に合わせ直す（古いビットマップが引き伸ばされて文字が潰れて見えるのを防ぐ）．
if (window.ResizeObserver) {
  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
}

function rowY(idx) { return LAYOUT.RULER_H + idx * state.rowH; }

// 再生ライン（再生ヘッド）の画面上の X 座標
function playheadX() { return LAYOUT.LEFT_W + (viewW - LAYOUT.LEFT_W) * LAYOUT.PLAYHEAD_X_RATIO; }

// ── 描画 ─────────────────────────────────────────────────

function drawRuler() {
  const rH  = LAYOUT.RULER_H;
  const phX = playheadX();

  // 背景（小節番号を描く帯）：下部バー(#toolbar)と同じパステルミント単色で塗る
  ctx.fillStyle = COLORS.FRAME_BG;
  ctx.fillRect(0, 0, viewW, rH);

  if (!state.isReadyToPlay) {
    // 下境界線だけ引いて終了
    ctx.strokeStyle = COLORS.PANEL_BORDER;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(0, rH - 0.5);
    ctx.lineTo(viewW, rH - 0.5);
    ctx.stroke();
    return;
  }

  // 各拍のティックとラベル（二分探索で画面内のビートだけ処理）
  const { tLeft, tRight } = visibleTimeRange();
  const barTicks  = new Path2D();
  const beatTicks = new Path2D();
  let lastLabelX = -Infinity;

  ctx.textAlign    = 'left';
  ctx.textBaseline = 'middle';
  let curFont = ''; // 直前のフォント．同じ値の再代入（フォント解析）を避けるため記録する

  for (let i = beatLowerBound(state.beats, tLeft); i < state.beats.length; i++) {
    const b = state.beats[i];
    if (b.time > tRight) break;
    const x = phX + (b.time - state.curTime) * LAYOUT.PX_PER_MS;

    const isBar = b.pos === 1;

    // ティック：小節線は全高，拍線は下半分（パスにまとめて後で2回だけ stroke）
    const tickPath = isBar ? barTicks : beatTicks;
    tickPath.moveTo(x, isBar ? 2 : rH * 0.5);
    tickPath.lineTo(x, rH - 2);

    // ラベル：「小節.拍」表記．小節頭は優先表示，拍はスペースがあるときのみ
    const minGap = isBar ? 39 : 51;
    if (x - lastLabelX >= minGap) {
      ctx.fillStyle = isBar ? COLORS.RULER_TEXT : COLORS.RULER_TEXT_DIM;
      const wantFont = isBar ? 'bold 15px sans-serif' : '13.5px sans-serif';
      if (wantFont !== curFont) { ctx.font = wantFont; curFont = wantFont; } // 変化時だけ代入
      ctx.fillText(`${b.bar}.${b.pos}`, x + 3, rH / 2);
      lastLabelX = x;
    }
  }

  ctx.strokeStyle = COLORS.RULER_TEXT_DIM;
  ctx.lineWidth   = 0.5;
  ctx.stroke(beatTicks);
  ctx.strokeStyle = COLORS.RULER_TEXT;
  ctx.lineWidth   = 1;
  ctx.stroke(barTicks);

  // ルーラー下境界線
  ctx.strokeStyle = COLORS.PANEL_BORDER;
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(0, rH - 0.5);
  ctx.lineTo(viewW, rH - 0.5);
  ctx.stroke();
}

function drawGrid() {
  // 背景：左上(ティール)→右下(向日葵)の淡いパステルグラデ．画面に固定（ノートが上を流れる）
  const rollX = LAYOUT.LEFT_W;
  const rollY = LAYOUT.RULER_H;
  const bgGrad = ctx.createLinearGradient(rollX, rollY, viewW, viewH);
  bgGrad.addColorStop(0, COLORS.BG);       // ティール寄り（seaglass）
  bgGrad.addColorStop(1, COLORS.BG_WARM);  // 向日葵寄り（淡いイエロー）
  ctx.fillStyle = bgGrad;
  ctx.fillRect(rollX, rollY, viewW - LAYOUT.LEFT_W, viewH - LAYOUT.RULER_H);

  for (let i = 0; i < ROW_COUNT; i++) {
    const y = rowY(i);

    if (i % 2 === 1) {
      ctx.fillStyle = COLORS.ROW_ODD;
      ctx.fillRect(LAYOUT.LEFT_W, y, viewW - LAYOUT.LEFT_W, state.rowH);
    }

    ctx.strokeStyle = COLORS.GRID_LINE;
    ctx.lineWidth   = 0.5;
    ctx.beginPath();
    ctx.moveTo(LAYOUT.LEFT_W, y);
    ctx.lineTo(viewW, y);
    ctx.stroke();
  }
}

// 画面内に映る時間範囲 [tLeft, tRight] を返す（drawBeats / drawRuler 共用）
function visibleTimeRange() {
  const phX = playheadX();
  return {
    phX,
    tLeft:  state.curTime + (LAYOUT.LEFT_W   - phX) / LAYOUT.PX_PER_MS,
    tRight: state.curTime + (viewW    - phX) / LAYOUT.PX_PER_MS,
  };
}

function drawBeats() {
  const { phX, tLeft, tRight } = visibleTimeRange();

  // 二分探索で画面内のビートだけに絞り，線種ごとに1つのパスへまとめて stroke を2回に抑える
  const barPath  = new Path2D();
  const beatPath = new Path2D();

  for (let i = beatLowerBound(state.beats, tLeft); i < state.beats.length; i++) {
    const b = state.beats[i];
    if (b.time > tRight) break;
    const x = phX + (b.time - state.curTime) * LAYOUT.PX_PER_MS;
    const linePath = b.pos === 1 ? barPath : beatPath;
    linePath.moveTo(x, LAYOUT.RULER_H);
    linePath.lineTo(x, viewH);
  }

  ctx.strokeStyle = COLORS.BEAT_LINE;
  ctx.lineWidth   = 0.5;
  ctx.stroke(beatPath);
  ctx.strokeStyle = COLORS.BAR_LINE;
  ctx.lineWidth   = 1;
  ctx.stroke(barPath);
}

// ユーザが指定中の段を再生ラインの右側にハイライト表示する
function drawUserRow() {
  if (state.userRow === null || state.curTime > state.userRowUntil) return;

  const phX   = playheadX();
  const y     = rowY(state.userRow);
  const color = ROW_COLORS[state.userRow % ROW_COLORS.length];

  ctx.fillStyle = color + '1f'; // 透明度 約12%
  ctx.fillRect(phX, y, viewW - phX, state.rowH);
  ctx.strokeStyle = color + 'aa';
  ctx.lineWidth   = 1;
  ctx.strokeRect(phX + 0.5, y + 0.5, viewW - phX - 1, state.rowH - 1);
}

// ノートブロックの描画幅(px)．発声時間が短くても最低幅 NOTE_MIN_W_PX を必ず確保する．
// 密集部では隣のノートと多少重なるが，細すぎて見えないノートをなくすことを優先している．
function noteDrawWidth(n) {
  const baseW = n.renderDur * LAYOUT.PX_PER_MS; // 発声時間に応じた本来の幅(px)
  return Math.max(baseW, LAYOUT.NOTE_MIN_W_PX);
}

// ノートブロックだけを描く（文字は drawNoteTexts で別に描く．
// 間にピッチボールを挟み「ブロック < ボール < 文字」の重なりにするため）
function drawNoteBlocks() {
  const rollW = viewW - LAYOUT.LEFT_W;
  const phX   = playheadX();
  const pad   = LAYOUT.NOTE_V_PAD;

  const leftMs = state.curTime - (LAYOUT.PLAYHEAD_X_RATIO * rollW / LAYOUT.PX_PER_MS);
  const startI = lowerBound(state.noteItems, leftMs);

  for (let i = startI; i < state.noteItems.length; i++) {
    const n = state.noteItems[i];
    const x = phX + (n.start - state.curTime) * LAYOUT.PX_PER_MS;
    if (x > viewW) break;

    // 描画幅（最低幅を確保しつつ隣に重ならない範囲）でブロックを決める
    const blockW   = noteDrawWidth(n) - 1;               // ブロックの幅(px)
    const clippedX = Math.max(x, LAYOUT.LEFT_W);         // 左パネルに隠れる分を切り詰めた左端
    const clippedW = blockW - (clippedX - x);            // 切り詰め後の幅
    if (clippedW <= 0) continue;                         // 完全に左パネルの裏なら描かない

    const y     = rowY(n.rowIdx);
    const color = ROW_COLORS[n.rowIdx % ROW_COLORS.length];

    ctx.fillStyle = color;
    const cornerRadius = Math.min(4, state.rowH / 4);
    ctx.beginPath();
    ctx.roundRect(clippedX, y + pad, Math.max(clippedW - 1, 3), state.rowH - pad * 2, cornerRadius);
    ctx.fill();
  }
}

// ノートの歌詞文字（非アクティブのみ．アクティブは drawActiveNotes が担当する）
function drawNoteTexts() {
  const rollW = viewW - LAYOUT.LEFT_W;
  const phX   = playheadX();

  const leftMs = state.curTime - (LAYOUT.PLAYHEAD_X_RATIO * rollW / LAYOUT.PX_PER_MS);
  const startI = lowerBound(state.noteItems, leftMs);

  // スクロールが遅いほどブロックが横に詰まって潰れやすいので速度に応じて文字を縮小する
  const fontScale  = lyricFontScale();

  // フォント設定はループ外で1回だけ（ctx.font への代入はパース処理が走り重い）
  const fontSize   = Math.floor(state.rowH * LAYOUT.NOTE_TEXT_SCALE * fontScale);
  ctx.font         = `bold ${fontSize}px sans-serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  // 縁取り（黒縁→白文字の順）．白文字がどんな背景でも沈まないよう濃いめ・やや太め．
  // 太さは文字サイズに比例（固定値だと小さい画面で相対的に太くなり潰れる）．
  ctx.strokeStyle  = 'rgba(0, 0, 0, 0.9)';
  ctx.lineWidth    = Math.max(1.5, fontSize * 0.07);
  ctx.lineJoin     = 'round';
  ctx.fillStyle    = '#ffffff';

  // ── 文字の重なり回避（ほぼ完全に潰れた所だけ）──────────────
  // 単語の長さがほぼ0で返ると文字が同じ座標に集中して読めなくなる．中心間隔が collapseGap
  // 未満のときだけ spreadGap まで右へ離す．通常の歌詞は動かさない（時刻データも変えない）．
  const collapseGap = fontSize * 0.30; // この中心間隔未満なら「潰れ」とみなす(px)
  const spreadGap   = fontSize * 0.55; // 潰れ時に確保する中心間隔(px)
  const lastCenter  = new Array(ROW_COUNT).fill(-Infinity); // 各段の直前文字の中心X

  for (let i = startI; i < state.noteItems.length; i++) {
    const n = state.noteItems[i];
    const x = phX + (n.start - state.curTime) * LAYOUT.PX_PER_MS;
    if (x > viewW) break;

    const active = state.curTime >= n.start && state.curTime <= n.end;
    if (!n.lyric || active) continue;

    let textX = x + noteDrawWidth(n) / 2; // ブロック中央（最低幅を考慮した幅で中央化）

    // 直前の文字とほぼ完全に重なっているときだけ右へ離す（左→右の順に処理）
    const row = n.rowIdx;
    if (row != null) {
      if (textX - lastCenter[row] < collapseGap) textX = lastCenter[row] + spreadGap;
      lastCenter[row] = textX;
    }

    if (textX > LAYOUT.LEFT_W && textX < viewW) {
      const textY = rowY(n.rowIdx) + state.rowH / 2;
      ctx.strokeText(n.lyric, textX, textY); // 黒縁を先に
      ctx.fillText(n.lyric, textX, textY);   // 白文字を上に重ねる
    }
  }
}

// ── 擬似ピッチ（ボカロエディタ風）────────────────────────
// 段の中心を基本線に，ポルタメント（S字遷移）とビブラートを合成した「時刻→Y座標」の
// 関数を定義し，ボールと軌跡の両方で共有する．

// ノート n と次ノート next のピッチカーブを繋ぐか判定する．
// next が無い／フレーズ先頭なら切る．それ以外は無音が GAP_BREAK_MS 未満なら繋ぐ．
function pitchConnected(n, next) {
  if (!next || next.phraseStart) return false;
  return (next.start - n.end) < PITCH.GAP_BREAK_MS;
}

// ノート n（次ノート next）のセグメント内時刻 t における Y 座標（セグメント外は null）
function pitchSegmentY(n, next, t) {
  const connected = pitchConnected(n, next);
  const segEnd    = connected ? next.start : n.end;
  if (t < n.start || t > segEnd) return null;

  // 段未確定（曲切り替え直後など）のノートは Y が NaN になるので描かない（クラッシュ防止）
  if (n.rowIdx == null) return null;

  // 基準位置は段の中央ではなく BASE_Y_RATIO の高さにして文字の下を通す
  const baseY   = rowY(n.rowIdx) + state.rowH * PITCH.BASE_Y_RATIO;
  // 次ノートの段が未確定なら移動先も自分と同じ高さに（NaN 回避）
  const targetY = (connected && next.rowIdx != null)
    ? rowY(next.rowIdx) + state.rowH * PITCH.BASE_Y_RATIO
    : baseY;
  // 遷移時間：段差が大きいほど長くして傾きをなだらかにする（1段ぶん=PORTAMENTO_MS）．
  // ただしノート長の一定割合を上限にして短いノートで長くなりすぎないようにする．
  const jump     = (connected && next.rowIdx != null) ? Math.abs(next.rowIdx - n.rowIdx) : 1;
  const maxRatio = (PITCH.PORTAMENTO_MAX_RATIO > 0 && PITCH.PORTAMENTO_MAX_RATIO <= 1)
    ? PITCH.PORTAMENTO_MAX_RATIO : 0.7; // 設定欠落時の既定値
  const segLen   = segEnd - n.start;
  const portTime = Math.min(PITCH.PORTAMENTO_MS * Math.max(jump, 1), segLen * maxRatio);
  const portStart = segEnd - portTime; // この時刻から segEnd にかけて次の段へ移る

  // ポルタメント：次の段へ移る
  let y = baseY;
  let trans = 0;
  if (t > portStart && segEnd > portStart) {
    const progress = (t - portStart) / (segEnd - portStart); // 0→1 の進み具合
    if (PITCH.OVERSHOOT > 0) {
      // easeOutBack：目標を行き過ぎてから戻る（派手な動き．OVERSHOOT で行き過ぎ量を調整）
      const overshoot = PITCH.OVERSHOOT;
      const back = progress - 1; // 目標(1.0)からの距離．行き過ぎを表す（負→0へ近づく）
      trans = 1 + (overshoot + 1) * back * back * back + overshoot * back * back;
    } else {
      // smootherstep：曲率も両端で 0 になり遷移の「角」が出ずに丸くつながる
      trans = progress * progress * progress * (progress * (progress * 6 - 15) + 10);
    }
    y = baseY + (targetY - baseY) * trans;
  }

  // しゃくり：フレーズ頭のノートの頭でだけピッチを少し下へ沈めてから戻す
  // （phraseStart はフレーズ最初の単語の最初の1文字だけ true）
  const dur      = n.end - n.start;
  const intoNote = t - n.start;
  const scoopDur = Math.min(PITCH.SCOOP_DUR_MS, dur / 2); // 短いノートでは縮める
  if (n.phraseStart && intoNote < scoopDur) {
    const scoopProgress = intoNote / scoopDur; // 0→1
    const valleyAt = (PITCH.SCOOP_VALLEY_AT > 0 && PITCH.SCOOP_VALLEY_AT < 1) ? PITCH.SCOOP_VALLEY_AT : 0.30;
    // 両端を傾き0でなめらかに繋ぐ「谷型」エンベロープ（前半で沈み後半で戻る）
    let env;
    if (scoopProgress < valleyAt) {
      const u = scoopProgress / valleyAt;
      env = u * u * (3 - 2 * u);                            // smoothstep（0→1）
    } else {
      const u = (scoopProgress - valleyAt) / (1 - valleyAt);
      env = 1 - u * u * (3 - 2 * u);                        // smoothstep（1→0）
    }
    y += state.rowH * PITCH.SCOOP_DEPTH * env;
  }

  // ビブラート：長いノートだけ．立ち上がりは徐々に・遷移中はフェードアウト
  if (dur >= PITCH.VIB_MIN_DUR_MS) {
    const ramp    = Math.min(Math.max((t - n.start - 150) / PITCH.VIB_RAMP_MS, 0), 1);
    const vibFade = Math.max(0, 1 - trans); // 行き過ぎで trans>1 でも負にしない
    y += Math.sin((t - n.start) / 1000 * PITCH.VIB_FREQ * 2 * Math.PI)
       * state.rowH * PITCH.VIB_AMP * ramp * vibFade;
  }
  return y;
}

// 時刻 t における擬似ピッチの Y 座標（無音区間は null）．start <= t の最後のノートを二分探索．
function pitchYAt(t) {
  const items = state.noteItems;
  if (!items.length) return null;
  let lo = 0, hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    items[mid].start <= t ? (lo = mid + 1) : (hi = mid);
  }
  const i = lo - 1;
  if (i < 0) return null;
  return pitchSegmentY(items[i], items[i + 1] ?? null, t);
}

// ボールの軌跡：通過済み（再生ラインの左）の過去カーブと未来カーブのプレビューを描く
function drawPitchTrail() {
  if (!PITCH.ENABLED || !state.noteItems.length) return;

  const rollW  = viewW - LAYOUT.LEFT_W;
  const phX    = playheadX();
  const items  = state.noteItems;
  const leftMs = state.curTime - (LAYOUT.PLAYHEAD_X_RATIO * rollW / LAYOUT.PX_PER_MS);
  const startI = lowerBoundPitch(items, leftMs); // カーブの右端基準で開始ノートを決める
  const stepMs = PITCH.STEP_PX / LAYOUT.PX_PER_MS; // px間隔→時間間隔

  const path = new Path2D();
  let penDown = false; // false のとき次の点は moveTo（線を切る）

  for (let i = startI; i < items.length; i++) {
    const n = items[i];
    if (n.start > state.curTime) break; // 再生ラインより右は描かない

    const next      = i + 1 < items.length ? items[i + 1] : null;
    const connected = pitchConnected(n, next);
    const segEnd    = Math.min(connected ? next.start : n.end, state.curTime);

    for (let t = Math.max(n.start, leftMs); t < segEnd; t += stepMs) {
      const x = phX + (t - state.curTime) * LAYOUT.PX_PER_MS;
      if (x < LAYOUT.LEFT_W) { penDown = false; continue; }
      const y = pitchSegmentY(n, next, t);
      if (y === null) { penDown = false; continue; }
      penDown ? path.lineTo(x, y) : path.moveTo(x, y);
      penDown = true;
    }
    if (!connected) penDown = false; // 無音区間では線を切る
  }

  // ── 未来のピッチカーブ（再生ヘッドより右：薄い白でプレビュー）──
  // まだ来ていない音符のカーブを薄く先行表示する．再生ライン付近が最も濃く右へ行くほど透明．
  const tRight      = state.curTime + (viewW - phX) / LAYOUT.PX_PER_MS;
  const futurePath  = new Path2D();
  let futurePen     = false;

  // カーブの右端基準で「まだ終わっていない or これから始まるノート」を探す
  // （繋がるノートの橋が再生ヘッド通過直後に消えないようにするため）
  const futureStartI = lowerBoundPitch(items, state.curTime);

  for (let i = futureStartI; i < items.length; i++) {
    const n = items[i];
    if (n.start > tRight) break; // 画面右端より先は描かない

    const next      = i + 1 < items.length ? items[i + 1] : null;
    const connected = pitchConnected(n, next);
    const segEnd    = connected ? next.start : n.end;

    if (segEnd < state.curTime) continue; // 再生ライン以前に終わったノートは飛ばす

    // 現在再生中のノートは curTime から，未来のノートは n.start から描き始める
    const tStart = Math.max(n.start, state.curTime);
    const tEnd   = Math.min(segEnd, tRight);

    for (let t = tStart; t <= tEnd; t += stepMs) {
      const x = phX + (t - state.curTime) * LAYOUT.PX_PER_MS;
      if (x > viewW) { futurePen = false; break; }
      const y = pitchSegmentY(n, next, t);
      if (y === null) { futurePen = false; continue; }
      futurePen ? futurePath.lineTo(x, y) : futurePath.moveTo(x, y);
      futurePen = true;
    }
    if (!connected) futurePen = false;
  }

  // 未来カーブ：薄い白グラデーション（作り置きを使う．recalcLayout で更新）
  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';
  ctx.strokeStyle = futureTrailGrad;
  ctx.lineWidth   = PITCH.TRAIL_W * state.pitchScale;
  ctx.stroke(futurePath);

  // 過去の軌跡：外側の淡い光 → 濃い芯 の2層で描く
  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';

  // 外側の柔らかい光
  ctx.strokeStyle = PITCH.TRAIL_GLOW_COLOR;
  ctx.lineWidth   = PITCH.TRAIL_GLOW_W * state.pitchScale;
  ctx.stroke(path);

  // 芯
  ctx.strokeStyle = PITCH.TRAIL_CORE_COLOR;
  ctx.lineWidth   = PITCH.TRAIL_W * state.pitchScale;
  ctx.stroke(path);
}

// 声量に追従するボールの脈動レベル(0〜1)．生の声量は激しく跳ねるので
// 「上がり速く・下がり遅く」滑らかに追従させてチラつきを防ぐ．
let ballPulse = 0;

// 再生ライン上で上下する光るボール（声量で膨らみ・光る）
function drawPitchBall() {
  if (!PITCH.ENABLED) return;
  const y = pitchYAt(state.curTime);
  // null（無音区間）だけでなく NaN/Infinity（段未確定など）も弾く．
  // 非有限値を createRadialGradient に渡すと例外で描画ループ全体が止まるため．
  if (y === null || !Number.isFinite(y)) return;

  const phX = playheadX();

  // 声量レベル(0〜1)．再生中だけ実データを読み，停止中は 0．
  let vocalLevel = 0;
  if (state.isPlaying && state.maxVocalAmplitude > 0) {
    vocalLevel = player.getVocalAmplitude(state.curTime) / state.maxVocalAmplitude;
    if (vocalLevel > 1) vocalLevel = 1;
    if (vocalLevel < 0) vocalLevel = 0;
  }
  // 上がり速く・下がり遅く＝歌声に弾けて反応し，余韻を残して戻る
  const pulseSpeed = vocalLevel > ballPulse ? 0.5 : 0.12;
  ballPulse += (vocalLevel - ballPulse) * pulseSpeed;

  const intensity = ballPulse; // 歌唱の強さ（0〜1）

  const [br, bg, bb] = hexToRgb(PITCH.BALL_COLOR);

  // ボールも行高さに合わせて縮め，さらに声量に比例して半径を変える
  // （静寂時 BALL_MIN_SCALE 倍 〜 最大声量で 1+PULSE_BALL 倍）
  const ballScale = PITCH.BALL_MIN_SCALE
                  + (1 + PITCH.PULSE_BALL - PITCH.BALL_MIN_SCALE) * intensity;
  const ballR = PITCH.BALL_R * state.pitchScale * ballScale;

  // ── 光彩（ハロー）：強く歌うほど明るく・大きく光る ──────────
  // 声量をそのまま使わず上に凸の曲線で持ち上げ低～中の声量でも光りやすくする
  const glowLevel = Math.pow(intensity, PITCH.GLOW_EASE);
  const a = PITCH.GLOW_ALPHA_MIN + (PITCH.GLOW_ALPHA_MAX - PITCH.GLOW_ALPHA_MIN) * glowLevel;
  const glowR = pitchGlowR * (1 + PITCH.PULSE_GLOW * glowLevel);
  const glow  = ctx.createRadialGradient(phX, y, 0, phX, y, glowR);
  glow.addColorStop(0,    `rgba(${br}, ${bg}, ${bb}, ${a})`);        // 中心
  glow.addColorStop(0.45, `rgba(${br}, ${bg}, ${bb}, ${a * 0.5})`);  // 中間
  glow.addColorStop(1,    `rgba(${br}, ${bg}, ${bb}, 0)`);           // 外周（透明）
  ctx.fillStyle = glow;
  ctx.fillRect(phX - glowR, y - glowR, glowR * 2, glowR * 2);

  // ── ボール本体 ─────────────────────────────────────────
  // 強く歌うほど色を白へ寄せて芯まで光って見せる（GLOW_WHITEN が白寄せ量）
  const whiten = glowLevel * PITCH.GLOW_WHITEN;   // 0=元の色 〜 1=白
  const cr = Math.round(br + (255 - br) * whiten);
  const cg = Math.round(bg + (255 - bg) * whiten);
  const cb = Math.round(bb + (245 - bb) * whiten); // 青は少し抑えて暖色の白にする
  ctx.fillStyle = `rgb(${cr}, ${cg}, ${cb})`;
  ctx.beginPath();
  ctx.arc(phX, y, ballR, 0, Math.PI * 2);
  ctx.fill();
}

function drawLeftPanel() {
  // 左の鍵盤パネルもルーラーと同じパステルミント単色で塗る（枠の色を揃える）
  ctx.fillStyle = COLORS.FRAME_BG;
  ctx.fillRect(0, 0, LAYOUT.LEFT_W, viewH);

  // アクティブな行（MIDIが来ている段）にキャラカラーを重ねて発色させる
  for (let i = 0; i < ROW_COUNT; i++) {
    if (state.activeRowSet.has(i)) {
      ctx.fillStyle = ROW_COLORS[i % ROW_COLORS.length] + '33';
      ctx.fillRect(0, rowY(i), LAYOUT.LEFT_W, state.rowH);
    }
  }

  ctx.strokeStyle = COLORS.PANEL_BORDER;
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(LAYOUT.LEFT_W - 0.5, 0);
  ctx.lineTo(LAYOUT.LEFT_W - 0.5, viewH);
  ctx.stroke();
}

function drawActiveNotes() {
  // start でソート済みなので，ループ末尾のマッチが最も最近始まったアクティブノート．
  // 常に1つだけ描くことで段の切り替わり時の二重表示を防ぐ．
  let active = null;
  const startI = lowerBound(state.noteItems, state.curTime);
  for (let i = startI; i < state.noteItems.length; i++) {
    const n = state.noteItems[i];
    if (n.start > state.curTime) break;
    if (n.end < state.curTime) continue;
    active = n;
  }
  if (!active || !active.lyric) return;

  const phX      = playheadX();
  // 流れる歌詞と同じ縮小率で連動させ，ヘッド通過時に文字サイズが急変しないようにする
  const fontScale = lyricFontScale();
  const fontSize  = Math.floor(state.rowH * LAYOUT.ACTIVE_TEXT_SCALE * fontScale);
  // 行の中央より少し上へずらして，下にピッチボールが見えるようにする（ACTIVE_TEXT_RISE）
  const cy        = rowY(active.rowIdx) + state.rowH / 2 - state.rowH * LAYOUT.ACTIVE_TEXT_RISE;

  ctx.save();
  ctx.beginPath();
  ctx.rect(LAYOUT.LEFT_W, 0, viewW - LAYOUT.LEFT_W, viewH);
  ctx.clip();

  ctx.font         = `bold ${fontSize}px sans-serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  // 縁取り（黒縁 → 白文字の順）．太さは文字サイズに比例．
  ctx.strokeStyle  = 'rgba(0, 0, 0, 0.9)';
  ctx.lineWidth    = Math.max(1.5, fontSize * 0.07);
  ctx.lineJoin     = 'round';
  ctx.fillStyle    = '#ffffff';
  ctx.strokeText(active.lyric, phX, cy); // 黒縁を先に
  ctx.fillText(active.lyric, phX, cy);   // 白文字を上に重ねる

  ctx.restore();
}

// タッチ位置の光ボールと彗星の尾（色は指定中段のキャラカラー．古い点ほど細く薄く消える）
function drawTouchPointer() {
  const now = performance.now();

  // 寿命切れの点を先頭から捨てる（push は末尾なので古い点は先頭にある）
  while (touchTrail.length && now - touchTrail[0].t > CONTROL.TRAIL_MS) {
    touchTrail.shift();
  }

  // 彗星の尾：隣り合う履歴点を線分で結ぶ．新しいほど太く濃く．
  ctx.lineCap = 'round';
  for (let i = 1; i < touchTrail.length; i++) {
    const p0 = touchTrail[i - 1];
    const p1 = touchTrail[i];
    const k  = 1 - (now - p1.t) / CONTROL.TRAIL_MS; // 1=新しい → 0=消える直前
    ctx.strokeStyle = hexToRgba(p1.color, 0.55 * k);
    ctx.lineWidth   = 2 + 6 * k;
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
  }

  // タッチ中だけ光のボールを描く
  if (!pointerActive || !lastTouch) return;
  const { x, y, color } = lastTouch;

  const glow = ctx.createRadialGradient(x, y, 0, x, y, CONTROL.GLOW_R);
  glow.addColorStop(0, hexToRgba(color, 0.50));
  glow.addColorStop(1, hexToRgba(color, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(x - CONTROL.GLOW_R, y - CONTROL.GLOW_R, CONTROL.GLOW_R * 2, CONTROL.GLOW_R * 2);

  // ボール本体は指定中段のキャラ色
  ctx.fillStyle = hexToRgba(color, 0.95);
  ctx.beginPath();
  ctx.arc(x, y, CONTROL.BALL_R, 0, Math.PI * 2);
  ctx.fill();
}

// 時刻 t 以前で最も近い拍を返す（二分探索．state.beats は time 昇順）
function lastBeatAtOrBefore(t) {
  const beats = state.beats;
  if (!beats.length || t < beats[0].time) return null;
  let lo = 0, hi = beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    beats[mid].time <= t ? (lo = mid + 1) : (hi = mid);
  }
  return beats[lo - 1]; // time <= t を満たす最後の拍
}

function drawPlayhead() {
  const x = playheadX();

  // 本体（実線）
  ctx.strokeStyle = COLORS.PLAYHEAD;
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, viewH);
  ctx.stroke();

  ctx.fillStyle = COLORS.PLAYHEAD;
  ctx.beginPath();
  ctx.moveTo(x - 7, 0);
  ctx.lineTo(x + 7, 0);
  ctx.lineTo(x, 10);
  ctx.closePath();
  ctx.fill();
}

// ── レンダリングループ ────────────────────────────────────
function render() {
  // onTimeUpdate は数十ms間隔でしか発火しないため，壁時計で補間して滑らかにする
  if (state.isPlaying && state.syncWallClock > 0) {
    const elapsed = performance.now() - state.syncWallClock;

    // 本来あるべき再生時刻（基準点 + 経過時間．200ms 超は補間しない）
    const target = state.syncTime + Math.min(elapsed, 200);

    // curTime を target へ少しずつ近づける（イージング）．報告時刻がブレても揺れがならされ
    // ピアノロールが振動しなくなる．大きくズレたときだけ即座に合わせる．
    const diff = target - state.curTime;
    if (Math.abs(diff) > 200) {
      state.curTime = target;
    } else {
      state.curTime += diff * 0.2; // 毎フレーム 20% ずつ詰める
    }
  }

  commitRows(); // 画面に入る直前のノートの段を確定
  updateSeekUI(state.curTime, state.duration);
  updateVU();

  // 毎フレーム座標系を dpr 倍にスケールし直す（以降は viewW/viewH 基準で描ける）
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.clearRect(0, 0, viewW, viewH);

  // 奥から手前の順に重ねて描く（後で呼ぶものほど前面に出る）
  drawGrid();
  drawBeats();
  drawUserRow();
  drawNoteBlocks();
  drawPitchTrail();
  drawNoteTexts();
  drawLeftPanel();
  drawPlayhead();
  drawPitchBall();
  drawTouchPointer();
  drawRuler();
  drawActiveNotes(); // 歌詞は最前面．ルーラーにも隠れないよう一番最後に描く
  requestAnimationFrame(render);
}

render();
