import assert from "node:assert/strict";
import { classifyWeather, normalizeOpenMeteoDaily } from "../src/weather-context.js";

assert.deepEqual(classifyWeather({
  temperatureMax: 31,
  temperatureMin: 18,
  precipitationProbability: 0,
  weatherCode: 0,
  windSpeedMax: 12,
}).tags, ["hot"]);

assert.deepEqual(classifyWeather({
  temperatureMax: 12,
  temperatureMin: 4,
  precipitationProbability: 80,
  weatherCode: 61,
  windSpeedMax: 34,
}).tags, ["cold", "rain", "windy"]);

assert.deepEqual(normalizeOpenMeteoDaily({
  daily: {
    time: ["2026-07-16"],
    temperature_2m_max: [28],
    temperature_2m_min: [19],
    apparent_temperature_max: [30],
    precipitation_probability_max: [10],
    weather_code: [3],
    wind_speed_10m_max: [18],
  },
}).tags, ["hot"]);

console.log("weather-context checks passed");
