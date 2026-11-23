// 정보: version, the newest release, the licenses. (The credits and the sizes of the parts of 2.0 come later, with the plugin list.)
import { tr } from '../core/i18n.js';
import { files } from '../fs.js';
import * as version from '../core/version.js';
import * as updatecheck from '../core/updatecheck.js';

const { emit, listen } = window.__TAURI__.event;
const invoke = window.__TAURI__.core.invoke;

// ---- the licenses: who made what this program is built from, and the full texts (they are files of the release: LICENSE and THIRD-PARTY-NOTICES.txt in the program folder)
const TECH = [
  ['ChatMatrix Reader', 'MIT · Copyright (c) 2026 Eternalguard'],
  ['Tauri (창, 웹뷰, 프로그램의 껍데기)', 'MIT / Apache-2.0 · https://tauri.app'],
  ['whisper.cpp (음성인식 엔진의 바탕)', 'MIT · https://github.com/ggml-org/whisper.cpp'],
  ['OpenAI Whisper (음성인식 모델)', 'MIT · https://github.com/openai/whisper'],
  ['그 밖의 Rust 라이브러리 약 300개', 'MIT, Apache-2.0, BSD, ISC, Zlib, MPL-2.0 등 · 전체 목록은 아래 버튼'],
];
function licensesRow() {
  const wrap = document.createElement('div'); wrap.className = 'licenses';
  const list = document.createElement('div'); list.className = 'lictech';
  for (const [what, lic] of TECH) {
    const line = document.createElement('div');
    const b = document.createElement('b'); b.textContent = tr(what);
    const s = document.createElement('small'); s.className = 'note'; s.textContent = tr(lic);
    line.append(b, document.createElement('br'), s); list.append(line);
  }
  const btns = document.createElement('div'); btns.className = 'vbench';
  const view = document.createElement('textarea'); view.className = 'licview'; view.readOnly = true; view.rows = 14; view.hidden = true; view.spellcheck = false;
  const msg = document.createElement('small'); msg.className = 'note';
  const show = (file, label) => {
    const b = Object.assign(document.createElement('button'), { className: 'btn small', textContent: tr(label) });
    b.onclick = async () => {
      let text = null;
      try { text = await files.read(file); } catch { /* none */ }
      view.hidden = !text; msg.textContent = text ? '' : tr('{file} 파일이 프로그램 폴더에 없습니다 (릴리즈 압축에 들어 있습니다).', { file });
      if (text) { view.value = text; view.scrollTop = 0; }
    };
    btns.append(b);
  };
  show('LICENSE', 'LICENSE 보기 (이 프로그램)');
  show('THIRD-PARTY-NOTICES.txt', '라이브러리 전체 목록과 라이선스 보기');
  wrap.append(list, btns, msg, view);
  return wrap;
}

export default {
  id: 'about', title: '정보', subtitle: '버전, 업데이트, 라이선스',
  cards: [
    { title: '업데이트', rows: [
      { key: 'check_updates', type: 'check', label: '새 버전 확인', keywords: '업데이트 릴리스 github',
        note: '새 버전이 있으면 창에 알려 줄 뿐, 자동으로 설치하지 않습니다. 확인은 GitHub의 공개 릴리스 정보 한 번을 읽는 것이 전부입니다.' },
    ] },
    { title: '사용한 기술과 라이선스', note: '이 프로그램은 MIT 라이선스이고, 아래 기술을 바탕으로 만들었습니다. 음성인식 엔진과 모델을 받는 곳은 음성인식 탭의 "받는 곳과 라이선스"에도 있습니다.', rows: [
      { type: 'custom', block: true, label: '라이선스', keywords: '라이선스 license mit 저작권 오픈소스 기술 라이브러리 tauri whisper notices', build: licensesRow },
    ] },
  ],

  // the top block: version and the newest release
  toolbar() {
    const el = document.createElement('section'); el.className = 'card aboutcard';
    el.innerHTML = '<h3>프로그램</h3><div class="aboutgrid"><span>현재 버전</span><b class="cur"></b><span></span>'
      + '<span>최신 버전</span><span class="latest"></span><span class="btns"></span><span>프로그램 폴더</span><span class="dir"></span><span></span></div>';
    const cur = el.querySelector('.cur'), latest = el.querySelector('.latest'), btns = el.querySelector('.btns'), dir = el.querySelector('.dir');
    cur.textContent = 'v' + version.DISPLAY;
    const check = Object.assign(document.createElement('button'), { textContent: '업데이트 확인' });
    const open = Object.assign(document.createElement('button'), { textContent: '릴리스 페이지 열기' });
    btns.append(check, open);
    let info = { tag: '', err: '', checking: false };
    check.onclick = () => emit('update-check', {});
    open.onclick = () => invoke('open_url', { url: version.RELEASES_URL }).catch(() => {});
    listen('update-info', ev => { info = ev.payload; refresh(); });
    emit('update-hello', {});
    invoke('app_folder').then(p => { dir.textContent = p; }).catch(() => {});
    function refresh() {
      check.disabled = info.checking;
      latest.className = 'latest';
      if (info.checking) latest.textContent = '확인 중...';
      else if (info.err) latest.textContent = tr('확인하지 못했습니다 ({err})', { err: info.err });
      else if (!info.tag) latest.textContent = '아직 확인하지 않았습니다';
      else if (updatecheck.isNewer(info.tag, version.VERSION)) { latest.textContent = tr('{tag} - 새 버전이 있습니다', { tag: info.tag }); latest.classList.add('newer'); }
      else latest.textContent = tr('{tag} - 최신입니다', { tag: info.tag });
    }
    refresh();
    return { el, refresh };
  },
};
