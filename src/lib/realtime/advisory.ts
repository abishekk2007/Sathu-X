// ---------------------------------------------------------------------------
// Phase 6B Extended — Deterministic advisory engine.
//
//   weather data → normalized realtime data → domain advisory engine → result
//
// Every measurement comes straight from the provider payload (never invented,
// never estimated by an LLM). Factors are derived deterministically with simple
// severity tiers (low / moderate / high / unknown); "unknown" means the data
// was genuinely unavailable — it is NEVER replaced with a fake zero.
//
// These summaries are application-level weather-based assessments. They are
// NOT official warnings, navigation clearances, aviation clearances,
// pesticide-safety certifications, or flood predictions — each brief carries an
// explicit limitation, and no provider is credited with the advisory itself
// (Open-Meteo supplies data; Spidey Bot produces the advisory).
// ---------------------------------------------------------------------------

import type { DomainIntent, DomainTimeframe } from "./domain";
import { conditionFor, type GeocodedLocation } from "./domain-weather";

export type Severity = "low" | "moderate" | "high" | "unknown";

export interface AdvisoryFactor {
  key: string;
  label: string;
  value: string;
  unit: string;
  severity: Severity;
}

export interface AdvisoryResult {
  domain: DomainIntent;
  severity: Severity;
  summary: string;
  factors: AdvisoryFactor[];
  limitations: string[];
  /** Human label for the forecast window actually used (from API time data). */
  forecastPeriod: string;
  /** The deterministic answer body (plain text, UI-safe). */
  answer: string;
}

interface WindowStats {
  indices: number[];
  label: string;
  peakIndex: number | null;
  count: number;
}

// ---------------------------------------------------------------------------
// Numeric helpers (missing data stays "Not available", never zero)
// ---------------------------------------------------------------------------

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asText(value: number | null): string {
  if (value === null) return "Not available";
  return String(value);
}

function fmt(value: number | null | string, digits: number): string {
  if (typeof value === "string") return value === "" ? "Not available" : value;
  if (value === null) return "Not available";
  const rounded = Number.isInteger(value) ? value : Number(value.toFixed(digits));
  return String(rounded);
}

function factorValue(
  label: string,
  value: number | null | string,
  unit: string,
  severity: Severity,
  _digits?: number
): AdvisoryFactor {
  return {
    key: label.toLowerCase().replace(/\s+/g, "-"),
    label,
    // A genuinely missing value renders with NO unit suffix ("Not available",
    // never a fake zero).
    value: value === null || value === "" ? "Not available" : `${fmt(value, _digits ?? 1)}${unit ? ` ${unit}` : ""}`,
    unit,
    severity,
  };
}

// ---------------------------------------------------------------------------
// Window selection over the hourly array (deterministic, from API time data)
// ---------------------------------------------------------------------------

function localDateOf(time: string): string {
  return time.slice(0, 10);
}

function localHourOf(time: string): number {
  const match = time.match(/T(\d{2}):/);
  return match ? Number(match[1]) : -1;
}

function selectWindow(
  times: string[],
  timeframe: DomainTimeframe
): WindowStats {
  if (times.length === 0) return { indices: [], label: "Not available", peakIndex: null, count: 0 };

  const distinctDates = [...new Set(times.map(localDateOf))];

  if (timeframe === "tonight") {
    const indices = times.reduce<number[]>((acc, t, i) => {
      const hour = localHourOf(t);
      if (hour >= 20 || hour < 6) acc.push(i);
      return acc;
    }, []);
    if (indices.length > 0) {
      return { indices, label: `Tonight (from ${times[indices[0]].slice(0, 16)})`, peakIndex: indices[0], count: indices.length };
    }
  }

  if (timeframe === "tomorrow") {
    const today = distinctDates[0];
    const tomorrow = distinctDates.find((d) => d !== today);
    if (tomorrow) {
      const indices = times.reduce<number[]>((acc, t, i) => {
        if (localDateOf(t) === tomorrow) acc.push(i);
        return acc;
      }, []);
      return { indices, label: `Tomorrow (${tomorrow})`, peakIndex: indices[Math.floor(indices.length / 2)] ?? indices[0], count: indices.length };
    }
    // Single-day horizon: tomorrow is not available — fall back to the tail.
    const tail = times.slice(Math.max(0, times.length - 6)).map((_, i) => times.length - 6 + i);
    return { indices: tail, label: `Next few hours (${times[tail[0]]?.slice(0, 16) ?? "not available"})`, peakIndex: tail[0], count: tail.length };
  }

  if (timeframe === "week") {
    const start = times[0];
    const end = times[times.length - 1];
    const indices = times.map((_, i) => i);
    return { indices, label: `This week (${start.slice(0, 10)} → ${end.slice(0, 10)})`, peakIndex: indices[0], count: indices.length };
  }

  // "today" (includes the "now" default): the first six hours of the returned
  // window give the nearest-horizon view; "today" widens to the whole day.
  const today = distinctDates[0];
  const todayIndices = times.reduce<number[]>((acc, t, i) => {
    if (localDateOf(t) === today) acc.push(i);
    return acc;
  }, []);
  const indices = timeframe === "today" ? todayIndices : todayIndices.slice(0, 6);
  if (indices.length === 0) indices.push(0);
  return {
    indices,
    label: timeframe === "today" ? `Today (${today})` : `Next few hours (from ${times[indices[0]].slice(0, 16)})`,
    peakIndex: indices[0],
    count: indices.length,
  };
}

function series(payload: Record<string, unknown>, key: string): number[] {
  const hourly = payload.hourly as Record<string, unknown> | undefined;
  const raw = hourly?.[key];
  return Array.isArray(raw) ? (raw as unknown[]).map((v) => asNumber(v) ?? NaN) : [];
}

/** String series (e.g. ISO timestamps) preserved verbatim from the payload. */
function timeSeries(payload: Record<string, unknown>, key: string): string[] {
  const hourly = payload.hourly as Record<string, unknown> | undefined;
  const raw = hourly?.[key];
  return Array.isArray(raw) ? (raw as unknown[]).filter((v): v is string => typeof v === "string") : [];
}

const NUM = (arr: number[], i: number | null): number | null =>
  typeof i === "number" && i >= 0 && i < arr.length && Number.isFinite(arr[i]) ? arr[i] : null;

function maxOver(arr: number[], indices: number[]): number | null {
  let best: number | null = null;
  for (const i of indices) {
    const v = NUM(arr, i);
    if (v !== null && (best === null || v > best)) best = v;
  }
  return best;
}

function sumOver(arr: number[], indices: number[]): number | null {
  let total = 0;
  let found = false;
  for (const i of indices) {
    const v = NUM(arr, i);
    if (v !== null) {
      total += v;
      found = true;
    }
  }
  return found ? total : null;
}

function meanOver(arr: number[], indices: number[]): number | null {
  let total = 0;
  let n = 0;
  for (const i of indices) {
    const v = NUM(arr, i);
    if (v !== null) {
      total += v;
      n += 1;
    }
  }
  return n > 0 ? total / n : null;
}

function peakIndexFor(arr: number[], indices: number[]): number | null {
  let best = -1;
  let bestVal: number | null = null;
  for (const i of indices) {
    const v = NUM(arr, i);
    if (v !== null && (bestVal === null || v > bestVal)) {
      bestVal = v;
      best = i;
    }
  }
  return best >= 0 ? best : (indices[0] ?? null);
}

// ---------------------------------------------------------------------------
// Severity tiers (deterministic; application-level only)
// ---------------------------------------------------------------------------

function rainSeverity(prob: number | null): Severity {
  if (prob === null) return "unknown";
  if (prob >= 70) return "high";
  if (prob >= 40) return "moderate";
  return "low";
}

function windSeverity(kph: number | null): Severity {
  if (kph === null) return "unknown";
  if (kph >= 40) return "high";
  if (kph >= 25) return "moderate";
  return "low";
}

function gustSeverity(kph: number | null): Severity {
  if (kph === null) return "unknown";
  if (kph >= 55) return "high";
  if (kph >= 35) return "moderate";
  return "low";
}

function tempSeverity(apparentMax: number | null, apparentMin: number | null): Severity {
  if (apparentMax === null || apparentMin === null) return "unknown";
  if (apparentMax >= 38 || apparentMin <= 8) return "high";
  if (apparentMax >= 32 || apparentMin <= 14) return "moderate";
  return "low";
}

function visibilitySeverity(km: number | null): Severity {
  if (km === null) return "unknown";
  if (km < 1) return "high";
  if (km < 5) return "moderate";
  return "low";
}

function waveSeverity(m: number | null): Severity {
  if (m === null) return "unknown";
  if (m >= 3) return "high";
  if (m >= 1.5) return "moderate";
  return "low";
}

function rainfallSeverity(mm: number | null): Severity {
  if (mm === null) return "unknown";
  if (mm >= 50) return "high";
  if (mm >= 20) return "moderate";
  return "low";
}

function worse(a: Severity, b: Severity): Severity {
  const order: Record<Severity, number> = { high: 3, moderate: 2, low: 1, unknown: 0 };
  return order[a] >= order[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Headline + shared text helpers
// ---------------------------------------------------------------------------

function headline(geo: GeocodedLocation): string {
  const parts = [geo.name];
  if (typeof geo.admin1 === "string" && geo.admin1) parts.push(geo.admin1);
  if (typeof geo.country === "string" && geo.country) parts.push(geo.country);
  return parts.join(", ");
}

const OVERALL_STATE: Record<string, string> = {
  high: "Conditions may require extra caution in the forecast window.",
  moderate: "Conditions look workable but worth planning around.",
  low: "Conditions appear relatively calm and suitable based on the retrieved forecast.",
  unknown: "Some of the data needed for a full assessment was unavailable.",
};

// ---------------------------------------------------------------------------
// Per-domain brief builders
// ---------------------------------------------------------------------------

interface DomainData {
  geo: GeocodedLocation;
  payload: Record<string, unknown>;
  window: WindowStats;
}

const UNITS: Record<string, string> = {
  temperature: "°C",
  rain: "mm",
  prob: "%",
  wind: "km/h",
  gust: "km/h",
  wave: "m",
  swell: "m",
  period: "s",
  visibility: "km",
  pressure: "hPa",
  humidity: "%",
  condition: "",
};

function agric(options: DomainData): Omit<AdvisoryResult, "domain"> {
  const d = options.payload;
  const w = options.window;
  const temp = series(d, "temperature_2m");
  const feels = series(d, "apparent_temperature");
  const rainChance = series(d, "precipitation_probability");
  const rainAmount = series(d, "precipitation");
  const wind = series(d, "wind_speed_10m");
  const gusts = series(d, "wind_gusts_10m");
  const humidity = series(d, "relative_humidity_2m");
  const codes = series(d, "weather_code");

  const rainP = maxOver(rainChance, w.indices);
  const rainA = sumOver(rainAmount, w.indices);
  const windMax = maxOver(wind, w.indices);
  const gustMax = maxOver(gusts, w.indices);
  const tempMean = meanOver(temp, w.indices);
  const feelsMax = maxOver(feels, w.indices);
  const feelsMin = meanOver(feels, w.indices);
  const humMean = meanOver(humidity, w.indices);
  const peak = peakIndexFor(rainChance, w.indices);
  const condition = conditionFor(NUM(codes, peak));

  const factors: AdvisoryFactor[] = [
    factorValue("Rain risk", rainP, UNITS.prob, rainSeverity(rainP), 0),
    factorValue("Expected rain", rainA, UNITS.rain, rainfallSeverity(rainA)),
    factorValue("Wind", windMax, UNITS.wind, windSeverity(windMax), 0),
    factorValue("Wind gusts", gustMax, UNITS.gust, gustSeverity(gustMax), 0),
    factorValue("Temperature", tempMean, UNITS.temperature, tempSeverity(feelsMax, feelsMin ?? null), 1),
    factorValue("Humidity", humMean, UNITS.humidity, "unknown", 0),
    factorValue("Condition", condition, "", "unknown"),
  ];

  const summaryParts: string[] = [];
  if (rainP !== null && rainP >= 40) {
    summaryParts.push(rainP >= 70 ? "Rain is likely in the forecast window, which could affect spraying and open-field work." : "There is a moderate chance of rain — plan around showers.");
  } else if (rainP !== null) {
    summaryParts.push("Little to no rain is expected, so conditions look favourable for outdoor field work (always re-check on the day).");
  }
  if (windMax !== null && windMax >= 40) {
    summaryParts.push("Strong wind may cause spray drift and uneven application — spraying is best deferred or calibrated for conditions.");
  } else if (windMax !== null && windMax >= 25) {
    summaryParts.push("Wind may be noticeable; take care with fine sprays.");
  } else if (windMax !== null) {
    summaryParts.push("Winds look calm enough for careful spraying.");
  }
  if (feelsMax !== null && feelsMax >= 38) {
    summaryParts.push("High heat may make extended field work uncomfortable.");
  } else if (feelsMin !== null && feelsMin <= 8) {
    summaryParts.push("Cold may limit early-morning field work.");
  }
  const summary = summaryParts.length > 0 ? summaryParts.join(" ") : "The retrieved forecast shows conditions within the expected range for field work.";

  return {
    severity: factors.reduce((acc, f) => worse(acc, f.severity), "low" as Severity),
    summary,
    factors,
    limitations: [
      "This is a weather-based assessment only — it is not a pesticide-safety certification or official agricultural approval.",
      "Always follow the pesticide label, local agricultural guidance, and product-specific requirements; weather data alone never proves an application is safe.",
      "No chemical dosage or application instructions are provided.",
    ],
    forecastPeriod: w.label,
    answer: "",
  };
}

function marine(options: DomainData): Omit<AdvisoryResult, "domain"> {
  const daily = options.payload.daily as Record<string, unknown> | undefined;
  const w = options.window;
  const wind = series(options.payload, "wind_speed_10m");
  const gusts = series(options.payload, "wind_gusts_10m");
  const rainChance = series(options.payload, "precipitation_probability");
  const current = series(options.payload, "ocean_current_velocity");

  const arr = (key: string): number[] =>
    daily && Array.isArray((daily as Record<string, unknown>)[key])
      ? ((daily as Record<string, unknown>)[key] as unknown[]).map((v) => asNumber(v) ?? NaN)
      : [];

  const dailyDates = daily && Array.isArray(daily.time) ? (daily.time as string[]) : [];
  let dayIndex = -1;
  if (dailyDates.length > 0) {
    if (options.window.label.startsWith("Tomorrow")) {
      const today = dailyDates[0];
      const tomorrow = dailyDates.find((x) => x !== today);
      dayIndex = tomorrow !== undefined ? dailyDates.indexOf(tomorrow) : dailyDates.length - 1;
    } else if (options.window.label.startsWith("Tonight")) {
      dayIndex = 0;
    } else if (options.window.label.startsWith("This week")) {
      dayIndex = dailyDates.length - 1;
    } else {
      dayIndex = 0;
    }
  }

  const waveH = NUM(arr("wave_height_max"), dayIndex);
  const wavePeriod = NUM(arr("wave_period_max"), dayIndex);
  const swell = NUM(arr("swell_wave_height_max"), dayIndex);
  const windWave = NUM(arr("wind_wave_height_max"), dayIndex);
  const sst = NUM(arr("sea_surface_temperature_max"), dayIndex);
  const windMax = maxOver(wind, w.indices);
  const gustMax = maxOver(gusts, w.indices);
  const rainP = maxOver(rainChance, w.indices);
  const currentV = maxOver(current, w.indices);

  const factors: AdvisoryFactor[] = [
    factorValue("Significant wave height", waveH, UNITS.wave, waveSeverity(waveH)),
    factorValue("Swell wave height", swell, UNITS.swell, waveSeverity(swell)),
    factorValue("Wave period", wavePeriod, UNITS.period, "unknown", 0),
    factorValue("Wind", windMax, UNITS.wind, windSeverity(windMax), 0),
    factorValue("Precipitation risk", rainP, UNITS.prob, rainSeverity(rainP), 0),
    factorValue("Sea surface temperature", sst, UNITS.temperature, "unknown", 1),
    factorValue("Ocean current", currentV, "m/s", "unknown"),
  ];
  void windWave;

  const summaryParts: string[] = [];
  if (waveH !== null && waveH >= 3) {
    summaryParts.push("Conditions appear potentially challenging based on the forecast — elevated seas are expected.");
  } else if (waveH !== null && waveH >= 1.5) {
    summaryParts.push("Conditions appear moderate based on the forecast; exercise judgement at sea.");
  } else if (waveH !== null) {
    summaryParts.push("Conditions appear relatively calm based on the retrieved forecast.");
  } else {
    summaryParts.push("Wave data for the window was not available.");
  }
  if (windMax !== null && windMax >= 40) {
    summaryParts.push("Strong wind is expected, which can build sea state and reduce comfort offshore.");
  }
  if (gustMax !== null && gustMax >= 55) {
    summaryParts.push("Wind gusts may be significant — allow extra margins for small craft.");
  }
  if (rainP !== null && rainP >= 40) {
    summaryParts.push("Rain is possible — allow extra caution and visibility margins.");
  }

  return {
    severity: factors.reduce((acc, f) => worse(acc, f.severity), "low" as Severity),
    summary: summaryParts.join(" "),
    factors,
    limitations: [
      "This is a weather-derived marine briefing, NOT a navigation clearance and NOT a claim that operations are safe.",
      "Official maritime/navigation guidance, nautical warnings, and published marine forecasts always take precedence for operational decisions.",
    ],
    forecastPeriod: w.label,
    answer: "",
  };
}

function aviation(options: DomainData): Omit<AdvisoryResult, "domain"> {
  const d = options.payload;
  const w = options.window;
  const temp = series(d, "temperature_2m");
  const wind = series(d, "wind_speed_10m");
  const gust = series(d, "wind_gusts_10m");
  const rain = series(d, "precipitation_probability");
  const visibility = series(d, "visibility");
  const cloud = series(d, "cloud_cover");
  const pressure = series(d, "surface_pressure");
  const codes = series(d, "weather_code");

  const windMax = maxOver(wind, w.indices);
  const gustMax = maxOver(gust, w.indices);
  const rainP = maxOver(rain, w.indices);
  const vis = minVis(visibility, w.indices);
  const cloudMax = maxOver(cloud, w.indices);
  const press = meanOver(pressure, w.indices);
  const tempMean = meanOver(temp, w.indices);
  const peak = peakIndexFor(rain, w.indices);
  const condition = conditionFor(NUM(codes, peak));

  const factors: AdvisoryFactor[] = [
    factorValue("Visibility", vis, UNITS.visibility, visibilitySeverity(vis)),
    factorValue("Cloud cover", cloudMax, "%", "unknown", 0),
    factorValue("Wind", windMax, UNITS.wind, windSeverity(windMax), 0),
    factorValue("Wind gusts", gustMax, UNITS.gust, gustSeverity(gustMax), 0),
    factorValue("Precipitation", rainP, UNITS.prob, rainSeverity(rainP), 0),
    factorValue("Temperature", tempMean, UNITS.temperature, "unknown", 1),
    factorValue("Pressure", press, UNITS.pressure, "unknown", 0),
    factorValue("Condition", condition, "", "unknown"),
  ];

  const summaryParts = [
    vis !== null && vis < 5 ? `Visibility is reduced (${fmt(vis, 1)} km).` : "Visibility looks adequate in the retrieved window.",
    cloudMax !== null && cloudMax >= 80 ? "Cloud cover is extensive." : "",
    windMax !== null && windMax >= 40 ? "Wind (and possibly gusts) will be strong." : "",
    rainP !== null && rainP >= 40 ? "Precipitation may affect the window." : "",
  ].filter(Boolean);

  return {
    severity: factors.reduce((acc, f) => worse(acc, f.severity), "low" as Severity),
    summary: summaryParts.join(" ") || "No significant weather concerns appear in the retrieved window.",
    factors,
    limitations: [
      "This is an informational weather briefing — it is NOT flight clearance, air traffic control, pilot authorization, or an official aviation meteorological briefing.",
      "For real operations check official aviation weather products and the relevant aviation authorities.",
    ],
    forecastPeriod: w.label,
    answer: "",
  };
}

function smartCity(options: DomainData): Omit<AdvisoryResult, "domain"> {
  const d = options.payload;
  const w = options.window;
  const rainAmount = series(d, "precipitation");
  const rainP = series(d, "precipitation_probability");
  const wind = series(d, "wind_speed_10m");
  const gust = series(d, "wind_gusts_10m");
  const visibility = series(d, "visibility");
  const codes = series(d, "weather_code");
  const temps = series(d, "temperature_2m");

  const rainSum = sumOver(rainAmount, w.indices);
  const rainProb = maxOver(rainP, w.indices);
  const windMax = maxOver(wind, w.indices);
  const gustMax = maxOver(gust, w.indices);
  const visMin = minVis(visibility, w.indices);
  const peak = peakIndexFor(rainP, w.indices);
  const condition = conditionFor(NUM(codes, peak));
  const hottest = maxOver(temps, w.indices);

  const factors: AdvisoryFactor[] = [
    factorValue("Rainfall", rainSum, UNITS.rain, rainfallSeverity(rainSum)),
    factorValue("Rain probability", rainProb, UNITS.prob, rainSeverity(rainProb), 0),
    factorValue("Wind", windMax, UNITS.wind, windSeverity(windMax), 0),
    factorValue("Wind gusts", gustMax, UNITS.gust, gustSeverity(gustMax), 0),
    factorValue("Visibility", visMin, UNITS.visibility, visibilitySeverity(visMin)),
    factorValue("Peak temperature", hottest, UNITS.temperature, tempSeverity(hottest, null), 1),
    factorValue("Condition", condition, "", "unknown"),
  ];

  const summaryParts: string[] = [];
  const heavyRain = rainProb !== null && rainProb >= 70;
  const heavyAmount = rainSum !== null && rainSum >= 20;
  if (heavyRain || heavyAmount) {
    summaryParts.push("Heavy rainfall is indicated in the forecast window.");
  } else if (rainSum !== null && rainSum >= 5) {
    summaryParts.push("City rainfall is expected; keep an umbrella handy.");
  } else if (rainProb !== null && rainProb < 40) {
    summaryParts.push("Little significant rainfall is expected in the window.");
  } else {
    summaryParts.push("Rainfall assessment from the retrieved forecast.");
  }
  if (windMax !== null && windMax >= 40) {
    summaryParts.push("Strong winds are expected, so secure loose outdoor items.");
  }
  if (gustMax !== null && gustMax >= 55) {
    summaryParts.push("Wind gusts may be significant.");
  }
  const preparedness = heavyRain || heavyAmount
    ? "Preparedness suggestion: monitor local weather alerts and flood-prone areas if rainfall intensifies."
    : "Preparedness suggestion: keep an eye on local weather updates for any changes.";

  return {
    severity: factors.reduce((acc, f) => worse(acc, f.severity), "low" as Severity),
    summary: `${summaryParts.join(" ")} ${preparedness}`,
    factors,
    limitations: [
      "Street-level flooding is NOT predicted from weather data alone — drainage, terrain, and local water levels decide flooding.",
      "Check official municipal alerts for warnings specific to your area.",
    ],
    forecastPeriod: w.label,
    answer: "",
  };
}

function travel(options: DomainData): Omit<AdvisoryResult, "domain"> {
  const d = options.payload;
  const w = options.window;
  const temp = series(d, "temperature_2m");
  const feels = series(d, "apparent_temperature");
  const rain = series(d, "precipitation_probability");
  const wind = series(d, "wind_speed_10m");
  const visibility = series(d, "visibility");
  const codes = series(d, "weather_code");

  const tempMax = maxOver(temp, w.indices);
  const feelsMin = meanOver(feels, w.indices);
  const feelsMax = maxOver(feels, w.indices);
  const rainP = maxOver(rain, w.indices);
  const windMax = maxOver(wind, w.indices);
  const visMin = minVis(visibility, w.indices);
  const peak = peakIndexFor(rain, w.indices);
  const condition = conditionFor(NUM(codes, peak));

  const factors: AdvisoryFactor[] = [
    factorValue("Temperature", tempMax, UNITS.temperature, tempSeverity(feelsMax, feelsMin ?? null), 1),
    factorValue("Feels-like", feelsMax, UNITS.temperature, "unknown", 1),
    factorValue("Rain probability", rainP, UNITS.prob, rainSeverity(rainP), 0),
    factorValue("Wind", windMax, UNITS.wind, windSeverity(windMax), 0),
    factorValue("Visibility", visMin, UNITS.visibility, visibilitySeverity(visMin)),
    factorValue("Condition", condition, "", "unknown"),
  ];

  const summaryParts: string[] = [];
  if (rainP !== null && rainP >= 40) {
    summaryParts.push(rainP >= 70 ? "Rain is likely — pack for wet conditions." : "Some rain is possible.");
  } else if (rainP !== null) {
    summaryParts.push("Little rain is expected.");
  }
  if (feelsMax !== null && feelsMax >= 35) {
    summaryParts.push("It will feel hot, so plan for heat and stay hydrated.");
  } else if (feelsMin !== null && feelsMin <= 12) {
    summaryParts.push("It will feel cool — dress warmly.");
  }
  if (windMax !== null && windMax >= 40) {
    summaryParts.push("Winds will be strong.");
  }

  return {
    severity: factors.reduce((acc, f) => worse(acc, f.severity), "low" as Severity),
    summary: summaryParts.join(" ") || "The forecast looks comfortable for travel.",
    factors,
    limitations: [
      "This is a weather-based travel note, NOT a guarantee of travel safety or suitability.",
      "Check transport operators and local guidance for the day of travel.",
    ],
    forecastPeriod: w.label,
    answer: "",
  };
}

function outdoor(options: DomainData): Omit<AdvisoryResult, "domain"> {
  const d = options.payload;
  const w = options.window;
  const temp = series(d, "temperature_2m");
  const feels = series(d, "apparent_temperature");
  const rain = series(d, "precipitation_probability");
  const wind = series(d, "wind_speed_10m");
  const codes = series(d, "weather_code");

  const tempMax = maxOver(temp, w.indices);
  const feelsMax = maxOver(feels, w.indices);
  const feelsMin = meanOver(feels, w.indices);
  const rainP = maxOver(rain, w.indices);
  const windMax = maxOver(wind, w.indices);
  const peak = peakIndexFor(rain, w.indices);
  const condition = conditionFor(NUM(codes, peak));

  const factors: AdvisoryFactor[] = [
    factorValue("Temperature", tempMax, UNITS.temperature, tempSeverity(feelsMax, feelsMin ?? null), 1),
    factorValue("Feels-like", feelsMax, UNITS.temperature, "unknown", 1),
    factorValue("Rain probability", rainP, UNITS.prob, rainSeverity(rainP), 0),
    factorValue("Wind", windMax, UNITS.wind, windSeverity(windMax), 0),
    factorValue("Condition", condition, "", "unknown"),
  ];

  const summaryParts: string[] = [];
  if (rainP !== null && rainP >= 40) {
    summaryParts.push(rainP >= 70 ? "Rain is likely — an outdoor plan may need a wet-weather backstop." : "Some rain is possible; keep a backup plan.");
  } else if (rainP !== null) {
    summaryParts.push("Little rain is expected, so outdoor plans look comfortable from the forecast.");
  }
  if (feelsMax !== null && feelsMax >= 35) {
    summaryParts.push("It will feel hot, so pace activity and stay hydrated.");
  } else if (feelsMin !== null && feelsMin <= 10) {
    summaryParts.push("It will feel cold — dress in layers.");
  }
  if (windMax !== null && windMax >= 40) {
    summaryParts.push("Strong wind is expected, which can affect comfort and light activities.");
  } else if (windMax !== null && windMax >= 25) {
    summaryParts.push("A moderate breeze is expected.");
  }

  return {
    severity: factors.reduce((acc, f) => worse(acc, f.severity), "low" as Severity),
    summary: summaryParts.join(" ") || "Conditions look comfortable for outdoor activity based on the retrieved forecast.",
    factors,
    limitations: [
      "This is a weather-based recommendation only, not a guarantee that an outdoor activity is safe or suitable.",
      "Consider individual fitness, terrain, and any official activity guidance.",
    ],
    forecastPeriod: w.label,
    answer: "",
  };
}

function minVis(arr: number[], indices: number[]): number | null {
  let best: number | null = null;
  for (const i of indices) {
    const v = NUM(arr, i);
    if (v !== null && (best === null || v < best)) best = v;
  }
  // Open-Meteo returns visibility in metres; every consumer displays km.
  return best === null ? null : best / 1000;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const TITLES: Record<Exclude<DomainIntent, "NONE">, string> = {
  AGRICULTURE: "Agricultural Weather Advisory",
  MARINE: "Marine Weather Briefing",
  AVIATION: "Airport Weather Briefing",
  SMART_CITY: "Smart City Weather Briefing",
  TRAVEL: "Travel Weather Note",
  OUTDOOR: "Outdoor Activity Weather Note",
};

const ATTRS: Record<Exclude<DomainIntent, "NONE">, string> = {
  AGRICULTURE: "Agricultural advisory",
  MARINE: "Marine briefing",
  AVIATION: "Aviation briefing",
  SMART_CITY: "Urban assessment",
  TRAVEL: "Travel note",
  OUTDOOR: "Outdoor note",
};

/** Data provider attribution — the provider supplies data; the bot makes the advisory. */
const PROVIDER: Record<Exclude<DomainIntent, "NONE">, string> = {
  AGRICULTURE: "Open-Meteo",
  MARINE: "Open-Meteo Marine",
  AVIATION: "Open-Meteo",
  SMART_CITY: "Open-Meteo",
  TRAVEL: "Open-Meteo",
  OUTDOOR: "Open-Meteo",
};

export function buildAdvisory(input: {
  domain: Exclude<DomainIntent, "NONE">;
  geo: GeocodedLocation;
  payload: Record<string, unknown>;
  timeframe: DomainTimeframe;
}): AdvisoryResult {
  const times = timeSeries(input.payload, "time");
  const window = selectWindow(times, input.timeframe);
  const base: DomainData = { geo: input.geo, payload: input.payload, window };

  let built: Omit<AdvisoryResult, "domain">;
  switch (input.domain) {
    case "AGRICULTURE":
      built = agric(base);
      break;
    case "MARINE":
      built = marine(base);
      break;
    case "AVIATION":
      built = aviation(base);
      break;
    case "SMART_CITY":
      built = smartCity(base);
      break;
    case "TRAVEL":
      built = travel(base);
      break;
    case "OUTDOOR":
      built = outdoor(base);
      break;
  }

  const stateLine = OVERALL_STATE[built.severity] ?? OVERALL_STATE.unknown;
  const riskLine =
    built.severity === "unknown" ? "Assessment: unknown (some data unavailable)." : `Assessment: ${capitalize(built.severity)} risk.`;

  const factorLines = built.factors.map((f) => `• ${f.label}: ${f.value}`);

  const answer = [
    TITLES[input.domain],
    "",
    `Location: ${headline(input.geo)}`,
    `Forecast period: ${built.forecastPeriod}`,
    "",
    ...factorLines,
    "",
    "Advisory:",
    built.summary,
    "",
    riskLine,
    "",
    `Source: ${PROVIDER[input.domain]}`,
    `Timestamp: ${new Date().toISOString()}`,
    "",
    "Safety note:",
    ...built.limitations.map((l) => `• ${l}`),
  ].join("\n");

  void stateLine;
  void ATTRS;
  void PROVIDER;
  return {
    domain: input.domain,
    severity: built.severity,
    summary: built.summary,
    factors: built.factors,
    limitations: built.limitations,
    forecastPeriod: built.forecastPeriod,
    answer,
  };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}