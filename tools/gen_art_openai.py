#!/usr/bin/env python3
"""客の立ち絵をOpenAI API（gpt-image-1）で生成する。
参照画像を渡して背景・画風・構図を固定し、表情/キャラだけを差し替える。

使い方:
  OPENAI_API_KEY必須
  python3 tools/gen_art_openai.py design shacho    # 新キャラの基準デザイン
  python3 tools/gen_art_openai.py face shacho p2   # 既存キャラの表情差分
  python3 tools/gen_art_openai.py glass shacho p2  # 既存表情の水割り版
"""
import base64
import json
import mimetypes
import os
import sys
import urllib.request
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG = os.path.join(ROOT, "images")
KEY = os.environ.get("OPENAI_API_KEY", "").strip()
MODEL = "gpt-image-1"
URL = "https://api.openai.com/v1/images/edits"

STYLE_LOCK = (
    "背景・内装・ライティング・画風（逆転裁判風のデフォルメが効いたアニメ塗り・太い輪郭線）・"
    "構図・引きの画角（バストアップで頭が切れない）は完全にそのまま維持し、"
)

WATER_SWAP = (
    "この画像の「シャンパングラス（フルート型）」だけを水割り用のグラスに差し替えてください。"
    "差し替え後＝背の低いタンブラー／ロックグラスに、琥珀色の水割り（ウイスキーの水割り）と氷。"
    "持ち手の指・手の位置・腕・キャラの顔と表情・服装・背景・画風・構図は一切変えない。"
    "グラスと中身だけ変える。横長16:9、黒帯なし、文字なし。"
)

FACES = {
    "p1": "表情＝レベル+1：基本のドヤ顔がもう一段明るくなり、口角が上がって嬉しそうにニコッと笑う満足げな笑み。",
    "p2": "表情＝レベル+2：声を出して大笑いしている上機嫌（口を開けて歯が見え、目を細めて楽しそうに笑う）。",
    "p3": "表情＝レベル+3：もっと豪快に、目一杯口を開けて笑い転げる大笑い（心底楽しくてたまらない最高潮一歩手前の高揚）。",
    "p4": (
        "感情MAXなのでポーズも顔も逆転裁判のキメ顔のように思いっきりオーバーに崩してOKです。"
        "「レベル+4・最高潮の大歓喜」にしてください：シャンパングラスを勢いよく高々と掲げ、"
        "天を仰ぐくらいの満面の歓喜、口を大きく開けて「最高だ！」と叫ぶ大興奮、"
        "目は輝くかギュッと閉じ、上半身が少しこちらに迫る。頭は切れないように収める。"
    ),
    "m1": (
        "ただし今回はシャンパングラスを持たず、両腕を胸の前でしっかり組む「腕組み」ポーズにしてください。"
        "手やグラスは持たせない。"
        "表情＝レベル−1「冷めた真顔」：さっきまでの笑顔が完全に消え、口は閉じて（歯を見せない）、"
        "目から光が引いた真顔。まだ睨んではいないが明らかに機嫌が下がり始めた空気。腕組み＋冷めた真顔。"
    ),
    "m2": (
        "グラスは持たず両腕を胸の前で組む「腕組み」ポーズにしてください。手やグラスは持たせない。"
        "表情＝レベル−2「はっきり不機嫌・静かな威圧」：笑顔は完全に消し、口はへの字ぎみに閉じる"
        "（歯は見せない）、眉間にしっかりシワを寄せ、目は据わって鋭く睨む。"
        "明らかに機嫌が悪く静かにプレッシャーをかけている。腕組み＋不機嫌の睨み。"
    ),
    "m3": (
        "グラスは持たず、腕組みをほどいて「怒りが伝わるポーズ」にしてください："
        "片手の人差し指をこちらにビシッと突きつけ（説教するように）、上半身を少し前に乗り出す。"
        "グラスは持たせない。"
        "表情＝レベル−3「明確な怒気」：歯を食いしばって眉を吊り上げ、目を鋭く見開いて睨みつける。"
        "本気で叱責する迫力。まだ絶叫まではしていない。"
    ),
    "m4": (
        "感情MAXなのでポーズも顔も逆転裁判ばりに思いっきりオーバーに崩してOK。グラスは持たない。"
        "頭は切れないように収める。"
        "表情＝レベル−4「激怒の大爆発」：椅子から腰を浮かせて両手を振り上げる"
        "（またはバン！と机を叩く勢い）激怒ポーズ。口を限界まで大きく開けて絶叫、"
        "目を力いっぱい見開き、こめかみと首に青筋、歯をむき出し、顔は真っ赤に紅潮。"
        "ついにブチギレて怒鳴る、一発でわかるオーバーな大爆発。"
    ),
}

SUFFIX = "横長16:9、黒帯なし、文字なし。"


def call_api(prompt, ref_paths, out_path, size="1536x1024", retries=3):
    boundary = uuid.uuid4().hex
    parts = []

    def add_field(name, value):
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())

    def add_file(name, path):
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as f:
            data = f.read()
        header = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; "
                  f"filename=\"{os.path.basename(path)}\"\r\nContent-Type: {mime}\r\n\r\n").encode()
        parts.append(header + data + b"\r\n")

    add_field("model", MODEL)
    add_field("prompt", prompt)
    add_field("size", size)
    for rp in ref_paths:
        add_file("image[]", rp)
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)

    req = urllib.request.Request(
        URL, data=body,
        headers={"Authorization": f"Bearer {KEY}",
                 "Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                data = json.loads(res.read())
                b64 = data["data"][0]["b64_json"]
                with open(out_path, "wb") as f:
                    f.write(base64.b64decode(b64))
                return True
        except urllib.error.HTTPError as e:
            print(f"  !! HTTPエラー {e.code}（{attempt}回目）: {e.read()[:300]}", file=sys.stderr)
        except Exception as e:
            print(f"  !! エラー（{attempt}回目）: {e}", file=sys.stderr)
    return False


def cmd_design(cust_id, char_desc):
    """新キャラの基準デザイン（ishi_fuをテンプレとして人物差し替え）"""
    ref = os.path.join(IMG, "ishi_fu.png")
    out = os.path.join(IMG, f"{cust_id}_fu.png")
    prompt = (
        f"{STYLE_LOCK}人物だけを全く別のキャラクターに差し替えてください。\n\n"
        f"新キャラ＝{char_desc}\n\n"
        f"ポーズ：片手にシャンパングラス（フルート型）を持ちバストアップで画面の主役として大きく。"
        f"表情＝レベル0（基本）。テーブル・小物なし。{SUFFIX}"
    )
    print(f"生成中: {cust_id}_fu（キャラ設計） ...")
    ok = call_api(prompt, [ref], out)
    print(f"  -> {'OK ' + out if ok else '失敗'}")


def cmd_face(cust_id, face):
    """既存キャラの基準画像から表情差分を生成"""
    ref = os.path.join(IMG, f"{cust_id}_fu.png")
    out = os.path.join(IMG, f"{cust_id}_{face}.png")
    face_desc = FACES[face]
    prompt = (
        f"このアップした画像と同じ人物・同じ背景・同じ画風・同じ引きの画角・同じバストアップ構図で、"
        f"{face_desc} {SUFFIX}"
    )
    print(f"生成中: {cust_id}_{face} ...")
    ok = call_api(prompt, [ref], out)
    print(f"  -> {'OK ' + out if ok else '失敗'}")


def cmd_glass(cust_id, face):
    """既存表情のシャンパン版から水割り版を生成"""
    ref = os.path.join(IMG, f"{cust_id}_{face}.png")
    out = os.path.join(IMG, f"{cust_id}_{face}_mizu.png")
    print(f"生成中: {cust_id}_{face}_mizu ...")
    ok = call_api(WATER_SWAP, [ref], out)
    print(f"  -> {'OK ' + out if ok else '失敗'}")


def main():
    if not KEY:
        print("OPENAI_API_KEY 未設定", file=sys.stderr)
        sys.exit(2)
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    mode, cust_id = sys.argv[1], sys.argv[2]
    if mode == "design":
        char_desc = sys.argv[3]
        cmd_design(cust_id, char_desc)
    elif mode == "face":
        cmd_face(cust_id, sys.argv[3])
    elif mode == "glass":
        cmd_glass(cust_id, sys.argv[3])
    else:
        print(f"不明なモード: {mode}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
