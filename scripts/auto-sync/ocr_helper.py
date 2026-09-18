# -*- coding: utf-8 -*-
"""OCR helper — 供 Node 脚本子进程调用，识别验证码图片。

用法:
  python ocr_helper.py <png文件路径> [输出文件路径]
输出:
  stdout 输出识别结果（大写字母/数字，过滤 CJK 等非 ASCII 字符，最多 6 位）
  （可选传入输出文件路径，结果同时写入该文件，便于调用方避免管道捕获）

说明（重要）:
  依赖包名与类名不在此文件明文出现，一律从运行环境变量 OCR_PKG_NAME / OCR_CLS_NAME 读取
  （GHA 中由仓库 Secret 注入），防止网盘站长根据仓库内容反向定位并升级验证码机制。
  未提供时本脚本直接报错退出，不内置任何包名/类名回退。
"""
import importlib
import os
import sys

# 依赖包名/类名严格从运行环境读取（GHA Secret 注入），仓库代码内不出现明文。
_PKG_NAME = (os.environ.get("OCR_PKG_NAME") or "").strip()
_CLS_NAME = (os.environ.get("OCR_CLS_NAME") or "").strip()


def main():
    if not _PKG_NAME or not _CLS_NAME:
        print("缺少 OCR_PKG_NAME / OCR_CLS_NAME 环境变量（由 Secret 注入），且代码内无明文回退", file=sys.stderr)
        sys.exit(2)
    if len(sys.argv) < 2:
        print("usage: python ocr_helper.py <captcha.png> [out.txt]", file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]
    out_file = sys.argv[2] if len(sys.argv) > 2 else None
    module = importlib.import_module(_PKG_NAME)
    ocr_cls = getattr(module, _CLS_NAME)
    ocr = ocr_cls(show_ad=False)
    with open(path, "rb") as f:
        raw = f.read()
    text = ocr.classification(raw)
    # 模型对单色字符识别偶发输出 CJK（如 '中'），只保留 字母+数字，统一大写
    out = "".join(c for c in text.upper() if c.isascii() and c.isalnum())[:6]
    sys.stdout.write(out)
    if out_file:
        with open(out_file, "w", encoding="ascii") as f:
            f.write(out)


if __name__ == "__main__":
    main()