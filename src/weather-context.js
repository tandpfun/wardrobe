const OPEN_METEO_ENDPOINT = "https://api.open-meteo.com/v1/forecast";

const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82]);

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function dailyValue(payload, key) {
  return first(payload?.daily?.[key]);
}

/**
 * Turn one Open-Meteo daily forecast into stable, UI-agnostic styling tags.
 * Consumers can use the tags to filter or rank outfits without coupling the
 * wardrobe domain to a particular weather provider or outfit algorithm.
 */
export function classifyWeather({
  temperatureMax,
  temperatureMin,
  apparentTemperatureMax = temperatureMax,
  precipitationProbability = 0,
  weatherCode = 0,
  windSpeedMax = 0,
}) {
  const tags = [];
  const maxTemperature = Math.max(temperatureMax ?? 0, apparentTemperatureMax ?? 0);

  if (maxTemperature >= 25) tags.push("hot");
  else if (temperatureMax <= 15 || temperatureMin <= 5) tags.push("cold");
  else tags.push("mild");

  if (precipitationProbability >= 40 || RAIN_CODES.has(weatherCode)) tags.push("rain");
  if (windSpeedMax >= 30) tags.push("windy");

  return {
    tags,
    temperatureMax,
    temperatureMin,
    apparentTemperatureMax,
    precipitationProbability,
    weatherCode,
    windSpeedMax,
  };
}

export function normalizeOpenMeteoDaily(payload) {
  if (!payload?.daily?.time?.length) throw new Error("Open-Meteo returned no daily forecast.");

  return classifyWeather({
    temperatureMax: dailyValue(payload, "temperature_2m_max"),
    temperatureMin: dailyValue(payload, "temperature_2m_min"),
    apparentTemperatureMax: dailyValue(payload, "apparent_temperature_max"),
    precipitationProbability: dailyValue(payload, "precipitation_probability_max") || 0,
    weatherCode: dailyValue(payload, "weather_code") || 0,
    windSpeedMax: dailyValue(payload, "wind_speed_10m_max") || 0,
  });
}

export async function fetchOpenMeteoWeather({ latitude, longitude, date, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  if (!date) throw new Error("A forecast date is required.");

  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    daily: "temperature_2m_max,temperature_2m_min,apparent_temperature_max,precipitation_probability_max,weather_code,wind_speed_10m_max",
    timezone: "auto",
    start_date: date,
    end_date: date,
  });
  const response = await fetchImpl(`${OPEN_METEO_ENDPOINT}?${params}`);
  if (!response.ok) throw new Error(`Open-Meteo request failed with ${response.status}.`);
  return normalizeOpenMeteoDaily(await response.json());
}
