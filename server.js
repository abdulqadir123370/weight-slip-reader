// ============================================================================
// WEIGHT SLIP READER v2 — reads net weight AND the printed date from a photo
// of a scale receipt. Drop-in replacement for the v1 service; same URL, same
// endpoint, same auth, same request/response shape — PLUS two new fields:
//   slipDate           "YYYY-MM-DD" or null — the date printed on the slip
//   slipDateConfidence "high" | "medium" | "low"
// The BrushTracker app (build 1786349383507+) already consumes both.
//
// Zero npm dependencies — pure Node (18+). Railway env vars required:
//   ANTHROPIC_API_KEY   (unchanged from v1)
//   SHARED_SECRET       (unchanged — must match WEIGHT_SLIP_READER_SECRET in the app)
//   MODEL               optional, defaults to claude-haiku-4-5 (cheap, fast, accurate for OCR)
//   PORT                provided by Railway automatically
// ============================================================================
const http = require('http');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const SHARED_SECRET = process.env.SHARED_SECRET;
const MODEL = process.env.MODEL || 'claude-haiku-4-5';
const PORT = process.env.PORT || 8080;

const PROMPT = `You are reading a photo of a printed weighing-scale receipt (weight slip) from a factory in Pakistan. Extract exactly two things:

1. NET WEIGHT in kilograms. Slips may show gross/tare/net — always prefer the NET figure. If only one weight is printed, use it. Convert grams to KG if needed.
2. THE DATE printed on the slip. Pakistani slips normally print dates day-first (DD/MM/YYYY or DD-MM-YY). Interpret day-first unless the slip explicitly shows otherwise. Convert to ISO format YYYY-MM-DD.

Respond with ONLY a JSON object, no markdown fences, no other text:
{
  "netWeightKg": <number or null if no weight is readable>,
  "confidence": "<high|medium|low>",
  "slipDate": "<YYYY-MM-DD or null if no date is readable>",
  "slipDateConfidence": "<high|medium|low>",
  "notes": "<very short note ONLY if something is ambiguous, else empty string>"
}

Confidence rules — be strict, a wrong number silently accepted is worse than a rejection:
- "high" only when the figure is clearly printed and unambiguous.
- Blurry, cut off, handwritten, multiple conflicting candidates, or ambiguous day/month → "medium" or "low".
- A date whose year is missing → report with "low" confidence using the most recent plausible year.`;

function json(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, {'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Headers':'Content-Type, Authorization', 'Access-Control-Allow-Methods':'POST, GET, OPTIONS'});
  res.end(body);
}

const server = http.createServer((req, res) => {
  if(req.method === 'OPTIONS'){ return json(res, 204, {}); }
  if(req.method === 'GET'){ return json(res, 200, {ok:true, service:'weight-slip-reader', version:2, dateExtraction:true}); }
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
          model: MODEL, max_tokens: 400,
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
      const conf = ['high','medium','low'].includes(parsed.confidence) ? parsed.confidence : 'low';
      let slipDate = null, dConf = 'low';
      if(typeof parsed.slipDate==='string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.slipDate) && !isNaN(new Date(parsed.slipDate).getTime())){
        const y = +parsed.slipDate.slice(0,4);
        if(y>=2020 && y<=2035){
          slipDate = parsed.slipDate;
          dConf = ['high','medium','low'].includes(parsed.slipDateConfidence) ? parsed.slipDateConfidence : 'low';
        }
      }
      return json(res, 200, {success:true, netWeightKg:kg, confidence:conf, slipDate, slipDateConfidence:dConf, notes: String(parsed.notes||'').slice(0,200)});
    }catch(e){
      console.error('read-slip failed:', e);
      return json(res, 502, {success:false, error:'reader service error'});
    }
  });
});

server.listen(PORT, () => console.log('weight-slip-reader v2 (with date extraction) listening on', PORT));
