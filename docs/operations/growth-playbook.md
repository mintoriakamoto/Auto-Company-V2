# Growth Playbook — Getting to First Paying Customers

This is the operating manual the autonomous loop follows to turn a shipped
product into **paying customers**. The North Star is **MRR**. Everything here
exists to make the perception → action → measurement loop real: you post
tracked links, customers convert, `/admin/metrics` reports it, and the loop
sees the result next cycle and doubles down on what works.

## The one rule that makes attribution work

**Every product URL posted publicly MUST carry a `?ref=<channel>` tag.**

Without it, `source` is `direct` and the loop is blind. Examples:

- Product Hunt: `https://snapog.dev/?ref=producthunt`
- A Reddit comment in r/SaaS: `https://snapog.dev/?ref=reddit-rsaas`
- Cold email to a prospect: `https://snapog.dev/?ref=cold-email`
- A blog post / SEO page: `https://snapog.dev/?ref=seo-<slug>`

`?ref=` (or `utm_source=`) is captured at `/register` and stored on the user,
so `/admin/metrics` can break MRR down by channel.

## Channels (map to existing skills)

| Channel | Skill to use | Tracked ref |
|---|---|---|
| Product Hunt + communities | `ph-community-outreach`, `community-led-growth` | `producthunt`, `indiehackers`, `hn` |
| Reddit / niche forums | `ph-community-outreach` | `reddit-<sub>` |
| Cold outbound | `cold-email-sequence-generator`, `email-sequence` | `cold-email` |
| SEO / content | `seo-content-strategist`, `content-strategy`, `seo-audit` | `seo-<slug>` |
| Positioning / messaging | `marketing-godin` agent | (applies to all) |

## Weekly growth cycle

1. **Read the scoreboard.** Pull `/admin/metrics` (already injected as "Live
   Metrics" each cycle). Note MRR, conversion rate, and the top/bottom channels.
2. **Decide from data, not vibes.** Double down on the highest-MRR channel; cut
   or fix the lowest-converting one. If MRR is $0, the job is *one* channel done
   well end-to-end, not five half-started.
3. **Ship one tracked motion.** e.g. a Product Hunt launch, a 5-touch cold-email
   sequence, or one SEO pillar page — each with its `?ref=` link.
4. **Instrument, then wait for signal.** Record the action + expected channel in
   `memories/consensus.md` under Active Projects so next cycle can attribute it.
5. **Convert, don't just acquire.** If signups rise but paying stays flat, the
   gap is activation/pricing, not traffic — fix the funnel (onboarding, the
   upgrade prompt, the offer) before buying more attention.

## Decision rules

- No paying customers yet → the entire company's Next Action is "get the first
  paying customer," full stop. One channel, one tracked link, one week.
- A channel shows paying customers → pour effort there; it is working.
- A channel shows signups but zero paying after a fair trial → the problem is
  the product/offer for that audience, not the channel volume.
- Never report revenue that `/admin/metrics` does not confirm. Ground truth
  only.

## Definition of a real "launch"

A product is launched only when: it is deployed, it can take payment
(Stripe `/billing/*`), and at least one tracked acquisition channel is live.
Anything less is a draft.
