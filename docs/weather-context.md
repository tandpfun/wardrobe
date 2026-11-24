# Weather Context

`src/weather-context.js` adds an optional Open-Meteo forecast for outfit ranking. It doesn't need an API key. It returns a small set of weather tags, so the outfit code can rank clothes without putting weather rules into every garment combination.

```js
import { fetchOpenMeteoWeather } from "./src/weather-context.js";

const context = await fetchOpenMeteoWeather({
  latitude: 52.37,
  longitude: 4.90,
  date: "2026-07-16",
});

// { tags: ["hot"], temperatureMax: 28, ... }
```

Consumers can use `hot`, `mild`, `cold`, `rain`, and `windy` as ranking and filtering context. The module doesn't choose garments, save locations, or access a calendar. A separate calendar adapter can later provide normalized occasion context.

The request uses Open-Meteo's daily endpoint and should run only when weather-aware suggestions are requested. If the request fails or the user is offline, the caller should keep the existing no-weather flow available.
