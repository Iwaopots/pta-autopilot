#!/usr/bin/env python3
"""拼图缺口定位（纯图像计算，不联网）。

输入：背景图（JPEG）+ 拼图块图（带 alpha 的 PNG）+ 拼图块参数。
输出：{"x": ..., "y": ..., "contrast": ..., "agree": ..., "xA": ..., "xB": ..., "corr": ..., "n": ...}

算法与 kisakiayano/PTA-mcp 的 solve.py locate() 一致（MIT）：
拼图块 alpha 轮廓在背景上的局部暗度对比（信号 1）+ 拼图块内容与背景
的相关性（信号 2），取两者各自 argmax，差 ≤4 像素视为一致。
依赖：Pillow、numpy（cv2 可选，无则走 Pillow 分支，结果一致）。
"""

import argparse
import json
import sys

import numpy as np
from PIL import Image, ImageFilter

try:
    import cv2  # noqa: F401
    _HAS_CV2 = True
except ImportError:
    cv2 = None
    _HAS_CV2 = False


def locate(bg_path, sp_path, sprite_pos, size_2d, init_pos):
    bg = np.array(Image.open(bg_path).convert("RGB"))
    sp = np.array(Image.open(sp_path).convert("RGBA"))
    sx, sy = sprite_pos
    w, h = size_2d
    ix, iy = init_pos
    m = sp[sy:sy + h, sx:sx + w, 3] > 128
    if m.sum() < 100:
        return {"x": ix, "y": iy, "contrast": 0.0, "agree": False,
                "xA": ix, "xB": ix, "corr": 0.0, "n": 0}
    if _HAS_CV2:
        ring = (cv2.dilate(m.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0) & ~m
        g = cv2.cvtColor(bg[:, :, :3], cv2.COLOR_BGR2GRAY).astype(np.float32)
        pg = cv2.cvtColor(sp[sy:sy + h, sx:sx + w, :3],
                          cv2.COLOR_BGR2GRAY).astype(np.float32)
    else:
        dil = np.array(Image.fromarray(m.astype(np.uint8) * 255, "L")
                       .filter(ImageFilter.MaxFilter(9))) > 0
        ring = dil & ~m
        g = np.array(Image.fromarray(bg[:, :, :3]).convert("L"), dtype=np.float32)
        pg = np.array(Image.fromarray(sp[sy:sy + h, sx:sx + w, :3]).convert("L"),
                      dtype=np.float32)
    xs, A, B = [], [], []
    for x in range(50, min(553, bg.shape[1] - w + 1)):
        win = g[iy:iy + h, x:x + w]
        if win.shape != m.shape:
            break
        xs.append(x)
        A.append(-(win[m].mean() - win[ring].mean()))  # 信号 1：缺口更暗
        a = pg[m].ravel()
        b = win[m].ravel()  # 信号 2：拼图块内容与背景相关性
        B.append(0.0 if a.std() < 1e-6 or b.std() < 1e-6
                 else float(np.corrcoef(a, b)[0, 1]))
    if not xs:
        return {"x": ix, "y": iy, "contrast": 0.0, "agree": False,
                "xA": ix, "xB": ix, "corr": 0.0, "n": 0}
    A = np.asarray(A)
    B = np.asarray(B)
    iA, iB = int(A.argmax()), int(B.argmax())
    xA, xB = xs[iA], xs[iB]
    return {"x": xA, "y": iy, "contrast": float(A[iA]), "agree": abs(xA - xB) <= 4,
            "xA": xA, "xB": xB, "corr": float(B[iB]), "n": len(xs)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bg", required=True)
    ap.add_argument("--sp", required=True)
    ap.add_argument("--sprite-pos", required=True, help="JSON [sx, sy]")
    ap.add_argument("--size", required=True, help="JSON [w, h]")
    ap.add_argument("--init-pos", required=True, help="JSON [ix, iy]")
    args = ap.parse_args()
    res = locate(args.bg, args.sp, json.loads(args.sprite_pos),
                 json.loads(args.size), json.loads(args.init_pos))
    print(json.dumps(res))
    return 0


if __name__ == "__main__":
    sys.exit(main())
