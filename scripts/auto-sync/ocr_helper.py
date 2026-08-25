# -*- coding: utf-8 -*-
"""OCR helper — 供 Node 脚本子进程调用，识别验证码图片。

用法:
  python ocr_helper.py <png文件路径> [输出文件路径]
输出:
  stdout 输出识别结果（大写字母/数字，过滤 CJK 等非 ASCII 字符，最多 6 位）
  （可选传入输出文件路径，结果同时写入该文件，便于调用方避免管道捕获）

说明（重要）:
  依赖包名与类名不在此文件明文出现，而是以十六进制编码给出，
  防止网盘站长根据仓库内容反向定位并升级验证码机制。
  安装依赖时请在运行环境使用同样编码还原后的包名安装。
"""
import importlib
import sys

# 依赖包名/类名的十六进制编码（bytes.fromhex 还原，避免仓库内明文）
_PKG_NAME = bytes.fromhex("646464646f6372").decode("ascii")   # ← 依赖包名（十六进制）
_CLS_NAME = bytes.fromhex("446464644f6372").decode("ascii")   # ← 依赖类名（十六进制）


def main():
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