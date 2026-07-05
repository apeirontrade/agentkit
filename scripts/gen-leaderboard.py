#!/usr/bin/env python3
"""Render the Provenance snapshot JSON into a static, themed leaderboard HTML."""
import json, html
from datetime import datetime
from urllib.parse import urlparse

snap = json.load(open("scratch/provenance-snapshot.json"))
rows = snap["rows"]

# Merge in delivery-probe results (we paid endpoints; did they return valid data?)
delivery = {}
try:
    dj = json.load(open("scratch/provenance-delivery.json"))
    for r in dj.get("results", []):
        delivery[r["payTo"]] = r
except FileNotFoundError:
    pass
n_paid = sum(1 for r in delivery.values() if r.get("delivered") is True)

SEV = {"low": "#3FB77E", "medium": "#D8A73A", "high": "#E27C3A", "critical": "#E5484D"}
taken = datetime.fromisoformat(snap["takenAt"].replace("Z", "+00:00"))
taken_str = taken.strftime("%B %-d, %Y · %H:%M UTC")

counts = {"low": 0, "medium": 0, "high": 0, "critical": 0}
for r in rows:
    counts[r["washLevel"]] += 1
gradeable = sum(1 for r in rows if r["grade"] != "INSUFFICIENT_DATA")

def host(urls):
    for u in urls:
        n = urlparse(u).netloc or u
        if "localhost" in n or "127.0.0.1" in n:
            return "local dev endpoint"
        return n
    return "—"

def esc(s):
    return html.escape(str(s)) if s is not None else ""

def drift_cell(r):
    d = r["drift"]
    if d is None:
        return '<span class="muted">—</span>'
    if r["onChainPayments"] == 0 and r["facilitatorSettle"] > 0:
        return f'<span class="drift neg">−{abs(d)}</span><span class="drift-note">claimed off-chain / testnet</span>'
    sign = "+" if d >= 0 else "−"
    cls = "pos" if d >= 0 else "neg"
    return f'<span class="drift {cls}">{sign}{abs(d)}</span><span class="drift-note">direct vs facilitator</span>'

cards = []
for i, r in enumerate(rows, 1):
    sev = r["washLevel"]
    col = SEV[sev]
    name = r.get("nfdName") or host(r["resourceUrls"])
    addr = r["payTo"]
    short = addr[:6] + "…" + addr[-4:]
    grade = r["grade"]
    grade_txt = "not gradeable" if grade == "INSUFFICIENT_DATA" else f'{grade} · {r["orq"]}'
    grade_cls = "na" if grade == "INSUFFICIENT_DATA" else "graded"
    desc = (r.get("description") or "").strip()
    if len(desc) > 68:
        desc = desc[:66].rstrip() + "…"
    flag = r["topFlags"][0] if r["topFlags"] else ""
    dv = delivery.get(addr, {})
    dstate = dv.get("delivered")
    if dstate is True:
        deliver_badge = f'<span class="deliver yes" title="{esc(dv.get("snippet",""))}">✓ delivers · paid {dv.get("priceUsdc","?")}</span>'
    elif dstate is False:
        deliver_badge = '<span class="deliver no">✗ no delivery</span>'
    else:
        deliver_badge = ''
    cards.append(f"""
    <article class="card" style="--sev:{col}">
      <div class="stripe"></div>
      <div class="card-body">
        <div class="row-top">
          <div class="ident">
            <span class="rank">{i:02d}</span>
            <div class="ident-text">
              <div class="name">{esc(name)}</div>
              <div class="sub"><span class="host">{esc(host(r["resourceUrls"]))}</span><span class="addr">{esc(short)}</span></div>
            </div>
          </div>
          <div class="verdicts">
            {deliver_badge}
            <span class="grade {grade_cls}">{esc(grade_txt)}</span>
            <span class="wash" style="--sev:{col}">
              <span class="wash-level">{sev}</span>
              <span class="wash-score">{r["washScore"]}<span class="of">/100</span></span>
            </span>
          </div>
        </div>
        <div class="meter"><span style="width:{r['washScore']}%;background:{col}"></span></div>
        <div class="row-bottom">
          <dl class="stats">
            <div><dt>on-chain</dt><dd>{r["onChainPayments"]} pay · {r["onChainPayers"]} payers · {r["nClusters"]} clusters</dd></div>
            <div><dt>facilitator</dt><dd>{r["facilitatorSettle"]} settled · {r["facilitatorVerify"]} verified</dd></div>
            <div><dt>drift</dt><dd>{drift_cell(r)}</dd></div>
          </dl>
          <p class="flag"><span class="mark">⚑</span>{esc(flag)}</p>
        </div>
      </div>
    </article>""")

cards_html = "\n".join(cards)

doc = f"""<title>Provenance — Algorand x402 Revenue Quality</title>
<style>
  :root {{
    --bg:#F5F7FA; --panel:#FFFFFF; --elev:#FBFCFE; --line:#E3E8EF;
    --ink:#141A24; --muted:#5B6879; --faint:#8695AB;
    --accent:#0FA894; --accent-ink:#0B7A6B;
    --grade-na:#8695AB;
    --shadow:0 1px 2px rgba(20,26,36,.05),0 8px 24px -12px rgba(20,26,36,.12);
    --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
    --sans:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  }}
  @media (prefers-color-scheme:dark) {{
    :root {{
      --bg:#0A0D13; --panel:#121722; --elev:#161C28; --line:#232C3B;
      --ink:#E7ECF4; --muted:#8695AB; --faint:#5D6B80;
      --accent:#3AD6C0; --accent-ink:#3AD6C0;
      --grade-na:#5D6B80;
      --shadow:0 1px 2px rgba(0,0,0,.3),0 12px 32px -16px rgba(0,0,0,.6);
    }}
  }}
  :root[data-theme="light"] {{
    --bg:#F5F7FA; --panel:#FFFFFF; --elev:#FBFCFE; --line:#E3E8EF;
    --ink:#141A24; --muted:#5B6879; --faint:#8695AB;
    --accent:#0FA894; --accent-ink:#0B7A6B; --grade-na:#8695AB;
    --shadow:0 1px 2px rgba(20,26,36,.05),0 8px 24px -12px rgba(20,26,36,.12);
  }}
  :root[data-theme="dark"] {{
    --bg:#0A0D13; --panel:#121722; --elev:#161C28; --line:#232C3B;
    --ink:#E7ECF4; --muted:#8695AB; --faint:#5D6B80;
    --accent:#3AD6C0; --accent-ink:#3AD6C0; --grade-na:#5D6B80;
    --shadow:0 1px 2px rgba(0,0,0,.3),0 12px 32px -16px rgba(0,0,0,.6);
  }}
  * {{ box-sizing:border-box; }}
  body {{
    margin:0; background:var(--bg); color:var(--ink);
    font-family:var(--sans); line-height:1.5;
    -webkit-font-smoothing:antialiased;
    font-feature-settings:"tnum" 1,"cv01" 1;
  }}
  .wrap {{ max-width:1000px; margin:0 auto; padding:clamp(20px,4vw,52px) clamp(16px,3vw,28px) 72px; }}

  /* Masthead */
  header {{ display:flex; flex-wrap:wrap; gap:16px 24px; align-items:baseline; justify-content:space-between;
           border-bottom:1px solid var(--line); padding-bottom:22px; }}
  .brand {{ display:flex; align-items:baseline; gap:12px; }}
  .mark-logo {{ width:11px; height:11px; border-radius:2px; background:var(--accent); transform:translateY(1px);
               box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent); }}
  .wordmark {{ font-family:var(--mono); font-weight:600; font-size:19px; letter-spacing:.14em;
              text-transform:uppercase; }}
  .tagline {{ color:var(--muted); font-size:13.5px; max-width:34ch; }}
  .meta {{ font-family:var(--mono); font-size:11.5px; color:var(--faint); text-align:right; letter-spacing:.02em; }}
  .meta b {{ color:var(--muted); font-weight:500; }}

  /* Thesis */
  .thesis {{ margin:38px 0 34px; }}
  .thesis h1 {{ font-size:clamp(26px,4.6vw,40px); line-height:1.08; letter-spacing:-.02em; margin:0 0 14px;
               text-wrap:balance; font-weight:640; }}
  .thesis h1 em {{ font-style:normal; color:var(--accent-ink); }}
  .thesis p {{ margin:0; color:var(--muted); font-size:15.5px; max-width:66ch; }}

  .tiles {{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin:26px 0 40px; }}
  @media (max-width:620px) {{ .tiles {{ grid-template-columns:repeat(2,1fr); }} }}
  .tile {{ background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px 16px 14px; box-shadow:var(--shadow); }}
  .tile .n {{ font-family:var(--mono); font-size:29px; font-weight:600; letter-spacing:-.02em; line-height:1; }}
  .tile .l {{ margin-top:8px; font-size:11px; text-transform:uppercase; letter-spacing:.09em; color:var(--faint); }}
  .tile.warn .n {{ color:{SEV['critical']}; }}

  /* Section label */
  .probe-note {{ margin:0 0 40px; padding:16px 18px; background:var(--elev); border:1px solid var(--line);
                border-radius:12px; color:var(--muted); font-size:14px; max-width:none; }}
  .probe-note b {{ color:var(--accent-ink); font-family:var(--mono); }}
  .seclabel {{ display:flex; align-items:center; gap:14px; margin:8px 0 16px; }}
  .seclabel h2 {{ font-family:var(--mono); font-size:12px; letter-spacing:.16em; text-transform:uppercase;
                 color:var(--muted); font-weight:600; margin:0; white-space:nowrap; }}
  .seclabel .line {{ flex:1; height:1px; background:var(--line); }}
  .seclabel .legend {{ display:flex; gap:12px; font-family:var(--mono); font-size:10.5px; color:var(--faint); }}
  .seclabel .legend span {{ display:inline-flex; align-items:center; gap:5px; text-transform:uppercase; letter-spacing:.06em; }}
  .seclabel .legend i {{ width:8px; height:8px; border-radius:2px; }}

  /* Cards */
  .list {{ display:flex; flex-direction:column; gap:12px; }}
  .card {{ position:relative; display:flex; background:var(--panel); border:1px solid var(--line);
          border-radius:13px; overflow:hidden; box-shadow:var(--shadow); }}
  .stripe {{ width:4px; flex:0 0 4px; background:var(--sev); }}
  .card-body {{ flex:1; padding:16px 18px 15px; min-width:0; }}
  .row-top {{ display:flex; justify-content:space-between; align-items:flex-start; gap:16px; }}
  .ident {{ display:flex; gap:14px; align-items:baseline; min-width:0; }}
  .rank {{ font-family:var(--mono); font-size:12px; color:var(--faint); letter-spacing:.05em; padding-top:2px; }}
  .ident-text {{ min-width:0; }}
  .name {{ font-weight:600; font-size:16px; letter-spacing:-.01em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
  .sub {{ display:flex; gap:10px; align-items:center; margin-top:3px; font-family:var(--mono); font-size:11.5px; }}
  .host {{ color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:42vw; }}
  .addr {{ color:var(--faint); }}
  .verdicts {{ display:flex; align-items:center; gap:12px; flex-shrink:0; }}
  .deliver {{ font-family:var(--mono); font-size:10px; letter-spacing:.02em; padding:5px 8px; border-radius:7px;
             white-space:nowrap; border:1px solid var(--line); cursor:default; }}
  .deliver.yes {{ color:{SEV['low']}; border-color:color-mix(in srgb,{SEV['low']} 38%,transparent);
                 background:color-mix(in srgb,{SEV['low']} 10%,transparent); }}
  .deliver.no {{ color:{SEV['high']}; border-color:color-mix(in srgb,{SEV['high']} 38%,transparent); }}
  .grade {{ font-family:var(--mono); font-size:11px; letter-spacing:.03em; padding:5px 9px; border-radius:7px;
           white-space:nowrap; border:1px solid var(--line); }}
  .grade.na {{ color:var(--grade-na); }}
  .grade.graded {{ color:{SEV['low']}; border-color:color-mix(in srgb,{SEV['low']} 40%,transparent); }}
  .wash {{ display:flex; flex-direction:column; align-items:flex-end; padding:5px 11px; border-radius:8px;
          background:color-mix(in srgb,var(--sev) 13%,transparent);
          border:1px solid color-mix(in srgb,var(--sev) 34%,transparent); }}
  .wash-level {{ font-family:var(--mono); font-size:9.5px; text-transform:uppercase; letter-spacing:.11em;
                color:var(--sev); font-weight:600; }}
  .wash-score {{ font-family:var(--mono); font-size:19px; font-weight:600; line-height:1; color:var(--sev); }}
  .wash-score .of {{ font-size:10px; color:var(--sev); opacity:.6; font-weight:400; }}
  .meter {{ height:3px; border-radius:2px; background:var(--line); margin:13px 0 13px; overflow:hidden; }}
  .meter span {{ display:block; height:100%; border-radius:2px; }}
  .row-bottom {{ display:flex; flex-wrap:wrap; gap:12px 26px; align-items:center; justify-content:space-between; }}
  .stats {{ display:flex; flex-wrap:wrap; gap:10px 26px; margin:0; }}
  .stats div {{ display:flex; flex-direction:column; gap:3px; }}
  .stats dt {{ font-size:9.5px; text-transform:uppercase; letter-spacing:.09em; color:var(--faint); }}
  .stats dd {{ margin:0; font-family:var(--mono); font-size:12.5px; color:var(--ink); }}
  .drift {{ font-weight:600; }}
  .drift.pos {{ color:var(--muted); }}
  .drift.neg {{ color:{SEV['critical']}; }}
  .drift-note {{ color:var(--faint); font-size:10px; margin-left:7px; letter-spacing:.02em; }}
  .flag {{ margin:0; font-size:12.5px; color:var(--muted); display:flex; gap:7px; align-items:baseline;
          max-width:52ch; }}
  .flag .mark {{ color:var(--sev,var(--faint)); flex-shrink:0; }}
  .card .flag .mark {{ color:var(--sev); }}

  /* Footer */
  footer {{ margin-top:48px; border-top:1px solid var(--line); padding-top:24px;
           color:var(--muted); font-size:13px; }}
  footer h3 {{ font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase;
              color:var(--faint); margin:0 0 12px; font-weight:600; }}
  footer p {{ margin:0 0 12px; max-width:74ch; }}
  footer .fine {{ font-family:var(--mono); font-size:11px; color:var(--faint); display:flex; flex-wrap:wrap; gap:6px 18px; margin-top:18px; }}
  footer a {{ color:var(--accent-ink); text-decoration:none; }}
  footer a:hover {{ text-decoration:underline; }}
  em.term {{ font-style:normal; color:var(--ink); font-weight:500; }}
</style>

<div class="wrap">
  <header>
    <div>
      <div class="brand"><span class="mark-logo"></span><span class="wordmark">Provenance</span></div>
      <p class="tagline">Organic-revenue quality for machine-payable endpoints. On-chain forensics for the x402 economy.</p>
    </div>
    <div class="meta">
      <div><b>SNAPSHOT</b> {taken_str}</div>
      <div><b>CHAIN</b> Algorand mainnet · USDC 31566704</div>
      <div><b>SOURCE</b> GoPlausible discovery · Nodely indexer</div>
    </div>
  </header>

  <section class="thesis">
    <h1>Nine live endpoints. <em>Zero</em> with organic revenue.</h1>
    <p>Algorand's x402 rails are live and the Global x402 Challenge leaderboard is filling — but every endpoint's revenue today traces to one to six wallets, most self-funded, several freshly created. Provenance reads the chain and reports which revenue is real. Right now, none of it is — yet.</p>
  </section>

  <div class="tiles">
    <div class="tile"><div class="n">{len(rows)}</div><div class="l">endpoints analyzed</div></div>
    <div class="tile"><div class="n">{snap['totalRoutes']}</div><div class="l">priced routes</div></div>
    <div class="tile"><div class="n">{gradeable}</div><div class="l">with organic demand</div></div>
    <div class="tile warn"><div class="n">{counts['critical']+counts['high']}</div><div class="l">high / critical wash risk</div></div>
  </div>

  <p class="probe-note">We paid <b>{n_paid}</b> of these endpoints a real USDC micropayment to verify delivery. Several return genuinely useful data — a BTC price proof, on-chain account intelligence, prediction-market arbitrage — yet still rate high wash risk. <em class="term">Delivering data and having organic revenue are different things.</em> An endpoint can work perfectly and still have no real customers.</p>

  <div class="seclabel">
    <h2>Endpoint ledger</h2>
    <span class="line"></span>
    <span class="legend">
      <span><i style="background:{SEV['low']}"></i>low</span>
      <span><i style="background:{SEV['medium']}"></i>med</span>
      <span><i style="background:{SEV['high']}"></i>high</span>
      <span><i style="background:{SEV['critical']}"></i>crit</span>
    </span>
  </div>

  <div class="list">
{cards_html}
  </div>

  <footer>
    <h3>How to read this</h3>
    <p><em class="term">Wash risk</em> is a 0–100 assessment available at any size, built from public on-chain facts: how many <em class="term">distinct payers</em> an endpoint has, whether revenue concentrates in one cluster, whether payout money loops back to payers, how fresh the payer wallets are, whether payments arrive on a metronome, and whether wallets share a controlling key (rekey Sybil). <em class="term">Drift</em> compares each endpoint's on-chain USDC payments against the facilitator's self-reported settlement count — large gaps flag revenue that can't be corroborated on mainnet.</p>
    <p><em class="term">Grade</em> (Organic Revenue Quality, A–F) is only assigned once an endpoint clears a data floor of 50 payments from 10 distinct payer clusters. Below that we decline to grade — which, pre-Challenge, is every endpoint.</p>
    <p>These are statistical opinions on public data — signals, not accusations. An endpoint owner whose payers are a legitimate customer's agent fleet can show that; the methodology, its confidence intervals, and an appeals path are part of the design.</p>
    <div class="fine">
      <span>Methodology v0.1.0</span>
      <span>Window {snap['windowDays']} days</span>
      <span>Generated {taken_str}</span>
      <span>Not investment advice</span>
    </div>
  </footer>
</div>

<script>
  (function(){{
    var root=document.documentElement;
    // respect a viewer toggle if one stamps data-theme; otherwise follow OS.
    try {{
      var t=localStorage.getItem('provenance-theme');
      if(t) root.setAttribute('data-theme',t);
    }} catch(e){{}}
  }})();
</script>
"""

open("scratch/provenance-leaderboard.html", "w").write(doc)
print("wrote scratch/provenance-leaderboard.html", len(doc), "bytes")
