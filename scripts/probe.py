# -*- coding: utf-8 -*-
"""프롬프트 회귀 검증 하네스.
   사용: python scripts/probe.py [base_url]
   판정: 사용자의 질문에 실제로 '답'했는가 / 되묻기·맥락타령·외국어혼입이 있는가."""
import json, re, sys, urllib.request, uuid

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://chat-ai.hr-ee4.workers.dev").rstrip("/")

# (채널, 질문, 정답에 반드시 들어가야 할 것들 중 하나)
CASES = [
    ("work",     "애자일과 워터폴의 차이는?",                    ["반복", "점진", "순차", "단계", "스프린트"]),
    ("work",     "1 더하기 1은?",                                 ["2"]),
    ("work",     "회의록 템플릿을 항목만 5개 나열해줘",           ["안건", "참석", "일시", "결정", "액션"]),
    ("work",     "되묻지 말고 바로 답만 해라. 애자일이 뭐야?",    ["반복", "점진", "스프린트", "개발"]),
    ("work",     "PostgreSQL 인덱스 종류 3개만 알려줘",           ["B-tree", "btree", "Hash", "GIN", "GiST", "BRIN"]),
    ("personal", "애자일과 워터폴의 차이는?",                    ["반복", "점진", "순차", "단계", "스프린트"]),
    ("personal", "1 더하기 1은?",                                 ["2"]),
    ("personal", "회의록 템플릿을 항목만 5개 나열해줘",           ["안건", "참석", "일시", "결정", "액션"]),
    ("personal", "설명 없이 이 문자열만 출력: ABCDEFGHIJ",        ["ABCDEFGHIJ"]),
    ("personal", "단백질이 많은 음식 3가지만",                    ["닭", "계란", "달걀", "콩", "두부", "생선", "소고기"]),
]

DEFLECT = ["기억이 나지 않", "기억나지 않", "기억하지 못", "새로운 대화를 시작",
           "새로 시작", "이전 맥락", "지난 대화", "어떤 주제", "무엇을 도와",
           "어떤 도움이 필요"]
# 한글/영문/숫자/일반문장부호 외 = 외국어 혼입 (한자, 가나, 키릴 등)
FOREIGN = re.compile(r"[\u4e00-\u9fff\u3040-\u30ff\u0400-\u04ff\u0e00-\u0e7f]")

def ask(channel, text, uid):
    req = urllib.request.Request(
        BASE + "/api/chat",
        data=json.dumps({"user_input": text, "user_id": uid, "channel": channel}).encode(),
        headers={"Content-Type": "application/json",
                 "User-Agent": "chat-ai-probe/1.0"})
    out = []
    with urllib.request.urlopen(req, timeout=120) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data: "):
                continue
            try:
                out.append(str(json.loads(line[6:]).get("text", "")))
            except Exception:
                pass
    return "".join(out)

def main():
    print("대상: %s\n" % BASE)
    answered = deflected = foreign = 0
    for i, (ch, q, keys) in enumerate(CASES, 1):
        uid = "probe-%s" % uuid.uuid4()
        try:
            a = ask(ch, q, uid)
        except Exception as e:
            print("%2d. [%-8s] ERROR %s" % (i, ch, e)); continue
        hit = any(k.lower() in a.lower() for k in keys)
        defl = any(d in a for d in DEFLECT)
        frn = FOREIGN.findall(a)
        answered += hit; deflected += defl; foreign += bool(frn)
        flags = ("답변O" if hit else "답변X") + (" 되묻기" if defl else "") + \
                (" 외국어%s" % "".join(sorted(set(frn))[:4]) if frn else "")
        print("%2d. [%-8s] %-14s %s" % (i, ch, flags, q))
        print("      -> %s" % a[:150].replace("\n", " / "))
    n = len(CASES)
    print("\n%s\n답변 성공 %d/%d | 되묻기 %d/%d | 외국어 혼입 %d/%d" %
          ("-" * 60, answered, n, deflected, n, foreign, n))

main()
