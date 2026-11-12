# -*- coding: utf-8 -*-
"""P2P 文件夹 E2E：host 用「选择文件夹」发送带子目录的文件夹（含同名文件），
guest 接收后校验：进度列表显示相对路径、OPFS 里 3 个文件大小/哈希各就其位（不覆盖）。
「选目录按结构写盘」需真人点系统目录框，无头环境无法自动点，故此处验到接收完整性为止。
环境变量：WFT_BASE(默认 http://127.0.0.1:3000) WFT_WORK(项目目录)
"""
import hashlib, os, random, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get("WFT_BASE", "http://127.0.0.1:3000")
WORK = os.environ.get("WFT_WORK", r"E:\开发项目\web-file-transfer")
CODE = open(os.path.join(WORK, "data", "access-code.txt"), encoding="utf-8").read().strip()
SRC = r"D:\wft-p2p-src2"
ROOT = os.path.join(SRC, "rootdir")

random.seed(11)
files = {
    "a.txt": b"A" * 100,
    "sub/a.txt": b"B" * 200,
    "sub/big.bin": random.randbytes(3 << 20),
}
for rel, data in files.items():
    p = os.path.join(ROOT, *rel.split("/"))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "wb").write(data)

def sha(b): return hashlib.sha256(b).hexdigest()
by_size = {len(v): sha(v) for v in files.values()}

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
        inputs.nth(1).set_input_files(ROOT)  # 第二个 input 是文件夹选择（webkitdirectory）
        A.get_by_text("已选 3 个").wait_for(timeout=10000)
        # 发送列表应显示相对路径
        assert A.get_by_text("rootdir/sub/a.txt").count() >= 1, "host list missing relative path"
        print("host list shows relative paths")
        A.get_by_role("button", name="发送 3 个文件").click()
        print("host sending folder...")

        B.get_by_role("button", name="下载全部文件").wait_for(timeout=90000)
        print("guest: all received")
        assert B.get_by_text("rootdir/sub/a.txt").count() >= 1, "guest progress missing relative path"
        print("guest progress shows relative paths")

        # OPFS 内容校验：3 个文件、大小两两不同、哈希与源一致（同名不覆盖）
        entries = B.evaluate("""(async () => {
          const root = await navigator.storage.getDirectory();
          const out = [];
          for await (const [name, handle] of root.entries()) {
            if (handle.kind === 'file') {
              const f = await handle.getFile();
              const buf = await f.arrayBuffer();
              const digest = await crypto.subtle.digest('SHA-256', buf);
              const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
              out.push([name, f.size, hex]);
            }
          }
          return out;
        })()""")
        got = {size: hexv for _name, size, hexv in entries}
        assert len(entries) == 3, f"expected 3 OPFS files, got {entries}"
        assert got == by_size, f"OPFS mismatch: got={got} want={by_size}"
        print("OPFS: 3 files, sizes+sha all match (same-name files kept separate)")
        print("P2P FOLDER E2E: ALL PASS")
    except Exception as e:
        for name, pg in (("B", globals().get("B")), ("A", globals().get("A"))):
            try:
                if pg: pg.screenshot(path=rf"D:\wft-p2p-folder-fail-{name}.png")
            except Exception:
                pass
        print("P2P FOLDER E2E FAILED:", repr(e))
        sys.exit(1)
    finally:
        browser.close()
