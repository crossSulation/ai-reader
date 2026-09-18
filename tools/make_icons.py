"""
生成扩展图标（纯标准库手写 PNG，不依赖 Pillow）。

图形：靛蓝→紫的圆角方块 + 白色对话气泡 + 三个点。
全部用几何数学逐像素绘制，4x4 超采样抗锯齿。
"""

import os
import struct
import zlib

C1 = (99, 102, 241)   # #6366f1
C2 = (139, 92, 246)   # #8b5cf6


def in_rrect(x, y, x0, y0, x1, y1, r):
    """点是否落在圆角矩形内（标准圆角矩形距离场判断）"""
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def _sign(p1, p2, p3):
    return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])


def in_triangle(px, py, a, b, c):
    p = (px, py)
    d1 = _sign(p, a, b)
    d2 = _sign(p, b, c)
    d3 = _sign(p, c, a)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def grad(t):
    """对角渐变取色"""
    return tuple(C1[i] + (C2[i] - C1[i]) * t for i in range(3))


def make_icon(size, path):
    S = 4                      # 每轴超采样数
    n = S * S
    radius = 0.235             # 外框圆角
    simple = size < 24         # 小尺寸简化，避免糊成一团

    if simple:
        bx0, by0, bx1, by1, br = 0.155, 0.215, 0.845, 0.70, 0.165
        tail = ((0.28, 0.63), (0.28, 0.82), (0.50, 0.675))
        dots = []
        dot_r = 0.0
    else:
        bx0, by0, bx1, by1, br = 0.175, 0.205, 0.825, 0.665, 0.155
        tail = ((0.285, 0.60), (0.285, 0.795), (0.475, 0.645))
        dot_r = 0.056
        dots = [(0.335, 0.435), (0.5, 0.435), (0.665, 0.435)]

    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r_acc = g_acc = b_acc = cov = 0.0
            for sy in range(S):
                for sx in range(S):
                    x = (px + (sx + 0.5) / S) / size
                    y = (py + (sy + 0.5) / S) / size
                    if not in_rrect(x, y, 0.0, 0.0, 1.0, 1.0, radius):
                        continue
                    t = (x + y) / 2.0
                    col = grad(t)

                    on_bubble = in_rrect(x, y, bx0, by0, bx1, by1, br) or in_triangle(x, y, *tail)
                    if on_bubble:
                        col = (255.0, 255.0, 255.0)
                        for dx_, dy_ in dots:
                            ddx, ddy = x - dx_, y - dy_
                            if ddx * ddx + ddy * ddy <= dot_r * dot_r:
                                col = grad(t)
                                break

                    r_acc += col[0]
                    g_acc += col[1]
                    b_acc += col[2]
                    cov += 1.0

            if cov <= 0:
                row += bytes((0, 0, 0, 0))
            else:
                alpha = cov / n
                row += bytes((
                    int(round(r_acc / cov)),
                    int(round(g_acc / cov)),
                    int(round(b_acc / cov)),
                    int(round(alpha * 255)),
                ))
        rows.append(bytes(row))

    raw = b''.join(b'\x00' + r for r in rows)
    write_png(path, size, size, raw)
    return path


def write_png(path, width, height, raw):
    def chunk(tag, data):
        return (
            struct.pack('>I', len(data)) + tag + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)  # 8bit RGBA
    png = (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', ihdr)
        + chunk(b'IDAT', zlib.compress(raw, 9))
        + chunk(b'IEND', b'')
    )
    with open(path, 'wb') as f:
        f.write(png)


if __name__ == '__main__':
    import sys

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    if '--store' in sys.argv:
        # 商店素材：Edge 要求一张 300×300 的商店 Logo；同一套几何绘制直接放大即可
        # （图标是矢量式绘制，放大到 300 依然锐利，不是位图拉伸）
        out_dir = os.path.join(root, 'store')
        os.makedirs(out_dir, exist_ok=True)
        p = make_icon(300, os.path.join(out_dir, 'logo-300.png'))
        print(f'{p}  {os.path.getsize(p)} bytes')
        sys.exit(0)

    out_dir = os.path.join(root, 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for s in (16, 32, 48, 128):
        p = make_icon(s, os.path.join(out_dir, f'icon{s}.png'))
        print(f'{p}  {os.path.getsize(p)} bytes')
