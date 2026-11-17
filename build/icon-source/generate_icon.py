# Linea 앱 아이콘 생성기 (벡터 SVG)
#   python3 generate_icon.py → 이 폴더에 mac.svg(macOS 둥근 사각형) · round.svg(원형: Windows · 웹) 생성
#   PNG(1024)는 SVG를 브라우저로 열어 저장하거나 Electron/rsvg 등으로 변환해 build/apple/macOS/app-icon.png, build/win_icon.png에 넣음
#   물결 모양은 STRANDS(진폭 · 위치 · 퍼짐 · 출렁임 횟수)로 조절
import math, sys, json
# 물결 가닥: 원 안쪽 왼쪽 끝(u=-1)에서 출발해 오른쪽 끝(u=1)으로. 가운데 쪽에서만 크게 출렁이고 양 끝에서 모임
STRANDS = [
    # (색, 진폭(음수면 아래로), 가장 크게 출렁이는 위치(-1~1), 퍼짐 폭, 출렁임 횟수) — 그리는 순서대로 (뒤에 그린 가닥이 위로 지나감)
    ('green',  0.62, -0.52, 0.60, 0.95),
    ('blue',   0.58,  0.54, 0.60, 0.95),
    ('purple', -0.70, 0.12, 0.50, 0.85),
    ('pink',   0.82, -0.16, 0.48, 0.85),
]
CYCLES = 0.8  # 원 지름(-1~1) 1만큼 갈 때 출렁이는 횟수
COLORS = {'green': ('#46b072', '#2f8f5b'), 'pink': ('#f2687c', '#d9485f'), 'purple': ('#9b5bd0', '#7a3fb0'), 'blue': ('#6cb8ea', '#3f8fcf')}

def strand_path(cx, cy, R, amp, c, w, cycles, n=240):
    pts = []
    shift = c - 0.25 / cycles  # c에서 sin이 1(가장 높이)이 되도록
    for i in range(n + 1):
        u = -1 + 2 * i / n
        edge = (1 - u * u) ** 0.9                      # 양 끝(원 테두리)에서 0으로 모임
        env = math.exp(-((u - c) / w) ** 2)            # 이 가닥이 크게 출렁이는 구간
        y = amp * env * edge * math.sin(2 * math.pi * cycles * (u - shift))
        pts.append((cx + u * R, cy - y * R))
    # Catmull-Rom → 베지어 (부드러운 곡선)
    d = f"M{pts[0][0]:.2f},{pts[0][1]:.2f}"
    for i in range(len(pts) - 1):
        p0 = pts[max(0, i - 1)]; p1 = pts[i]; p2 = pts[i + 1]; p3 = pts[min(len(pts) - 1, i + 2)]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d += f" C{c1[0]:.2f},{c1[1]:.2f} {c2[0]:.2f},{c2[1]:.2f} {p2[0]:.2f},{p2[1]:.2f}"
    return d

def emblem(cx, cy, R, bg, stroke, ring_w, gap):
    """원 테두리 + 물결 네 가닥. 가닥마다 아래에 배경색 테를 깔아 엇갈리는 부분이 엮인 것처럼 보이게"""
    inner = R - ring_w * 0.5 - stroke * 0.15
    defs = [f'''<linearGradient id="ring" x1="{cx-R}" y1="{cy+R}" x2="{cx+R}" y2="{cy-R}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2f8f5b"/><stop offset="0.45" stop-color="#c8718f"/><stop offset="0.75" stop-color="#9b5bd0"/><stop offset="1" stop-color="#6c4bb8"/></linearGradient>''']
    body = [f'<circle cx="{cx}" cy="{cy}" r="{R}" fill="none" stroke="url(#ring)" stroke-width="{ring_w}"/>']
    for name, amp, c, w, cycles in STRANDS:
        d = strand_path(cx, cy, inner, amp, c, w, cycles)
        a, b = COLORS[name]
        defs.append(f'''<linearGradient id="g-{name}" x1="{cx-inner}" y1="0" x2="{cx+inner}" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{b}"/><stop offset="0.5" stop-color="{a}"/><stop offset="1" stop-color="{b}"/></linearGradient>''')
        body.append(f'<path d="{d}" fill="none" stroke="{bg}" stroke-width="{stroke + gap * 2}" stroke-linecap="round" stroke-linejoin="round"/>')
        body.append(f'<path d="{d}" fill="none" stroke="url(#g-{name})" stroke-width="{stroke}" stroke-linecap="round" stroke-linejoin="round"/>')
    return defs, body

def squircle(x, y, s, k=0.59):
    # 애플 아이콘 모양에 가까운 둥근 사각형 (연속 곡률 근사)
    r = s * 0.225
    c = r * (1 - k)
    return (f"M{x+r},{y} H{x+s-r} C{x+s-c},{y} {x+s},{y+c} {x+s},{y+r} V{y+s-r} C{x+s},{y+s-c} {x+s-c},{y+s} {x+s-r},{y+s} "
            f"H{x+r} C{x+c},{y+s} {x},{y+s-c} {x},{y+s-r} V{y+r} C{x},{y+c} {x+c},{y} {x+r},{y} Z")

def mac_icon():
    S = 1024; x0 = 100; s = 824  # 애플 macOS 아이콘 규격: 1024 캔버스에 824 몸통
    defs, body = emblem(512, 512, 300, '#ffffff', 30, 20, 8)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 {S} {S}">
  <defs>
    <linearGradient id="bgfill" x1="0" y1="{x0}" x2="0" y2="{x0+s}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eeedf3"/></linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity="0.22"/></filter>
    {''.join(defs)}
  </defs>
  <path d="{squircle(x0, x0, s)}" fill="url(#bgfill)" filter="url(#shadow)"/>
  <path d="{squircle(x0, x0, s)}" fill="none" stroke="#000" stroke-opacity="0.06" stroke-width="2"/>
  {''.join(body)}
</svg>'''

def round_icon(size=1024, bg='#ffffff'):
    # 윈도우 · 웹용: 흰 원 위에 문양 (바깥은 투명)
    defs, body = emblem(size / 2, size / 2, size * 0.42, bg, size * 0.04, size * 0.028, size * 0.011)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">
  <defs>{''.join(defs)}</defs>
  <circle cx="{size/2}" cy="{size/2}" r="{size*0.495}" fill="{bg}"/>
  {''.join(body)}
</svg>'''

open('mac.svg', 'w').write(mac_icon())
open('round.svg', 'w').write(round_icon())
print('ok')
