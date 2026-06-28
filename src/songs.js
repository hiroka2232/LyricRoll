// 曲情報
//   bpm        : 曲のBPM
//   scroll_spd : 基準スクロール速度 px/ms
//   video      : 音楽地図（ビート・コード・サビ）と歌詞タイミングのバージョン番号
export const SONGS = [
  {
    title:  'こたえて',
    artist: 'imie feat. 初音ミク',
    url:    'https://piapro.jp/t/6W2N/20251215164617',
    bpm:    130,
    scroll_spd: 0.50,
    // コーラス部分は歌詞として表示しない
    hiddenPhrases: [
      'どれほどの苦しみも悲しみの向こうに',
      'きっと私の目指す私がいると信じ続けていた',
    ],
    video: {
      beatId:               4827293,
      chordId:              2963754,
      repetitiveSegmentId:  3086261,
      lyricId:              126519,
      lyricDiffId:          28645,
    },
  },
  {
    title:  'アフター・ザ・カーテン',
    artist: 'Rulmry feat. 初音ミク',
    url:    'https://piapro.jp/t/zoqO/20251214200738',
    bpm:    70,
    scroll_spd: 0.50,
    bpmChanges: [
      { from_ms: 41242,  end_ms: 68615,  bpm: 140 },
      { from_ms: 123556, end_ms: 139023, bpm: 140 },
      { from_ms: 169802, end_ms: 183551, bpm: 140 },
      { from_ms: 205852, end_ms: 212749, bpm: 140 },
      { from_ms: 219556, end_ms: 238439, bpm: 140 },
    ],
    video: {
      beatId:               4827294,
      chordId:              2963755,
      repetitiveSegmentId:  3086262,
      lyricId:              126591,
      lyricDiffId:          28627,
    },
  },
  {
    title:  'シャッターチャンス',
    artist: '夜未アガリ feat. 初音ミク＆鏡音リン',
    url:    'https://piapro.jp/t/PNpQ/20251209170719',
    bpm:    115,
    scroll_spd: 0.70,
    video: {
      beatId:               4827295,
      chordId:              2963756,
      repetitiveSegmentId:  3086263,
      lyricId:              126542,
      lyricDiffId:          28628,
    },
  },
  {
    title:  '世界最後の音楽隊',
    artist: '夏山よつぎ×ど～ぱみん feat. 初音ミク',
    url:    'https://piapro.jp/t/B3yJ/20251215061727',
    bpm:    150,
    scroll_spd: 0.60,
    bpmChanges: [
      { from_ms: 67980,  end_ms: 93555,  bpm: 75 },
      { from_ms: 154422, end_ms: 167177, bpm: 75 },
    ],
    video: {
      beatId:               4827296,
      chordId:              2963757,
      repetitiveSegmentId:  3086264,
      lyricId:              126594,
      lyricDiffId:          28629,
    },
  },
  {
    title:  'トリツクロジー',
    artist: '鶴三 feat. 鏡音リン',
    url:    'https://piapro.jp/t/QBdL/20251215094303',
    bpm:    65,
    scroll_spd: 0.40,
    video: {
      beatId:               4827297,
      chordId:              2963758,
      repetitiveSegmentId:  3086265,
      lyricId:              126593,
      lyricDiffId:          28630,
    },
  },
  {
    title:  'TAKEOVER',
    artist: 'Twinfield feat. 初音ミク',
    url:    'https://piapro.jp/t/E2i3/20251215092113',
    bpm:    174,
    scroll_spd: 0.80,
    video: {
      beatId:               4827298,
      chordId:              2963759,
      repetitiveSegmentId:  3086266,
      lyricId:              126533,
      lyricDiffId:          28631,
    },
  },
];
