# Detour

Take a different way to the same place. Detour finds a fresh route, a bakery on it, and (with reviews connected) a dish worth trying. Built for the Hacktoberfest Open-Source AI Challenge, Week 1 ("Touch Grass").

- Routes: OpenStreetMap, Nominatim, FOSSGIS routing, Overpass (all free)
- Text: open-weight Gemma 4, called through two routes at once (OpenRouter and Google AI Studio) for reliability
- Reviews (optional): Google Places API
- Server: one small Node file, no dependencies. API keys stay on the server.

## Run locally
```
export OPENROUTER_API_KEY=your-key
export GEMINI_API_KEY=your-key
export PLACES_API_KEY=your-key   # optional
npm start
```
Open http://localhost:3000

## Deploy on Render
New Web Service, connect this repo, Build Command empty, Start Command `npm start`, add `OPENROUTER_API_KEY` and `GEMINI_API_KEY` (and optionally `PLACES_API_KEY`) under Environment.