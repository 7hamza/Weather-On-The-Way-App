# ThrottleCast

Free weather-on-the-way web app for motorcycle trip planning.

ThrottleCast lets you build an interactive itinerary, view your route on the map, and estimate weather checkpoints along the path at the expected time you pass each point.

## Features

- Interactive map with route visualization
- Origin, destination, and unlimited stopovers
- Live location suggestions for stop inputs
- Auto route + weather recalculation when itinerary changes
- Day/night-aware weather point icons
- Weather checkpoint list with ETA and location label
- Itinerary export as JSON

## Tech Stack

- React + TypeScript + Vite
- Leaflet + React Leaflet
- OSRM (routing)
- Open-Meteo (forecast)
- OpenStreetMap Nominatim (search/reverse geocoding)

## Run Locally

1. Install dependencies:

```bash
npm install
```

2. Start development server:

```bash
npm run dev
```

3. Build for production:

```bash
npm run build
```

## Deployment

### Netlify (free)

- Build command: `npm run build`
- Publish directory: `dist`

You can deploy by drag-and-drop (upload `dist`) or by connecting the GitHub repository.

## Notes

- Forecast range is limited by provider capabilities.
- Route and weather quality depend on third-party API availability.
