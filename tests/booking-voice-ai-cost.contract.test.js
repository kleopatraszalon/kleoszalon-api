const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(process.cwd(),file),'utf8');

test('Voice Booking uses auditable model pricing instead of writing zero cost',()=>{
  const src=read('src/routes/bookingVoice.ts');
  assert.match(src,/estimateOpenAiTextCost/);
  assert.match(src,/usage\.estimatedCostUsd/);
  assert.doesNotMatch(src,/estimated_cost_usd\) VALUES\(\$1,\$2,\$3,\$4,0\)/);
});

test('billable OpenAI usage is logged even when intent JSON parsing later fails',()=>{
  const src=read('src/routes/bookingVoice.ts');
  const estimate=src.indexOf('estimateOpenAiTextCost(model');
  const usageInsert=src.indexOf('INSERT INTO ai_usage_log');
  const parse=src.indexOf('JSON.parse(extractOutputText');
  assert.ok(estimate>=0&&usageInsert>estimate&&parse>usageInsert,'usage/cost must be persisted before response parsing');
});

test('cost estimator handles cached input and official default gpt-5-mini rates',()=>{
  const src=read('src/ai/openAiCost.ts');
  assert.match(src,/prefix:"gpt-5-mini"/);
  assert.match(src,/inputUsdPer1M:0\.25/);
  assert.match(src,/cachedInputUsdPer1M:0\.025/);
  assert.match(src,/outputUsdPer1M:2/);
  assert.match(src,/input_tokens_details\?\.cached_tokens/);
  assert.match(src,/nonCachedInputTokens\/1_000_000\*pricing\.inputUsdPer1M/);
  assert.match(src,/cachedInputTokens\/1_000_000\*pricing\.cachedInputUsdPer1M/);
});

test('pricing can be overridden without deploy and unknown models do not invent a price',()=>{
  const src=read('src/ai/openAiCost.ts');
  assert.match(src,/BOOKING_VOICE_OPENAI/);
  assert.match(src,/OPENAI_CACHED_INPUT_USD_PER_1M/);
  assert.match(src,/pricingResolved:false/);
});

test('Voice health exposes pricing resolution for live UAT',()=>{
  const src=read('src/routes/bookingVoice.ts');
  assert.match(src,/ai_cost_estimation/);
  assert.match(src,/input_usd_per_1m/);
  assert.match(src,/cached_input_usd_per_1m/);
  assert.match(src,/output_usd_per_1m/);
});
