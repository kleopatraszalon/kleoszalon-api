export type OpenAiUsageLike={
  input_tokens?:number|null;
  output_tokens?:number|null;
  input_tokens_details?:{cached_tokens?:number|null}|null;
};

export type OpenAiTextPricing={
  inputUsdPer1M:number;
  cachedInputUsdPer1M:number;
  outputUsdPer1M:number;
  source:string;
};

// Verified public OpenAI PAYG text-token prices, USD per 1M tokens.
// Keep environment overrides available so production pricing can be changed without a deploy.
const VERIFIED_PRICING:Array<{prefix:string;pricing:OpenAiTextPricing}>=[
  {prefix:"gpt-5.6-sol",pricing:{inputUsdPer1M:5,cachedInputUsdPer1M:0.5,outputUsdPer1M:30,source:"openai_public_2026-08-11"}},
  {prefix:"gpt-5.6-terra",pricing:{inputUsdPer1M:2.5,cachedInputUsdPer1M:0.25,outputUsdPer1M:15,source:"openai_public_2026-08-11"}},
  {prefix:"gpt-5.6-luna",pricing:{inputUsdPer1M:1,cachedInputUsdPer1M:0.1,outputUsdPer1M:6,source:"openai_public_2026-08-11"}},
  {prefix:"gpt-5.4-mini",pricing:{inputUsdPer1M:0.75,cachedInputUsdPer1M:0.075,outputUsdPer1M:4.5,source:"openai_public_2026-08-11"}},
  {prefix:"gpt-5-mini",pricing:{inputUsdPer1M:0.25,cachedInputUsdPer1M:0.025,outputUsdPer1M:2,source:"openai_public_2026-08-11"}},
  {prefix:"gpt-5",pricing:{inputUsdPer1M:1.25,cachedInputUsdPer1M:0.125,outputUsdPer1M:10,source:"openai_public_2026-08-11"}},
];

function envNumber(name:string):number|null{
  const raw=process.env[name];
  if(raw===undefined||raw===null||String(raw).trim()==="")return null;
  const value=Number(raw);
  return Number.isFinite(value)&&value>=0?value:null;
}

export function resolveOpenAiTextPricing(model:string,envPrefix="BOOKING_VOICE_OPENAI"):OpenAiTextPricing|null{
  const specificInput=envNumber(`${envPrefix}_INPUT_USD_PER_1M`);
  const specificCached=envNumber(`${envPrefix}_CACHED_INPUT_USD_PER_1M`);
  const specificOutput=envNumber(`${envPrefix}_OUTPUT_USD_PER_1M`);
  if(specificInput!==null&&specificOutput!==null){
    return{inputUsdPer1M:specificInput,cachedInputUsdPer1M:specificCached??specificInput,outputUsdPer1M:specificOutput,source:`env:${envPrefix}`};
  }

  const genericInput=envNumber("OPENAI_INPUT_USD_PER_1M");
  const genericCached=envNumber("OPENAI_CACHED_INPUT_USD_PER_1M");
  const genericOutput=envNumber("OPENAI_OUTPUT_USD_PER_1M");
  if(genericInput!==null&&genericOutput!==null){
    return{inputUsdPer1M:genericInput,cachedInputUsdPer1M:genericCached??genericInput,outputUsdPer1M:genericOutput,source:"env:OPENAI"};
  }

  const normalized=String(model||"").trim().toLowerCase();
  return VERIFIED_PRICING.find(entry=>normalized.startsWith(entry.prefix))?.pricing||null;
}

const tokenCount=(value:unknown)=>Math.max(0,Math.trunc(Number(value)||0));
const money=(value:number)=>Math.round(value*1_000_000_000_000)/1_000_000_000_000;

export function estimateOpenAiTextCost(model:string,usage:OpenAiUsageLike,envPrefix="BOOKING_VOICE_OPENAI"){
  const inputTokens=tokenCount(usage?.input_tokens);
  const outputTokens=tokenCount(usage?.output_tokens);
  const cachedInputTokens=Math.min(inputTokens,tokenCount(usage?.input_tokens_details?.cached_tokens));
  const nonCachedInputTokens=inputTokens-cachedInputTokens;
  const pricing=resolveOpenAiTextPricing(model,envPrefix);
  if(!pricing){
    return{inputTokens,outputTokens,cachedInputTokens,nonCachedInputTokens,estimatedCostUsd:0,pricing:null,pricingResolved:false};
  }
  const estimatedCostUsd=money(
    nonCachedInputTokens/1_000_000*pricing.inputUsdPer1M+
    cachedInputTokens/1_000_000*pricing.cachedInputUsdPer1M+
    outputTokens/1_000_000*pricing.outputUsdPer1M
  );
  return{inputTokens,outputTokens,cachedInputTokens,nonCachedInputTokens,estimatedCostUsd,pricing,pricingResolved:true};
}
