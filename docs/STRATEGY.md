# ParkCast strategy

The durable decisions. Product and engineering choices in this repo should be
checked against this file; update it when the strategy genuinely changes, not
per feature.

## Positioning

**Digital signage for entertainment venues. Unlimited screens. One price per
location.** Underneath: use your existing TVs · connect your booking system ·
manage every location remotely · no per-screen fees.

Do NOT lead with AI, and do not position as generic signage. The sentence no
competitor can say — the category claim — is: **"Your booking system runs
your screens."**

## ICP (initial, hold tight)

Independent or small-chain trampoline park / FEC operator, 1–20 locations,
**8–30 TVs per location**, currently on Fire TV/Android TV hardware with
Yodeck/Directable/manual-USB/Canva workflows. This segment is too small for
enterprise signage white-glove and too screen-heavy for per-screen pricing —
exactly where flat-rate vertical wins.

## Pricing

**No per-screen fees, ever.** That phrase is the marketing, not "$4/screen
instead of $8."

- Single Venue: $79–149/location/month
- Pro Venue (integrations + party automation): ~$199/location/month
- Multi-location: negotiated per-location rate
- Enterprise: platform fee + low per-location fee

Economics: competitors charge per screen because it's a convenient value
metric, not because screen #21 costs them anything. Our marginal screen cost
is pennies (cached media, tiny state pushes). A 25-screen park: Yodeck Basic
$200/mo vs. us $99/mo — $1,212/yr saved per location, against their
*cheapest* tier. The sales contrast: "Need another TV? Plug it in" vs.
"+$12/month forever."

**Price is the wedge, not the moat.** Yodeck can ship an FEC plan any time.
The moat ladder: no-per-screen pricing → easy sale → ROLLER integration →
POS/Toast integration → party automation → location hierarchy → FEC-specific
workflows → deeply embedded. Cheaper AND the system understands their
business.

## Platform discipline

Support **Fire TV / Android TV + the web player. Nothing else.** No
Raspberry Pi, Tizen, webOS, BrightSign, Roku. Tell customers: "for
guaranteed support use one of these three $30–50 sticks." Chasing device
breadth is how Yodeck accumulated its compatibility matrix; it is
deliberately not our game.

## Competitive facts that drive decisions (researched Sept 2026)

- **Nobody** connects booking systems to screens as a standalone product.
  ROLLER lists 65 integration partners, zero signage. Being ROLLER's first
  signage partner is the highest-leverage move available. CenterEdge has a
  POS-locked ~$50/mo name-display add-on; Hangar.Media does real
  booking-driven takeovers but UK-bowling-only.
- Generic content playback is commoditizing to ~zero (Samsung VXT:
  $20–40/display/**year**). Never compete on template counts, widget
  catalogs, per-screen price, or AI features.
- Rockbot owns music/TV licensing at FEC chains (Altitude, Lucky Strike):
  coexist as the party-and-ops layer, concede audio.
- Our demo-blocking gaps, in order: offline playback, park template pack,
  monitoring/alerts, roles/multi-location. Full analysis in the competitive
  landscape review.

## Switching is a product feature

The pitch to a venue on a competitor: "Send us your current screen setup and
content. We migrate everything. Your staff plugs in players." 30-day
one-location pilot. The decision becomes "why wouldn't we try one location"
instead of "should we rip out our system."

## Sequencing (set Sept 2026)

1. Sky Zone Schaumburg live on all screens — the pilot, the case study, and
   the demo video. Target: mid-October 2026.
2. Five external venues live by end of November 2026, run as single-tenant
   instances (multi-tenancy is deferred until after the five are live —
   five Render services from this repo is fine and fast).
3. ROLLER partnership outreach starts immediately (long lead time); CSV
   remains the universal fallback and is NOT a launch blocker.
4. Then: multi-tenancy, template packs at depth, QR rebooking attribution,
   sponsor-ad module (venue keeps the revenue).
