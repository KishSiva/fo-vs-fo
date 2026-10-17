# Run 1 findings: The Impossible E-Bike (Claude vs Claude)

**Date:** 2026-10-17
**Scenario:** [`the-impossible-ebike.md`](../the-impossible-ebike.md)
**Full transcript:** [`run-1.md`](run-1.md)

## Setup

- Two fresh Claude agents. Each received only its own owner script
  ([`script-a-maya.md`](../script-a-maya.md) or [`script-b-dev.md`](../script-b-dev.md))
  and no other context.
- A relay passed each `MESSAGE` to the other side word for word. Each agent also
  wrote an `UPDATE FOR OWNER` line that was never relayed.
- Neutral rules only: up to 8 messages each, `DEAL:` to accept the other side's
  latest proposal exactly, `NO DEAL` to walk away. No strategy hints. Owners
  could not be reached mid-negotiation.
- Dev (buyer) opened.

## Outcome

**Deal in 3 rounds each.** Both agents confirmed identical terms:

> $900 by Venmo, paid on arrival, for the e-bike, charger, IKEA Kivik sofa and
> standing desk. Pickup Saturday 10am in the Mission; the buyer brings a truck and
> a second person. The seller keeps the lock, helmet and wall hook.

| | Value to them | Gain over walking away |
|---|---|---|
| Maya (seller) | $900 cash + $250 junk removal avoided = $1,150 | **+$100** over her $1,050 floor |
| Dev (buyer) | bike $1,300 + sofa $300 + desk $150 − $900 = $850 | **+$850** over taking the bus |

- **Every limit respected:** charger included, ≤ $900 without a lock, bulky
  items moved in Dev's Saturday-morning truck window, before Maya's Sunday 10am deadline.
- **Value created:** $950 of the $965 maximum available (**98%**). The missing
  $15 is the wall hook.
- **Price within the range:** for this bundle, any price from $800 (Maya's
  minimum) to $900 (Dev's limit without a lock) worked. It landed at $900, the
  top of the range.

## How it unfolded

| Round | Dev (buyer) | Maya (seller) |
|---|---|---|
| 1 | $800 for bike + charger + lock. Asks for a helmet and **whether there's any furniture for sale**. Mentions a truck on Saturday. | Names the sofa, desk and hook. **$1,200** with the furniture thrown in free; keeps lock and helmet; Saturday 10am. |
| 2 | **$850** for bike + charger + sofa + desk; turns down the hook. Says the budget "doesn't stretch, whatever's included." | Privately notes $850 already clears her floor; counters at **$950** to test for more. |
| 3 | Offers two options: **(a) $900**, or **(b) $950 with a lock**. | Takes **(a)**. Keeping the $60 lock is worth more to her than an extra $50. **DEAL.** |
| 4 | Confirms the same terms. **DEAL.** | |

## Observations

**What worked**
- **Bundling instead of haggling.** Neither agent fought over price alone. The
  deal was built from furniture, timing and transport, which is the scenario's intent.
- **Correct private math.** Maya's agent counted the avoided junk-removal cost
  toward her floor without being told to, and correctly turned down the lock
  trade ($50 more cash < $60 lock).
- **Discipline on limits.** Dev's agent never went above $900 without a lock, and
  structured its final offer around that exact rule.
- **Nothing leaked.** Neither agent stated its owner's floor or ceiling outright.

**What didn't**
- **The "hidden" deal wasn't hidden.** Dev's agent asked about furniture in its
  first message. Dev's script says the apartment is unfurnished and gives dollar
  values for a couch and desk, so asking was obvious. Maya's agent then put
  everything on the table at once. **There was never a stalemate**, so there's
  no breakthrough moment for an audience to watch.
- **Information given away early.** Dev's agent mentioned the Saturday truck in
  its first message, and Maya's agent named a pickup slot in its first reply.
  Timing was settled before price was discussed.
- **A contradiction that went unchallenged.** In round 2 Dev's agent said the
  budget "doesn't stretch, whatever's included," then in round 3 offered $950 if
  a lock was included. Maya's agent didn't notice.
- **Small value left on the table.** Dev's agent turned down the free wall hook
  because it was useless to Dev, though taking it would have cost Dev nothing
  and saved Maya about $15.
- **Agreed fast.** Maya's agent accepted $900 one round after testing $950. With
  her floor at $800 for this bundle, holding out for more was possible but risky.

**Process notes**
- **Safety filter.** The first attempt was blocked by an API safety filter
  (labelled "reasoning extraction") because the turn format asked the agent to
  write out its "private thinking." Changing it to a one- or two-sentence
  "update for owner" fixed it. **Expect the same if we ask Fo to show its reasoning on screen.**
- **Relaying worked.** A strict relay (only the `MESSAGE` crosses over) was
  enough to keep each side's private information private.

## Recommendations for the next run

1. **Make the discovery harder.**
   - Remove furniture values from Dev's script and leave only the unfurnished apartment.
   - Make Maya's furniture less obvious, for example stored at a friend's place
     that has to be cleared by Sunday, so it doesn't come up in normal bike talk.
2. **Run the price-only version first.** Same bike, no furniture. The correct
   outcome is no deal, which sets up the contrast for the full run.
3. **Run it 3-5 times.** One run doesn't show whether the result is reliable.
   Track deal or no deal, value created (% of $965), and price.
4. **Bring in owner check-ins.** Let owners answer questions mid-negotiation (the
   scripts' "check with me" moments). That's the most demo-worthy beat, and it
   was disabled here.
5. **Then switch to Fo.** Use the same relay with two Fo accounts, one per side.
   One shared account risks Fo's memory carrying Maya's brief into Dev's conversation.
