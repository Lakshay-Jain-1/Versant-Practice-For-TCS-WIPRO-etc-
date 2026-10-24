import json
import re
from collections import defaultdict

data = json.load(open("data/sentences.json", encoding="utf-8"))
names = set("asha sana pooja meera farah isha kavya ravi karan anil varun rohan rahul dev harsh aditya imran arjun neha leela tara maya diya nandini sneha priya nikhil vikram kabir ananya pooja".split())
cities = set("mysore delhi pune chennai kochi surat indore lucknow jaipur nagpur mumbai bangalore bengaluru hyderabad kolkata ahmedabad".split())
days = set("sunday monday tuesday wednesday thursday friday saturday".split())

def sk(s):
    t = s.lower()
    t = re.sub(r"[^a-z0-9]+", " ", t)
    words = []
    for w in t.split():
        if w in names or w in cities or w in days or w.isdigit():
            words.append("#")
        else:
            words.append(w)
    return " ".join(words)

def wc(s):
    return len(re.findall(r"[A-Za-z0-9']+", s))

resp = json.load(open("data/responses.json", encoding="utf-8"))
print("--- original prompts ---")
for item in resp:
    if not str(item["id"]).startswith("resp-gen"):
        print(item["id"], item["prompt"])

print("--- warmup kept ---")
for band, items in data.items():
    groups = defaultdict(list)
    for s in items:
        groups[sk(s)].append(s)
    clones = {k: v for k, v in groups.items() if len(v) > 1}
    extra = sum(len(v) - 1 for v in clones.values())
    print(band, "count", len(items), "unique_sk", len(groups), "clone_groups", len(clones), "extras", extra)
    counts = defaultdict(int)
    for s in items:
        counts[wc(s)] += 1
    print("  words", dict(sorted(counts.items())))
    print("  clone samples:")
    for k, v in list(clones.items())[:8]:
        print("   ", len(v), k[:90])
