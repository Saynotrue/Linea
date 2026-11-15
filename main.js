const { app, BrowserWindow, screen, Tray, Menu, nativeImage, nativeTheme, globalShortcut, ipcMain, powerSaveBlocker, safeStorage, session, webFrameMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ─── 앱 데이터 폴더 ─────────────────────
// 앱 이름을 Linea로 바꾸기 전에 쓰던 데이터 폴더(설정, NVIDIA 키 파일)가 있으면 그 폴더를 계속 사용
// (app.getPath('userData')를 처음 쓰기 전에 정해야 하므로 맨 위에서 처리)
// Electron이 시작할 때 새 폴더를 먼저 만들어 두므로, 폴더가 있는지가 아니라 실제 데이터가 있는지로 판단
{
    const appData = app.getPath('appData');
    const hasData = (dir) => ['Local Storage', 'nvidia-key.bin', 'Partitions'].some(f => fs.existsSync(path.join(dir, f)));
    if (!hasData(app.getPath('userData'))) {
        const legacyDir = ['music-lyrics-widget', 'Music Lyrics Widget'].map(n => path.join(appData, n)).find(hasData);
        if (legacyDir) app.setPath('userData', legacyDir);
    }
}

// ─── NVIDIA API 키 (AI 가사 번역용) ─────────────────────
// 설정 창에서 입력한 키를 이 컴퓨터의 앱 데이터 폴더에 암호화해 저장 (macOS 키체인 / Windows DPAPI)
// 서버(server.js)는 같은 프로세스에서 process.env.NVIDIA_API_KEY를 읽음. 설정 키 > 실행 시 환경 변수 > 셸 설정(~/.zshrc) 순
const launchEnvNvidiaKey = process.env.NVIDIA_API_KEY || '';
let savedNvidiaKey = '';
const nvidiaKeyFile = () => path.join(app.getPath('userData'), 'nvidia-key.bin');

function applyNvidiaKey() {
    const key = savedNvidiaKey || launchEnvNvidiaKey;
    if (key) process.env.NVIDIA_API_KEY = key;
    else delete process.env.NVIDIA_API_KEY;
}

function loadNvidiaKey() {
    try {
        const buf = fs.readFileSync(nvidiaKeyFile());
        savedNvidiaKey = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    } catch (e) { savedNvidiaKey = ''; }
    applyNvidiaKey();
}

// 화면에는 앞 6자(nvapi-)와 끝 4자만 보여줌
function nvidiaKeyStatus() {
    const mask = (k) => `${k.slice(0, 6)}••••${k.slice(-4)}`;
    if (savedNvidiaKey) return { set: true, source: 'settings', masked: mask(savedNvidiaKey) };
    if (launchEnvNvidiaKey) return { set: true, source: 'env', masked: mask(launchEnvNvidiaKey) };
    return { set: false };
}

ipcMain.handle('get-nvidia-key-status', () => nvidiaKeyStatus());

ipcMain.handle('set-nvidia-key', (event, input) => {
    const key = String(input || '').trim();
    if (key && !/^nvapi-[\w-]{20,}$/.test(key)) return { ...nvidiaKeyStatus(), error: 'format' };
    try {
        if (key) {
            const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key, 'utf8');
            fs.mkdirSync(path.dirname(nvidiaKeyFile()), { recursive: true });
            fs.writeFileSync(nvidiaKeyFile(), data, { mode: 0o600 });
        } else {
            fs.rmSync(nvidiaKeyFile(), { force: true });
        }
        savedNvidiaKey = key;
        applyNvidiaKey();
        return nvidiaKeyStatus();
    } catch (e) {
        return { ...nvidiaKeyStatus(), error: 'save' };
    }
});

// ─── 전역 창 참조 및 상태 ────────────────────────────────
let win;
let tray = null;
let currentIconStyle = 'player';
let currentWidgetStyle = 'eq';

// ─── 2. 앱 실행 및 메인 윈도우 생성 ───────────────────────
app.whenReady().then(() => {
    // 저장해 둔 NVIDIA API 키를 서버가 읽을 수 있게 먼저 불러옴
    loadNvidiaKey();
    // 통합 서버 구동
    require('./server.js');

    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const barWidth = 700;
    const barHeight = 44;

    win = new BrowserWindow({
        width: barWidth,
        height: barHeight,
        x: Math.floor((width - barWidth) / 2),
        y: height - barHeight - 4,
        frame: false,
        transparent: true,
        alwaysOnTop: true, // 🚨 앱 켜질 때 기본 위젯 모드이므로 항상 위 활성화
        visibleOnAllWorkspaces: true,
        skipTaskbar: true,
        resizable: true,
        hasShadow: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false,
            webSecurity: false
        }
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    // 전체화면 앨범 아트 자리의 영상(서버의 /art-video 페이지 안 유튜브 플레이어)
    //   많은 공식 뮤직비디오가 알 수 없는 사이트(127.0.0.1)에서의 재생을 막아(오류 150), 이 페이지가 보내는 요청만
    //   유튜브 뮤직에서 연 것처럼 Referer를 바꿈 (위젯 창의 기본 세션만 해당. 다른 요청은 그대로)
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube.com/*'] }, (details, callback) => {
        const headers = { ...details.requestHeaders };
        const key = Object.keys(headers).find(k => k.toLowerCase() === 'referer');
        if (key && headers[key].startsWith('http://127.0.0.1:8888/')) headers[key] = 'https://music.youtube.com/';
        callback({ requestHeaders: headers });
    });

    // 앨범 아트 자리 영상: 유튜브 플레이어가 영상 위에 띄우는 제목·재생 버튼·공유·"동영상 더보기"·로고·추천 영상을 숨김
    //   (다른 출처 프레임이라 위젯 화면에서는 스타일을 바꿀 수 없어, 메인 프로세스가 그 프레임에 직접 스타일을 넣음)
    //   .ytPlayerControlsContainerHost: 지금 유튜브 임베드의 화면 조작 영역 전체, 나머지는 예전 플레이어 화면 요소
    const ART_VIDEO_HIDE_CSS = '.ytPlayerControlsContainerHost, .ytp-player-content, .ytp-caption-window-container, .ytp-chrome-top, .ytp-chrome-bottom, '
        + '.ytp-gradient-top, .ytp-gradient-bottom, .ytp-pause-overlay, .ytp-large-play-button, .ytp-bezel, .ytp-spinner, .ytp-watermark, '
        + '.ytp-ce-element, .ytp-cards-teaser, .ytp-paid-content-overlay, .iv-branding, .html5-endscreen, .ytp-endscreen-content, .ytp-contextmenu '
        + '{ display: none !important; }';
    win.webContents.on('did-frame-finish-load', (event, isMainFrame, frameProcessId, frameRoutingId) => {
        if (isMainFrame) return;
        const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
        // 영상 페이지(127.0.0.1:8888/art-video) 안의 유튜브 플레이어만
        if (!frame?.url.startsWith('https://www.youtube.com/embed/') || !frame.parent?.url.startsWith('http://127.0.0.1:8888/art-video')) return;
        // 영상 원본 크기도 알려 줌 (위젯이 영상 상자를 원본 비율로 맞춰 위아래·양옆 검은 띠를 없앰). 영상이 바뀌면 다시
        frame.executeJavaScript(`(() => {
            const s = document.createElement('style'); s.textContent = ${JSON.stringify(ART_VIDEO_HIDE_CSS)}; document.documentElement.appendChild(s);
            let last = '';
            setInterval(() => {
                const v = document.querySelector('video');
                if (!v || !v.videoWidth || !v.videoHeight) return;
                const key = v.videoWidth + 'x' + v.videoHeight;
                if (key === last) return;
                last = key;
                parent.postMessage({ artVideoSize: { width: v.videoWidth, height: v.videoHeight } }, '*');
            }, 500);
        })()`).catch(() => { });
    });

    win.loadFile('renderer/index.html');

    // F11 전체화면 버그 방지
    win.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F11') event.preventDefault();
    });

    // ─── 3. 트레이 아이콘 설정 (OS 맞춤형) ────────────────
    let trayIconPath;
    if (process.platform === 'win32') {
        trayIconPath = path.join(__dirname, 'tray', 'Windows', 'playerTemplate_white.png');
    } else {
        trayIconPath = path.join(__dirname, 'tray', 'macOS', 'playerTemplate.png');
    }

    const trayIcon = nativeImage.createFromPath(trayIconPath);
    if (process.platform === 'darwin') trayIcon.setTemplateImage(true);

    tray = new Tray(trayIcon);
    tray.setToolTip('Linea');

    function changeTrayIcon(style) {
        currentIconStyle = style;
        const iconName = style === 'player' ? 'playerTemplate' : 'spectrumTemplate';
        let newTrayIconPath;
        if (process.platform === 'win32') {
            newTrayIconPath = path.join(__dirname, 'tray', 'Windows', `${iconName}_white.png`);
        } else {
            newTrayIconPath = path.join(__dirname, 'tray', 'macOS', `${iconName}.png`);
        }
        const newTrayIcon = nativeImage.createFromPath(newTrayIconPath);
        if (process.platform === 'darwin') newTrayIcon.setTemplateImage(true);
        tray.setImage(newTrayIcon);
    }

    // 창 보이기/숨기기: 전체화면 창이 다른 창 뒤에 있으면(Alt+Tab으로 넘어간 경우) 숨기지 않고 앞으로 가져옴
    function isWindowShown() {
        // 종료 도중 창만 먼저 닫힌 경우(destroyed)에도 트레이 메뉴가 오류 없이 열리도록
        if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return false;
        return !isWindowFullScreen() || win.isFocused();
    }
    function bringWindowToFront() {
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    }
    function toggleWindow() {
        isWindowShown() ? win.hide() : bringWindowToFront();
    }

    // ─── 4. 동적 컨텍스트 메뉴 ────────────────────────────
    function getDynamicContextMenu() {
        const isWindowVisible = isWindowShown();
        return Menu.buildFromTemplate([
            {
                label: '설정',
                click: () => {
                    if (!win.isVisible()) win.show();
                    win.focus();
                    // 강제로 최상단으로 한 번 끌어올린 뒤, 설정창 조작을 위해 항상 위 해제
                    win.setAlwaysOnTop(true, 'screen-saver');
                    win.setAlwaysOnTop(false);

                    win.webContents.send('hide-widget-for-settings');
                    setTimeout(() => {
                        const { width, height } = screen.getPrimaryDisplay().workAreaSize;
                        win.setResizable(true);
                        win.setBounds({ x: 0, y: 0, width: width, height: height });
                        win.setResizable(false);
                        win.webContents.send('open-settings');
                    }, 300);
                },
            },
            { type: 'separator' },
            {
                label: isWindowVisible ? '숨기기' : '보이기',
                accelerator: 'CommandOrControl+Shift+Space',
                registerAccelerator: false,
                click: () => {
                    isWindowVisible ? win.hide() : bringWindowToFront();
                },
            },
            { type: 'separator' },
            {
                label: '종료',
                click: () => {
                    app.isQuiting = true;
                    app.quit();
                }
            }
        ]);
    }

    tray.on('click', () => {
        tray.popUpContextMenu(getDynamicContextMenu());
    });

    // ─── 5. 윈도우 모드 변경 (Bar / LP) ───────────────────
    function setWindowMode(mode) {
        currentWidgetStyle = mode;
        const currentScreen = screen.getPrimaryDisplay().workAreaSize;
        win.setResizable(true);
        if (mode === 'eq') {
            win.setSize(700, 44);
            win.setPosition(Math.floor((currentScreen.width - 700) / 2), currentScreen.height - 44 - 4);
            if (win && !win.isDestroyed()) win.webContents.send('change-style', 'eq');
        } else if (mode === 'lp') {
            win.setSize(320, 360);
            win.setPosition(Math.floor((currentScreen.width - 320) / 2), currentScreen.height - 360 - 20);
            if (win && !win.isDestroyed()) win.webContents.send('change-style', 'lp');
        }
        win.setResizable(false);
    }

    // ─── 6. IPC 통신 (설정 및 창 제어) ────────────────────
    ipcMain.on('update-system-settings', (event, settings) => {
        // 🚨 설정 창에서 변경사항이 들어오더라도 항상 위 여부를 변경하지 않음 (설정창/전체화면 간섭 방지)

        if (settings.globalShortcut) {
            if (!globalShortcut.isRegistered('CommandOrControl+Shift+Space')) {
                globalShortcut.register('CommandOrControl+Shift+Space', toggleWindow);
            }
        } else {
            globalShortcut.unregister('CommandOrControl+Shift+Space');
        }
        changeTrayIcon(settings.trayIcon);
        currentWidgetStyle = settings.widgetStyle;
    });

    ipcMain.on('close-settings', () => {
        setWindowMode(currentWidgetStyle);
        // 🚨 설정 창이 닫히고 위젯 모드로 돌아오면 무조건 항상 위(Always On Top) 활성화
        if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver');
        win.webContents.send('show-widget-after-settings');
    });

    win.setResizable(false);
});

// ─── 전체 화면 제어 통신 ────────────────────────────────
// 🚨 macOS는 '단순 전체화면'(simple fullscreen) 사용: 기본 전체화면은 노치 양옆(메뉴 막대 줄)을 검게 비워 두지만,
//    단순 전체화면은 메뉴 막대·Dock을 숨기고 그 줄까지 창을 늘려 화면 전체를 채움 (별도 데스크탑 공간도 만들지 않음)
const USE_SIMPLE_FULLSCREEN = process.platform === 'darwin';

function isWindowFullScreen() {
    return USE_SIMPLE_FULLSCREEN ? win.isSimpleFullScreen() : win.isFullScreen();
}

function setWindowFullScreen(on) {
    if (!USE_SIMPLE_FULLSCREEN) return win.setFullScreen(on);
    // 크기 고정(resizable: false) 상태에서는 창 크기를 바꾸지 못할 수 있으므로 전환하는 동안만 풀어 둠
    win.setResizable(true);
    win.setSimpleFullScreen(on);
    win.setResizable(false);
}

ipcMain.on('toggle-fullscreen', (event, isFullscreen) => {
    // 🚨 포커스 된 창을 찾는 방식에서 전역 상태인 win을 직접 참조하도록 안정성 강화
    if (!win || win.isDestroyed()) return;

    // 🚨 위젯 바는 작업 표시줄/Alt+Tab 목록에서 숨기지만(skipTaskbar), 전체화면일 때는 일반 창처럼 표시해야
    //    Windows에서 Alt+Tab으로 다른 창에 갔다가 다시 돌아올 수 있음
    if (isFullscreen) {
        // 🚨 전체화면 켜기: 항상 위 옵션을 강제로 해제하고 꽉 채움
        win.setAlwaysOnTop(false);
        win.setSkipTaskbar(false);
        setWindowFullScreen(true);
    } else {
        // 🚨 전체화면 끄기: 전체화면을 풀고 무조건 항상 위 옵션 재활성화
        setWindowFullScreen(false);
        win.setSkipTaskbar(true);
        win.setAlwaysOnTop(true, 'screen-saver');
    }
});

// ─── 잠자기 방지 ─────────────────────────────────────────
// 음악이 재생 중일 때만 화면이 꺼지거나 잠자기(대기 모드)에 들어가지 않게 막음 (일시정지하면 다시 허용)
let sleepBlockerId = null;
ipcMain.on('playback-state', (event, playing) => {
    if (playing && sleepBlockerId === null) {
        sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    } else if (!playing && sleepBlockerId !== null) {
        powerSaveBlocker.stop(sleepBlockerId);
        sleepBlockerId = null;
    }
});

// ─── 앱 종료 관리 ─────────────────────────────────────────
app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', (e) => {
    e.preventDefault();
});