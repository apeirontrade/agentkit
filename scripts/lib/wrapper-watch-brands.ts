/**
 * Curated first-party API brand list for Wrapper Watch.
 *
 * Each brand: match terms (word-boundary regexes), the brand's own domains
 * (an endpoint hosted there is first-party, not a wrapper), a rough known
 * per-call USD price where public (for cost-plus-markup detection), and an
 * outbound note (does this company have budget + motive to pay for
 * unauthorized-reseller monitoring?).
 */

export interface Brand {
  id: string;
  name: string;
  /** Lowercase word-boundary terms. Matched against URL, description, schema, tags. */
  terms: string[];
  /** Suffix-matched official domains — endpoint hosted here is NOT a wrapper. */
  officialDomains: string[];
  category:
    | "knowledge"
    | "travel"
    | "search"
    | "maps"
    | "ai-model"
    | "social"
    | "weather"
    | "finance"
    | "news"
    | "media"
    | "security"
    | "crypto-data"
    | "web-data";
  /** Rough public per-call USD price for markup heuristics (optional). */
  knownUnitUsd?: number;
  /** Context regexes that VOID a term match (e.g. "twitter card" HTML metadata). */
  excludeContexts?: RegExp[];
  /** Why (or whether) this brand would pay for monitoring. */
  outboundNote: string;
}

export const BRANDS: Brand[] = [
  {
    id: "wolfram",
    name: "Wolfram|Alpha",
    terms: ["wolfram", "wolframalpha", "wolfram alpha"],
    officialDomains: ["wolfram.com", "wolframalpha.com", "wolframcloud.com"],
    category: "knowledge",
    knownUnitUsd: 0.025, // ~$25/1k queries (Full Results API)
    outboundNote: "Paid API with strict ToS; licensing team actively enforces.",
  },
  {
    id: "amadeus",
    name: "Amadeus",
    terms: ["amadeus"],
    officialDomains: ["amadeus.com", "amadeus.net"],
    category: "travel",
    knownUnitUsd: 0.01,
    outboundNote: "Enterprise GDS; flight-data redistribution requires a contract.",
  },
  {
    id: "skyscanner",
    name: "Skyscanner",
    terms: ["skyscanner"],
    officialDomains: ["skyscanner.net", "skyscanner.com"],
    category: "travel",
    outboundNote: "Partner-only API; public resale is unauthorized by default.",
  },
  {
    id: "google-maps",
    name: "Google Maps Platform",
    terms: ["google maps", "google places", "places api", "geocoding api", "google map"],
    officialDomains: ["googleapis.com", "google.com", "goog.le"],
    category: "maps",
    knownUnitUsd: 0.005, // geocoding $5/1k
    outboundNote: "ToS explicitly bans resale/caching; large enforcement budget.",
  },
  {
    id: "google-search",
    name: "Google Search (SERP)",
    terms: ["google search", "google serp", "serp results", "google results"],
    officialDomains: ["googleapis.com", "google.com"],
    category: "search",
    knownUnitUsd: 0.005, // Custom Search $5/1k
    outboundNote: "SERP scraping-resale is the canonical wrapper category.",
  },
  {
    id: "serpapi",
    name: "SerpApi",
    terms: ["serpapi", "serp api"],
    officialDomains: ["serpapi.com"],
    category: "search",
    knownUnitUsd: 0.01,
    outboundNote: "Itself a scraping vendor, but resale of its keys breaches its ToS.",
  },
  {
    id: "openai",
    name: "OpenAI",
    terms: ["openai", "gpt-4", "gpt-4o", "gpt-5", "chatgpt", "dall-e", "dalle", "o3", "sora"],
    officialDomains: ["openai.com", "oaistatic.com", "chatgpt.com"],
    category: "ai-model",
    knownUnitUsd: 0.01, // order-of-magnitude per typical completion
    outboundNote: "Key-resale/proxying violates usage policies; active enforcement team.",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    terms: ["anthropic", "claude"],
    officialDomains: ["anthropic.com", "claude.ai", "claude.com"],
    category: "ai-model",
    knownUnitUsd: 0.01,
    outboundNote: "Same key-resale concern as OpenAI; safety-sensitive brand.",
  },
  {
    id: "xai-grok",
    name: "xAI (Grok)",
    terms: ["grok", "xai api"],
    officialDomains: ["x.ai", "grok.com"],
    category: "ai-model",
    outboundNote: "Newer API, less policed — wrappers common.",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    terms: ["google gemini", "gemini pro", "gemini flash", "gemini-2", "gemini 2", "gemini api"],
    officialDomains: ["googleapis.com", "google.com", "deepmind.com"],
    category: "ai-model",
    outboundNote: "Same Google enforcement machinery as Maps.",
  },
  {
    id: "twitter",
    name: "X / Twitter",
    terms: ["twitter", "tweets", "tweet", "x.com"],
    officialDomains: ["twitter.com", "x.com", "twimg.com"],
    excludeContexts: [/twitter[: ]?card/i, /og[: ]?twitter/i], // HTML/OpenGraph metadata, not resale

    category: "social",
    knownUnitUsd: 0.005, // paid API tiers make per-read pricing real
    outboundNote: "Post-2023 paid API: unauthorized data resale is a revenue leak they litigate.",
  },
  {
    id: "reddit",
    name: "Reddit",
    terms: ["reddit", "subreddit"],
    officialDomains: ["reddit.com", "redd.it"],
    category: "social",
    knownUnitUsd: 0.00024, // $0.24/1k calls
    outboundNote: "Charges for API since 2023; scraped-data resale directly undercuts data-licensing deals.",
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    terms: ["linkedin"],
    officialDomains: ["linkedin.com", "licdn.com"],
    category: "social",
    outboundNote: "Famously litigious about scraping (hiQ); partner-only API.",
  },
  {
    id: "instagram",
    name: "Instagram",
    terms: ["instagram"],
    officialDomains: ["instagram.com", "facebook.com", "meta.com"],
    category: "social",
    outboundNote: "Meta platform ToS bans scraping/resale.",
  },
  {
    id: "tiktok",
    name: "TikTok",
    terms: ["tiktok"],
    officialDomains: ["tiktok.com", "tiktokv.com", "bytedance.com"],
    category: "social",
    outboundNote: "Research API is gated; commercial resale unauthorized.",
  },
  {
    id: "youtube",
    name: "YouTube Data",
    terms: ["youtube"],
    officialDomains: ["youtube.com", "googleapis.com", "ytimg.com"],
    category: "media",
    outboundNote: "Quota-limited free API; resale breaches API Services ToS.",
  },
  {
    id: "weatherapi",
    name: "WeatherAPI.com",
    terms: ["weatherapi"],
    officialDomains: ["weatherapi.com"],
    category: "weather",
    knownUnitUsd: 0.0001,
    outboundNote: "Small vendor; a free wrapper report is a warm intro.",
  },
  {
    id: "openweather",
    name: "OpenWeatherMap",
    terms: ["openweather", "openweathermap"],
    officialDomains: ["openweathermap.org"],
    category: "weather",
    knownUnitUsd: 0.0015,
    outboundNote: "Paid tiers; redistribution restricted by license.",
  },
  {
    id: "alphavantage",
    name: "Alpha Vantage",
    terms: ["alpha vantage", "alphavantage"],
    officialDomains: ["alphavantage.co"],
    category: "finance",
    knownUnitUsd: 0.0017, // ~$50/mo premium / ~30k calls
    outboundNote: "Free-key resale behind a paywall is pure ToS breach + brand risk.",
  },
  {
    id: "coingecko",
    name: "CoinGecko",
    terms: ["coingecko"],
    officialDomains: ["coingecko.com"],
    category: "crypto-data",
    knownUnitUsd: 0.0008, // analyst tier ~$129/500k
    outboundNote: "Sells API tiers; attribution required even on free tier — resellers strip it.",
  },
  {
    id: "coinmarketcap",
    name: "CoinMarketCap",
    terms: ["coinmarketcap"],
    officialDomains: ["coinmarketcap.com"],
    category: "crypto-data",
    knownUnitUsd: 0.003,
    outboundNote: "Commercial-use redistribution needs an enterprise license.",
  },
  {
    id: "bloomberg",
    name: "Bloomberg",
    terms: ["bloomberg"],
    officialDomains: ["bloomberg.com", "bloomberglp.com"],
    category: "finance",
    outboundNote: "Most protective data licensor on earth; any resale claim is actionable.",
  },
  {
    id: "yahoo-finance",
    name: "Yahoo Finance",
    terms: ["yahoo finance", "yfinance"],
    officialDomains: ["yahoo.com", "yahooapis.com"],
    category: "finance",
    outboundNote: "No official public API — every 'Yahoo Finance API' is a scraper by definition.",
  },
  {
    id: "polygon-io",
    name: "Polygon.io",
    terms: ["polygon.io"],
    officialDomains: ["polygon.io"],
    category: "finance",
    knownUnitUsd: 0.002,
    outboundNote: "Licensed exchange data — redistribution is regulated (SIP fees).",
  },
  {
    id: "yelp",
    name: "Yelp",
    terms: ["yelp"],
    officialDomains: ["yelp.com"],
    category: "web-data",
    outboundNote: "Fusion API bans caching/resale.",
  },
  {
    id: "tripadvisor",
    name: "Tripadvisor",
    terms: ["tripadvisor"],
    officialDomains: ["tripadvisor.com"],
    category: "travel",
    outboundNote: "Content API is partner-gated.",
  },
  {
    id: "zillow",
    name: "Zillow",
    terms: ["zillow", "zestimate"],
    officialDomains: ["zillow.com", "zillowstatic.com"],
    category: "web-data",
    outboundNote: "Shut its public API; every 'Zillow API' today is unauthorized.",
  },
  {
    id: "bing",
    name: "Bing Search",
    terms: ["bing search", "bing api", "bing serp"],
    officialDomains: ["bing.com", "microsoft.com", "azure.com"],
    category: "search",
    knownUnitUsd: 0.015,
    outboundNote: "Retired public Search API in 2025 — resale claims are inherently gray-market.",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    terms: ["perplexity"],
    officialDomains: ["perplexity.ai"],
    category: "ai-model",
    knownUnitUsd: 0.005,
    outboundNote: "Answer-engine wrappers piggyback on its brand for credibility.",
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    terms: ["elevenlabs", "eleven labs"],
    officialDomains: ["elevenlabs.io"],
    category: "ai-model",
    knownUnitUsd: 0.1, // per ~1k chars TTS
    outboundNote: "Voice cloning resale is also an abuse-safety issue for them.",
  },
  {
    id: "midjourney",
    name: "Midjourney",
    terms: ["midjourney"],
    officialDomains: ["midjourney.com"],
    category: "ai-model",
    outboundNote: "Has NO public API — any 'Midjourney API' is automation against their ToS.",
  },
  {
    id: "stability",
    name: "Stability AI",
    terms: ["stable diffusion", "stability ai", "sdxl"],
    officialDomains: ["stability.ai"],
    category: "ai-model",
    outboundNote: "Membership terms restrict commercial resale of hosted API.",
  },
  {
    id: "flightaware",
    name: "FlightAware",
    terms: ["flightaware"],
    officialDomains: ["flightaware.com"],
    category: "travel",
    knownUnitUsd: 0.005,
    outboundNote: "AeroAPI is metered; redistribution needs a data license.",
  },
  {
    id: "aviationstack",
    name: "Aviationstack",
    terms: ["aviationstack"],
    officialDomains: ["aviationstack.com"],
    category: "travel",
    knownUnitUsd: 0.0005,
    outboundNote: "Small apilayer brand; warm-intro candidate.",
  },
  {
    id: "newsapi",
    name: "NewsAPI.org",
    terms: ["newsapi"],
    officialDomains: ["newsapi.org"],
    category: "news",
    knownUnitUsd: 0.002,
    outboundNote: "Free-tier keys explicitly non-commercial — paywalled resale is a clean violation.",
  },
  {
    id: "shodan",
    name: "Shodan",
    terms: ["shodan"],
    officialDomains: ["shodan.io"],
    category: "security",
    knownUnitUsd: 0.01,
    outboundNote: "Security data resale is both a ToS and an ethics problem for them.",
  },
  {
    id: "etherscan",
    name: "Etherscan",
    terms: ["etherscan", "basescan"],
    officialDomains: ["etherscan.io", "basescan.org"],
    category: "crypto-data",
    knownUnitUsd: 0.0002,
    outboundNote: "API Pro exists precisely because free-tier resale was rampant.",
  },
  {
    id: "exa",
    name: "Exa",
    terms: ["exa"],
    officialDomains: ["exa.ai"],
    category: "search",
    knownUnitUsd: 0.005,
    outboundNote: "AI-native search vendor; x402 resellers openly say 'powered by Exa'.",
  },
  {
    id: "tavily",
    name: "Tavily",
    terms: ["tavily"],
    officialDomains: ["tavily.com"],
    category: "search",
    knownUnitUsd: 0.008,
    outboundNote: "Agent-search vendor whose free credits get arbitraged.",
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    terms: ["firecrawl"],
    officialDomains: ["firecrawl.dev"],
    category: "web-data",
    knownUnitUsd: 0.001,
    outboundNote: "Scrape-API vendor; wrapper resale skims their credit pricing.",
  },
  {
    id: "apify",
    name: "Apify",
    terms: ["apify"],
    officialDomains: ["apify.com"],
    category: "web-data",
    knownUnitUsd: 0.002,
    outboundNote: "Actor marketplace — unauthorized re-wrapping bypasses their rev-share.",
  },
  {
    id: "dexscreener",
    name: "DEX Screener",
    terms: ["dexscreener", "dex screener"],
    officialDomains: ["dexscreener.com"],
    category: "crypto-data",
    outboundNote: "Free API with rate limits; paywalled proxies monetize their infra.",
  },
  {
    id: "opensea",
    name: "OpenSea",
    terms: ["opensea"],
    officialDomains: ["opensea.io"],
    category: "crypto-data",
    outboundNote: "Keyed API; resale breaches developer ToS.",
  },
  {
    id: "binance",
    name: "Binance",
    terms: ["binance"],
    officialDomains: ["binance.com", "binance.us"],
    category: "crypto-data",
    outboundNote: "Public market data is free — charging for a proxy is pure margin on their infra.",
  },
];

/** Phrases that indicate a comparative mention rather than resale ("alternative to X"). */
export const COMPARATIVE_PHRASES = [
  "alternative to",
  "alternatives to",
  "similar to",
  "instead of",
  "cheaper than",
  "better than",
  "replacement for",
  "like",
  "vs",
  "without",
  "no need for",
  "compared to",
];

/** Generic-infrastructure host suffixes (cheap/ephemeral hosting). */
export const GENERIC_INFRA_SUFFIXES = [
  "vercel.app",
  "netlify.app",
  "railway.app",
  "up.railway.app",
  "workers.dev",
  "pages.dev",
  "trycloudflare.com",
  "herokuapp.com",
  "onrender.com",
  "fly.dev",
  "ngrok.app",
  "ngrok-free.app",
  "ngrok.io",
  "loca.lt",
  "serveo.net",
  "glitch.me",
  "repl.co",
  "replit.dev",
  "replit.app",
  "azurewebsites.net",
  "cloudfront.net",
  "amazonaws.com",
  "appspot.com",
  "run.app",
  "github.io",
  "hf.space",
  "deno.dev",
  "koyeb.app",
  "zeabur.app",
  "render.com",
];
