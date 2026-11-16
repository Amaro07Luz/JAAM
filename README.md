# Stevens Parking — camera prototype (MGT 103)

One phone films the garage entrance and counts cars. Every other phone opens the
Stevens Parking app and sees the open-space count change within about a second.
No sensors, no app store, nothing to buy.

```
 Camera phone (/camera)            Your laptop (server.js)              Student phones (/)
 ┌───────────────────┐  "car IN"   ┌──────────────────────┐   live     ┌──────────────────┐
 │ films the lane    │ ──────────► │ keeps the count:     │ ─────────► │ 88 open of 436   │
 │ detects crossings │  WebSocket  │ open = 436 − cars    │  WebSocket │ holds, alerts,   │
 └───────────────────┘             │        − holds       │            │ chart, board     │
                                   └──────────────────────┘            └──────────────────┘
```

---

## How it works

### 1. Detecting a car (`public/detector.js`)
This is the camera version of "two sensors 1 m apart":

1. The page draws two boxes, **A** and **B**, across the lane.
2. For the first couple of seconds it learns what the **empty lane** looks like (the background).
3. Every frame (about 15 per second) it shrinks the picture to 160 px wide, turns it grey, and checks
   how many pixels inside each box look different from the background.
4. If more than 20% of a box changed, that box is **blocked**.
5. **A blocked, then B → a car moving A→B. B, then A → B→A.** You choose which direction means IN.
6. After a count it waits until both boxes are clear before it can count the next car.
7. The background keeps slowly updating, so gradual light changes are ignored.

**Optional AI check:** turn on *"Only count if the AI sees a vehicle"* in Settings. The page downloads a
small free object-detection model (COCO-SSD, runs in the browser) and only counts a crossing if it sees a
car, truck, bus or motorcycle in the boxes. This filters out people walking through. It's slower on old
phones, so try without it first.

### 2. Keeping the count (`server.js`)
- `open spaces = 436 − cars inside − active holds`
- Entrance camera: **IN** adds 1 car, **OUT** removes 1.
- The count can never go below 0 or above 436.
- Everything is saved to `data.json`, so restarting the laptop doesn't lose the count.
- The trend line ("Filling fast · full in about 25 min") comes from cars in and out over the last 15 minutes.

### 3. The app (`public/index.html` + `app.js`), following the mockup
| Mockup screen | In the prototype |
|---|---|
| Welcome / login | Works. You type a name instead of a real Stevens SSO + Duo login. |
| Parking (garage card, trend, by level) | Live from the camera. Levels say "Not counted yet" until ramps have cameras (see below). |
| Level detail + "Open spaces today" chart | Real chart from today's counts, plus a dashed 30-minute trend. |
| Hold a space (10/15/20 min) | Works. The space shows as taken for everyone, the next car to enter uses the hold, and the space is released if no car comes in time. 3 no-shows pause holds. |
| "Alert me below 20 open" | In-app alert + vibration (and a phone notification if you allow it in Account). |
| Display board (dark) | `#/board`. Open it on a laptop or TV. |
| EV chargers / low-emission spots, "Where on this level" zones | Left out on purpose: they need sensors on specific spaces (phase 2). |

**Per-level counts:** set up a camera on each ramp (choose "Ramp Level 1 ↔ 2", etc. on the camera page;
IN = driving up). Once all 3 ramps have reported, the levels turn on. For the demo you can fake ramp
traffic with the buttons on the Admin page.

---

## Running it

You need **Node.js 18+** (nodejs.org).

```bash
cd stevens-parking
npm install
npm start
```

Open **http://localhost:3000** (app) and **http://localhost:3000/camera** (camera) on the laptop.
On the laptop, the webcam works straight away because browsers allow cameras on `localhost`.

### Using real phones
Phone browsers only allow the camera on **https://** pages. The easiest way to get an https link
is a free Cloudflare quick tunnel (no account needed):

```bash
# install once:  Mac: brew install cloudflared     Windows: winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:3000
```

It prints a link like `https://random-words.trycloudflare.com`. Then:
- **Camera phone:** open `https://…trycloudflare.com/camera`
- **Everyone else:** open `https://…trycloudflare.com`. You can also choose "Add to Home Screen" so it looks like an app.

The laptop must stay on, with `npm start` and `cloudflared` both running. The link changes each time you restart cloudflared.

---

## How to test it (do these in order)

### Test 0: automatic tests (1 minute)
```bash
npm test
```
This runs 7 detector tests (fake cars moving across fake frames, including a car that reverses out
and a slow lighting change) and 17 server tests (counting, holds, limits, live updates).

### Test 1: no camera, just the app (5 minutes)
1. Open the app in two browser tabs (or on two phones).
2. In one, go to Account → **Admin & calibration** and press **Car enters** a few times.
3. ✅ The other tab's number drops right away, and the chart moves.
4. Hold a space → the count drops by 1. Press **Car enters** → the hold is used ("My hold" empties).
5. Make a 10-minute hold and wait → it expires and the space comes back.

### Test 2: camera on your desk (10 minutes)
1. Open `/camera` on the laptop, then press **Start camera** with nothing in front of it for 2 s.
2. Move a book or your hand across box A, then box B.
3. ✅ "CAR IN +1" flashes, and the app tab updates. Go the other way and you get OUT.
4. If the wrong way counts as IN: Settings → *Which way is "IN"* → swap.
5. If it misses: lower **Sensitivity**. If it counts random things: raise it. Turn on the
   **"what changed" mask** to see what the camera is reacting to.

### Test 3: recorded video (best test before going to the garage)
1. Film 10–15 minutes at the Babbio entrance on a phone (hold it steady or use a tripod; ask Parking Services first).
2. On the camera page tap **Use a video file** and pick the clip. Adjust the boxes so cars cross both.
3. Watch the same clip yourself and **count the cars by hand**.
4. **Accuracy = cars the camera counted correctly ÷ real cars.** Note misses and double counts separately.
   Try again with the AI check on and compare.

### Test 4: live at the garage (the demo)
1. Calibrate first: count the cars already parked (or start early when it's nearly empty), then enter
   that number in **Admin → Calibrate**.
2. Mount the camera phone so cars cross the frame **sideways** (side-on works best; avoid pointing it
   straight into headlights). Plug it into a power bank. The page keeps the screen on.
3. Leave it running for the morning rush and record by hand for 20 minutes as a check.
4. Afterwards you have: the "Open spaces today" chart, an accuracy %, and a cost of $0.

### Tips for good counts
- The **boxes should cover the car's body**, not the floor where people walk.
- Put **A and B far enough apart** that a car doesn't block both at the same time (about a car length).
- Steady camera + steady lighting matters more than a good phone.
- One lane per camera works best. If entry and exit lanes are side by side, put the boxes over one lane,
  or use two phones.

---

## Known limitations (good to say in the presentation)
- The count slowly **drifts** if a car is missed. Real systems recalibrate every night, and you can use Admin.
- A hold reserves a **number**, not a specific spot, and any car entering uses the oldest hold.
  Real enforcement would need license-plate recognition or a QR check-in.
- The login is a name only. Real Stevens SSO would be phase 2.
- Data lives on your laptop. Hosting it (e.g. on Render or a Stevens server) is the next step.

## Files
```
server.js            server: count, holds, history, live updates
public/detector.js   two-box car detector (also used by the tests)
public/camera.html   camera counter page   (+ camera.js)
public/index.html    Stevens Parking app   (+ app.js, style.css)
test/                automatic tests
```
