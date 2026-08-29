// ============================================================================
// WEIGHT SLIP READER v3 — fixes a real misread bug found 13/08/2026: Pakistani
// "Kanta" (weighbridge) slips often print the weight FOUR ways — First, Second,
// Net (boxed, in KG), and an alternate "Maunds (@ 40kg/Maund): 24 M and 35 KG"
// line. v2's prompt said "prefer the NET figure" but never explained this
// fourth line, so the model sometimes grabbed the trailing "...and 35 KG"
// REMAINDER (the leftover after whole maunds) and reported THAT as the entire
// net weight — e.g. reporting 35 KG for a slip whose real net weight was 995 KG.
// Confirmed on two real slips uploaded by the Owner (995kg and 835kg, both
// misread down to their Maunds remainder). v3 fixes this two ways:
//   1. The prompt now explicitly names and separates all four numbers, states
//      the Maunds line is NEVER the answer, and requires the printed NET WEIGHT
//      box as the primary source.
//   2. The model also returns first/second/maundsTotal for cross-checking;
//      this server verifies second-first, the net box, and the Maunds total
//      all agree before trusting "high" confidence — any mismatch (the exact
//      signature of this bug) is forced down to "low" rather than silently
//      accepted, even if the model's top-level answer looked confident.
// Same drop-in contract as v2 — same URL, same endpoint, same auth, same
// external response shape (netWeightKg, confidence, slipDate,
// slipDateConfidence) — so nothing else in the app needs to change.
const http = require('http');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const SHARED_SECRET = process.env.SHARED_SECRET;
const MODEL = process.env.MODEL || 'claude-haiku-4-5';
const PORT = process.env.PORT || 8080;

const PROMPT = `You are reading a photo of a printed weighing-scale receipt (weight slip / "Kanta parchi") from a factory in Pakistan. These slips commonly print the weight in FOUR different places — you must tell them apart correctly:

1. FIRST WEIGHT (پہلا وزن / "First Weight") — a KG figure, usually the tare/empty reading.
2. SECOND WEIGHT (دوسرا وزن / "Second Weight") — a KG figure, the loaded reading.
3. NET WEIGHT (نیٹ ویٹ / "Net Weight") — a KG figure in its own box, usually = Second minus First. THIS is the number you report as netWeightKg.
4. An ALTERNATE line, often printed as "Maunds (@ 40kg/Maund): 24 M and 35 KG" or similar. This expresses the SAME net weight in a different unit (maunds), NOT a different weight. The "35 KG" at the end of that line is only the LEFTOVER REMAINDER after dividing into whole 40kg maunds — it is a small number by definition (always under 40) and is NEVER the total net weight. A real net weight of 995 KG might be printed here as "24 M and 35 KG" (24×40+35=995) — if you report "35" as the net weight instead of "995", that is a serious error. Do not use this line as your primary source; only use it to CROSS-CHECK your answer (maunds×40 + remainder should equal your netWeightKg).

Respond with ONLY a JSON object, no markdown fences, no other text:
{
  "firstWeightKg": <number or null>,
  "secondWeightKg": <number or null>,
  "netWeightKg": <number or null — the boxed NET WEIGHT figure, or Second minus First if the box itself is unclear>,
  "maundsTotalKg": <number or null — ONLY if a Maunds line is printed, compute maunds×40+remainder; null if no such line exists>,
  "serialNo": "<the slip's serial number (سیریل نمبر), digits/text exactly as printed, or null if not readable>",
  "cNo": "<the C-NO. / receipt number printed on the slip (e.g. from a line like C-NO.= 19246), or null>",
  "confidence": "<high|medium|low>",
  "slipDate": "<YYYY-MM-DD or null if no date is readable>",
  "slipDateConfidence": "<high|medium|low>",
  "notes": "<very short note ONLY if something is ambiguous or the cross-check numbers disagree, else empty string>"
}

Pakistani slips normally print dates day-first (DD/MM/YYYY or DD-MM-YY) — interpret day-first unless the slip explicitly shows otherwise, and convert to ISO YYYY-MM-DD.

Confidence rules — be strict, a wrong number silently accepted is worse than a rejection:
- "high" only when the net weight is clearly printed and unambiguous, AND (if a Maunds line exists) it matches maundsTotalKg.
- Blurry, cut off, handwritten, multiple conflicting candidates, ambiguous day/month, or any mismatch between netWeightKg and maundsTotalKg → "medium" or "low".
- A date whose year is missing → report with "low" confidence using the most recent plausible year.`;

function json(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, {'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Headers':'Content-Type, Authorization', 'Access-Control-Allow-Methods':'POST, GET, OPTIONS'});
  res.end(body);
}

// .trim() added 29/08/2026: a stray space/newline pasted into the Railway var mangles the
// key and Google then sees NO credential at all ("Expected OAuth 2 access token" 401).
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
// Model default fixed 16/08/2026: 'gemini-1.5-flash' was the original default but that
// model line was retired for new projects back in April 2025 — it was already dead, which
// is exactly why /report returned a 404 the moment it was first used. gemini-3.5-flash is
// the current free-tier GA model (confirmed against Google's own pricing page 16/08/2026:
// genuinely free, not a "-preview" build that can vanish without notice, and the strongest
// reasoning available at no cost — matters for complicated cost-analysis narration).
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

// ============================================================================
// /report — AI REPORT ASSISTANT (v5, added 13/08/2026 on Owner request)
// Architecture decision (agreed with Owner): ALL arithmetic stays in the app's
// own tested code. The app compiles pre-computed figures (costing rates, pools,
// totals) and sends them here; the model's ONLY job is selecting, comparing and
// narrating those figures — it is explicitly instructed never to compute new
// numbers. A server-side verification pass then extracts every numeric figure
// the report quotes and checks it exists in the input data; unmatched figures
// are listed in an "unverified" footer rather than silently trusted. Runs on
// Gemini's free tier (GEMINI_API_KEY env var, from aistudio.google.com) —
// model-agnostic on purpose, one env-var swap away from anything else.
// ============================================================================
const REPORT_PROMPT_HEADER = `You are the reporting assistant for a brush manufacturing factory's tracking system (Royal Plastics, Karachi). You will receive (1) a question from the factory owner and (2) a JSON dataset of PRE-COMPUTED figures from the factory's audited tracking software.

STRICT RULES — these exist because your report may drive real business decisions:
- Quote ONLY numbers that appear in the dataset. NEVER compute, derive, add, subtract, average or estimate new numbers yourself — not even simple sums. The software already computed everything trustworthy.
- If answering well would require arithmetic the dataset doesn't already contain, say so plainly ("the system doesn't pre-compute X") and describe the DIRECTION of the comparison in words instead (higher/lower/roughly similar), without inventing a magnitude.
- If the dataset doesn't contain what's asked, say exactly that. Never guess or fill gaps.
- Currency is Pakistani Rupees (Rs.), weights in KG, quantities in pcs. Dates are YYYY-MM-DD.
- Be direct and structured: short headed sections, the key finding first. Flag anything that looks like a problem (negative variance, pending approvals, cash owed, unusually low yield) prominently.
- Write in the language the question was asked in (English, Urdu, or Roman Urdu).

Now the owner's question and the dataset follow.`;

function collectNumbersFromData(obj, out){
  if(obj==null) return;
  if(typeof obj==='number' && isFinite(obj)){
    const a = Math.abs(obj); // prose writes "-35 KG" as "shortfall of 35 KG" — abs variants must match
    out.add(String(obj)); out.add(String(a));
    out.add(String(Math.round(obj))); out.add(String(Math.round(a)));
    out.add(obj.toFixed(1)); out.add(obj.toFixed(2));
    out.add(a.toFixed(1)); out.add(a.toFixed(2));
    out.add(Math.round(a).toLocaleString('en-US'));
    return;
  }
  if(typeof obj==='string'){
    // strings in the data may themselves contain figures (e.g. "@ Rs.43/pc")
    (obj.match(/\d[\d,]*\.?\d*/g)||[]).forEach(n=>{ out.add(n); out.add(n.replace(/,/g,'')); });
    return;
  }
  if(Array.isArray(obj)){ obj.forEach(v=>collectNumbersFromData(v,out)); return; }
  if(typeof obj==='object'){ Object.values(obj).forEach(v=>collectNumbersFromData(v,out)); return; }
}
function verifyReportNumbers(report, data){
  const known = new Set();
  collectNumbersFromData(data, known);
  // small integers 0-31 are almost always dates/counts/ordinals in prose — too noisy to flag
  const candidates = (report.match(/\d[\d,]*\.?\d*/g)||[]);
  const unverified = [];
  for(const raw of candidates){
    const clean = raw.replace(/,/g,'');
    const asNum = parseFloat(clean);
    if(!isFinite(asNum)) continue;
    if(asNum>=0 && asNum<=31 && Number.isInteger(asNum)) continue;
    if(/^20\d\d$/.test(clean)) continue; // years
    if(known.has(raw) || known.has(clean)) continue;
    // Exact/formatted matches only for DECIMAL tokens — an integer-rounding fallback here
    // once let any invented decimal that merely ROUNDS to a known integer slip through
    // (e.g. a hallucinated "1.87" passing because a real "2.01" put "2" in the known set).
    // Integer tokens may still match the .0 form of a real decimal (report "205" vs data 205.0).
    if(Number.isInteger(asNum) && !clean.includes('.') && (known.has(asNum.toFixed(1)) || known.has(asNum.toFixed(2)))) continue;
    // Decimal tokens: exact or 2-decimal match ONLY. The 1-decimal tolerance was itself a
    // leak — a real 1.95 puts "1.9" in the known set, and a hallucinated 1.87 also rounds
    // to "1.9". Data-side variants already cover legitimate roundings (report "87.3" matches
    // data 87.31 through the data's own toFixed(1) entry), so the token side stays strict.
    if(clean.includes('.') && known.has(asNum.toFixed(2))) continue;
    if(!unverified.includes(raw)) unverified.push(raw);
  }
  return unverified;
}

async function handleReport(req, res, body){
  if(!GEMINI_API_KEY){ return json(res, 500, {success:false, error:'GEMINI_API_KEY not configured on the server'}); }
  const question = (body && typeof body.question==='string') ? body.question.trim().slice(0, 2000) : '';
  const data = body && body.data;
  if(!question){ return json(res, 400, {success:false, error:'missing question'}); }
  if(!data || typeof data!=='object'){ return json(res, 400, {success:false, error:'missing data'}); }
  const dataStr = JSON.stringify(data);
  if(dataStr.length > 400000){ return json(res, 400, {success:false, error:'dataset too large'}); }
  try{
    // Key moved from ?key= URL param to the x-goog-api-key header 29/08/2026 — Google's
    // recommended method; also keeps the key out of URLs (which end up in logs/proxies).
    const apiResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method:'POST', headers:{'Content-Type':'application/json', 'x-goog-api-key':GEMINI_API_KEY},
      body: JSON.stringify({
        contents:[{ role:'user', parts:[{ text: REPORT_PROMPT_HEADER + '\n\nOWNER QUESTION:\n' + question + '\n\nDATASET (pre-computed by the tracking software):\n' + dataStr }] }],
        generationConfig:{ temperature: 0.2, maxOutputTokens: 3000 }
      })
    });
    const out = await apiResp.json();
    if(!apiResp.ok){
      console.error('Gemini API error:', apiResp.status, JSON.stringify(out).slice(0,300));
      const hint = apiResp.status===429 ? ' (free-tier rate limit hit — wait a minute and try again)' : '';
      return json(res, 502, {success:false, error:'report model error ('+apiResp.status+')'+hint});
    }
    const report = (((out.candidates||[])[0]||{}).content||{}).parts?.map(p=>p.text||'').join('').trim() || '';
    if(!report){ return json(res, 502, {success:false, error:'empty report from model'}); }
    const unverified = verifyReportNumbers(report, data);
    return json(res, 200, {success:true, report, unverified});
  }catch(e){
    console.error('report failed:', e);
    return json(res, 502, {success:false, error:'report service error'});
  }
}

const server = http.createServer((req, res) => {
  if(req.method === 'OPTIONS'){ return json(res, 204, {}); }
  if(req.method === 'GET'){ return json(res, 200, {ok:true, service:'weight-slip-reader', version:5, dateExtraction:true, maundsCrossCheck:true, serialExtraction:true, reportAssistant:true, reportModel:GEMINI_MODEL}); }
  if(req.method !== 'POST' || !(req.url.startsWith('/read-slip') || req.url.startsWith('/report'))){ return json(res, 404, {success:false, error:'not found'}); }

  const auth = req.headers['authorization'] || '';
  if(!SHARED_SECRET || auth !== 'Bearer ' + SHARED_SECRET){ return json(res, 401, {success:false, error:'unauthorized'}); }
  // NOTE: the Anthropic-key check lives on the slip path only (below) — /report runs on
  // GEMINI_API_KEY and must not fail just because the slip reader's key is absent.

  let chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if(size > 15*1024*1024){ req.destroy(); } else chunks.push(c); });
  req.on('end', async () => {
    let body;
    try{ body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch(e){ return json(res, 400, {success:false, error:'invalid JSON body'}); }
    if(req.url.startsWith('/report')){ return handleReport(req, res, body); }
    if(!API_KEY){ return json(res, 500, {success:false, error:'ANTHROPIC_API_KEY not configured'}); }
    const image = body && body.image;
    const mediaType = (body && body.mediaType) || 'image/jpeg';
    if(!image || typeof image !== 'string'){ return json(res, 400, {success:false, error:'missing image (base64)'}); }

    try{
      const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'x-api-key':API_KEY, 'anthropic-version':'2023-06-01' },
        body: JSON.stringify({
          model: MODEL, max_tokens: 500,
          messages: [{ role:'user', content: [
            { type:'image', source:{ type:'base64', media_type: mediaType, data: image } },
            { type:'text', text: PROMPT }
          ]}]
        })
      });
      const data = await apiResp.json();
      if(!apiResp.ok){
        console.error('Anthropic API error:', apiResp.status, JSON.stringify(data).slice(0,300));
        return json(res, 502, {success:false, error:'reader model error ('+apiResp.status+')'});
      }
      const text = (data.content||[]).map(b=>b.type==='text'?b.text:'').join('').replace(/```json|```/g,'').trim();
      let parsed;
      try{ parsed = JSON.parse(text); }
      catch(e){
        console.error('Unparseable model reply:', text.slice(0,200));
        return json(res, 200, {success:true, netWeightKg:null, confidence:'low', slipDate:null, slipDateConfidence:'low', notes:'reader reply unparseable'});
      }

      // Sanitize — never trust shape blindly
      const kg = (typeof parsed.netWeightKg==='number' && isFinite(parsed.netWeightKg) && parsed.netWeightKg>0 && parsed.netWeightKg<100000) ? parsed.netWeightKg : null;
      let conf = ['high','medium','low'].includes(parsed.confidence) ? parsed.confidence : 'low';
      let slipDate = null, dConf = 'low';
      if(typeof parsed.slipDate==='string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.slipDate) && !isNaN(new Date(parsed.slipDate).getTime())){
        const y = +parsed.slipDate.slice(0,4);
        if(y>=2020 && y<=2035){
          slipDate = parsed.slipDate;
          dConf = ['high','medium','low'].includes(parsed.slipDateConfidence) ? parsed.slipDateConfidence : 'low';
        }
      }

      // ---- THE FIX: server-side cross-check, independent of what the model claims ----
      // This is what actually closes the bug — even if the model's own stated confidence
      // is "high", we verify the numbers agree before trusting it. Any disagreement forces
      // confidence down to "low" so the accountant is asked to weigh/check manually rather
      // than silently accepting a wrong figure, per the standing "wastage always requires a
      // real weight" rule.
      let notes = String(parsed.notes||'').slice(0,200);
      if(kg!=null){
        const first = (typeof parsed.firstWeightKg==='number' && isFinite(parsed.firstWeightKg)) ? parsed.firstWeightKg : null;
        const second = (typeof parsed.secondWeightKg==='number' && isFinite(parsed.secondWeightKg)) ? parsed.secondWeightKg : null;
        const maundsTotal = (typeof parsed.maundsTotalKg==='number' && isFinite(parsed.maundsTotalKg) && parsed.maundsTotalKg>0) ? parsed.maundsTotalKg : null;
        const mismatches = [];
        if(first!=null && second!=null){
          const expected = second - first;
          if(Math.abs(expected - kg) > Math.max(2, expected*0.02)) mismatches.push(`second-first=${expected} vs reported net=${kg}`);
        }
        if(maundsTotal!=null && Math.abs(maundsTotal - kg) > Math.max(2, maundsTotal*0.02)){
          mismatches.push(`Maunds line computes to ${maundsTotal} vs reported net=${kg}`);
        }
        if(mismatches.length>0){
          conf = 'low';
          notes = (`Cross-check mismatch, please verify manually: ${mismatches.join('; ')}. ` + notes).slice(0,200);
        }
      }

      const serialNo = (typeof parsed.serialNo==='string' && parsed.serialNo.trim()) ? parsed.serialNo.trim().slice(0,30) : null;
      const cNo = (typeof parsed.cNo==='string' && parsed.cNo.trim()) ? parsed.cNo.trim().slice(0,30) : null;
      return json(res, 200, {success:true, netWeightKg:kg, confidence:conf, slipDate, slipDateConfidence:dConf, serialNo, cNo, notes});
    }catch(e){
      console.error('read-slip failed:', e);
      return json(res, 502, {success:false, error:'reader service error'});
    }
  });
});

server.listen(PORT, () => console.log('weight-slip-reader v5 (slip reading + AI report assistant) listening on', PORT));
