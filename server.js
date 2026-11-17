const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8888;
const WS_PORT = 8889;

let playerState = { playing: false };
const commandClients = new Set();
// 이퀄라이저 데이터를 받을 위젯들 (여러 개가 연결돼도 모두에게 보냄. 하나만 기억하면 나중에 연결한 쪽이 자리를 가져가
//   먼저 연결된 위젯은 다시 연결할 때까지 이퀄라이저가 멈춤)
const rendererSockets = new Set();

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});
app.use(express.json());

// ─── 미디어 제어 및 상태 동기화 ───────────────────────────
app.get('/command-stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(': connected\n\n');
    commandClients.add(res);
    req.on('close', () => { commandClients.delete(res); });
});

function sendCommand(command) {
    for (const client of commandClients) client.write(`data: ${command}\n\n`);
}

app.post('/play-pause', (req, res) => {
    sendCommand('play-pause');
    res.json({ ok: true });
});

app.post('/previous', (req, res) => {
    sendCommand('previous');
    res.json({ ok: true });
});

app.post('/next', (req, res) => {
    sendCommand('next');
    res.json({ ok: true });
});

// 전체화면 소리 조절 (0~100)
app.post('/volume', (req, res) => {
    const volume = Number(req.body?.volume);
    if (Number.isFinite(volume)) sendCommand(`volume:${Math.max(0, Math.min(100, Math.round(volume)))}`);
    res.json({ ok: true });
});

// 전체화면 소리 버튼 클릭 → 음소거/해제
app.post('/mute', (req, res) => {
    sendCommand(`mute:${req.body?.muted ? 1 : 0}`);
    res.json({ ok: true });
});

// 전체화면 가사 클릭 → 해당 가사 위치로 이동 (ms)
app.post('/seek', (req, res) => {
    const ms = Number(req.body?.ms);
    if (Number.isFinite(ms) && ms >= 0) sendCommand(`seek:${Math.round(ms)}`);
    res.json({ ok: true });
});

// 위젯 앨범 아트 자리에 띄우는 영상 (소리 없이, 유튜브 뮤직 재생 위치에 맞춰 따라감)
//   위젯 화면은 file:// 주소라 유튜브 임베드가 재생을 거부하므로(오류 153) 이 서버 주소의 페이지 안에서 플레이어를 띄움
//   위젯 → postMessage { type: 'sync', videoId, time(초), playing, tolerance, lead, minSeekGap }
//     tolerance: 이만큼(초) 어긋나면 위치를 맞춤 / lead: 맞출 때 이만큼 앞으로 (이동 후 다시 재생되기까지 걸리는 시간만큼 늦어지므로)
//     minSeekGap: 위치를 맞춘 뒤 이 시간(초) 동안은 다시 맞추지 않음 (계속 이동하면 버퍼링이 반복돼 끊김)
//   페이지 → 위젯 { artVideo: 'playing' | 'error' | 'time' | 'size', ... }
//     time: 실제 재생 위치(0.25초마다. 위젯이 배경 영상을 앨범 아트 자리 영상에 맞추는 데 사용)
//     size: 영상 원본 크기 (유튜브 프레임 안의 영상 크기는 메인 프로세스가 넣은 스크립트가 알려 줌 → 그대로 위젯에 전달)
const ART_VIDEO_PAGE = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#p{position:absolute;inset:0;width:100%;height:100%}</style>
</head><body><div id="p"></div>
<script>
let player = null, ready = false, want = null, wantAt = 0, loadedId = null, lastSeekAt = 0, aligned = false;
const tell = (msg) => parent.postMessage({ artVideo: msg.state, ...msg }, '*');
// 자막은 항상 끔 (올린 사람이 기본으로 켜 둔 자막도. 영상이 바뀌거나 다시 재생될 때 다시 켜지므로 재생될 때마다)
function hideCaptions() {
    for (const name of ['captions', 'cc']) { try { player.unloadModule(name); } catch (e) { } }
    try { player.setOption('captions', 'track', {}); } catch (e) { }
}
// 받은 시점 이후 흐른 시간까지 더한 지금의 목표 위치
function wantTime() {
    return want.time + (want.playing ? (performance.now() - wantAt) / 1000 : 0);
}
// 처음 불러온 영상이 목표 위치 근처에서 재생 중인지 (유튜브가 시작 위치를 무시하고 0초부터 틀 때가 있어,
// 맞춰지기 전에는 'playing'을 알리지 않음 → 위젯이 영상 첫 장면을 잠깐 보여 주지 않음)
function checkAligned() {
    if (aligned || !ready || !want) return;
    // 재생 중이거나, 멈춘 곡이면 멈춘 상태(2)·준비된 상태(5)에서 판단
    const state = player.getPlayerState();
    if (!(state === 1 || (!want.playing && (state === 2 || state === 5)))) return;
    const duration = player.getDuration() || 0;
    const target = duration ? Math.min(wantTime(), duration - 0.2) : wantTime();
    if (Math.abs(player.getCurrentTime() - target) <= 1) {
        aligned = true;
        tell({ state: 'playing', videoId: loadedId });
    } else if (Date.now() - lastSeekAt > 800) {
        lastSeekAt = Date.now();
        player.seekTo(duration ? Math.min(target + 0.3, duration - 0.2) : target + 0.3, true);
    }
}
function apply() {
    if (!ready || !want) return;
    if (want.videoId !== loadedId) {
        loadedId = want.videoId;
        aligned = false;
        lastSeekAt = Date.now();
        player.loadVideoById({ videoId: want.videoId, startSeconds: wantTime() + 0.3 });
        if (!want.playing) setTimeout(() => player.pauseVideo(), 300);
        return;
    }
    if (!aligned) {
        const st = player.getPlayerState();
        if (want.playing && st !== 1 && st !== 3) player.playVideo();
        return checkAligned();
    }
    const state = player.getPlayerState();
    // 영상이 끝났거나(0) 짝 영상이 곡보다 짧으면 그대로 둠
    const duration = player.getDuration() || 0;
    const target = duration ? Math.min(want.time, duration - 0.2) : want.time;
    const lead = want.playing ? (want.lead ?? 0.1) : 0;
    if (Math.abs(player.getCurrentTime() - target) > (want.tolerance || 0.6) && Date.now() - lastSeekAt > (want.minSeekGap || 0) * 1000) {
        lastSeekAt = Date.now();
        player.seekTo(duration ? Math.min(target + lead, duration - 0.2) : target + lead, true);
    }
    if (want.playing && state !== 1 && state !== 3) player.playVideo();
    if (!want.playing && state === 1) player.pauseVideo();
}
window.addEventListener('message', (e) => {
    if (e.data?.artVideoSize) return tell({ state: 'size', videoId: loadedId, ...e.data.artVideoSize });
    if (e.data?.type !== 'sync') return;
    want = e.data;
    wantAt = performance.now();
    apply();
});
setInterval(() => {
    checkAligned();
    if (ready && loadedId && aligned) tell({ state: 'time', videoId: loadedId, time: player.getCurrentTime(), playing: player.getPlayerState() === 1 });
}, 250);
window.onYouTubeIframeAPIReady = () => {
    player = new YT.Player('p', {
        width: '100%', height: '100%',
        playerVars: { autoplay: 1, mute: 1, controls: 0, cc_load_policy: 0, disablekb: 1, fs: 0, rel: 0, iv_load_policy: 3, playsinline: 1, modestbranding: 1, origin: location.origin },
        events: {
            onReady: () => { ready = true; player.mute(); apply(); },
            onStateChange: (e) => {
                if (e.data !== 1) return;
                hideCaptions();
                if (aligned) tell({ state: 'playing', videoId: loadedId });
                else checkAligned();
            },
            // 101·150: 퍼가기 금지 영상, 100: 없는 영상, 153: 재생 주소 문제
            onError: (e) => tell({ state: 'error', code: e.data, videoId: loadedId }),
        },
    });
};
</script>
<script src="https://www.youtube.com/iframe_api"></script>
</body></html>`;
app.get('/art-video', (req, res) => res.type('html').send(ART_VIDEO_PAGE));

app.post('/update-state', (req, res) => {
    playerState = req.body;
    res.json({ ok: true });
});

// 최근 조회 결과 캐시 (오래된 항목부터 삭제)
const CACHE_MAX = 50;

function cacheSet(map, key, value) {
    map.delete(key);
    map.set(key, value);
    if (map.size > CACHE_MAX) map.delete(map.keys().next().value);
}

// ─── 유튜브 자막 (lrclib에 가사가 없을 때만 사용) ──────────
// 서버가 유튜브에 직접 요청하지 않고, Tampermonkey에 요청 → 페이지의 플레이어가 자막을 불러오면 그 응답을 LRC로 변환해 보내줌
const pageCaptions = new Map();       // videoId → LRC | null(자막 없음)
const captionWaiters = new Map();     // videoId → [resolve, ...]
const CAPTION_WAIT_MS = 30000; // 재생 중인 영상 → 뮤직비디오 후보(최대 2개)를 차례로 시도하는 시간

function requestPageCaptions(videoId, langs, candidates) {
    if (pageCaptions.has(videoId)) return Promise.resolve(pageCaptions.get(videoId));
    if (commandClients.size === 0) return Promise.resolve(null); // 유튜브 뮤직 페이지가 연결되어 있지 않음
    return new Promise(resolve => {
        const waiting = captionWaiters.get(videoId);
        if (waiting) { waiting.push(resolve); return; } // 이미 요청 중이면 같은 결과를 기다림
        captionWaiters.set(videoId, [resolve]);
        sendCommand(`captions:${JSON.stringify({ videoId, langs, candidates })}`);
        setTimeout(() => resolveCaptionWaiters(videoId, null), CAPTION_WAIT_MS); // 응답이 없어도 '자막 없음'으로 확정하지 않음
    });
}

function resolveCaptionWaiters(videoId, lyrics) {
    const waiting = captionWaiters.get(videoId);
    if (!waiting) return;
    captionWaiters.delete(videoId);
    waiting.forEach(resolve => resolve(lyrics));
}

app.post('/yt-captions', (req, res) => {
    const { videoId, lyrics, lang, from } = req.body || {};
    if (videoId) {
        cacheSet(pageCaptions, videoId, lyrics || null);
        console.log(lyrics ? `[가사 검색] 🎈 유튜브 자막 추출 성공 (Video ID: ${videoId}${from ? ` → 뮤직비디오 ${from}` : ''}, 자막: ${lang})` : `[가사 검색] 🎈 유튜브 자막 없음 (Video ID: ${videoId})`);
        resolveCaptionWaiters(videoId, lyrics || null);
    }
    res.json({ ok: true });
});

app.get('/current-track', (req, res) => {
    res.json(playerState);
});

// 텍스트에서 가장 많이 쓰인 문자 체계로 언어 추정 (영문은 글자 단위라 음절 문자와 비슷한 비중이 되도록 보정)
function detectTextLang(text) {
    const count = (re) => (text.match(re) || []).length;
    const kana = count(/[ぁ-ゟァ-ヿ]/g), kanji = count(/[一-龥]/g);
    const scores = {
        ko: count(/[가-힣]/g),
        // 가나 없이 한자만 있으면 중국어 (일본어 가사에는 거의 항상 가나가 섞임. 예: 중국어 가사를 일본어로 잘못 판단하던 문제)
        ja: kana > 0 ? kana + kanji * 0.5 : 0,
        zh: kana > 0 ? 0 : kanji,
        en: count(/[a-zA-Z]/g) / 4,
    };
    const [lang, score] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return score > 0 ? lang : null;
}

// 가사가 기대하는 언어인지 확인. 한국어는 영어가 많이 섞여도(K-pop) 한글이 가나보다 많으면 한국어로 봄
//   (detectTextLang은 영어 비중이 큰 한국어 가사를 'en'으로 판단할 수 있음)
function lyricsLangIs(text, lang) {
    if (lang !== 'ko') return detectTextLang(text) === lang;
    const hangul = (text.match(/[가-힣]/g) || []).length;
    return hangul > 0 && hangul > (text.match(/[ぁ-ゟァ-ヿ]/g) || []).length;
}

const normalize = (s) => (s || '').toLowerCase().replace(/[\s'"`‘’“”「」『』【】\[\]()（）|·・\-_:~!?.,、。！？〜～…★☆♪♡]/g, '');

// ─── 가나 곡명 ↔ 영문 곡명이 같은 말인지 (예: ライラック ↔ Lilac, アイドル ↔ Idol) ─────────
// 가나를 로마자로 바꾼 뒤 둘 다 자음 뼈대만 남겨 비교 (일본어 외래어는 모음이 붙고 l/r 구분이 없으므로)
//   예: ダンスホール(dnshl) ↔ A Posteriori(pstr)는 다름 → 같은 가수·비슷한 길이의 다른 곡을 막음
const KANA_ROMAJI = (() => {
    const base = {
        ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o', カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko', ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge', ゴ: 'go',
        サ: 'sa', シ: 'shi', ス: 'su', セ: 'se', ソ: 'so', ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo', タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to',
        ダ: 'da', ヂ: 'ji', ヅ: 'zu', デ: 'de', ド: 'do', ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no', ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho',
        バ: 'ba', ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo', パ: 'pa', ピ: 'pi', プ: 'pu', ペ: 'pe', ポ: 'po', マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo',
        ヤ: 'ya', ユ: 'yu', ヨ: 'yo', ラ: 'ra', リ: 'ri', ル: 'ru', レ: 're', ロ: 'ro', ワ: 'wa', ヲ: 'o', ン: 'n', ヴ: 'vu',
        ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o', ャ: 'ya', ュ: 'yu', ョ: 'yo',
    };
    return base;
})();
const KANA_ONLY = /^[ぁ-ゟァ-ヿー・\s!?！？.,、。&＆-]+$/;
function kanaToRomaji(text) {
    const kata = text.replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
    return [...kata].map(c => KANA_ROMAJI[c] ?? (/[a-z]/i.test(c) ? c : '')).join('');
}
function consonantSkeleton(latin) {
    return latin.toLowerCase()
        .replace(/ph/g, 'f').replace(/th/g, 's').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's')
        .replace(/[cq]/g, 'k').replace(/x/g, 'ks').replace(/v/g, 'b').replace(/l/g, 'r').replace(/[zj]/g, 's')
        .replace(/(sh|ch|ts)/g, 's')
        .replace(/[^a-z]/g, '').replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1');
}
function editDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
}
// kanaTitle이 가나로만 된 곡명이면 latinTitles 중 하나와 발음이 비슷해야 같은 곡. 가나만이 아니면(한자·한글 등) 판단하지 않음(true)
function kanaTitleSoundsLike(kanaTitle, latinTitles) {
    if (!KANA_ONLY.test(kanaTitle)) return true;
    const k = consonantSkeleton(kanaToRomaji(kanaTitle));
    return latinTitles.some(t => {
        if (!/[a-zA-Z]/.test(t)) return false;
        const l = consonantSkeleton(t);
        if (!k || !l) return false;
        return 1 - editDistance(k, l) / Math.max(k.length, l.length) >= 0.6;
    });
}

// 같은 곡의 뮤직비디오 찾기 (유튜브 검색 결과 중 곡명이 들어간 영상, 아티스트 공식 채널 우선)
const MV_EXCLUDE_KEYWORDS = /노래방|karaoke|커버|cover|inst\b|instrumental|reaction|리액션|piano|guitar|bass|drum|vietsub|싱크룸|직캠|fancam|teaser|티저|1시간|1hour|playlist|shorts/i;
async function findMusicVideoIds(title, artist, excludeId) {
    try {
        const { data } = await axios.post('https://www.youtube.com/youtubei/v1/search?prettyPrint=false',
            { context: { client: { clientName: 'WEB', clientVersion: '2.20260901.00.00', hl: 'ko', gl: 'KR' } }, query: `${title} ${artist}`.trim() },
            { headers: { 'Content-Type': 'application/json' }, timeout: 5000 });

        const videos = [];
        (function walk(o) {
            if (!o || typeof o !== 'object') return;
            if (o.videoRenderer) {
                const v = o.videoRenderer;
                videos.push({ id: v.videoId, title: v.title?.runs?.map(r => r.text).join('') || '', owner: v.ownerText?.runs?.map(r => r.text).join('') || '' });
                return;
            }
            for (const k in o) walk(o[k]);
        })(data);

        const nTitle = normalize(title);
        const nArtist = normalize(artist);
        return videos
            .slice(0, 8)
            .filter(v => v.id !== excludeId && normalize(v.title).includes(nTitle))
            // 원곡 제목에 없는 커버/노래방/연주/티저 등의 키워드가 붙은 영상은 제외
            .filter(v => !MV_EXCLUDE_KEYWORDS.test(v.title) || MV_EXCLUDE_KEYWORDS.test(title))
            .sort((a, b) => Number(normalize(b.owner + b.title).includes(nArtist)) - Number(normalize(a.owner + a.title).includes(nArtist)))
            .slice(0, 2)
            .map(v => v.id);
    } catch (err) {
        console.error('[가사 검색] 뮤직비디오 검색 오류:', err.message);
        return [];
    }
}

// ─── 원곡 정보 추출 (커버 영상 제목 → 원곡 가수 / 원제) ─────────
const JP_CHARS = /[ぁ-ゟァ-ヿ一-龥]/;
const JP_SEGMENTS = /[ぁ-ゟァ-ヿ一-龥々〆ー・·]+/g;
const NON_SONG_GROUP = /cover|커버|ver\.?|version|official|m\/?v|live|라이브|full|short|가사|lyrics|자막|^\s*(4k|8k|hd|fhd|uhd|hq|1080p|4k\s*60fps)\s*$/i;

// 예) "물떼새[ヨルシカ - 千鳥] | 아라하시 타비 cover"        → 후보: 千鳥 / ヨルシカ
//     "푸름과 여름 (Mrs. GREEN APPLE) / 텐코 시부키 cover"     → 가수: Mrs. GREEN APPLE (원제는 검색으로 확인)
//     "아이네 클라이네 (アイネクライネ : 요네즈 켄시) / ..."     → 후보: アイネクライネ / 요네즈 켄시
//     "아 프리오리 (Mrs. GREEN APPLE「ア·プリオリ」) / ..."   → 후보: ア·プリオリ / Mrs. GREEN APPLE
// 곡 정보와 커버 가수 사이의 구분선: " / ", " | ", "｜", "ㅣ", "┃" (ㅣ·┃는 앞뒤 공백 없이 쓰이기도 함)
// 괄호 밖의 구분선에서만 나눔 (예: "orion - [米津玄師 / 요네즈 켄시] ㅣ아카네 리제"의 괄호 안 " / "는 구분선이 아님)
function splitTitleParts(title) {
    const masked = title.replace(/[\[(（【][^\])）】]*[\])）】]/g, m => '\0'.repeat(m.length));
    const parts = [];
    let start = 0;
    for (const m of masked.matchAll(/\s+[\/|｜]\s+|\s*[ㅣ┃│]\s*/g)) {
        parts.push(title.slice(start, m.index));
        start = m.index + m[0].length;
    }
    parts.push(title.slice(start));
    return parts;
}

// 따옴표로 감싼 곡명 (앞뒤가 공백/구분선이어야 함 → "Don't"의 ' 같은 문자는 제외)
const QUOTED_TITLE = /(?:^|[\s|ㅣ｜/])[‘'"“]([^’'"”]{1,60})[’'"”](?=$|[\s|ㅣ｜/,])/;
const NON_SONG_WORDS = /\b(music video|official|m\/?v|lyric video|live)\b/gi;

function parseOriginalSong(title) {
    const tracks = [], artists = [], titles = [];
    const artistOnly = new Set(); // 가수 이름으로 확정된 값 (곡명 후보에서 제외)
    const add = (list, v) => { v = (v || '').trim(); if (v && !list.includes(v)) list.push(v); };

    // "가수 | '곡명'" 형태 (예: "네네코 마시로(Neneko Mashiro) | ‘봄꿈’", "TAEYEON (태연) 'To. X' / … Cover")
    //   → 따옴표 안이 곡명, 같은 부분의 나머지(괄호 안 포함)는 가수 후보 (원곡 가수이거나 본인)
    const quotedTitle = title.match(QUOTED_TITLE);
    if (quotedTitle) {
        const part = splitTitleParts(title).find(p => p.includes(quotedTitle[0])) || title;
        const rest = part.replace(quotedTitle[0], ' ').replace(NON_SONG_WORDS, ' ');
        for (const name of rest.split(/[\[(（【\])）】]|\s+[xX×]\s+/)) {
            const n = name.replace(/\s+/g, ' ').trim();
            if (n.length >= 2 && !/^(cover|커버)$/i.test(n)) add(artists, n);
        }
    }

    // "곡 정보 / 커버 가수" 형태이므로 커버 가수 부분(/, | 뒤)은 제외
    // "ㅣ"(한글 모음)를 구분선으로 쓰는 경우도 있음 (예: "orion - [米津玄師] ㅣ아카네 리제 【COVER】")
    const titleParts = splitTitleParts(title);
    let songPart = quotedTitle ? quotedTitle[1].trim() : titleParts[0];
    // "원곡 가수 / 곡명 (原題) ┃ 커버 가수" 형태 (예: "Vaundy / 날아오를 때 (飛ぶ時)┃Cover by Hebi")
    //   → 괄호 없는 첫 부분은 원곡 가수, "곡명 (일본어 원제)" 모양의 두 번째 부분이 곡 정보
    const ARTIST_FIRST_SONG = /^[^\[(（【]+[\[(（【][^\])）】]*[ぁ-ゟァ-ヿ一-龥][^\])）】]*[\])）】]\s*$/;
    if (!quotedTitle && titleParts.length >= 2 && !/[\[(（【]/.test(titleParts[0]) && !JP_CHARS.test(titleParts[0])
        && ARTIST_FIRST_SONG.test(titleParts[1].trim()) && !/cover|커버|歌ってみた/i.test(titleParts[1])) {
        const originalArtist = titleParts[0].trim();
        add(artists, originalArtist);
        artistOnly.add(originalArtist);
        songPart = titleParts[1];
    }
    const groups = [...songPart.matchAll(/[\[(（【]([^\])）】]+)[\])）】]/g)].map(m => m[1].trim());
    for (const g of groups) {
        if (NON_SONG_GROUP.test(g) && !JP_CHARS.test(g)) continue;

        const quoted = g.match(/[「『"](.+?)[」』"]/);
        if (quoted) {
            add(tracks, quoted[1]);
            add(artists, g.replace(quoted[0], ''));
            continue;
        }
        // "[米津玄師 / 요네즈 켄시]"처럼 같은 가수를 표기만 달리해 나열한 경우 → 가수만
        const names = g.split(/\s+[\/／]\s+/).map(s => s.trim()).filter(Boolean);
        if (names.length >= 2 && !/\s[-–]\s|[:：]/.test(g)) {
            names.forEach(n => { add(artists, n); artistOnly.add(n); });
            continue;
        }
        // "가수 - 곡명" / "곡명 : 가수" 등 순서가 제각각이므로 양쪽 모두 후보로 사용
        const parts = g.split(/\s+[-–]\s+|\s*[:：]\s*/).map(s => s.trim()).filter(Boolean);
        if (parts.length === 2) {
            parts.forEach(p => { add(tracks, p); add(artists, p); });
        } else {
            // 일본어가 들어간 괄호는 원제일 가능성이 높으므로 통째로 원제 후보에도 넣음 (예: "앨리스 인 냉동고 (Alice in 冷凍庫)")
            if (JP_CHARS.test(g)) add(tracks, g);
            add(artists, g);
        }
    }

    // 괄호 밖의 "곡명 - 가수" (예: "라일락[ライラック] - Mrs. GREEN APPLE")
    const outside = songPart.replace(/[\[(（【][^\])）】]*[\])）】]/g, ' ').replace(/\s+/g, ' ')
        .replace(/^[\s\-–~:]+|[\s\-–~:]+$/g, '').trim(); // 괄호를 빼고 남은 "orion -"의 "-" 제거
    const outsideParts = outside.split(/\s+[-–]\s+/).map(s => s.trim()).filter(Boolean);
    if (outsideParts.length === 2) outsideParts.forEach(p => add(artists, p));
    // 괄호를 뺀 곡명 후보 (예: "W/X/Y", "Henceforth - Orangestar" → Henceforth / Orangestar, "푸름과 여름")
    // 한글/일본어가 들어간 쪽을 대표 곡명으로 우선 (예: "Mrs. GREEN APPLE - 춘수" → 춘수)
    outsideParts.length === 2
        ? [...outsideParts].sort((a, b) => Number(/[가-힣ぁ-ゟァ-ヿ一-龥]/.test(b)) - Number(/[가-힣ぁ-ゟァ-ヿ一-龥]/.test(a))).forEach(p => add(titles, p))
        : add(titles, outside);

    // 괄호 밖에 있는 일본어 원제도 후보로 추가
    for (const seg of songPart.match(JP_SEGMENTS) || []) add(tracks, seg);

    // 다른 후보에 포함된 조각은 뺌 (예: "Alice in 冷凍庫"가 있으면 "冷凍庫"는 제외)
    const finalTracks = tracks.filter(t => JP_CHARS.test(t) && !artistOnly.has(t) && !tracks.some(o => o !== t && o.includes(t)));
    return { tracks: finalTracks, artists, titles: titles.filter(t => !finalTracks.includes(t)) };
}

// 제목에 원제가 없을 때(예: "푸름과 여름"): 유튜브 검색 결과 제목들에 함께 적힌 일본어 원제 중 가장 많이 나온 것을 사용
async function resolveJapaneseTitle(koreanTitle, originalArtist) {
    try {
        const { data } = await axios.post('https://www.youtube.com/youtubei/v1/search?prettyPrint=false',
            { context: { client: { clientName: 'WEB', clientVersion: '2.20260901.00.00', hl: 'ko', gl: 'KR' } }, query: `${originalArtist || ''} ${koreanTitle}`.trim() },
            { headers: { 'Content-Type': 'application/json' }, timeout: 5000 });

        const titles = [];
        (function walk(o) {
            if (!o || typeof o !== 'object') return;
            if (o.videoRenderer) { titles.push(o.videoRenderer.title?.runs?.map(r => r.text).join('') || ''); return; }
            for (const k in o) walk(o[k]);
        })(data);

        const nKo = normalize(koreanTitle);
        const nArtist = normalize(originalArtist);
        const counts = new Map();
        const koPattern = [...koreanTitle.replace(/\s+/g, '')].map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
        const besideKo = new RegExp(`${koPattern}\\s*[\\[(（【「『]\\s*([^\\])）】」』]+?)\\s*[\\])）】」』]`);
        for (const t of titles.slice(0, 10)) {
            if (!normalize(t).includes(nKo)) continue; // 한국어 제목이 함께 적힌 영상만 사용
            // "푸름과 여름(青と夏)"처럼 한국어 제목 바로 뒤 괄호 안의 일본어가 원제일 가능성이 가장 높음
            const beside = t.match(besideKo)?.[1]?.trim();
            if (beside && JP_CHARS.test(beside)) counts.set(beside, (counts.get(beside) || 0) + 3);
            for (const seg of new Set(t.match(JP_SEGMENTS) || [])) {
                if (nArtist && normalize(seg) === nArtist) continue;
                counts.set(seg, (counts.get(seg) || 0) + 1);
            }
        }
        const best = [...counts].sort((a, b) => b[1] - a[1])[0];
        if (best) console.log(`[가사 검색] 🈶 원제 확인: ${koreanTitle} → ${best[0]}`);
        return best ? best[0] : null;
    } catch (err) {
        console.error('[가사 검색] 원제 검색 오류:', err.message);
        return null;
    }
}

// 유튜브 뮤직의 영어 표기 곡 정보 (예: 멸종위기사랑 / 이찬혁 → Endangered Love / LEE CHANHYUK)
// lrclib은 Spotify/Apple Music 영어 표기 기준으로 등록된 곡이 많아 한국어 제목으로는 검색되지 않는 경우가 많음
const englishMetaCache = new Map();
async function fetchEnglishMetadata(videoId) {
    if (!videoId) return null;
    if (englishMetaCache.has(videoId)) return englishMetaCache.get(videoId);
    try {
        const { data } = await axios.post('https://music.youtube.com/youtubei/v1/next?prettyPrint=false',
            { context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20260901.01.00', hl: 'en', gl: 'US' } }, videoId },
            { headers: { 'Content-Type': 'application/json', Origin: 'https://music.youtube.com' }, timeout: 4000 });

        let renderer = null;
        (function walk(o) {
            if (renderer || !o || typeof o !== 'object') return;
            if (o.playlistPanelVideoRenderer?.videoId === videoId) { renderer = o.playlistPanelVideoRenderer; return; }
            for (const k in o) walk(o[k]);
        })(data);

        const title = renderer?.title?.runs?.map(r => r.text).join('').trim();
        // longBylineText: "LEE CHANHYUK • EROS • 2025" → 첫 항목이 가수
        const artist = (renderer?.longBylineText?.runs?.map(r => r.text).join('') || '').split(' • ')[0].trim();
        const result = title ? { title, artist } : null;
        cacheSet(englishMetaCache, videoId, result);
        return result;
    } catch (err) {
        console.error('[가사 검색] 영어 곡 정보 조회 오류:', err.message);
        return null; // 실패는 캐시하지 않음
    }
}

// lrclib에 같은 곡 이름으로 대량 등록된 엉터리 가사 (예: YOASOBI「アイドル」 영어판을 일본어로 받아 적은 가사가 20개 이상 등록되어 정상 가사가 검색 결과에서 밀려남)
// 해당 가사의 특징적인 줄로 걸러냄
const VANDALIZED_LYRIC_LINES = [
    '課す 冥土 よこす 実に上の上',
    '万事休す ウィットに富む あれマジで',
];
const isVandalizedLyrics = (lyrics) => !!lyrics && VANDALIZED_LYRIC_LINES.some(line => lyrics.includes(line));

// lrclib은 과부하(503 ServerOverloaded)나 요청 제한(429)이 수시로 발생하므로 간격을 늘려가며 최대 3번 재시도
const LRCLIB_RETRY_DELAYS = [1000, 2000, 4000];
async function searchLrclib(params) {
    for (let attempt = 0; ; attempt++) {
        try {
            const { data } = await axios.get('https://lrclib.net/api/search', { params, timeout: 5000 });
            return (data || []).filter(r => !isVandalizedLyrics(r.syncedLyrics));
        } catch (e) {
            const status = e.response?.status;
            if (attempt < LRCLIB_RETRY_DELAYS.length && (status === 503 || status === 429)) {
                await new Promise(r => setTimeout(r, LRCLIB_RETRY_DELAYS[attempt]));
                continue;
            }
            throw e;
        }
    }
}

// ─── 추가 가사 제공처 (lrclib에 가사가 없을 때) ──────────────
// Syncanto(MIT, vendor/syncanto)의 제공처 코드 사용. 원본의 getLyrics()는 첫 검색 결과를 그대로 쓰므로,
// search() 결과를 lrclib과 같은 기준(가수/곡명/길이)으로 검증한 뒤 getById()로 가사를 가져옴
const { MusixmatchProvider } = require('./vendor/syncanto/providers/musixmatch');
const { AppleMusicProvider } = require('./vendor/syncanto/providers/applemusic');
const { NetEaseProvider } = require('./vendor/syncanto/providers/netease');
const { QQMusicProvider } = require('./vendor/syncanto/providers/qqmusic');
const { KugouProvider } = require('./vendor/syncanto/providers/kugou');
require('./vendor/syncanto/utils/http').log = () => { }; // 라이브러리 내부 디버그 로그 끔

// 우선순위 순서. Spotify 가사는 Musixmatch가 제공하므로 Spotify 자리에는 Musixmatch를 사용
// (YouTube Music 가사는 싱크 없는 일반 가사이고 로그인이 필요해 제외)
const EXTRA_PROVIDERS = [
    { label: 'Spotify(Musixmatch)', provider: new MusixmatchProvider() },
    { label: 'Apple Music', provider: new AppleMusicProvider() },
    { label: 'NetEase', provider: new NetEaseProvider() },
    { label: 'QQ Music', provider: new QQMusicProvider() },
    { label: 'KuGou', provider: new KugouProvider() },
];
const EXTRA_REQUEST_TIMEOUT_MS = 8000;    // 요청 1번
const EXTRA_PROVIDER_BUDGET_MS = 15000;   // 제공처 하나 전체 (모든 제공처를 동시에 검색하므로 최대 대기 시간도 이 정도)

const withTimeout = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(null), ms))]);

const LRC_TIMED_LINE = /^\s*\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]\s*\S/;
// 가사 앞에 붙는 제작 정보 줄 (예: NetEase "作词 : 大森元貴", "作曲 : …")
const CREDIT_LINE = /^(作词|作詞|作曲|编曲|編曲|制作人|製作|制作团队|监制|混音|混缩|母带|和声|录音|吉他|贝斯|鼓|弦乐|出品|出品人|发行|演唱|原唱|翻唱|策划|后期|曲绘|词|曲|vocals?|lyrics?|lyricist|composer|composed by|arranged by|arranger|producer|written by)\s*(by)?\s*[:：]/i;

// 한자로 된 짧은 항목명 + 콜론 (예: "混音/母带：LL", "和声编写：…") — 일본어 가사는 가나가 섞이므로 해당 없음
const CREDIT_LINE_ZH = /^[一-龥\s/&·、]{1,10}[:：]/;

// 제작 정보 줄과 맨 앞의 "곡명 - 가수" 줄(예: QQ "[00:00.23]ライラック - Mrs. GREEN APPLE")을 빼고 정리
function cleanProviderLyrics(lrc, trackName, artistName) {
    const nTitle = normalize(trackName), nArtist = normalize(artistName);
    return lrc.split('\n').filter(line => {
        const text = line.replace(/\[[^\]]*\]/g, '').trim();
        if (!text) return true;
        if (CREDIT_LINE.test(text) || CREDIT_LINE_ZH.test(text)) return false;
        const n = normalize(text);
        if (nTitle && nArtist && n.includes(nTitle) && n.includes(nArtist)) return false;
        // 맨 앞의 "곡명 - 원작자" 줄 (예: "サクラキミワタシ - tuki.")
        return !(nTitle && n.startsWith(nTitle) && /\s[-–]\s/.test(text));
    }).join('\n');
}

// 제공처 하나에서 검색 → 검증(accept) 통과한 결과 중 길이가 가까운 순으로 싱크 가사를 찾음
async function searchExtraProvider({ provider }, queries, accept, byDuration, expectLang, verifyLyrics) {
    for (const query of queries) {
        const results = (await withTimeout(provider.search(query).catch(() => []), EXTRA_REQUEST_TIMEOUT_MS)) || [];
        const candidates = results
            // 제공처마다 길이 단위가 다름 (NetEase는 ms, 나머지는 초)
            .map(r => ({ ...r, trackName: r.name, artistName: r.artist, duration: r.duration > 10000 ? r.duration / 1000 : r.duration }))
            .filter(accept)
            .sort(byDuration)
            .slice(0, 2);
        for (const c of candidates) {
            const track = await withTimeout(provider.getById(c.trackId).catch(() => null), EXTRA_REQUEST_TIMEOUT_MS);
            if (!track?.synced) continue;
            const lyrics = cleanProviderLyrics(track.synced, c.name, c.artist);
            if (lyrics.split('\n').filter(l => LRC_TIMED_LINE.test(l)).length < 3) continue; // 싱크 줄이 거의 없으면 제외
            if (isVandalizedLyrics(lyrics)) continue;
            if (expectLang && !lyricsLangIs(lyrics, expectLang)) continue;
            if (verifyLyrics && !verifyLyrics(c, lyrics)) continue;
            return { lyrics, match: c };
        }
    }
    return null;
}

// ─── 🚨 가사 Fetch (스마트 필터 및 커버 지원) ─────────────────
// 찾은 가사를 영상별로 잠시 보관 (다음 곡을 미리 찾아 두면 곡이 바뀌었을 때 바로 돌려줌)
const lyricsResultCache = new Map();

app.get('/lyrics', async (req, res) => {
    const { title = '', artist, album, videoId } = req.query;
    // 저장 기준은 영상 + 제목: 곡이 넘어가는 순간 유튜브 뮤직이 새 곡의 videoId와 이전 곡의 제목을 같이 보내는 경우가 있어,
    // videoId만으로 저장하면 이전 곡 가사가 새 곡에 저장돼 계속 나옴 (예: I Love Rock 'N Roll에 이전 곡 Overdose 가사)
    const lyricsCacheKey = videoId ? `${videoId}|${title}` : '';
    if (lyricsCacheKey && lyricsResultCache.has(lyricsCacheKey)) return res.json(lyricsResultCache.get(lyricsCacheKey));
    if (req.query.prefetch) console.log(`[가사 검색] ⏭️ 다음 곡 미리 찾기: ${title} (${videoId})`);
    // 가사를 찾은 응답만 보관 (못 찾은 경우는 다음에 다시 시도: 재생 중일 때는 유튜브 자막 단계가 추가로 있음)
    const sendJson = res.json.bind(res);
    res.json = (body) => {
        if (lyricsCacheKey && body?.lyrics) cacheSet(lyricsResultCache, lyricsCacheKey, body);
        return sendJson(body);
    };

    // 🚨 1. 가수 이름 정제: " 및 ", " & ", " feat." 등을 잘라내고 메인 가수 1명만 추출!
    let cleanArtist = artist || '';
    if (cleanArtist) {
        // 예: "지코 및 Lilas" -> "지코"
        // 자동 생성 아티스트 채널의 " - Topic" 제거 (예: "K/DA - Topic" → "K/DA")
        cleanArtist = cleanArtist.replace(/\s+-\s+Topic$/i, '');
        cleanArtist = cleanArtist.split(/ 및 | & |, | feat\.? | ft\.? /i)[0].trim();
    }

    // 2. 노래 제목 정제
    // ("/"나 "-"로 무작정 자르면 "W/X/Y" → "W"처럼 곡명이 망가지므로 커버 가수 부분과 괄호만 제거)
    const original = parseOriginalSong(title);
    let cleanTitle = original.titles[0] || original.tracks[0] || title.split(/[\[\(\-\/\|]/)[0].trim();
    if (!cleanTitle) cleanTitle = title.trim();

    // 원곡 정보: 제목 괄호 안의 원곡 가수/원제, 없으면 유튜브 검색으로 일본어 원제 확인
    // 제목이 한국어 번역 제목일 때만 원제 검색 (예: "BOW AND ARROW"처럼 이미 원제인 경우는 검색하지 않음)
    if (original.tracks.length === 0 && /[가-힣]/.test(cleanTitle) && original.artists.length > 0) {
        const resolved = await resolveJapaneseTitle(cleanTitle, original.artists[0]);
        if (resolved) original.tracks.push(resolved);
    }

    // expectLang: 이 검색으로 기대하는 가사 언어 (다른 언어 가사는 번역/다른 곡일 가능성이 높아 버림)
    // lrclib 검색은 느슨하게 일치하는 다른 곡도 돌려주므로, 곡명이 검색어와 실제로 일치하는 결과만 채택
    const titleMatches = (r, query) => {
        const a = normalize(r.trackName), b = normalize(query);
        return !!a && !!b && (a.includes(b) || b.includes(a));
    };

    const findBestLyrics = (data, expectLang, query) => {
        if (!data || data.length === 0) return null;
        const syncedResults = data.filter(r => r.syncedLyrics && titleMatches(r, query));
        if (syncedResults.length === 0) return null;

        if (expectLang) return syncedResults.find(r => lyricsLangIs(r.syncedLyrics, expectLang)) || null;

        // 다른 언어로 다시 부른 버전(예: Fantastic Baby의 "ALIVE [Japanese Version]")은 듣는 곡도 그 버전일 때만 사용
        //   후보는 곡 길이가 가까운 순이라, 길이가 1초 더 가까운 일본어 버전이 한국어 원곡보다 먼저 뽑히던 문제
        const LANG_VERSION = /(japanese|english|chinese|korean)\s*(ver(sion)?\b|ver\.)|日本語\s*(ver|バージョン)|일본어\s*버전|영어\s*버전/i;
        const versionOk = (r) => !LANG_VERSION.test(`${r.trackName} ${r.albumName}`) || LANG_VERSION.test(title);
        const cjkResults = syncedResults.filter(r => /[가-힣ぁ-んァ-ン一-龥]/.test(r.syncedLyrics) && versionOk(r));
        // 듣는 곡이 다른 언어 버전이면(예: "Fantastic Baby (Japanese Ver.)") 그 버전 가사를 먼저
        if (LANG_VERSION.test(title)) {
            const sameVersion = cjkResults.find(r => LANG_VERSION.test(`${r.trackName} ${r.albumName}`));
            if (sameVersion) return sameVersion;
        }
        // 후보 가사의 언어가 섞여 있으면 가장 많은 후보가 쓰는 언어(대개 원곡 언어)를 고름. 같으면 길이가 가까운 쪽
        const langCount = {};
        cjkResults.forEach(r => { const l = detectTextLang(r.syncedLyrics); langCount[l] = (langCount[l] || 0) + 1; });
        const mainLang = Object.keys(langCount).sort((a, b) => langCount[b] - langCount[a])[0];
        const originalLangMatch = cjkResults.find(r => detectTextLang(r.syncedLyrics) === mainLang);
        const cleanMatch = syncedResults.find(r =>
            !/romaji|romanized|transliteration/i.test(r.trackName) &&
            !/romaji|romanized|transliteration/i.test(r.albumName)
        );
        return originalLangMatch || cleanMatch || syncedResults[0];
    };

    // 검색 순서: 커버 가수 버전 → 원제(+원곡 가수) → 원제 단독 → 유튜브 뮤직 제목(+가수) → 제목 단독
    const queries = [];

    // 유튜브 뮤직 가수 이름은 "hebi. 헤비", "아오쿠모 린 AOKUMO RIN"처럼 표기가 섞여 있어 lrclib에서 검색되지 않으므로 표기별로 분리
    // 제목의 커버 가수 부분 (예: "アスノヨゾラ哨戒班 / Hebi. cover" → "Hebi", "… | 아라하시 타비 ARAHASHI TABI cover")
    // 유튜브 뮤직 가수 이름은 한글만 있는 경우(예: "헤비")가 있어 lrclib의 영문 표기와 맞추려면 제목 쪽 이름이 필요
    // 따옴표 곡명은 커버 가수 이름이 아님 (예: "아카네 리제(Akane Lize)ㅣ'Stranger'"의 Stranger)
    const titleCoverArtist = (splitTitleParts(title.replace(QUOTED_TITLE, ' ')).slice(1).join(' ') || '')
        .replace(/[\[(（【][^\])）】]*[\])）】]/g, ' ')
        .replace(/\b(covered\s+by|cover(ed)?|歌ってみた|official|mv|m\/v|live|ver\.?|version)\b|커버|불러보았다/gi, ' ')
        .replace(/\s+/g, ' ').trim();

    // 표기별로 분리 (lrclib은 "hebi. 헤비"처럼 섞인 이름으로는 검색되지 않음). 제목 쪽 이름을 우선
    const scriptCount = (t) => [/[가-힣]/, /[ぁ-ゟァ-ヿ一-龥]/, /[a-zA-Z]/].filter(re => re.test(t)).length;
    const coverArtists = [];
    for (const source of [titleCoverArtist, cleanArtist]) {
        for (const v of [
            source,
            (source.match(/[a-zA-Z][a-zA-Z0-9 .'&_-]*/g) || []).join(' '),
            (source.match(/[가-힣][가-힣 ]*/g) || []).join(' '),
            (source.match(/[ぁ-ゟァ-ヿ一-龥][ぁ-ゟァ-ヿ一-龥ー・ ]*/g) || []).join(' '),
        ]) {
            const name = v.replace(/[\s.]+$/, '').trim();
            if (name.length < 2 || scriptCount(name) > 1 || coverArtists.includes(name)) continue;
            coverArtists.push(name);
        }
    }
    // 한국어/일본어 표기 곡은 영어 표기(예: Endangered Love / LEE CHANHYUK)로도 검색
    const englishMeta = /[가-힣ぁ-ゟァ-ヿ一-龥]/.test(`${title} ${artist}`) ? await fetchEnglishMetadata(videoId) : null;
    // 제목이 같아도 가수만 영어 표기가 다른 경우가 있음 (예: Festa! / 아카네 리제 → Festa! / Akane Lize)
    const englishTitle = englishMeta && (normalize(englishMeta.title) !== normalize(title) || normalize(englishMeta.artist) !== normalize(artist))
        ? (parseOriginalSong(englishMeta.title).titles[0] || englishMeta.title) : null;
    const englishExpect = /[ぁ-ゟァ-ヿ]/.test(cleanTitle) ? 'ja' : null;
    // 곡명에 가나가 있으면 일본어 가사만 채택 (로마자 표기 가사 제외. 예: 怪獣の花唄 → "Omoidasu no wa kimi no uta")
    // 유튜브 뮤직 제목에 한글이 있는 한국 곡이면 한국어 가사만 채택 (예: "LOVE SCENARIO (사랑을 했다)"
    //   → lrclib의 "LOVE SCENARIO / iKON" 결과 대부분이 곡명 표시 없는 일본어 버전 가사라 그쪽이 뽑히던 문제)
    //   커버곡·일본어 원제가 있는 곡(한국어 번역 제목의 일본 노래)은 제외
    const isCover = /cover|커버|歌ってみた/i.test(title);
    const koreanTitle = /[가-힣]/.test(title) && !/[ぁ-ゟァ-ヿ]/.test(title) && original.tracks.length === 0 && !isCover;
    const titleExpect = englishExpect || (koreanTitle ? 'ko' : null);
    if (englishTitle) {
        console.log(`[가사 검색] 🔤 영어 표기: ${englishTitle} / ${englishMeta.artist}`);
        // 영어 제목으로 찾으면 영어판 가사(예: アイドル → Idol)가 걸리므로, 원제가 일본어면 일본어 가사만 채택
        if (englishMeta.artist) queries.push([{ track_name: englishTitle, artist_name: englishMeta.artist }, titleExpect]);
    }

    // 커버 가수 본인 버전이 lrclib에 있으면 지금 재생 중인 음원과 타이밍이 정확히 일치하므로 최우선
    // (곡명만으로 검색하면 결과가 20개로 잘려 커버 버전이 빠지는 경우가 많음)
    for (const t of [...new Set([...original.tracks, ...original.titles, cleanTitle])].slice(0, 2)) {
        for (const a of coverArtists.slice(0, 3)) queries.push([{ track_name: t, artist_name: a }, titleExpect]);
    }
    // "가수 - 곡명"의 순서를 알 수 없으므로 (원제+원곡 가수) 조합을 모두 먼저 시도한 뒤 원제 단독 검색
    for (const track of original.tracks) {
        for (const a of original.artists) if (a !== track) queries.push([{ track_name: track, artist_name: a }, 'ja']);
    }
    // 제목에 원곡 가수가 적힌 경우 (예: "W/X/Y (Tani Yuuki)", "Henceforth - Orangestar")
    for (const t of original.titles) {
        for (const a of original.artists) if (a !== t) queries.push([{ track_name: t, artist_name: a }, titleExpect]);
    }
    for (const track of original.tracks) queries.push([{ track_name: track }, 'ja']);
    queries.push([{ track_name: cleanTitle, artist_name: cleanArtist }, titleExpect]);
    // 괄호 안의 한국어 제목 (예: "LOVE SCENARIO (사랑을 했다)" → 사랑을 했다 / iKON)
    if (koreanTitle && cleanArtist) {
        for (const m of title.matchAll(/[\[(（【]([^\])）】]*[가-힣][^\])）】]*)[\])）】]/g)) {
            const alt = m[1].trim();
            if (!NON_SONG_GROUP.test(alt) && normalize(alt) !== normalize(cleanArtist)) queries.push([{ track_name: alt, artist_name: cleanArtist }, 'ko']);
        }
    }
    for (const t of original.titles) queries.push([{ track_name: t }, titleExpect]);
    queries.push([{ track_name: cleanTitle }, titleExpect]);
    if (englishTitle) queries.push([{ track_name: englishTitle }, titleExpect]);

    // 같은 곡명의 다른 가수 곡(예: ライラック / 美波)을 피하기 위해, 제목에서 알아낸 원곡 가수와 일치하는 결과를 우선
    const knownArtists = [...original.artists, ...coverArtists, englishMeta?.artist || ''].map(normalize).filter(a => a.length >= 2);
    // 가수 이름 비교: 완전히 같거나, 결과 가수 칸의 이름 하나(예: "Orangestar feat.IA"의 Orangestar)와 같으면 같은 가수.
    //   한쪽이 다른 쪽에 포함되는 경우는 짧은 쪽이 4자 이상일 때만 인정
    //   (예: "B.I"(bi)가 "Hebi"(hebi) 안에 들어 있어 Hebi의 Be I에 B.I의 BE I 가사가 붙던 문제)
    const ARTIST_SPLIT = /\s*[\/&,、×]\s*|\s+(?:x|feat\.?|ft\.?|with|and)\s+|[()（）\[\]]/i;
    const artistMatches = (r) => {
        const a = normalize(r.artistName);
        if (!a) return false;
        const parts = new Set([a, ...String(r.artistName).split(ARTIST_SPLIT).map(normalize).filter(Boolean)]);
        return knownArtists.some(k => {
            if (!k) return false;
            if (parts.has(k)) return true;
            const [shorter, longer] = k.length <= a.length ? [k, a] : [a, k];
            return shorter.length >= 4 && longer.includes(shorter);
        });
    };

    // 가수 미확인 결과 허용 조건: 곡명이 정확히 같고, 가수 이름이 우리가 아는 가수와 다른 문자로 표기된 경우만
    // (예: 요네즈 켄시 ↔ 米津玄師, 스텔라이브 ↔ STELLIVE). 같은 문자인데 이름이 다르면 다른 가수(예: 스텔라이브 ↔ EXO는 곡명도 다름)
    const scriptsOf = (text) => {
        const set = new Set();
        if (/[가-힣]/.test(text)) set.add('ko');
        if (/[ぁ-ゟァ-ヿ一-龥]/.test(text)) set.add('ja');
        if (/[a-zA-Z]/.test(text)) set.add('latin');
        return set;
    };
    const queryTitles = new Set([...original.tracks, ...original.titles, cleanTitle, englishTitle || ''].map(normalize));
    // 커버곡: 유튜브 뮤직 가수는 커버 가수라 원곡 가수와 다른 게 당연함 (예: Beyond the way / 하나코 나나 cover → 원곡 Giga).
    //   제목에 원곡 가수도 없으면 가수 대신 곡 길이로 확인 (커버는 보통 원곡과 길이가 비슷함)
    // 곡 길이: 재생 중인 곡이면 플레이어 정보, 다음 곡을 미리 찾을 때는 위젯이 알려준 길이(초)
    const playingSec = playerState.videoId === videoId && playerState.duration ? playerState.duration / 1000 : (Number(req.query.duration) || 0);
    const durationClose = (r) => !playingSec || !r.duration || Math.abs(r.duration - playingSec) <= 15;
    // 표기 문자 비교에 쓸 가수: 곡명으로 쓰인 후보(예: "(星座になれたら : 결속 밴드)"의 星座になれたら)는 제외하고,
    //   커버곡이면 커버 가수(유튜브 뮤직 가수)도 제외 → 원곡 가수만 남김
    // 영문 곡명 옆의 한글은 곡명의 한국어 표기일 가능성이 큼 (예: "phony [포니 / ツミキ]"의 포니 → 원곡 가수는 ツミキ)
    //   곡명에 한글이 없고 일본어 표기 가수 후보가 따로 있으면, 한글만으로 된 후보는 가수에서 뺌
    const hangulOnly = (a) => /[가-힣]/.test(a) && !/[a-zA-Zぁ-ゟァ-ヿ一-龥]/.test(a);
    const looksLikeKoreanTitle = (a) => hangulOnly(a) && !/[가-힣]/.test(cleanTitle)
        && original.artists.some(o => /[ぁ-ゟァ-ヿ一-龥]/.test(o));
    const realOriginalArtists = original.artists.filter(a => !original.tracks.includes(a) && !original.titles.includes(a) && !looksLikeKoreanTitle(a));
    // 커버가 아니면 유튜브 뮤직 가수와 그 영어 표기(예: 아카네 리제 / Akane Lize)도 비교 → 다른 가수의 동명곡(예: Festa / Alex Britti) 차단
    const compareArtists = isCover ? realOriginalArtists : [...realOriginalArtists, cleanArtist, englishMeta?.artist].filter(Boolean);
    const compareScripts = new Set(compareArtists.flatMap(a => [...scriptsOf(a || '')]));
    // 제목 앞 【아야츠노 유니】처럼 괄호 안에 커버 가수 본인 이름이 적힌 경우는 원곡 가수가 아니므로 제외
    const performerNames = [cleanArtist, artist || '', ...coverArtists].map(normalize).filter(n => n.length >= 2);
    const isPerformer = (a) => { const n = normalize(a); return !!n && performerNames.some(p => p.includes(n) || n.includes(p)); };
    const originalArtistScripts = [...new Set(realOriginalArtists.filter(a => !isPerformer(a)).flatMap(a => [...scriptsOf(a)]))].filter(sc => sc !== 'latin');
    // 가사가 원곡 가수 이름의 문자(한글/일본어)로 '주로' 쓰였는지 (몇 글자 섞인 것만으로는 인정하지 않음)
    //   예: phony / ツミキ 커버에 Will Stetson의 영어 커버 가사가 붙던 문제 (영어 가사에 "パラッダ" 몇 글자가 있어 통과)
    //   영어가 섞인 가사(J-pop, K-pop)도 통과하도록 해당 문자 비중이 25% 이상이면 인정
    const scriptShare = (lyrics, sc) => {
        const text = lyrics.replace(/\[[^\]]*\]/g, '');
        const count = (re) => (text.match(re) || []).length;
        const ko = count(/[가-힣]/g), ja = count(/[ぁ-ゟァ-ヿ]/g) + count(/[一-龥]/g) * 0.5, en = count(/[a-zA-Z]/g) / 4;
        const total = ko + ja + en;
        return total ? ({ ko, ja }[sc] || 0) / total : 0;
    };
    const lyricsMatchOriginalArtistScript = (lyrics) =>
        originalArtistScripts.length === 0 || originalArtistScripts.some(sc => scriptShare(lyrics, sc) >= 0.25);
    const isSafeFallback = (r) => {
        if (!queryTitles.has(normalize(r.trackName))) return false;
        if (!durationClose(r)) return false;
        // 비교할 원곡 가수가 없으면 곡명 + 길이로만 판단
        if (compareArtists.length === 0) return true;
        // 같은 가수를 다른 문자로 표기한 경우만 허용 (예: 결속 밴드 ↔ 結束バンド / Kessoku Band)
        const resultArtistScripts = [...scriptsOf(r.artistName || '')];
        // 한글/일본어/영문이 아닌 문자로만 된 가수(예: 러시아어 "ЛСП")는 표기만 다른 같은 가수로 볼 근거가 없음
        //   (예: Pit / NANAOAKARI ↔ "PiT / ЛСП" 러시아 노래가 통과하던 문제)
        if (resultArtistScripts.length === 0) return false;
        if (resultArtistScripts.some(sc => compareScripts.has(sc))) return false;
        // 제목에 적힌 원곡 가수 이름이 한글/일본어면 가사에도 그 문자가 있어야 같은 곡으로 봄
        //   (예: BE SOMEBODY (육성재) cover ↔ "Be Somebody / slimdan"은 가수 이름 문자만 달라 통과했지만 가사가 전부 영어)
        //   유튜브 뮤직 가수(커버 가수일 수 있음)는 기준에서 제외 (예: 怪獣の花唄 / 아이리 칸나 → 일본어 원곡 가사가 맞음)
        if (r.syncedLyrics && !lyricsMatchOriginalArtistScript(r.syncedLyrics)) return false;
        return true;
    };

    const MAX_LRCLIB_REQUESTS = 14;
    const tried = new Set();
    let fallbackMatch = null; // 가수가 확인되지 않은 결과 (가수 일치 결과가 끝내 없을 때만 사용)
    let searchFailed = false; // lrclib 과부하(503) 등으로 검색 하나라도 실패했는지
    let otherLangMatch = null; // 한국어 제목인데 다른 언어인 가사 (한국어 가사를 끝내 못 찾았을 때만 사용)
    let lengthMismatch = null; // 가수는 맞지만 길이가 크게 다른 결과 (예: 티저/짧은 버전. 끝내 다른 결과가 없을 때만 사용)
    // 후보가 여럿이면 재생 중인 곡과 길이가 가장 가까운 것 우선 (같은 곡의 다른 버전/커버/티저 구분)
    const exactTitlePool = [];
    const byDuration = (a, b) => playingSec ? Math.abs((a.duration || 1e9) - playingSec) - Math.abs((b.duration || 1e9) - playingSec) : 0;
    for (const [params, expectLang] of queries) {
        const key = JSON.stringify(params);
        if (tried.has(key)) continue;
        if (tried.size >= MAX_LRCLIB_REQUESTS) break;
        tried.add(key);
        try {
            const results = await searchLrclib(params);
            // 원제 단독 검색 결과는 '원곡 가수 다수결' 마지막 수단용으로 모아 둠
            if (!params.artist_name && original.tracks.includes(params.track_name)) exactTitlePool.push(...results);
            const candidates = (knownArtists.length > 0 ? results.filter(artistMatches) : results).sort(byDuration);
            const bestMatch = findBestLyrics(candidates.filter(durationClose), expectLang, params.track_name);
            if (bestMatch) {
                console.log(`[가사 검색] 📜 lrclib 가사 사용 (${bestMatch.trackName} / ${bestMatch.artistName})`);
                return res.json({ lyrics: bestMatch.syncedLyrics, source: 'lrclib' });
            }
            if (!lengthMismatch) lengthMismatch = findBestLyrics(candidates, expectLang, params.track_name);
            if (!otherLangMatch && expectLang === 'ko') otherLangMatch = findBestLyrics(candidates.filter(durationClose), null, params.track_name);
            if (!fallbackMatch) fallbackMatch = findBestLyrics(results.filter(isSafeFallback).sort(byDuration), expectLang, params.track_name);
        } catch (e) {
            searchFailed = true;
            console.error("가사 검색 실패:", e.message);
        }
    }

    // [2순위] 추가 가사 제공처: Spotify(Musixmatch) → Apple Music → NetEase → QQ Music → KuGou
    //   모두 동시에 검색하고, 찾은 것 중 우선순위가 가장 높은 제공처의 가사를 사용
    {
        const extraQueries = [...new Set([
            original.tracks[0] ? `${original.tracks[0]} ${realOriginalArtists[0] || ''}`.trim() : null, // 커버곡: 일본어 원제 + 원곡 가수
            // 제목 괄호 안의 원곡 가수 (예: "BE SOMEBODY (육성재) / 아라하시 타비 Cover" → "BE SOMEBODY 육성재")
            realOriginalArtists[0] ? `${cleanTitle} ${realOriginalArtists[0]}` : null,
            `${cleanTitle} ${cleanArtist}`.trim(),
            englishTitle && englishMeta?.artist ? `${englishTitle} ${englishMeta.artist}` : null,
        ].filter(Boolean))].slice(0, 2);
        const queryTitleScripts = new Set([cleanTitle, ...original.tracks, ...original.titles, englishTitle || ''].flatMap(t => [...scriptsOf(t)]));
        // 반주/노래방/짧은 버전/라이브 버전 (라이브는 가사 타이밍이 음원과 다름)
        const VERSION_WORDS = /instrumental|\binst\b|karaoke|カラオケ|off vocal|伴奏|剪辑|anime size|\blive\b|라이브|现场/i;
        const extraAccept = (r) => {
            const nName = normalize(r.trackName);
            if (!nName) return false;
            // 반주/노래방/짧은 버전은 지금 듣는 곡도 그 버전일 때만
            if (VERSION_WORDS.test(r.trackName) && !VERSION_WORDS.test(title)) return false;
            if (!durationClose(r)) return false;
            const titleOk = [...queryTitles].some(q => q && (nName.includes(q) || q.includes(nName)));
            // 곡명이 언어만 다른 경우(예: ライラック ↔ Lilac): 가수가 같고 길이가 3초 이내로 거의 같으며,
            // 곡명이 검색한 어떤 제목과도 다른 문자(한글/일본어/영문)로 쓰였을 때만 같은 곡으로 봄
            // (같은 문자인데 곡명이 다르면 같은 가수의 다른 곡. 예: 맨드라미 ↔ 한참 외로워 하던 사람은 결국 고양이가 되어서)
            const sameLength = playingSec && r.duration && Math.abs(r.duration - playingSec) <= 3;
            // 한자만으로 된 제목은 중국어 제목일 수 있어 제외 (예: To. X ↔ 噩梦 같은 가수의 다른 곡)
            const otherScript = /[ぁ-ゟァ-ヿ가-힣a-zA-Z]/.test(r.trackName) && ![...scriptsOf(r.trackName)].some(sc => queryTitleScripts.has(sc));
            // 가나 곡명이면 영문 곡명과 발음까지 비슷해야 함 (예: A Posteriori에 같은 가수·비슷한 길이의 ダンスホール 가사가 붙던 문제)
            const soundsSame = kanaTitleSoundsLike(r.trackName, [cleanTitle, ...original.titles, englishTitle || '']);
            if (artistMatches(r) && (titleOk || (sameLength && otherScript && soundsSame))) return true;
            // 가수를 확인하지 못한 결과는 곡 길이로라도 확인돼야 함 (QQ Music 등은 길이 정보가 없어
            // 길이 검사가 그냥 통과됨 → 같은 제목의 다른 사람 커버가 붙음. 예: Alice in 冷凍庫 / めありー)
            if (!r.duration || !isSafeFallback(r)) return false;
            r.unverifiedArtist = true; // 가사를 받은 뒤 가사 문자로 한 번 더 확인 (searchExtraProvider)
            return true;
        };
        // 가수를 확인하지 못한 결과: 원곡 가수 이름이 한글/일본어면 가사에도 그 문자가 있어야 함 (isSafeFallback과 같은 기준)
        const verifyExtraLyrics = (c, lyrics) => {
            return !c.unverifiedArtist || lyricsMatchOriginalArtistScript(lyrics);
        };
        const extraExpect = (original.tracks.length > 0 || /[ぁ-ゟァ-ヿ]/.test(cleanTitle)) ? 'ja' : (koreanTitle ? 'ko' : null);
        const found = await Promise.all(EXTRA_PROVIDERS.map(p =>
            withTimeout(searchExtraProvider(p, extraQueries, extraAccept, byDuration, extraExpect, verifyExtraLyrics).catch(() => null), EXTRA_PROVIDER_BUDGET_MS)));
        const bestIdx = found.findIndex(Boolean);
        if (bestIdx >= 0) {
            const { lyrics, match } = found[bestIdx];
            console.log(`[가사 검색] 🧩 ${EXTRA_PROVIDERS[bestIdx].label} 가사 사용 (${match.name} / ${match.artist})`);
            return res.json({ lyrics, source: EXTRA_PROVIDERS[bestIdx].label });
        }
        console.log(`[가사 검색] 🧩 추가 제공처에도 가사 없음 (검색어: ${extraQueries.join(' | ')})`);
    }

    // 원곡 가수를 확인하지 못했지만 곡명이 일치하는 가사 (예: 가수 표기가 한국어/일본어로 달라 매칭 실패)
    // lrclib 검색이 하나라도 실패(과부하 503 등)했으면 정확한 결과를 놓쳤을 수 있으므로, 불확실한 결과(가수 미확인/길이 다름)나
    // 자막으로 확정하거나 "가사 없음"으로 끝내지 않고 위젯이 잠시 뒤 다시 요청하게 함
    //   (예: "orion / 米津玄師" 검색이 503 → 같은 이름의 다른 가수 곡 "Orion / Glenn Hughes"가 선택됨,
    //        "死神(사신) / 아라하시 타비 Cover" 검색이 모두 503 → 가사가 있는데도 "가사 없음")
    //   위젯의 마지막 시도(final)에서는 더 미루지 않고 남은 방법까지 씀
    if (searchFailed && !req.query.final) {
        console.log(`[가사 검색] ⏳ lrclib 검색 일부 실패(서버 과부하) → 결과를 미루고 잠시 뒤 다시 시도 (${title})`);
        return res.json({ lyrics: null, source: null, retry: true });
    }

    if (fallbackMatch) {
        console.log(`[가사 검색] 📜 lrclib 가사 사용 - 가수 미확인 (${fallbackMatch.trackName} / ${fallbackMatch.artistName})`);
        return res.json({ lyrics: fallbackMatch.syncedLyrics, source: 'lrclib' });
    }
    if (lengthMismatch) {
        console.log(`[가사 검색] 📜 lrclib 가사 사용 - 곡 길이 다름 (${lengthMismatch.trackName} / ${lengthMismatch.artistName}, ${lengthMismatch.duration}s)`);
        return res.json({ lyrics: lengthMismatch.syncedLyrics, source: 'lrclib' });
    }
    if (otherLangMatch) {
        console.log(`[가사 검색] 📜 lrclib 가사 사용 - 한국어 가사 없음, 다른 언어 가사 (${otherLangMatch.trackName} / ${otherLangMatch.artistName})`);
        return res.json({ lyrics: otherLangMatch.syncedLyrics, source: 'lrclib' });
    }

    console.log(`[가사 검색] ❌ lrclib에서 가사를 찾지 못함 (검색어: ${[...tried].map(k => Object.values(JSON.parse(k)).join(' / ')).join(' | ')})`);

    // [마지막] 유튜브 자막: 지금 재생 중인 영상만 가능 (페이지의 플레이어가 자막을 불러와야 하므로)
    //   자막 언어는 제목 → 가수 이름의 언어 순으로 우선 (예: 제목이 일본어면 일본어 자막)
    if (videoId && playerState.videoId === videoId) {
        const langs = [...new Set([detectTextLang(title), detectTextLang(cleanArtist)].filter(Boolean))];
        // 공식 음원(자동 생성 음원 영상)은 자막이 없는 경우가 많으므로 같은 곡의 뮤직비디오도 후보로 전달
        const candidates = pageCaptions.has(videoId) ? [] : await findMusicVideoIds(cleanTitle, cleanArtist, videoId);
        const lyrics = await requestPageCaptions(videoId, langs, candidates);
        if (lyrics) return res.json({ lyrics, source: 'youtube' });
    }

    // [최후] 원곡 가수 다수결: 제목에 원곡 가수가 없고 커버라서 길이도 다른 경우 (예: "Alice in 冷凍庫" 라이브 커버 273초 ↔ 원곡 342초)
    //   원제로만 검색한 결과 중 곡명이 정확히 같은 싱크 가사가 2개 이상이고, 그 절반 이상이 같은 가수면 그 가수의 원곡으로 봄
    //   (커버는 전주 길이 등이 달라 싱크가 어긋날 수 있음 → ↑/↓ 키로 조절)
    {
        const sameTitle = exactTitlePool.filter(r => r.syncedLyrics && original.tracks.some(t => normalize(t) === normalize(r.trackName))
            && (!titleExpect || lyricsLangIs(r.syncedLyrics, titleExpect))); // 일본어 제목이면 일본어 가사만 (로마자 표기 제외)
        // 가수 칸의 이름들 (예: "めありー/Orangestar", "Orangestar feat.IA" → 각각의 이름)
        const artistNames = (r) => [...new Set((r.artistName || '').split(/\s*[\/&,、]\s*|\s*\b(?:feat|ft)\.?\s*/i).map(normalize).filter(Boolean))];
        // 결과마다 등장한 이름을 세어 가장 많이 나온 이름을 원곡 가수로 봄
        const counts = new Map();
        for (const r of sameTitle) for (const n of artistNames(r)) counts.set(n, (counts.get(n) || 0) + 1);
        const [topArtist, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
        if (topArtist && sameTitle.length >= 2 && topCount * 2 >= sameTitle.length) {
            // 그 가수가 첫 번째 이름인 결과(원곡) 우선, 그다음 재생 중인 곡과 길이가 가까운 순
            const pick = sameTitle.filter(r => artistNames(r).includes(topArtist))
                .sort((a, b) => (artistNames(b)[0] === topArtist) - (artistNames(a)[0] === topArtist) || byDuration(a, b))[0];
            console.log(`[가사 검색] 📜 lrclib 가사 사용 - 원곡 가수 추정(${topCount}/${sameTitle.length}건) (${pick.trackName} / ${pick.artistName}, ${pick.duration}s)`);
            return res.json({ lyrics: pick.syncedLyrics, source: 'lrclib' });
        }
    }

    res.json({ lyrics: null, source: null });
});

// ─── 가사 번역 (외국어 가사 → 한국어, 구글 번역) ─────────────
// 키가 필요 없는 구글 번역 주소 사용. 줄마다 따로 넣어 보내면 줄 순서대로 [번역, 감지 언어]를 돌려줌
const GOOGLE_TRANSLATE_URL = 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=ko';
const TRANSLATE_CHUNK_LINES = 100; // 한 번에 보내는 줄 수 (요청이 너무 커지지 않게)
const translationCache = new Map(); // 가사 전체 → 결과 (다음 곡 미리 번역 / 다시 켜기)

const HAS_LETTER = /\p{L}/u;
// 글자가 있는 줄 중 30% 이상에 한글이 있으면 한국어 가사로 보고 번역하지 않음 (renderer/app.js의 isKoreanLyrics와 같은 기준)
//   글자 수로 세면 영어가 많이 섞인 K-pop(예: Fantastic Baby)은 한글 비율이 낮게 나와 번역 대상이 되던 문제
const isKoreanLyrics = (lines) => {
    const withLetters = lines.filter(l => HAS_LETTER.test(l));
    return withLetters.length > 0 && withLetters.filter(l => /[가-힣]/.test(l)).length / withLetters.length >= 0.3;
};

// 1순위: 구글 번역 gtx 주소. 여러 줄을 줄바꿈으로 이어 한 번에 보내고, 돌아온 번역을 다시 줄바꿈으로 나눔
//   (2026-11 기준 아래 clients5 주소가 대부분의 줄에 빈 번역("")을 돌려주게 됨)
const GOOGLE_GTX_URL = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ko&dt=t';
const GTX_CHUNK_CHARS = 1800; // 한 요청에 보내는 글자 수 (너무 길면 거절될 수 있어 나눔)
const HANGUL_ONLY = (line) => /[가-힣]/.test(line) && !/[ぁ-ゟァ-ヿ一-龥]/.test(line);

async function gtxTranslateChunk(lines) {
    const body = new URLSearchParams({ q: lines.join('\n') });
    const { data } = await axios.post(GOOGLE_GTX_URL, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        timeout: 10000,
    });
    // data[0] = [[번역, 원문, ...], ...] (문장 단위로 나뉘어 오므로 이어 붙인 뒤 줄바꿈으로 다시 나눔), data[2] = 감지한 언어
    const text = (Array.isArray(data?.[0]) ? data[0] : []).map(seg => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : '')).join('');
    const parts = text.split('\n');
    if (parts.length !== lines.length) throw new Error(`gtx line mismatch ${parts.length}/${lines.length}`);
    const lang = typeof data?.[2] === 'string' ? data[2] : '';
    // 한 덩어리의 언어만 알려 주므로, 한글만 있는 줄은 한국어 줄로 봄 (번역 줄을 붙이지 않게)
    return parts.map((tr, i) => ({ tr: tr.trim(), lang: HANGUL_ONLY(lines[i]) ? 'ko' : lang }));
}

// 2순위: 예전 주소 (q를 줄마다 따로 보냄)
async function clients5TranslateChunk(lines) {
    const body = new URLSearchParams();
    lines.forEach(line => body.append('q', line));
    const { data } = await axios.post(GOOGLE_TRANSLATE_URL, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        timeout: 10000,
    });
    // 한 줄만 보내면 [번역, 언어] 하나만 올 수 있어 배열로 맞춤
    const items = typeof data?.[0] === 'string' ? [data] : data;
    return lines.map((_, i) => {
        const item = items?.[i];
        return Array.isArray(item) ? { tr: item[0] || '', lang: item[1] || '' } : { tr: String(item || ''), lang: '' };
    });
}

const googleTranslateChunk = (lines) => gtxTranslateChunk(lines).catch(e => {
    console.log(`[가사 번역] gtx 실패 → 예전 주소로: ${e.response?.status || e.message}`);
    return clients5TranslateChunk(lines);
});

// 줄을 글자 수 기준으로 나눔 (줄바꿈으로 이어 보내므로)
function chunkLines(items, lengthOf = (line) => line.length) {
    const chunks = [];
    let cur = [], size = 0;
    for (const line of items) {
        if (cur.length && (size + lengthOf(line) + 1 > GTX_CHUNK_CHARS || cur.length >= TRANSLATE_CHUNK_LINES)) { chunks.push(cur); cur = []; size = 0; }
        cur.push(line);
        size += lengthOf(line) + 1;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
}

// 구글이 가끔 오류 대신 빈 번역("")을 돌려줌 → 빈 줄만 모아 잠시 뒤 다시 요청 (최대 2번).
//   그래도 빈 줄은 missing으로 알려 결과를 저장하지 않게 함
const GOOGLE_RETRY_DELAYS_MS = [400, 1200];
async function googleTranslateLines(lines) {
    // 줄바꿈으로 이어 보내므로 줄 안의 줄바꿈은 공백으로
    lines = lines.map(l => l.replace(/\s*\n\s*/g, ' '));
    const out = [];
    for (const chunk of chunkLines(lines)) out.push(...await googleTranslateChunk(chunk));
    for (const delay of GOOGLE_RETRY_DELAYS_MS) {
        const empty = out.map((r, i) => (r.tr.trim() ? -1 : i)).filter(i => i >= 0);
        if (empty.length === 0) break;
        await new Promise(r => setTimeout(r, delay));
        for (const chunk of chunkLines(empty, (i) => lines[i].length)) {
            const again = await googleTranslateChunk(chunk.map(i => lines[i])).catch(() => null);
            again?.forEach((r, k) => { if (r.tr.trim()) out[chunk[k]] = r; });
        }
    }
    out.missing = out.filter(r => !r.tr.trim()).length;
    return out;
}

// ─── 번역한 곡 저장 (앱을 다시 켜도 그대로) ─────────────────
// 한 번 번역한 곡은 이 컴퓨터의 앱 데이터 폴더(translations.json)에 저장해 두고, 같은 가사면 다시 번역하지 않고 바로 씀
//   (Azure 무료 한도를 아끼고 기다림이 없음). 가사 내용이 같으면 같은 곡으로 봄
//   엔진별로 따로 저장: Azure 번역이 있으면 그것을 먼저 쓰고, 구글 번역은 Azure 키가 없을 때만 씀
//   최대 TRANSLATION_STORE_MAX곡. 넘치면 가장 오래 안 쓴 곡부터 지움
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TRANSLATION_STORE_MAX = 3000;
const translationStoreFile = path.join(process.env.LINEA_DATA_DIR || path.join(require('os').homedir(), '.linea'), 'translations.json');
const translationStore = new Map(); // `${engine}:${가사 해시}` → { translations, title, artist, usedAt }
try {
    const saved = JSON.parse(fs.readFileSync(translationStoreFile, 'utf8'));
    for (const [k, v] of saved.items || []) translationStore.set(k, v);
    console.log(`[가사 번역] 저장된 번역 ${translationStore.size}곡 불러옴`);
} catch (e) { /* 처음 실행이면 파일이 없음 */ }
let translationStoreTimer = null;
function saveTranslationStore() {
    clearTimeout(translationStoreTimer);
    translationStoreTimer = setTimeout(writeTranslationStore, 1000);
}
// 저장을 기다리는 중에 앱이 꺼지면 바로 씀
process.on('exit', () => { if (translationStoreTimer) writeTranslationStore(); });
function writeTranslationStore() {
    translationStoreTimer = null;
    try {
        if (translationStore.size > TRANSLATION_STORE_MAX) {
            const oldest = [...translationStore.entries()].sort((x, y) => (x[1].usedAt || 0) - (y[1].usedAt || 0));
            for (const [k] of oldest.slice(0, translationStore.size - TRANSLATION_STORE_MAX)) translationStore.delete(k);
        }
        fs.mkdirSync(path.dirname(translationStoreFile), { recursive: true });
        const tmp = `${translationStoreFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: [...translationStore.entries()] }));
        fs.renameSync(tmp, translationStoreFile); // 쓰는 도중 앱이 꺼져도 이전 파일이 깨지지 않게
    } catch (e) { console.log(`[가사 번역] 번역 저장 실패: ${e.message}`); }
}
const lyricsHash = (text) => crypto.createHash('sha1').update(text).digest('hex');
function getStoredTranslation(text, hasAzureKey) {
    const h = lyricsHash(text);
    for (const engine of hasAzureKey ? ['azure'] : ['azure', 'google']) {
        const item = translationStore.get(`${engine}:${h}`);
        if (item) { item.usedAt = Date.now(); saveTranslationStore(); return { translations: item.translations, engine }; }
    }
    return null;
}
function storeTranslation(text, engine, translations, title, artist) {
    translationStore.set(`${engine}:${lyricsHash(text)}`, { translations, title: title || '', artist: artist || '', usedAt: Date.now() });
    saveTranslationStore();
}

// ─── Azure 번역 (키가 있으면 구글 번역 대신) ─────────────────
// 무료(F0) 요금제는 매월 200만 자 (가사 한 곡 약 1,500~2,500자). 한 번 번역한 곡은 위에서 저장해 두므로 다시 세지 않음
//   문맥: 곡 가사 전체를 줄바꿈으로 이은 글 하나로 보내, 앞뒤 줄을 보고 번역하게 함 (말투·대명사·반복구가 곡 안에서 맞음)
//     돌아온 번역을 줄바꿈으로 다시 나눔. 줄 수가 어긋나면(두 줄을 한 줄로 합치는 등) 줄마다 따로 번역해 다시 받음
//   키: 설정 창에 저장한 키 > 실행 시 환경 변수 > 셸 설정(~/.zshrc)의 AZURE_TRANSLATOR_KEY / AZURE_TRANSLATOR_REGION
//     지역(region)은 Azure에서 번역 리소스를 만들 때 고른 곳 (예: koreacentral). 전역(global) 리소스면 비워 둠
//   실패하면(401 키·지역 오류, 403 이번 달 한도 초과, 429 요청 많음 등) 구글 번역으로
//   Azure는 키로 사용량을 알려 주지 않아, 이 앱이 보낸 글자 수를 달마다 세어 설정 창에 보여 줌 (azure-usage.json)
const { execFile } = require('child_process');
const AZURE_ENDPOINT = 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=ko';
const AZURE_FREE_LIMIT = 2000000;
const AZURE_KEY_RE = /^[0-9A-Za-z]{32,100}$/;
const AZURE_REGION_RE = /^[a-z0-9]{2,40}$/;
let azureShellPromise = null;
function getAzureCreds() {
    const key = process.env.AZURE_TRANSLATOR_KEY || '';
    if (key) return Promise.resolve({ key, region: process.env.AZURE_TRANSLATOR_REGION || '' });
    if (!azureShellPromise) {
        azureShellPromise = new Promise(resolve => {
            if (process.platform === 'win32') return resolve(null);
            execFile(process.env.SHELL || '/bin/zsh', ['-ic', 'printf "%s\\n%s\\n" "$AZURE_TRANSLATOR_KEY" "$AZURE_TRANSLATOR_REGION"'], { timeout: 5000 }, (err, stdout) => {
                const [k = '', r = ''] = String(stdout || '').trim().split('\n').slice(-2).map(s => s.trim());
                resolve(AZURE_KEY_RE.test(k) ? { key: k, region: AZURE_REGION_RE.test(r) ? r : '' } : null);
            });
        });
    }
    return azureShellPromise;
}

// 이번 달 보낸 글자 수 (Azure가 세는 방식처럼 공백·줄바꿈 포함 글자 수)
const azureUsageFile = path.join(path.dirname(translationStoreFile), 'azure-usage.json');
const thisMonth = () => new Date().toISOString().slice(0, 7); // Azure는 UTC 기준 달마다 초기화
let azureUsage = { month: thisMonth(), chars: 0, songs: 0, songChars: 0, quotaExceeded: false };
try { azureUsage = { ...azureUsage, ...JSON.parse(fs.readFileSync(azureUsageFile, 'utf8')) }; } catch (e) { }
let azureLastError = null; // 'auth' | 'quota' | null — 설정 창 안내용
function currentAzureUsage() {
    if (azureUsage.month !== thisMonth()) azureUsage = { month: thisMonth(), chars: 0, songs: 0, songChars: 0, quotaExceeded: false };
    return azureUsage;
}
// song: 곡 하나를 다 번역했을 때 그 곡에 쓴 글자 수 (남은 곡 수를 실제 평균으로 계산하려고)
function addAzureUsage(chars, quotaExceeded, song) {
    const u = currentAzureUsage();
    u.chars += chars;
    if (quotaExceeded) u.quotaExceeded = true;
    if (song) { u.songs = (u.songs || 0) + 1; u.songChars = (u.songChars || 0) + song; }
    try {
        fs.mkdirSync(path.dirname(azureUsageFile), { recursive: true });
        fs.writeFileSync(azureUsageFile, JSON.stringify(u));
    } catch (e) { }
}

async function azureRequest(creds, texts) {
    const headers = { 'Ocp-Apim-Subscription-Key': creds.key, 'Content-Type': 'application/json' };
    if (creds.region) headers['Ocp-Apim-Subscription-Region'] = creds.region;
    try {
        const { data } = await axios.post(AZURE_ENDPOINT, texts.map(Text => ({ Text })), { headers, timeout: 15000 });
        addAzureUsage(texts.reduce((n, t) => n + [...t].length, 0));
        azureLastError = null;
        if (!Array.isArray(data) || data.length !== texts.length) throw new Error(`azure count ${data?.length}/${texts.length}`);
        return data.map(d => String(d?.translations?.[0]?.text || ''));
    } catch (e) {
        const status = e.response?.status;
        const code = e.response?.data?.error?.code;
        if (status === 401) azureLastError = 'auth';
        if (status === 403) { azureLastError = 'quota'; if (code === 403001 || code === 403000) addAzureUsage(0, true); }
        throw e;
    }
}

// 줄 목록 → [{ tr, lang }] (구글 번역 함수와 같은 모양)
async function azureTranslateLines(creds, lines) {
    // 1) 곡 전체를 한 글로: 앞뒤 문맥을 보고 번역
    const whole = (await azureRequest(creds, [lines.join('\n')]))[0];
    const split = whole.split(/\r?\n/);
    if (split.length === lines.length) return { results: split.map(tr => ({ tr, lang: '' })), mode: '문맥' };
    // 2) 줄 수가 어긋나면 줄마다 따로 (한 번에 최대 1000줄)
    console.log(`[가사 번역] Azure 문맥 번역 줄 수가 어긋남 (${split.length}/${lines.length}) → 줄별로 다시`);
    const out = [];
    for (let i = 0; i < lines.length; i += 1000) out.push(...await azureRequest(creds, lines.slice(i, i + 1000)));
    return { results: out.map(tr => ({ tr, lang: '' })), mode: '줄별' };
}

// Azure 이번 달 사용량 (설정 창에 표시). 키가 없으면 { set: false }
//   ?check=1: 짧은 글자(2자)를 번역해 키·지역이 맞는지 확인 (키를 저장했을 때)
app.get('/azure-usage', async (req, res) => {
    const creds = await getAzureCreds();
    if (!creds) return res.json({ set: false });
    if (req.query.check) { try { await azureRequest(creds, ['Hi']); } catch (e) { if (!azureLastError) azureLastError = 'failed'; } }
    const u = currentAzureUsage();
    // 한 곡 평균 글자 수: 이번 달 3곡 이상 번역했으면 실제 평균, 아니면 1,000자로 어림
    const perSong = u.songs >= 3 ? Math.max(100, Math.round(u.songChars / u.songs)) : 1000;
    res.json({ set: true, count: u.chars, limit: AZURE_FREE_LIMIT, perSong, measured: u.songs >= 3, error: u.quotaExceeded ? 'quota' : azureLastError });
});

app.post('/translate', async (req, res) => {
    const lines = Array.isArray(req.body?.lines) ? req.body.lines.map(l => String(l ?? '')) : [];
    if (lines.length === 0) return res.json({ translations: [] });
    const cacheKey = lines.join('\n');
    if (isKoreanLyrics(lines)) return res.json({ skip: true });
    // Azure 키가 있으면 Azure 결과를 따로 저장 (키를 나중에 넣어도 구글 결과가 남아 있지 않게)
    const creds = await getAzureCreds();
    const engineCacheKey = (creds ? 'azure\n' : '') + cacheKey;
    if (translationCache.has(engineCacheKey)) return res.json(translationCache.get(engineCacheKey));
    const stored = getStoredTranslation(cacheKey, !!creds);
    if (stored) {
        const body = { translations: stored.translations };
        cacheSet(translationCache, engineCacheKey, body);
        console.log(`[가사 번역] 💾 저장된 ${stored.engine === 'azure' ? 'Azure ' : ''}번역 사용: ${req.body.title || ''}`);
        return res.json(body);
    }

    // 글자가 있는 줄만, 같은 줄은 한 번만 번역 (♪, 빈 줄, 반복되는 후렴 등)
    const unique = [...new Set(lines.filter(l => HAS_LETTER.test(l)))];
    try {
        const t0 = Date.now();
        let results = null, engine = 'google', mode = '';
        // 이번 달 한도를 이미 다 쓴 걸 알면 Azure에 보내지 않음 (다음 달에 다시)
        if (creds && !currentAzureUsage().quotaExceeded) {
            try {
                const before = currentAzureUsage().chars;
                ({ results, mode } = await azureTranslateLines(creds, unique));
                addAzureUsage(0, false, currentAzureUsage().chars - before);
                results.missing = results.filter(r => !r.tr.trim()).length;
                engine = 'azure';
            } catch (e) {
                const status = e.response?.status;
                const why = status === 403 ? '이번 달 무료 한도 초과' : status === 401 ? '키·지역 오류' : status === 429 ? '요청이 많음' : (status || e.message);
                console.log(`[가사 번역] Azure 실패 (${why}) → 구글 번역으로`);
            }
        }
        if (!results) results = await googleTranslateLines(unique);
        const byLine = new Map(unique.map((line, i) => [line, results[i]]));
        const translations = lines.map(line => {
            const r = byLine.get(line);
            // 한국어 줄이거나 번역해도 그대로인 줄(고유명사 등)은 번역 줄을 붙이지 않음
            return r && r.lang !== 'ko' && r.tr.trim() && r.tr.trim() !== line.trim() ? r.tr.trim() : '';
        });
        // 다시 요청해도 절반 넘게 비면 실패로 알림 (위젯이 "잠시 후 다시" 안내). 일부만 비면 있는 만큼 보여 주되 저장하지 않음 (다음에 다시 받게)
        if (results.missing > unique.length / 2) {
            console.log(`[가사 번역] 실패: ${engine === 'azure' ? 'Azure' : '구글'}가 빈 번역을 돌려줌 (${results.missing}/${unique.length}줄)`);
            return res.json({ error: 'failed' });
        }
        const body = { translations };
        // Azure가 실패해 구글로 받은 결과는 저장하지 않음 (다음에 Azure로 다시 받게)
        if (results.missing === 0 && (engine === 'azure' || !creds)) cacheSet(translationCache, engineCacheKey, body);
        if (results.missing === 0) storeTranslation(cacheKey, engine, translations, req.body.title, req.body.artist);
        console.log(`[가사 번역] ✅ ${engine === 'azure' ? `Azure(${mode}) ` : ''}${req.body.prefetch ? '⏭️ 다음 곡 ' : ''}${req.body.title || ''} ${unique.length}줄 ${Date.now() - t0}ms${results.missing ? ` (빈 번역 ${results.missing}줄)` : ''}`);
        res.json(body);
    } catch (e) {
        console.log(`[가사 번역] 실패: ${e.response?.status || e.message}`);
        res.json({ error: e.response?.status === 429 ? 'rate_limited' : 'failed' });
    }
});

// ─── 오디오 비주얼라이저 릴레이 ───────────────────────────
const wss = new WebSocket.Server({ port: WS_PORT, host: '127.0.0.1' }); // 이 컴퓨터 안에서만 접속 (브라우저 → 위젯)

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'register_renderer') {
                rendererSockets.add(ws);
            } else if (data.type === 'eq_data') {
                const text = JSON.stringify(data);
                for (const socket of rendererSockets) if (socket.readyState === WebSocket.OPEN) socket.send(text);
            }
        } catch (e) { }
    });
    ws.on('close', () => rendererSockets.delete(ws));
});

app.listen(PORT, '127.0.0.1', () => {
    console.log(`[HTTP] 통합 서버 실행 중: http://127.0.0.1:${PORT}`);
    console.log(`[ WS ] WebSocket 실행 중: ws://127.0.0.1:${WS_PORT}`);
});