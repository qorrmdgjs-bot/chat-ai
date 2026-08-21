# -*- coding: utf-8 -*-
"""언어 규칙 회귀 검증: 한국어 응답에 한자/가나/키릴/타이/베트남어가 섞이는 비율."""
import json,re,sys,urllib.request,uuid
BASE=(sys.argv[1] if len(sys.argv)>1 else "https://chat-ai.hr-ee4.workers.dev").rstrip("/")
FOREIGN=re.compile(r"[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\u0400-\u04ff\u0e00-\u0e7f"
                   r"\u1ea0-\u1ef9\u00c0-\u00ff]")
PROMPTS=[
 ("work","배송 지연이 제일 큰 문제인데 어떻게 접근해야 할까?"),
 ("work","팀원 5명으로 신규 프로젝트 우선순위를 정하는 방법 알려줘"),
 ("work","회의가 너무 길어지는데 줄이는 방법 있을까?"),
 ("work","재고 관리 지표로 뭘 봐야 해?"),
 ("work","외주 업체와 계약할 때 주의할 점 3가지"),
 ("work","분기 목표를 팀에 공유하는 좋은 방식은?"),
 ("work","업무 자동화를 어디부터 시작하면 좋을까"),
 ("personal","요즘 잠을 잘 못 자는데 도움될 만한 습관 알려줘"),
 ("personal","주말에 서울 근교 당일치기로 갈 만한 곳 추천해줘"),
 ("personal","단백질 위주 식단을 짜려면 뭘 고려해야 해?"),
 ("personal","독서 습관을 들이는 현실적인 방법"),
 ("personal","스트레스 받을 때 바로 할 수 있는 것"),
 ("personal","월급의 몇 퍼센트를 저축하는 게 좋을까?"),
 ("personal","운동을 꾸준히 하려면 어떻게 해야 해?"),
 ("personal","집중력이 떨어질 때 대처법 알려줘"),
]
def ask(ch,t,uid):
    req=urllib.request.Request(BASE+"/api/chat",
        data=json.dumps({"user_input":t,"user_id":uid,"channel":ch}).encode("utf-8"),
        headers={"Content-Type":"application/json","User-Agent":"probe/1"})
    o=[]
    with urllib.request.urlopen(req,timeout=120) as r:
        for raw in r:
            l=raw.decode("utf-8","replace").strip()
            if l.startswith("data: "):
                try: o.append(str(json.loads(l[6:]).get("text","")))
                except: pass
    return "".join(o)
def dele(uid):
    for ch in("work","personal"):
        try: urllib.request.urlopen(urllib.request.Request(
            BASE+"/api/memory/%s?channel=%s"%(uid,ch),method="DELETE",
            headers={"User-Agent":"probe/1"}),timeout=30)
        except: pass
print("대상: %s\n"%BASE)
bad=0
for i,(ch,q) in enumerate(PROMPTS,1):
    uid="langprobe-%s"%uuid.uuid4()
    try: a=ask(ch,q,uid)
    except Exception as e:
        print("%2d. ERROR %s"%(i,e)); continue
    f=FOREIGN.findall(a)
    if f:
        bad+=1
        ctx=[]
        for m in FOREIGN.finditer(a):
            s=max(0,m.start()-12); ctx.append(a[s:m.end()+12].replace("\n"," "))
        print("%2d. [%-8s] 혼입 %s"%(i,ch,"".join(sorted(set(f)))))
        for c in ctx[:3]: print("        ...%s..."%c)
    else:
        print("%2d. [%-8s] clean"%(i,ch))
    dele(uid)
print("\n%s\n외국어 혼입: %d/%d (%.0f%%)"%("-"*56,bad,len(PROMPTS),100.0*bad/len(PROMPTS)))
