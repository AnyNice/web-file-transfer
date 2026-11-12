# -*- coding: utf-8 -*-
"""P2P E2E（需先启动服务且装有 Playwright）：两个浏览器上下文，
host 发 3 个文件(5MB/0B/小文本)，guest 接收下载后逐个比对 sha256。
环境变量：WFT_BASE(默认 http://127.0.0.1:3000) WFT_WORK(项目目录)
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

random.seed(7)
files = {
    "a-5mb.bin": random.randbytes(5 << 20),
    "b-empty.txt": b"",
    "c-small.txt": "hello p2p 你好\n".encode("utf-8") * 100,
}
paths = []
for name, data in files.items():
    p = os.path.join(SRC, name)
    open(p, "wb").write(data)
    paths.append(p)

def sha(b): return hashlib.sha256(b).hexdigest()

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
        assert len(room_code) == 6

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
        inputs = A.locator('input[type="file"]')
        inputs.nth(0).set_input_files(paths)  # P2P 视图下只有 P2P 的两个 input
        A.get_by_text("已选 3 个").wait_for(timeout=10000)
        A.get_by_role("button", name="发送 3 个文件").click()
        print("host sending...")

        downloads = []
        B.on("download", lambda d: downloads.append(d))
        B.get_by_role("button", name="下载全部文件").wait_for(timeout=90000)
        print("guest: all received")
        B.get_by_role("button", name="下载全部文件").click()
        deadline = time.time() + 30
        while len(downloads) < 3 and time.time() < deadline:
            B.wait_for_timeout(500)
        assert len(downloads) == 3, f"expected 3 downloads, got {len(downloads)}"
        ok = True
        for d in downloads:
            save_to = os.path.join(DL, d.suggested_filename)
            d.save_as(save_to)
            got = open(save_to, "rb").read()
            match = sha(got) == sha(files[d.suggested_filename])
            print(f"  {d.suggested_filename}: {len(got)}B sha-match={match}")
            ok = ok and match
        assert ok, "sha mismatch"
        print("P2P E2E: ALL PASS")
    except Exception as e:
        for name, pg in (("B", globals().get("B")), ("A", globals().get("A"))):
            try:
                if pg: pg.screenshot(path=rf"D:\wft-p2p-fail-{name}.png")
            except Exception:
                pass
        print("P2P E2E FAILED:", repr(e))
        sys.exit(1)
    finally:
        browser.close()
