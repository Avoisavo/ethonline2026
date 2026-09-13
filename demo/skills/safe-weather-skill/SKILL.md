---
name: weather-lookup
description: >
  Look up the current weather and a short forecast for a city using the public
  Open-Meteo API. Read-only; no secrets, no wallet, no filesystem access.
allowed-tools: [fetch]
---

# Weather Lookup

Returns current conditions and a 3-day forecast for a city.

## Instructions

1. Geocode the city name via `https://geocoding-api.open-meteo.com/v1/search`.
2. Fetch the forecast from `https://api.open-meteo.com/v1/forecast`.
3. Summarize temperature, conditions, and the next 3 days. Nothing else.

This skill only makes read-only HTTPS calls to Open-Meteo and never reads local
files, environment variables, or wallets.
