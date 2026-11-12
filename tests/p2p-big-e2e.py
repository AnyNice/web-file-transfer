# -*- coding: utf-8 -*-
"""P2P 大文件 E2E：1 个 200MB 文件，验证不中断、大小与 sha256 一致。
复现用户反馈「刚传文件就断」用：小文件 E2E 测不出背压/落盘瓶颈。
"""
import hashlib, os, random, sys, time
from playwright.sync_api import sync_playwright

BASE = os.environ.get("WFT_BASE", "http://127.0.0.1:3000")
WORK = os.environ.get("WFT_WORK", r"E:\开发项目\web-file-transfer")
CODE = open(os.path.join(WORK, "data", "access-code.txt"), encoding="utf-8").read().strip()
SRC = r"D:\wft-p2p-src"
DL = r"D:\wft-p2p-dl"
os.makedirs(SRC, exist_ok=True)
os.makedirs(DL, exist_ok=True)

SIZE = 200 << 20
random.seed(42)
src_path = os.path.join(SRC, "big-200mb.bin")
if not os.path.exists(src_path) or os.path.getsize(src_path) != SIZE:
    with open(src_path, "wb") as f:
        left = SIZE
        while left > 0:
            chunk = random.randbytes(min(left, 8 << 20))
            f.write(chunk)
            left -= len(chunk)
src_sha = hashlib.sha256(open(src_path, "rb").read()).hexdigest()
print("source ready:", SIZE, "sha:", src_sha[:12])

def login(page):
    page.goto(BASE, wait_until="networkidle")
    page.get_by_placeholder("6 位口令").fill(CODE)
    page.get_by_role("button", name="进入").click()
    page.get_by_role("button", name="P2P传输").wait_for(timeout=15000)

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    try:
        ctxA = browser.new_context(accept_downloads=True)
        A = ctxA.new_page()
        login(A)
        A.get_by_role("button", name="P2P传输").click()
        A.get_by_role("button", name="生成邀请码").last.click()
        code_el = A.locator("div.text-5xl")
        code_el.wait_for(timeout=20000)
        room_code = code_el.inner_text().strip()
        print("room code:", room_code)

        ctxB = browser.new_context(accept_downloads=True)
        B = ctxB.new_page()
        login(B)
        B.get_by_role("button", name="P2P传输").click()
        B.get_by_role("button", name="我是接收方").click()
        B.get_by_placeholder("000000").fill(room_code)
        B.get_by_role("button", name="连接").click()
        B.get_by_text("已连接，等待对方发送文件").wait_for(timeout=30000)
        print("guest connected")

        A.get_by_text("已连接 · 选择本机文件").wait_for(timeout=30000)
        A.locator('input[type="file"]').nth(0).set_input_files([src_path])
        A.get_by_text("已选 1 个").wait_for(timeout=10000)
        t0 = time.time()
        A.get_by_role("button", name="发送 1 个文件").click()
        print("host sending 200MB...")

        downloads = []
        B.on("download", lambda d: downloads.append(d))
        try:
            B.get_by_role("button", name="下载全部文件").wait_for(state="visible", timeout=300000)
        except Exception:
            print("A status tail:", A.locator("body").inner_text()[-400:])
            print("B status tail:", B.locator("body").inner_text()[-400:])
            raise
        print(f"guest: all received in {time.time()-t0:.1f}s")
        B.get_by_role("button", name="下载全部文件").click()
        deadline = time.time() + 120
        while len(downloads) < 1 and time.time() < deadline:
            B.wait_for_timeout(500)
        assert len(downloads) == 1, f"expected 1 download, got {len(downloads)}"
        save_to = os.path.join(DL, downloads[0].suggested_filename)
        downloads[0].save_as(save_to)
        got_size = os.path.getsize(save_to)
        got_sha = hashlib.sha256(open(save_to, "rb").read()).hexdigest()
        print(f"saved: {got_size}B sha-match={got_sha == src_sha}")
        assert got_size == SIZE and got_sha == src_sha
        print("P2P BIG E2E: ALL PASS")
    except Exception as e:
        print("P2P BIG E2E FAILED:", repr(e))
        sys.exit(1)
    finally:
        browser.close()
