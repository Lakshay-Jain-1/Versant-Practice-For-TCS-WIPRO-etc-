import json
import re
from collections import defaultdict

NAMES = set("""
asha sana pooja meera farah isha kavya ravi karan anil varun rohan rahul dev harsh
aditya imran arjun neha leela tara maya diya nandini sneha priya nikhil vikram kabir
ananya menon sharma
""".split())
PLACES = set("""
mysore delhi pune chennai kochi surat indore lucknow jaipur nagpur mumbai bangalore
bengaluru hyderabad kolkata ahmedabad
""".split())
DAYS = set("sunday monday tuesday wednesday thursday friday saturday".split())
NUMBERS = set("""
zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen
fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy
eighty ninety hundred
""".split())


def skeleton(text):
    text = text.lower()
    text = re.sub(r"today,\s*item\s*\d+", " ", text)
    text = re.sub(r"\bitem\s*\d+\b", " ", text)
    text = re.sub(r"[^a-z0-9']+", " ", text)
    words = []
    for word in text.split():
        if word in NAMES or word in PLACES or word in DAYS or word in NUMBERS or word.isdigit():
            words.append("#")
        else:
            words.append(word)
    return " ".join(words)


def words(text):
    return len(re.findall(r"[A-Za-z0-9']+", text))


def dedupe(items):
    kept = []
    seen = set()
    for item in items:
        key = skeleton(item)
        if key in seen:
            continue
        seen.add(key)
        kept.append(item)
    return kept


WARMUP = [
    "The keys are on the front desk.",
    "Please water the plants before leaving.",
    "Our team meets every Monday morning.",
    "The scanner stopped working after lunch.",
    "She booked a cab for the airport.",
    "Please turn off the lights tonight.",
    "The invoice is due next week.",
    "He spilled coffee on the keyboard.",
    "We need a new box of pens.",
    "The gate closes at eight tonight.",
    "Please stack these files on the shelf.",
    "Her badge is still at reception.",
    "The fan in this room is loud.",
    "I forgot to lock the cupboard.",
    "They shifted the chairs into the hall.",
    "Please collect your parcel from security.",
    "The whiteboard marker has dried out.",
    "We ran out of printed forms.",
    "She left a note on your chair.",
    "Please refill the soap in the washroom.",
    "Please silence your phone in the lab.",
    "He returned the spare key yesterday.",
    "The corridor lights switch off early.",
    "I saved the draft on my laptop.",
    "They painted the lobby last weekend.",
]

LEVEL2 = [
    "The courier left the parcel with the guard at noon.",
    "Please confirm that the visitor badge was returned yesterday.",
    "We will test the new software on a spare laptop.",
    "She asked the team to review the slides before the demo.",
    "The canteen will serve only packed lunch during the repairs.",
    "He could not join the call because his headset broke.",
    "Please keep the emergency exit clear at all times.",
    "The accounts team needs the receipts before the month ends.",
    "We moved the spare chairs into the room beside reception.",
    "She will share the recording after the workshop finishes.",
    "The security guard asked everyone to sign the night register.",
    "Please label each box before it goes into storage.",
    "He found the missing cable behind the projector stand.",
    "The office will stay open late for the inventory count.",
    "We should send a reminder about the fire drill tomorrow.",
    "She replaced the torn notice on the staff board.",
    "The driver is waiting outside with the signed delivery note.",
    "Please do not unplug the server during the backup.",
    "He booked two extra seats for the guests from finance.",
    "The cleaner will mop this floor after the shift ends.",
]

# prompt, good reply, two replies that do not fit
RESPONSES = [
    ("The projector will not connect to my laptop.", "Try the spare cable in the drawer.", "The canteen closes at two.", "She joined the team last year."),
    ("Could someone take notes while I present?", "I can. I'll send them after the session.", "The bus leaves from gate four.", "My badge is in the drawer."),
    ("The taxi I booked still has not arrived.", "I'll call the desk and ask for another one.", "The slides use a blue background.", "Please water the plants."),
    ("I left my charger in the meeting room.", "I'll check the table by the window.", "The exam is next month.", "He prefers the aisle seat."),
    ("We're out of clean mugs in the kitchen.", "I'll wash a few and put them on the rack.", "The client liked the logo.", "Her train gets in at six."),
    ("The client wants the quote before this evening.", "I'll finish the numbers and send it by four.", "The lobby was painted last week.", "I already locked the gate."),
    ("Can you watch the front desk for a short while?", "Yes. I'll stay until you get back.", "The library book is overdue.", "Add more salt to the soup."),
    ("I think that alarm is only a practice drill.", "Let's wait for the announcement before we leave.", "The newsletter needs a title.", "He bought a new umbrella."),
    ("My screen keeps freezing during the video call.", "Close the extra tabs and join again.", "The sports day is on Saturday.", "Please sign the birthday card."),
    ("Has the printer jammed on this floor again?", "Yes. I'll clear the paper from the tray.", "The guest likes window seats.", "Our team won the quiz."),
    ("We need one more chair for the guest.", "I'll bring one from the room next door.", "The password changed in March.", "She studies in the evening."),
    ("The cafeteria stops serving lunch at two.", "Then let's go down before the queue gets long.", "The contract has six pages.", "I left my coat at home."),
    ("I can't hear you. Your microphone seems muted.", "Thanks. I had switched it off by mistake.", "The garden needs more shade.", "Rent is due on the first."),
    ("Could we start the tour with the lab?", "Of course. I'll ask the team to expect us.", "The film starts at nine.", "Please recycle the bottles."),
    ("The parcel at reception is addressed to you.", "I'll collect it on my way out.", "The kettle takes too long.", "He missed the morning lecture."),
    ("I'm not sure which bay the shuttle uses.", "It leaves from the bay beside the main gate.", "The cake is in the fridge.", "We need more staplers."),
    ("The air conditioning in this room is too cold.", "I'll raise the setting by a couple of degrees.", "The match was cancelled.", "She writes with her left hand."),
    ("Did anyone see where I put the spare keys?", "They're hanging on the hook by the door.", "The budget was approved.", "Please book a window table."),
    ("We should tell the guard about the late van.", "I'll call him so he can let it in.", "The choir meets on Fridays.", "My shoes are by the stairs."),
    ("The link you sent asks me for a password.", "Use the one from this morning's mail.", "The picnic is in the park.", "He sold his old bicycle."),
    ("I may be a few minutes late for the briefing.", "We'll start with the updates and wait for you.", "The curtains are too short.", "Please feed the fish."),
    ("Can the workshop be recorded for people away?", "Yes. I'll start the recording when we begin.", "The soup is too salty.", "She lives near the river."),
    ("This spreadsheet is missing last month's column.", "I'll add it and send you the new file.", "The dog is in the yard.", "We painted the fence."),
    ("The visitor is waiting downstairs in the lobby.", "I'll come down and bring them up.", "The novel has twenty chapters.", "Please close the blinds."),
    ("We have no sticky notes left in the cupboard.", "I'll pick some up from the stationery shop.", "The flight lands at noon.", "He forgot his glasses."),
    ("Would you proofread this paragraph for me?", "Happy to. Send it across.", "The gym closes at ten.", "I watered the tulips."),
    ("The lift is stuck between two floors.", "I'll report it, and we'll use the stairs.", "The poem is very short.", "Please sharpen the pencils."),
    ("I need a quiet corner for a short interview.", "The small room at the end of the hall is empty.", "The apples are on sale.", "She knits on the bus."),
    ("The badge machine is not printing names.", "Switch it off, wait a minute, and try again.", "The lake freezes in winter.", "We ordered garlic bread."),
    ("Could you introduce me to the new analyst?", "Yes. She sits at the desk near the window.", "The play begins at seven.", "Please sweep the porch."),
    ("We forgot to book a return cab for the guests.", "I'll arrange one for half past five.", "The museum is free today.", "He lost a button."),
    ("The handbook on the intranet is out of date.", "I'll replace it with last week's version.", "The cat is on the sofa.", "Bring a warm jacket."),
    ("I'm locked out of the shared folder again.", "I'll ask the help desk to restore your access.", "The bakery opens at dawn.", "She collects old stamps."),
    ("The coffee machine is showing an error light.", "Unplug it, and I'll request a repair.", "The river is very wide.", "Please fold the napkins."),
    ("Can we shift the standup to just after lunch?", "That works. I'll tell the rest of the team.", "The violin needs new strings.", "He walked to the market."),
    ("Someone left the lab door propped open.", "I'll close it and remind them about the rule.", "The stars are bright tonight.", "We bought fresh mangoes."),
    ("The chart on this slide is too small to read.", "I'll enlarge it and move the caption below.", "The ferry leaves hourly.", "Please dust the shelves."),
    ("I didn't catch the second speaker's name.", "It was Mr. Menon from the finance team.", "The garden gate is rusty.", "She prefers green tea."),
    ("We should order an extra vegetarian meal.", "I'll add one when I confirm the booking.", "The piano is out of tune.", "He fixed the leaky tap."),
    ("The backup drive is almost full.", "I'll move last year's files onto the archive.", "The zoo closes at dusk.", "Please iron the shirts."),
    ("Could you hold my calls for the next hour?", "Certainly. I'll take messages at the desk.", "The hill road is steep.", "We planted two trees."),
    ("The sign on the door still shows the old event.", "I'll swap it for today's notice.", "The soup needs more pepper.", "She missed the last bus."),
    ("I'm having trouble finding the east staircase.", "Walk past reception and it's on your left.", "The movie was too long.", "Please charge the torch."),
    ("The sample box arrived with a broken seal.", "Don't open it. I'll inform the supplier.", "The pond has frozen over.", "He enjoys morning walks."),
    ("We need a volunteer to meet the school group.", "I can do it. What time do they arrive?", "The curtains faded in the sun.", "Add sugar to the tea."),
    ("My headset battery died in the middle of the call.", "Plug it in, and I'll say you'll rejoin.", "The library smells of books.", "She bought a red scarf."),
    ("The form asks for a manager's signature.", "Leave it with me and I'll sign it after lunch.", "The kite is stuck in a tree.", "Please wash the grapes."),
    ("Can the interns sit in on this discussion?", "Yes, if they listen and save questions for later.", "The oven is still hot.", "He collects bus tickets."),
    ("The street outside is closed for a parade.", "Then let's leave a little earlier than planned.", "The cushion has a tear.", "We need more hangers."),
    ("I think I emailed the wrong version of the memo.", "Send a short note with the correct file attached.", "The birds nest on the roof.", "Please boil the milk."),
    ("The pantry filter needs a new cartridge.", "I'll order one and tape a note on the tap.", "The painting is crooked.", "She sings in the choir."),
    ("Would you like me to book the aisle seat?", "Yes, please. I prefer not to sit in the middle.", "The clock battery is dead.", "He repaired the fence."),
    ("The clock in the hall is ten minutes fast.", "Thanks. I'll set my watch by my phone instead.", "The bread is still warm.", "Please open the curtains."),
    ("We still haven't chosen a name for the newsletter.", "Let's decide at the end of this meeting.", "The suitcase is too heavy.", "She feeds the sparrows."),
    ("The scanner keeps saying the page is too long.", "Try the flatbed instead of the feeder.", "The road is full of puddles.", "We rented a small car."),
    ("I can cover the help desk on Thursday afternoon.", "That's a relief. I'll update the roster.", "The honey has crystallized.", "Please trim the hedge."),
    ("The guest asked whether we have a prayer room.", "Yes. It's on the ground floor, past the clinic.", "The radio is too loud.", "He forgot the house keys."),
    ("Could you dim the lights before the video starts?", "I'll turn them down now.", "The well is nearly dry.", "She baked a small cake."),
    ("This receipt is for a personal purchase.", "Then it cannot go on the expense claim.", "The path is covered in leaves.", "Please wind the clock."),
    ("The new intern doesn't know where to park.", "Tell them to use the open lot behind the building.", "The soup boiled over.", "We watched the sunset."),
    ("We should apologize for sending the draft late.", "I'll write to the client this morning.", "The ladder is in the shed.", "She tied her shoelace."),
    ("Is there a first-aid box on this floor?", "Yes. It's on the wall beside the fire hose.", "The rice needs more water.", "He closed the shop early."),
    ("The microphone on the podium is crackling.", "I'll swap it with the one from the training room.", "The towel is still damp.", "Please peel the oranges."),
    ("I promised to send the photos after the event.", "I can upload them to the shared album tonight.", "The fence needs a coat of paint.", "She lost her hairpin."),
    ("The door code was changed over the weekend.", "The new one is in the message from security.", "The tea is too sweet.", "We hired a small van."),
    ("Can we keep the questions until the end?", "Yes. Please hold them and we'll take them together.", "The pillow is too soft.", "He watered the lawn."),
    ("The plant by the window looks very dry.", "I'll water it before I leave.", "The ticket machine is broken.", "Please lock the garage."),
    ("I need someone to double-check this addition.", "Read me the figures and I'll add them up.", "The sky looks stormy.", "She mended the torn sleeve."),
    ("The courier refused the package because it was open.", "Seal it again and I'll call them back.", "The bench is wet from rain.", "We sang the school song."),
    ("Two candidates are waiting at the same time.", "I'll take one next door, and you start with the other.", "The jam has gone mouldy.", "Please shut the attic."),
    ("The subtitle file doesn't match the video.", "I'll adjust the timing and export it again.", "The rope is badly frayed.", "He polished his shoes."),
    ("Could you save me a copy of the handout?", "There's a pile on the table. I'll keep one aside.", "The pond smells of algae.", "She packed a light bag."),
    ("The fan above my desk is rattling.", "I'll raise a maintenance ticket for it.", "The grapes are still sour.", "Please wipe the mirror."),
    ("I don't have building access for the weekend.", "Ask security for a temporary pass before you leave on Friday.", "The candle has burned down.", "We crossed the old bridge."),
    ("The welcome banner is still in the storeroom.", "I'll bring it up and we'll hang it before they arrive.", "The soup lacks salt.", "He folded the clean sheets."),
    ("Someone unplugged the router to charge a phone.", "I'll plug it back in and move the charger.", "The path is very muddy.", "Please stack the chairs."),
]


def main():
    sentences = json.load(open("data/sentences.json", encoding="utf-8"))
    sentences["warmup"] = dedupe(sentences["warmup"]) + WARMUP
    sentences["level2"] = dedupe(sentences["level2"]) + LEVEL2
    sentences["level3"] = dedupe(sentences["level3"])
    bands = {"warmup": (6, 8), "level2": (9, 12), "level3": (13, 16)}
    for band, (lo, hi) in bands.items():
        items = sentences[band]
        seen = {}
        assert len(items) >= 100, (band, len(items))
        for item in items:
            count = words(item)
            assert lo <= count <= hi, (band, count, item)
            key = skeleton(item)
            assert key not in seen, (band, item, seen[key])
            seen[key] = item
        print(band, len(items))
    json.dump(sentences, open("data/sentences.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    open("data/sentences.json", "a", encoding="utf-8").write("\n")

    old = json.load(open("data/responses.json", encoding="utf-8"))
    kept = [item for item in old if not str(item["id"]).startswith("resp-gen")]
    assert len(kept) == 24, len(kept)
    assert len(RESPONSES) == 76, len(RESPONSES)
    built = []
    for index, (prompt, good, bad1, bad2) in enumerate(RESPONSES):
        options = [good, bad1, bad2]
        shift = index % 3
        options = options[shift:] + options[:shift]
        built.append({
            "id": "resp-%d" % (25 + index),
            "prompt": prompt,
            "options": options,
            "answer": options.index(good),
        })
    responses = kept + built
    seen = {}
    for item in responses:
        assert "item " not in item["prompt"].lower(), item["prompt"]
        assert len(item["options"]) == 3
        assert item["answer"] in (0, 1, 2)
        assert len(set(item["options"])) == 3
        key = skeleton(item["prompt"])
        assert key not in seen, (item["prompt"], seen[key])
        seen[key] = item["prompt"]
    assert len(responses) == 100
    json.dump(responses, open("data/responses.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    open("data/responses.json", "a", encoding="utf-8").write("\n")
    print("responses", len(responses))


if __name__ == "__main__":
    main()
