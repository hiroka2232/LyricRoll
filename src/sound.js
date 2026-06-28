// ピアノロールのタップ音（Web Audio API）．
// その時点のコードに合わせて，タップした段の音を「主音＋コードのルート」の2音で短く鳴らす．
// コード名の解釈と音高への変換には Tonal.js を使う．

import { Chord, Note } from 'tonal';

// 各段に並べる主音（ルートからの半音）．ペンタトニックで不協和音を避ける
const MAJOR_PENTATONIC = [0, 2, 4, 7, 9, 12];
const MINOR_PENTATONIC = [0, 3, 5, 7, 10, 12];

const BASE_OCTAVE = 3;

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// コード名 → 6段ぶんの声部 [{ melody, harmony }]（低い段から順．コード無し等は null）．
// melody は各段の主音，harmony は全段共通のルート音．
export function chordToRowVoices(name) {
  const chord = Chord.get(name);
  if (chord.empty || !chord.tonic) return null;

  const baseMidi = Note.midi(`${chord.tonic}${BASE_OCTAVE}`);
  if (baseMidi == null) return null;

  // マイナー・ディミニッシュは短調ペンタ，それ以外は長調ペンタ
  const minor      = chord.quality === 'Minor' || chord.quality === 'Diminished';
  const pentatonic = minor ? MINOR_PENTATONIC : MAJOR_PENTATONIC;

  const rootFreq = midiToFreq(baseMidi);
  return pentatonic.map(semi => ({
    melody:  midiToFreq(baseMidi + semi),
    harmony: rootFreq,
  }));
}

const TAP_VOLUME = 1.0;

// AudioContext はユーザー操作後でないと音を出せないので最初のタップ時に作る
let audioCtx = null;

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playOneTone(ac, freq, peak) {
  const now = ac.currentTime;

  // 立ち上げてから指数減衰（peak*0.5 は2本重ねるぶんの調整）
  const amp = ac.createGain();
  amp.gain.setValueAtTime(0.0001, now);
  amp.gain.exponentialRampToValueAtTime(peak * 0.5, now + 0.01);
  amp.gain.exponentialRampToValueAtTime(0.0001, now + 1.0);

  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(4000, now);
  filter.frequency.exponentialRampToValueAtTime(1200, now + 0.25);

  amp.connect(filter).connect(ac.destination);

  // 三角波を ±6セントずらして2本重ねる
  for (const detune of [-6, 6]) {
    const osc = ac.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    osc.detune.value     = detune;
    osc.connect(amp);
    osc.start(now);
    osc.stop(now + 1.05);
  }
}

export function playTapTone(freqs) {
  const list = Array.isArray(freqs) ? freqs : [freqs];
  const ac   = ensureAudioContext();
  // 音数で割って同時発音でも割れないようにする
  const peak = TAP_VOLUME / Math.sqrt(list.length);
  for (const freq of list) playOneTone(ac, freq, peak);
}
