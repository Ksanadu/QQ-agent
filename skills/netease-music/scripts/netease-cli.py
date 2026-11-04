# -*- coding: utf-8 -*-
"""
netease-cli.py — cloud-music-mcp 的只读 CLI 封装（给 QQ-agent tts 式 skill 调用）。

为什么要这个文件：cloud-music-mcp 是 stdio MCP server，QQ-agent 的 skill 体系
不 speaks MCP；而它的 api.py 用顶层导入（from auth import load_session），
只能以「sys.path 指向 src/cloud_music_mcp + import api」方式加载。
本脚本把推荐所需的数据源聚合成一次性 JSON 输出，等效于 MCP 工具的只读子集。

用法（PYTHONUTF8=1）:
  python netease-cli.py status
  python netease-cli.py login            # 弹二维码窗口，轮询到确认/超时(150s)
  python netease-cli.py recommend        # 收藏专辑全量 + 红心歌单全量（行式文本，无日推）
  python netease-cli.py search <kw> [song|album|artist|playlist]
  python netease-cli.py album <album_id>
约定：一律输出单个 JSON 对象到 stdout（ok:true/false），错误不抛栈只给人话。
只读：刻意不封装 play / create_playlist / add_to_playlist —— bot 不许操作账号。
"""
import io
import json
import os
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

MUSIC_ROOT = Path(os.environ.get("CLOUD_MUSIC_MCP_ROOT") or (Path(__file__).resolve().parents[4] / "cloud-music-mcp"))
SRC = str(MUSIC_ROOT / "src" / "cloud_music_mcp")
if SRC not in sys.path:
    sys.path.insert(0, SRC)

ALBUM_SUB_LIMIT = 300    # 收藏专辑单次拉取上限


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False))


def fail(message):
    emit({"ok": False, "error": str(message)[:300]})
    sys.exit(0)


def load_auth():
    """加载 cookie 并验证；成功后短路后续重复的登录校验请求。"""
    import auth
    ok, nickname = auth.load_session()
    if not ok:
        fail("网易云未登录。请先在服务器上跑一次扫码登录（netease-cli.py login）。")
    auth.load_session = lambda: (True, nickname)
    return nickname


def cmd_status():
    import auth
    ok, nickname = auth.check_login_status()["logged_in"], auth.check_login_status().get("nickname")
    emit({"ok": True, "logged_in": bool(ok), "nickname": nickname})


def cmd_login():
    import auth
    auth.ensure_storage_dir()  # 上游 login_via_qrcode 不建目录，直接 save 会 Errno 2
    result = auth.login_via_qrcode()
    emit({
        "ok": bool(result.get("success")),
        "message": result.get("message", ""),
        "nickname": result.get("nickname", ""),
    })


def _slim_song(song):
    return {
        "id": song.get("id"),
        "name": song.get("name"),
        "artist": (song.get("ar") or [{}])[0].get("name", "未知") if isinstance(song.get("ar"), list) else "未知",
        "album": (song.get("al") or {}).get("name", ""),
    }


def cmd_login_qr():
    """出 ASCII 二维码到 stdout（贴给用户扫），uuid 落盘给 login-poll 用。"""
    import auth
    import qrcode
    from pyncm import apis
    auth.ensure_storage_dir()
    result = apis.login.LoginQrcodeUnikey(1)
    if result.get("code") != 200:
        fail("获取二维码失败")
    uuid = result["unikey"]
    with open(os.path.join(auth.STORAGE_DIR, "login_pending.txt"), "w") as fh:
        fh.write(uuid)
    qr = qrcode.QRCode(border=1)
    qr.add_data(f"https://music.163.com/login?codekey={uuid}")
    qr.make(fit=True)
    qr.print_ascii(out=sys.stdout, invert=True)
    emit({"ok": True, "message": "二维码已输出，请 120 秒内扫码并跑 login-poll"})


def cmd_login_poll():
    """轮询扫码结果并保存 cookie。"""
    import time
    import auth
    from pyncm import apis
    auth.ensure_storage_dir()
    path = os.path.join(auth.STORAGE_DIR, "login_pending.txt")
    if not os.path.exists(path):
        fail("没有待确认的二维码，先跑 login-qr")
    with open(path) as fh:
        uuid = fh.read().strip()
    for _ in range(60):
        result = apis.login.LoginQrcodeCheck(uuid)
        code = result.get("code")
        if code == 800:
            emit({"ok": False, "message": "二维码已过期，重新跑 login-qr"})
            return
        if code == 803:
            if "cookie" in result:
                apis.login.WriteLoginInfo(result["cookie"])
            auth.save_session()
            status = auth.check_login_status()
            emit({"ok": True, "nickname": status.get("nickname"), "message": "登录成功"})
            return
        time.sleep(2)
    emit({"ok": False, "message": "轮询超时（2 分钟），重新跑 login-poll 再等一轮"})


def cmd_recommend():
    """收藏专辑全量 + 红心歌单全量 → 行式文本。不带每日推荐。"""
    from pyncm import apis
    nickname = load_auth()

    lines = []
    album_count = 0
    try:
        subs = apis.user.GetUserAlbumSubs(limit=ALBUM_SUB_LIMIT)
        data = subs.get("data") or []
        album_count = len(data)
        lines.append(f"[收藏专辑 {album_count} 张]")
        for item in data:
            artist = ((item.get("artists") or [{}])[0]).get("name", "未知")
            lines.append(f"{artist} - {item.get('name', '')}")
    except Exception as exc:
        lines.append(f"[收藏专辑] 拉取失败：{str(exc)[:120]}")

    heart_songs = []
    try:
        me = apis.login.GetCurrentLoginStatus()
        uid = me["profile"]["userId"]
        pls = apis.user.GetUserPlaylists(uid)
        # 网易云约定：自建歌单列表第一个就是「我喜欢的音乐」（红心）
        heart = next((pl for pl in (pls.get("playlist") or [])
                      if pl.get("creator", {}).get("userId") == uid), None)
        if heart:
            detail = apis.playlist.GetPlaylistInfo(heart["id"])
            tracks = (detail.get("playlist") or {}).get("tracks") or []
            heart_songs = [{
                "artist": (t.get("ar") or [{}])[0].get("name", "未知"),
                "name": t.get("name", ""),
                "album": (t.get("al") or {}).get("name", ""),
            } for t in tracks]
            lines.append(f"[红心歌单「{heart.get('name')}」{len(heart_songs)} 首]")
            for s in heart_songs:
                suffix = f" [{s['album']}]" if s["album"] else ""
                lines.append(f"{s['artist']} - {s['name']}{suffix}")
        else:
            lines.append("[红心歌单] 未找到自建歌单")
    except Exception as exc:
        lines.append(f"[红心歌单] 拉取失败：{str(exc)[:120]}")

    emit({
        "ok": True,
        "nickname": nickname,
        "album_count": album_count,
        "heart_count": len(heart_songs),
        "text": "\n".join(lines),
    })


def cmd_search():
    keyword = sys.argv[2] if len(sys.argv) > 2 else ""
    category = sys.argv[3] if len(sys.argv) > 3 else "song"
    if not keyword:
        fail("用法: search <关键词> [song|album|artist|playlist]")
    from pyncm import apis
    load_auth()
    stype = {"song": 1, "album": 10, "artist": 100, "playlist": 1000}.get(category, 1)
    try:
        result = apis.cloudsearch.GetSearchResult(keyword, stype=stype, limit=8)
    except Exception as exc:
        fail(exc)
    if result.get("code") != 200:
        fail("搜索接口返回异常")
    res = result.get("result") or {}
    items = []
    if category == "song":
        for s in res.get("songs", []):
            items.append({"id": s.get("id"), "name": s.get("name"),
                          "artist": (s.get("ar") or [{}])[0].get("name", "未知"),
                          "album": (s.get("al") or {}).get("name", "")})
    elif category == "album":
        for a in res.get("albums", []):
            items.append({"id": a.get("id"), "name": a.get("name"),
                          "artist": (a.get("artist") or {}).get("name", "未知"),
                          "song_count": a.get("size") or a.get("songCount")})
    elif category == "artist":
        for a in res.get("artists", []):
            items.append({"id": a.get("id"), "name": a.get("name")})
    elif category == "playlist":
        for p in res.get("playlists", []):
            items.append({"id": p.get("id"), "name": p.get("name"), "count": p.get("trackCount", 0)})
    emit({"ok": True, "category": category, "items": items})


def cmd_album():
    album_id = sys.argv[2] if len(sys.argv) > 2 else ""
    if not album_id.isdigit():
        fail("用法: album <专辑ID>")
    from pyncm import apis
    load_auth()
    try:
        result = apis.album.GetAlbumInfo(int(album_id))
    except Exception as exc:
        fail(exc)
    album = result.get("album") or {}
    songs = [{"id": s.get("id"), "name": s.get("name"),
              "artist": (s.get("ar") or [{}])[0].get("name", "未知")}
             for s in result.get("songs", [])]
    emit({
        "ok": True,
        "album": {
            "name": album.get("name"), "artist": (album.get("artist") or {}).get("name", "未知"),
            "size": album.get("size", len(songs)),
            "company": album.get("company", ""),
            "pic_url": album.get("picUrl", ""),
            "publish_time": album.get("publishTime", 0),
            "first_song_id": (songs[0].get("id") if songs else None),
        },
        "songs": songs,
    })


def cmd_songurl():
    """歌曲试听 URL（带时效，发 custom 音乐卡片用）。"""
    song_id = sys.argv[2] if len(sys.argv) > 2 else ""
    if not song_id.isdigit():
        fail("用法: songurl <歌曲ID>")
    from pyncm import apis
    load_auth()

    @apis.WeapiCryptoRequest
    def _url():
        return "/weapi/song/enhance/player/url", {"ids": f"[{song_id}]", "br": 128000, "os": "pc"}

    try:
        r = _url()
    except Exception as exc:
        fail(exc)
    d = (r.get("data") or [{}])[0]
    emit({"ok": True, "url": d.get("url") or "", "type": d.get("type", "")})


def cmd_song():
    """歌曲详情（含封面）——给发分享卡片用。"""
    song_id = sys.argv[2] if len(sys.argv) > 2 else ""
    if not song_id.isdigit():
        fail("用法: song <歌曲ID>")
    from pyncm import apis
    load_auth()
    try:
        r = apis.track.GetTrackDetail([int(song_id)])
    except Exception as exc:
        fail(exc)
    s = (r.get("songs") or [{}])[0]
    if not s:
        fail("没找到这首歌")
    al = s.get("al") or {}
    emit({
        "ok": True,
        "id": s.get("id"),
        "name": s.get("name"),
        "artist": " / ".join(a.get("name", "") for a in (s.get("ar") or [])),
        "album": al.get("name", ""),
        "album_id": al.get("id"),
        "picUrl": al.get("picUrl", ""),
        "duration_ms": s.get("dt", 0),
    })


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    try:
        {"status": cmd_status, "login": cmd_login, "login-qr": cmd_login_qr,
         "login-poll": cmd_login_poll, "recommend": cmd_recommend,
         "search": cmd_search, "album": cmd_album, "song": cmd_song, "songurl": cmd_songurl}.get(cmd, cmd_status)()
    except SystemExit:
        raise
    except Exception as exc:
        fail(exc)


if __name__ == "__main__":
    main()
