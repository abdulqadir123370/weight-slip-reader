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

const server = http.createServer((req, res) => {
  if(req.method === 'OPTIONS'){ return json(res, 204, {}); }
  if(req.method === 'GET'){ return json(res, 200, {ok:true, service:'weight-slip-reader', version:4, dateExtraction:true, maundsCrossCheck:true, serialExtraction:true}); }
  if(req.method !== 'POST' || !req.url.startsWith('/read-slip')){ return json(res, 404, {success:false, error:'not found'}); }

  const auth = req.headers['authorization'] || '';
  if(!SHARED_SECRET || auth !== 'Bearer ' + SHARED_SECRET){ return json(res, 401, {success:false, error:'unauthorized'}); }
  if(!API_KEY){ return json(res, 500, {success:false, error:'ANTHROPIC_API_KEY not configured'}); }

  let chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if(size > 15*1024*1024){ req.destroy(); } else chunks.push(c); });
  req.on('end', async () => {
    let body;
    try{ body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch(e){ return json(res, 400, {success:false, error:'invalid JSON body'}); }
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

server.listen(PORT, () => console.log('weight-slip-reader v4 (Maunds cross-check + serial/C-No) listening on', PORT));
