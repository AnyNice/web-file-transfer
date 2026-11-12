# -*- coding: utf-8 -*-
"""服务器模式 UI E2E：登录 → 上传 3MB → 列表可见 → 删除该行 → 消失"""
import os, random, sys
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3000"
CODE = open(r"E:\开发项目\web-file-transfer\data\access-code.txt", encoding="utf-8").read().strip()
SRC = r"D:\wft-p2p-src\ui-up-3mb.bin"
os.makedirs(os.path.dirname(SRC), exist_ok=True)
random.seed(3)
open(SRC, "wb").write(random.randbytes(3 << 20))

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    page = browser.new_page()
    page.on("dialog", lambda d: d.accept())
    try:
        page.goto(BASE, wait_until="networkidle")
        page.get_by_placeholder("6 位口令").fill(CODE)
        page.get_by_role("button", name="进入").click()
        page.locator('input[type="file"]').first.wait_for(state="attached", timeout=15000)
        page.locator('input[type="file"]').first.set_input_files(SRC)
        page.get_by_text("待上传队列").wait_for(timeout=10000)
        page.get_by_role("button", name="开始上传").click()
        page.get_by_text("上传成功").wait_for(timeout=60000)
        print("upload ok")
        page.get_by_text("ui-up-3mb.bin").first.wait_for(timeout=10000)
        print("listed ok")
        row = page.locator("div.n4-fcard", has_text="ui-up-3mb.bin")
        row.get_by_title("删除").click()
        page.wait_for_timeout(1500)
        assert page.get_by_text("ui-up-3mb.bin").count() == 0, "file still listed after delete"
        print("delete ok")
        exists = os.path.exists(r"E:\开发项目\web-file-transfer\uploads\ui-up-3mb.bin")
        assert not exists, "file still on disk"
        print("SERVER UI E2E: ALL PASS")
    except Exception as e:
        page.screenshot(path=r"D:\wft-server-ui-fail.png")
        print("SERVER UI E2E FAILED:", repr(e))
        sys.exit(1)
    finally:
        browser.close()
