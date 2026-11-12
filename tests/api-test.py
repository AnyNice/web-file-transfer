# -*- coding: utf-8 -*-
"""接口自动化测试：鉴权 / 上传完整性(含分片边界) / 目录 / Range / 信令 / 路径穿越
环境变量：WFT_BASE(默认 http://127.0.0.1:3000) WFT_WORK(项目目录，读口令与落盘校验)
用法：python tests/api-test.py
"""
import glob, hashlib, http.cookiejar, json, os, random, shutil, socket, sys, urllib.request, urllib.error

BASE = os.environ.get("WFT_BASE", "http://127.0.0.1:3000")
WORK = os.environ.get("WFT_WORK", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
passed, failed = [], []

def clean_test_artifacts():
    """清掉本测试在 uploads 里留下的产物，保证可重复连跑（幂等）。
    只清测试自有命名：dir1/ 目录树、t<数字>*.bin（含重名去重的 _N 变体）、tricky.bin。"""
    up = os.path.join(WORK, "uploads")
    shutil.rmtree(os.path.join(up, "dir1"), ignore_errors=True)
    for pat in ("t[0-9]*.bin", "tricky.bin"):
        for f in glob.glob(os.path.join(up, pat)):
            try: os.remove(f)
            except OSError: pass

clean_test_artifacts()

def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f"  {extra}" if extra and not cond else ""))

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
plain = urllib.request.build_opener()

def req(op, method, path, data=None, headers=None):
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers or {})
    try:
        with op.open(r) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()

def low(h): return {k.lower(): v for k, v in h.items()}

# 1) 未登录拦截
s, _, _ = req(plain, "GET", "/api/files")
check("未登录 GET /api/files = 401", s == 401, f"got {s}")
s, _, _ = req(plain, "POST", "/api/p2p/signaling", b"{}", {"Content-Type": "application/json"})
check("未登录 signaling = 401", s == 401, f"got {s}")

# 2) 登录
req(opener, "GET", "/api/auth")
code = open(os.path.join(WORK, "data/access-code.txt"), encoding="utf-8").read().strip()
check("口令文件已生成(6位)", len(code) == 6 and code.isdigit(), code)
s, _, _ = req(opener, "POST", "/api/auth", json.dumps({"code": "000000" if code != "000000" else "111111"}).encode(), {"Content-Type": "application/json"})
check("错误口令 = 401", s == 401, f"got {s}")
s, _, _ = req(opener, "POST", "/api/auth", json.dumps({"code": code}).encode(), {"Content-Type": "application/json"})
check("正确口令登录 = 200", s == 200, f"got {s}")

# 3) 上传完整性（多种大小）
def multipart_upload(name, data, extra_headers=None, boundary="----PyTestBoundary7MA4YWxk"):
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
    h = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    if extra_headers: h.update(extra_headers)
    return req(opener, "POST", "/api/upload", body, h)

random.seed(42)
for size in [0, 1, 255, 256, 4096, 1 << 20, 25 << 20]:
    data = random.randbytes(size)
    s, _, resp = multipart_upload(f"t{size}.bin", data)
    ok = s == 200
    if ok:
        info = json.loads(resp)
        ok = info["size"] == size
        s2, _, dl = req(opener, "GET", f"/api/files/t{size}.bin")
        ok = ok and s2 == 200 and hashlib.sha256(dl).hexdigest() == hashlib.sha256(data).hexdigest()
    check(f"上传 {size}B 完整性(sha256)", ok, f"status={s}")

# 4) 13 字节分片发送 + 内容含 boundary 前缀（差一截的假边界）干扰
def chunked_upload(name, data, chunk=13):
    boundary = "----ChunkBoundaryABC"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
    port = int(BASE.rsplit(":", 1)[1])
    sock = socket.create_connection(("127.0.0.1", port))
    cookie = "; ".join(f"{c.name}={c.value}" for c in cj)
    head = (f"POST /api/upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: multipart/form-data; boundary={boundary}\r\n"
            f"Content-Length: {len(body)}\r\nCookie: {cookie}\r\nConnection: close\r\n\r\n").encode()
    sock.sendall(head)
    for i in range(0, len(body), chunk):
        sock.sendall(body[i:i+chunk])
    resp = b""
    while True:
        d = sock.recv(65536)
        if not d: break
        resp += d
    sock.close()
    return resp

tricky = (b"\r\n------ChunkBoundaryAB" * 50) + random.randbytes(10000) + (b"\r\n------ChunkBoundaryAB" * 3) + random.randbytes(5000)
chunked_upload("tricky.bin", tricky)
s2, _, dl = req(opener, "GET", "/api/files/tricky.bin")
check("13字节分片+假边界前缀干扰 内容完整", s2 == 200 and dl == tricky, f"dl={len(dl)} want={len(tricky)}")

# 5) 文件夹上传保目录 + 嵌套下载 + Range
data = b"hello nested world " * 100
s, _, resp = multipart_upload("hello.txt", data, {"X-File-Path": "dir1/sub/hello.txt"})
info = json.loads(resp) if s == 200 else {}
check("文件夹上传返回相对路径", s == 200 and info.get("path") == "dir1/sub/hello.txt", f"{s} {info}")
check("落盘路径正确", os.path.exists(os.path.join(WORK, "uploads/dir1/sub/hello.txt")))
s, _, body = req(opener, "GET", "/api/files")
tree = json.loads(body)["files"]
dir1 = next((f for f in tree if f["name"] == "dir1"), None)
check("列表含目录树", bool(dir1 and dir1.get("children") and dir1["children"][0]["name"] == "sub"))
s, h, dl = req(opener, "GET", "/api/files/dir1/sub/hello.txt")
check("嵌套文件下载完整", s == 200 and dl == data)
s, h, part = req(opener, "GET", "/api/files/dir1/sub/hello.txt", headers={"Range": "bytes=10-19"})
check("Range 206+内容", s == 206 and part == data[10:20] and low(h).get("content-range") == f"bytes 10-19/{len(data)}", f"{s}")
s, h, part = req(opener, "GET", "/api/files/dir1/sub/hello.txt", headers={"Range": "bytes=-25"})
check("后缀 Range", s == 206 and part == data[-25:], f"{s}")
s, _, _ = req(opener, "GET", "/api/files/dir1/sub/hello.txt", headers={"Range": "bytes=999999-"})
check("越界 Range = 416", s == 416, f"got {s}")

# 6) 路径穿越
s, _, body = req(opener, "GET", "/api/files/..%2f..%2fpackage.json")
check("路径穿越被拒", s in (400, 403, 404) and b"web-file-transfer" not in body, f"got {s}")

# 7) 信令全流程 + 落盘
s, _, resp = req(opener, "POST", "/api/p2p/signaling", json.dumps({"action": "host-create", "sdp": "OFFER_SDP"}).encode(), {"Content-Type": "application/json"})
code_room = json.loads(resp)["code"] if s == 200 else ""
check("host-create 返回邀请码", s == 200 and len(code_room) == 6, f"{s}")
rooms_file = json.load(open(os.path.join(WORK, "p2p-rooms.json"), encoding="utf-8"))
check("房间已落盘", code_room in rooms_file.get("rooms", {}))
s, _, resp = req(opener, "POST", "/api/p2p/signaling", json.dumps({"action": "guest-join", "code": code_room}).encode(), {"Content-Type": "application/json"})
check("guest-join 拿到 offer", s == 200 and json.loads(resp).get("offer") == "OFFER_SDP", f"{s}")
s, _, _ = req(opener, "POST", "/api/p2p/signaling", json.dumps({"action": "guest-join", "code": "999999" if code_room != "999999" else "888888"}).encode(), {"Content-Type": "application/json"})
check("错误邀请码 = 404", s == 404, f"got {s}")
req(opener, "POST", "/api/p2p/signaling", json.dumps({"action": "guest-answer", "code": code_room, "sdp": "ANSWER_SDP"}).encode(), {"Content-Type": "application/json"})
s, _, resp = req(opener, "POST", "/api/p2p/signaling", json.dumps({"action": "host-poll", "code": code_room}).encode(), {"Content-Type": "application/json"})
j = json.loads(resp) if s == 200 else {}
check("host-poll 拿到 answer", s == 200 and j.get("joined") and j.get("answer") == "ANSWER_SDP", f"{s} {j}")
s, _, _ = req(opener, "POST", "/api/p2p/signaling", json.dumps({"action": "host-poll", "code": code_room}).encode(), {"Content-Type": "application/json"})
check("房间消费后失效 = 404", s == 404, f"got {s}")

# 8) 文件夹打包下载（流式 ZIP + ZIP64）
import io, zipfile
s, h, zbody = req(opener, "GET", "/api/files/dir1")
ok = s == 200 and "zip" in low(h).get("content-type", "")
names, zdata = [], None
if ok:
    try:
        zf = zipfile.ZipFile(io.BytesIO(zbody))
        names = zf.namelist()
        zdata = zf.read("sub/hello.txt")
        ok = zf.testzip() is None
    except Exception:
        ok = False
check("文件夹打包下载=ZIP 且内容完整", ok and "sub/hello.txt" in names and zdata == data, f"{s} {names}")
s, h, zbody = req(opener, "GET", "/api/files/dir1/sub")
okn = False
if s == 200:
    try:
        zf = zipfile.ZipFile(io.BytesIO(zbody)); okn = zf.namelist() == ["hello.txt"] and zf.read("hello.txt") == data
    except Exception:
        okn = False
check("子目录打包下载", okn, f"{s}")
big = random.randbytes(2 << 20)
multipart_upload("big.bin", big, {"X-File-Path": "dir1/big.bin"})
s, h, zbody = req(opener, "GET", "/api/files/dir1")
okb = False
if s == 200:
    try:
        zf = zipfile.ZipFile(io.BytesIO(zbody))
        okb = hashlib.sha256(zf.read("big.bin")).hexdigest() == hashlib.sha256(big).hexdigest()
    except Exception:
        okb = False
check("打包含 2MB 文件且哈希一致", okb, f"{s}")
s, _, _ = req(plain, "GET", "/api/files/dir1")
check("未登录打包下载 = 401", s == 401, f"got {s}")
req(opener, "DELETE", "/api/files/dir1/big.bin")

# 9) 删除需登录 + 生效
s, _, _ = req(plain, "DELETE", "/api/files/tricky.bin")
check("未登录 DELETE = 401", s == 401, f"got {s}")
s, _, _ = req(opener, "DELETE", "/api/files/tricky.bin")
check("删除成功且文件消失", s == 200 and not os.path.exists(os.path.join(WORK, "uploads/tricky.bin")), f"got {s}")

clean_test_artifacts()

print(f"\n==== {len(passed)} passed, {len(failed)} failed ====")
if failed:
    print("FAILED:", failed)
    sys.exit(1)
