# -*- coding: utf-8 -*-
"""新版 UI 截图：服务器页 / P2P 页 / 200MB 传输中的进度条特写"""
import os, random
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3000"
CODE = open(r"E:\开发项目\web-file-transfer\data\access-code.txt", encoding="utf-8").read().strip()
OUT = r"D:\wft-shots"
os.makedirs(OUT, exist_ok=True)
SRC = r"D:\wft-p2p-src\big-200mb.bin"
os.makedirs(os.path.dirname(SRC), exist_ok=True)
if not os.path.exists(SRC):
    random.seed(11)
    open(SRC, "wb").write(random.randbytes(200 << 20))

def login(page):
    page.goto(BASE, wait_until="networkidle")
    page.get_by_placeholder("6 位口令").fill(CODE)
    page.get_by_role("button", name="进入").click()
    page.get_by_role("button", name="P2P传输").wait_for(timeout=15000)

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    ctxA = browser.new_context(viewport={"width": 1180, "height": 860}, accept_downloads=True)
    A = ctxA.new_page()
    login(A)
    A.wait_for_timeout(800)
    A.screenshot(path=OUT + r"\1-server.png")

    A.get_by_role("button", name="P2P传输").click()
    A.get_by_role("button", name="生成邀请码").last.click()
    code_el = A.locator("div.text-5xl")
    code_el.wait_for(timeout=20000)
    room = code_el.inner_text().strip()
    A.wait_for_timeout(600)
    A.screenshot(path=OUT + r"\2-p2p.png")

    ctxB = browser.new_context(viewport={"width": 1180, "height": 860}, accept_downloads=True)
    B = ctxB.new_page()
    login(B)
    B.get_by_role("button", name="P2P传输").click()
    B.get_by_role("button", name="我是接收方").click()
    B.get_by_placeholder("000000").fill(room)
    B.get_by_role("button", name="连接").click()
    B.get_by_text("已连接，等待对方发送文件").wait_for(timeout=30000)

    A.get_by_text("已连接 · 选择本机文件").wait_for(timeout=30000)
    A.locator('input[type="file"]').nth(0).set_input_files(SRC)
    A.get_by_role("button", name="发送 1 个文件").click()
    # 等接收端进度到中段再截图
    B.wait_for_timeout(5000)
    B.screenshot(path=OUT + r"\3-progress.png")
    print("shots done")
    browser.close()
