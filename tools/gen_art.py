#!/usr/bin/env python3
"""客の立ち絵をGemini APIで生成する。
参照画像（承認済みのキャラ画像）を渡してキャラを固定し、表情と背景を指定して量産する。

使い方:
  GEMINI_API_KEY必須（~/.zshrcにあり。zsh -ic 経由でも可）
  python3 tools/gen_art.py ishi          # 院長の全表情を生成
  python3 tools/gen_art.py ishi ken      # 特定の表情だけ
出力: images/{cust_id}_{face}.png
"""
import base64
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = os.environ.get("GEMINI_API_KEY", "").strip()
MODEL = "gemini-2.5-flash-image"
URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={KEY}"

# 全キャラ共通の画風・構図
STYLE = (
    "横長16:9のゲーム用2Dイラスト。逆転裁判シリーズ風のデフォルメが効いたデザイン"
    "（太めの輪郭線・アニメ塗り・誇張された表情）。実写風・写真風は禁止。"
    "セリフ・文字・擬音・吹き出し・ロゴ・ウォーターマークは画像内に一切描かない。"
)

# 店の共通仕様（八王子駅前・雑居ビル5階の中規模キャバクラ）
STORE = (
    "東京・八王子駅前の雑居ビル5階にある中規模キャバクラの店内。豪華すぎない庶民的な内装："
    "赤茶の合皮ソファ、少し年季の入った壁、暖色のダウンライト、"
    "テーブルには水割りセット（ウイスキーボトル・アイスペール）とおしぼり。"
    "シャンデリアや豪華なベルベットの壁は禁止。人物は一切描かない（無人の席）。"
    "構図＝キャバ嬢がソファに座って隣の席を見た一人称目線。"
    "画面の隅々まで店内を描き切ること。上下の黒帯・レターボックス・額縁は禁止。"
    "文字・ロゴ・著作権表記・ウォーターマーク・サインは一切描かない。"
)

# 背景4パターン（同じ店の別の席）。bg_a を先に生成し、b〜d は a を参照して統一感を出す
BACKGROUNDS = {
    "a": "店の一番奥のボックス席。L字の合皮ソファ、背後は黒い大理石調パネルの壁。一番いい席の空気。",
    "b": "鏡張りの柱のすぐ隣の席。鏡に店内の暖色照明とボトル棚がぼんやり映り込んでいる。",
    "c": "壁掛けのカラオケモニターが見える席。モニターの青白い光が少しだけ差す。デンモクがテーブルの端にある。",
    "d": "入口寄りの二人掛けの小さめの席。遠くにレジカウンターと酒瓶の棚が見える。",
}

CUSTOMERS = {
    "ishi": {
        "bg": "a",                        # 院長は背景A固定（全表情で同じ席）
        "ref": "images/_ref_ishi.png",   # 承認済みキャラの参照画像
        "chara": (
            "【重要】参照画像は「人物の見た目」だけの参考。背景・内装・照明は参照画像から一切コピーしないこと。"
            "背景は必ず上記の八王子の庶民的な店の指定に差し替える（シャンデリア・豪華な壁は描かない）。"
            "キャラクター＝参照画像とまったく同じ人物にすること（顔・髪型・服装・体型を完全一致）。"
            "50代男性、美容クリニック経営者。白髪まじりのオールバック（真っ白ではない）、太い眉、"
            "日焼けしたツヤ肌、恰幅がいい、白っぽい高級ジャケットに開けた襟元、金の腕時計と光る指輪。"
            "コミカルで愛嬌のある「憎めない痛客」。"
        ),
        # テンションラダー: p4(最高潮)〜fu(普通)〜m4(爆発)の9段階
        "faces": {
            "fu": "表情＝レベル0（普通）：シャンパングラスを軽く掲げて自慢話の最中の得意げなドヤ顔。余裕と自己満足。",
            "p1": "表情＝レベル+1：ドヤ顔が明るくなる。目に輝き、口角がしっかり上がる。「お、この子わかってるね」の顔。",
            "p2": "表情＝レベル+2：声を出して笑う上機嫌。目を細めて笑い、体がこちらに少し向く。",
            "p3": "表情＝レベル+3：大笑い。口を大きく開けて身を乗り出し、片手でテーブルを軽く叩いている。",
            "p4": "表情＝レベル+4（最高潮）：立ち上がりかけてシャンパングラスを高々と掲げ、満面の笑みで歓声を上げている。文字は描かない。",
            "m1": "表情＝レベル-1：笑顔が消えた真顔。目から光が引き、口角が水平になる。空気が変わった瞬間。",
            "m2": "表情＝レベル-2：眉間にしわ、目が据わる。口は真一文字。グラスをテーブルに置いて、静かな威圧感。",
            "m3": "表情＝レベル-3：明確な怒気。歯を食いしばり、こめかみに血管。グラスに添えた手に力が入り、視線が鋭い。",
            "m4": "表情＝レベル-4（爆発）：ソファから腰を浮かせて怒鳴っている。目を見開き、口を大きく開けて青筋。テーブルのグラスが倒れかけている。",
        },
    },
}


def generate(prompt, ref_paths, out_path, retries=3):
    parts = [{"text": prompt}]
    for rp in (ref_paths or []):
        if rp and os.path.exists(rp):
            with open(rp, "rb") as f:
                parts.append({"inline_data": {"mime_type": "image/png",
                                              "data": base64.b64encode(f.read()).decode()}})
    body = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "imageConfig": {"aspectRatio": "16:9"},
        },
    }
    req = urllib.request.Request(
        URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=180) as res:
                data = json.loads(res.read())
            for part in data["candidates"][0]["content"]["parts"]:
                blob = part.get("inlineData") or part.get("inline_data")
                if blob:
                    with open(out_path, "wb") as f:
                        f.write(base64.b64decode(blob["data"]))
                    return True
            print(f"  !! 画像が返らなかった（{attempt}回目）", file=sys.stderr)
        except Exception as e:
            print(f"  !! エラー（{attempt}回目）: {e}", file=sys.stderr)
        time.sleep(3)
    return False


def gen_backgrounds(only=None):
    """背景4パターンを生成。aを先に作り、b〜dはaを参照して同じ店に見せる"""
    base = os.path.join(ROOT, "images", "bg_a.png")
    for bg_id, desc in BACKGROUNDS.items():
        if only and bg_id != only:
            continue
        out = os.path.join(ROOT, "images", f"bg_{bg_id}.png")
        refs = []
        prompt = f"{STYLE}\n{STORE}\n席＝{desc}"
        if bg_id != "a" and os.path.exists(base):
            refs = [base]
            prompt += ("\n【重要】参照画像とまったく同じ店・同じ内装・同じ照明・同じ色調・同じ画風で、"
                       "席の位置だけが違う画にすること。")
        print(f"生成中: bg_{bg_id} ...")
        ok = generate(prompt, refs, out)
        print(f"  -> {'OK ' + out if ok else '失敗'}")


def gen_customer(cust_id, only=None):
    cust = CUSTOMERS[cust_id]
    face_ref = os.path.join(ROOT, cust["ref"])
    bg_ref = os.path.join(ROOT, "images", f"bg_{cust['bg']}.png")
    if not os.path.exists(bg_ref):
        print(f"背景 bg_{cust['bg']}.png が無い。先に: python3 tools/gen_art.py bg", file=sys.stderr)
        sys.exit(2)
    for face, face_prompt in cust["faces"].items():
        if only and face != only:
            continue
        out = os.path.join(ROOT, "images", f"{cust_id}_{face}.png")
        prompt = (
            f"{STYLE}\n"
            "参照画像は2枚：1枚目＝この卓の背景（店の席）、2枚目＝人物の顔。\n"
            "【背景】1枚目の背景画像とまったく同じ席・同じ内装・同じ照明・同じ色調を厳密に維持する。"
            "背景を作り変えないこと。\n"
            f"【人物】その席のソファに、2枚目の参照画像とまったく同じ人物を座らせる（顔・髪型・体型を完全一致）。"
            f"{cust['chara']}\n"
            f"【構図】客を画面の主役として大きく描く：バストアップで画面中央、頭が画面上端近くまで来る大きさ、カメラ目線（キャバ嬢の一人称目線）。"
            f"背景はソファの背もたれと壁がすぐ後ろに見える近さ。引きの構図・広い室内を見せる構図・人物を小さく隅に置く構図は禁止。全身は写さない。\n"
            f"{face_prompt}"
        )
        print(f"生成中: {cust_id}_{face}（背景{cust['bg'].upper()}） ...")
        ok = generate(prompt, [bg_ref, face_ref], out)
        print(f"  -> {'OK ' + out if ok else '失敗'}")


def main():
    if not KEY:
        print("GEMINI_API_KEY 未設定", file=sys.stderr)
        sys.exit(2)
    target = sys.argv[1] if len(sys.argv) > 1 else "ishi"
    only = sys.argv[2] if len(sys.argv) > 2 else None
    if target == "bg":
        gen_backgrounds(only)
    else:
        gen_customer(target, only)


if __name__ == "__main__":
    main()
